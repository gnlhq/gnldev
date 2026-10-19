// Child process for the detached-run scenarios: ONE app process built from @gnldev/durable alone —
// storage, process liveness, DetachedRuns, and a thirty-line HTTP door in front of them (what any door
// does: start or join a run, stream it on the same connection, follow it from a cursor).
//
//   argv: <kind sqlite|postgres> <db path | url> <readyFile> <effectsFile>
//   env:  DN_TOOL_MS (tool body), DN_CLAIM_TTL, DN_SIGNAL=notify, DN_RECOVER=1, DN_CONFIRM=1,
//         DN_WORDS, DN_GAP_MS, DN_BASELINE=1 (no process liveness: today's claim-by-age), DN_SWEEP_MS,
//         DN_IDEMPOTENT=1 (the tool declares a repeat harmless: the crash ladder may run it again)
import { createServer } from 'node:http';
import { appendFileSync, readFileSync, existsSync } from 'node:fs';
import { writeReady } from './write-ready.js';
import { tool } from 'ai';
import { z } from 'zod';
import { armFixtureWatchdog } from './watchdog.js';
import {
  DetachedRuns, DrainingError, streamDurable, admitAgentRun, parseCursor, eraseSubject, purgeRun, agentStreamEvents, LIMIT_ERROR_CODES, sqliteLiveness, postgresLiveness, pgRunSignal, installProcessLiveness,
  type Journal, type ProcessLiveness, type RunSignal,
} from '../../src/index.js';
import { SqliteStorage } from '../../src/sqlite-storage.js';
import { PostgresStorage } from '../../src/postgres-storage.js';
import { streamingModel } from '../detached/models.js';

armFixtureWatchdog(Number(process.env.DN_DEADLINE_MS ?? 120_000));

const [kind, where, readyFile, effectsFile] = process.argv.slice(2) as [string, string, string, string];
const env = process.env;
const toolMs = Number(env.DN_TOOL_MS ?? 0);
const words = (env.DN_WORDS ?? 'Hello from a detached run .').split(' ').map((w) => `${w} `);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const storage = kind === 'sqlite' ? new SqliteStorage(where) : new PostgresStorage({ connectionString: where });
if (kind === 'postgres') (storage as any).pool?.on?.('error', () => {});
// Every statement the store sends (counted on each pooled connection: the pool routes through them).
const counters = { statements: 0 };
if (kind === 'postgres') {
  (storage as any).pool.on('connect', (c: any) => {
    const q = c.query.bind(c);
    c.query = (...args: unknown[]) => { counters.statements++; return q(...args); };
  });
}
const journal = storage.runs as unknown as Journal;

let liveness: ProcessLiveness | undefined;
let signal: RunSignal | undefined;
if (env.DN_BASELINE !== '1' && env.DN_NO_LIVENESS !== '1') {
  if (kind === 'sqlite') liveness = sqliteLiveness(where);
  else {
    const session = await postgresLiveness({ connectionString: where, heartbeatMs: 1_000 });
    liveness = session;
    if (env.DN_SIGNAL === 'notify') signal = pgRunSignal(session);
  }
}
installProcessLiveness(liveness);

/** One side effect = one line in the effects file (outside the database, so nothing can undo or hide it). */
const effect = tool({
  description: 'a side effect',
  inputSchema: z.object({ order: z.string() }),
  execute: async ({ order }, opts: any) => {
    appendFileSync(`${effectsFile}.started`, `${process.pid} ${order}\n`);
    await sleep(toolMs);
    appendFileSync(effectsFile, `${process.pid} ${opts?.idempotencyKey ?? order}\n`);
    await sleep(Number(env.DN_AFTER_MS ?? 0)); // the window between the effect and its record
    return `done ${order}`;
  },
});
Object.assign(effect, { sideEffect: true });
if (env.DN_RECOVER === '1') {
  // Asks the "provider" (the effects file) whether the effect with this idempotency key happened.
  Object.assign(effect, {
    recover: async (_input: unknown, { idempotencyKey }: { idempotencyKey: string }) => {
      const lines = existsSync(effectsFile) ? readFileSync(effectsFile, 'utf8') : '';
      return lines.includes(idempotencyKey) ? { done: true, output: 'recovered' } : { done: false };
    },
  });
}
if (env.DN_CONFIRM === '1') Object.assign(effect, { confirm: true });
if (env.DN_IDEMPOTENT === '1') Object.assign(effect, { sideEffect: undefined, idempotent: true });

const tools = { effect };
const model = streamingModel({ words, gapMs: Number(env.DN_GAP_MS ?? 10), ...(toolMs >= 0 && env.DN_NO_TOOL !== '1' ? { tool: { name: 'effect', input: { order: 'o-1' } } } : {}) });
const timeouts = { claimTtlMs: Number(env.DN_CLAIM_TTL ?? 30_000) };
const argsFor = (runId: string, approvals?: Record<string, boolean>, who = 'alice') =>
  ({ journal, runId, model, tools, prompt: 'do it', resourceId: who, timeouts, ...(approvals ? { approvals } : {}) }) as any;
const launchFor = (runId: string, approvals?: Record<string, boolean>, who = 'alice') => (abortSignal: AbortSignal) =>
  streamDurable({ ...argsFor(runId, approvals, who), abortSignal });

// DN_NO_LIVENESS=1: the app hands DetachedRuns no liveness at all (the misconfiguration of T1).
const runs = liveness || env.DN_NO_LIVENESS === '1'
  ? new DetachedRuns({
      journal, ...(liveness ? { liveness } : {}), ...(signal ? { signal } : {}), sweepMs: Number(env.DN_SWEEP_MS ?? 300), pollMs: Number(env.DN_POLL_MS ?? 100),
      resume: (rec) => launchFor(rec.runId),
      onComplete: async (c) => { appendFileSync(`${effectsFile}.hooks`, `${process.pid} ${c.id} ${c.state}\n`); },
    })
  : undefined;

const body = (req: any): Promise<any> => new Promise((res) => { let b = ''; req.on('data', (d: any) => (b += d)); req.on('end', () => res(b ? JSON.parse(b) : {})); });

const server = createServer(async (req, res) => {
  const url = new URL(req.url ?? '/', 'http://x');
  try {
    if (req.method === 'POST' && url.pathname === '/start') {
      const b = await body(req);
      let started;
      try {
        // Whose run: the engine's admission, asked before anything is executed or joined.
        const who = b.caller ?? 'alice';
        started = await runs!.start({ runId: b.runId, admit: () => admitAgentRun(argsFor(b.runId, b.approvals, who)), launch: launchFor(b.runId, b.approvals, who), resumeIntent: !!b.approvals });
      } catch (e) {
        if (e instanceof DrainingError) { res.writeHead(503).end(JSON.stringify({ error: 'draining' })); return; }
        if (['RunOwnerMismatchError', 'RunActorMismatchError'].includes((e as Error)?.name)) { res.writeHead(404).end(JSON.stringify({ error: 'run not found' })); return; }
        throw e;
      }
      if (url.searchParams.get('stream') !== '1') { res.writeHead(202, { 'content-type': 'application/json' }).end(JSON.stringify(started)); return; }
      return followTo(res, b.runId, url.searchParams.get('after') ?? '0', started.state);
    }
    if (req.method === 'GET' && url.pathname === '/events') {
      return followTo(res, url.searchParams.get('runId')!, url.searchParams.get('after') ?? '0');
    }
    if (req.method === 'POST' && url.pathname === '/direct') {
      // Today's model: the run inside the request (no execution record). The E6 baseline and the
      // tool-level sibling of S4b.
      const b = await body(req);
      try {
        const r: any = await launchFor(b.runId, b.approvals)(new AbortController().signal);
        const text = await r.text;
        res.writeHead(200).end(JSON.stringify({ ok: true, text }));
      } catch (e: any) {
        res.writeHead(409).end(JSON.stringify({ error: String(e?.message ?? e), name: e?.name }));
      }
      return;
    }
    if (req.method === 'POST' && url.pathname === '/direct-stream') {
      // Today's in-request streaming (the S1 baseline): the run lives and dies with this response.
      const b = await body(req);
      const ac = new AbortController();
      res.on('close', () => ac.abort());
      const r: any = await launchFor(b.runId)(ac.signal);
      res.writeHead(200, { 'content-type': 'application/x-ndjson' });
      res.flushHeaders?.();
      let seq = 0;
      for await (const ev of agentStreamEvents(r, b.runId, LIMIT_ERROR_CODES)) res.write(`${JSON.stringify({ seq: ++seq, kind: ev.event, data: ev.data })}\n`);
      res.end();
      return;
    }
    if (req.method === 'POST' && url.pathname === '/erase') {
      // Erasure from THIS process while the run may execute in another: a person, or one run.
      const b = await body(req);
      if (b.kind === 'subject') await eraseSubject(storage as any, b.subject);
      else await purgeRun(journal as any, b.runId);
      res.writeHead(200).end('{}');
      return;
    }
    if (req.method === 'GET' && url.pathname === '/keys') {
      res.writeHead(200).end(JSON.stringify(await (journal as any).listKeys(url.searchParams.get('prefix') ?? '')));
      return;
    }
    if (req.method === 'GET' && url.pathname === '/pending') { res.writeHead(200).end(JSON.stringify(await runs!.pending(Number(url.searchParams.get('quiet') ?? 1000)))); return; }
    if (req.method === 'GET' && url.pathname === '/stats') { res.writeHead(200).end(JSON.stringify({ ...runs?.stats, store: counters.statements, liveness: (liveness as any)?.statements })); return; }
    res.writeHead(404).end();
  } catch (e: any) {
    // A stream that already began (a follow whose store read failed mid-way) can only be cut short:
    // writing a status now threw ERR_HTTP_HEADERS_SENT and killed the node (seen in the partition harness).
    if (res.headersSent) { res.end(); return; }
    res.writeHead(500).end(JSON.stringify({ error: String(e?.message ?? e) }));
  }
});

/** `after`: the reader's cursor — `seq`, or `seq.offset` mid-segment (formatCursor). */
async function followTo(res: any, runId: string, afterRaw: string, state?: string): Promise<void> {
  const c = parseCursor(afterRaw) ?? { seq: 0, offset: 0 };
  res.writeHead(200, { 'content-type': 'application/x-ndjson', ...(state ? { 'x-run-state': state } : {}) });
  res.flushHeaders?.();
  const ac = new AbortController();
  res.on('close', () => ac.abort());
  for await (const ev of runs!.follow({ runId, after: c.seq, ...(c.offset ? { afterOffset: c.offset } : {}), signal: ac.signal })) {
    if (ac.signal.aborted) break;
    res.write(`${JSON.stringify(ev)}\n`);
  }
  res.end();
}

process.on('SIGTERM', async () => {
  // Graceful drain: 503 for new runs, the running tool finishes, no new step, runs released, exit.
  appendFileSync(`${effectsFile}.drain`, `${process.pid} drain-start ${Date.now()}\n`);
  await runs?.drain();
  await liveness?.close();
  appendFileSync(`${effectsFile}.drain`, `${process.pid} drain-exit ${Date.now()}\n`);
  process.exit(0);
});

server.listen(0, '127.0.0.1', () => {
  writeReady(readyFile, `${(server.address() as any).port} ${process.pid}`);
});
