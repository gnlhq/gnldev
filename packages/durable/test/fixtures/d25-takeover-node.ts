// Child process for the d25 P2 takeover scenarios: ONE app process on `createGnl` + a detached sweep.
// A tiny HTTP door seals the caller onto the request (as a real door does) and runs an agent whose
// DYNAMIC `tools` / `system` and whose tool HOOKS (idempotencyKey, lookup, recover, compensate) write
// the caller they were handed into files beside the effects file, so a test can read what a process that
// took the run over (kill -9 of the first one) was told.
//
//   argv: <kind sqlite|postgres> <db path | url> <readyFile> <effectsFile>
//   env:  DT_KILL=1  the first process to run the body kills itself
//         right after the effect (before its record): the successor must resume through recover()
//         DT_SWEEP_MS
// Files (`<effectsFile>.<name>`), one line per call: `<pid> <who>` where who = JSON of what the code saw.
//   dyn   the dynamic `tools` function's context   sys   the dynamic `system` function's context
//   idem  idempotencyKey hook   lookup  recover  exec  the body   killed  the self-kill
import { createServer } from 'node:http';
import { appendFileSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { writeReady } from './write-ready.js';
import { tool } from 'ai';
import { z } from 'zod';
import { armFixtureWatchdog } from './watchdog.js';
import { createGnl, gnlTool, readRunOutcome, type Journal } from '../../src/index.js';
import { sealRequestContext, serverIdentityOf } from '../../src/registry.js';
import { identityOf } from '../../src/run-identity.js';
import { SqliteStorage } from '../../src/sqlite-storage.js';
import { PostgresStorage } from '../../src/postgres-storage.js';

armFixtureWatchdog(60_000);
const [kind, where, readyFile, effectsFile] = process.argv.slice(2) as [string, string, string, string];
const env = process.env;
const storage: any = kind === 'sqlite' ? new SqliteStorage(where) : new PostgresStorage({ connectionString: where });
if (kind === 'postgres') storage.pool?.on?.('error', () => {});
const journal = storage.runs as unknown as Journal;
const note = (name: string, v: unknown) => appendFileSync(`${effectsFile}.${name}`, `${process.pid} ${JSON.stringify(v)}\n`);
const seenBy = (o: unknown) => { const i: any = identityOf(o); return { kind: i.kind, id: i.id, orgId: i.orgId, runId: i.runId, approved: (o as any)?.gnl?.approved }; };

const usage = { inputTokens: { total: 1, noCache: 1, cacheRead: undefined, cacheWrite: undefined }, outputTokens: { total: 1, text: 1, reasoning: undefined } };
const model: any = {
  specificationVersion: 'v4', provider: 'scripted', modelId: 'd25', supportedUrls: {},
  doGenerate: async () => { throw new Error('stream only'); },
  doStream: async ({ prompt }: any) => {
    const toolDone = prompt.some((m: any) => m.role === 'tool');
    return { stream: new ReadableStream({ start(c) {
      c.enqueue({ type: 'stream-start', warnings: [] });
      if (!toolDone) {
        c.enqueue({ type: 'tool-call', toolCallId: 'k1', toolName: 'charge', input: JSON.stringify({ order: 'o-1' }) });
        c.enqueue({ type: 'finish', finishReason: { unified: 'tool-calls', raw: 'tool-calls' }, usage });
      } else {
        c.enqueue({ type: 'text-start', id: 't' }); c.enqueue({ type: 'text-delta', id: 't', delta: 'done' }); c.enqueue({ type: 'text-end', id: 't' });
        c.enqueue({ type: 'finish', finishReason: { unified: 'stop', raw: 'stop' }, usage });
      }
      c.close();
    } }) };
  },
};

const charge = gnlTool(tool({
  description: 'charge', inputSchema: z.object({ order: z.string() }),
  execute: async ({ order }: { order: string }, opts: any) => {
    note('exec', seenBy(opts));
    appendFileSync(effectsFile, `${process.pid} ${opts?.idempotencyKey ?? order}\n`);
    if (env.DT_KILL === '1' && !existsSync(`${effectsFile}.killed`)) { writeFileSync(`${effectsFile}.killed`, `${process.pid}\n`); process.kill(process.pid, 'SIGKILL'); }
    return { charged: order };
  },
}), {
  sideEffect: true,
  idempotencyWindow: 'run' as const,
  idempotencyKey: (i: { order: string }, o?: unknown) => { note('idem', seenBy(o)); return i.order; },
  lookup: async (_i: unknown, o: unknown) => { note('lookup', seenBy(o)); return { exists: false as const }; },
  recover: async (_i: unknown, o: any) => {
    note('recover', { ...seenBy(o), key: o?.idempotencyKey });
    const lines = existsSync(effectsFile) ? readFileSync(effectsFile, 'utf8') : '';
    return lines.includes(o.idempotencyKey) ? { done: true as const, output: { charged: 'recovered' } } : { done: false as const };
  },
} as any);

const dynamicCtx = (ctx: Record<string, unknown>) => ({ ...serverIdentityOf(ctx), org: ctx.org });
const gnl = createGnl({
  storage,
  agents: { a: {
    model,
    system: (ctx: Record<string, unknown>) => { note('sys', dynamicCtx(ctx)); return 'you are a billing agent'; },
    tools: (ctx: Record<string, unknown>) => { note('dyn', dynamicCtx(ctx)); return { charge }; },
  } },
  detached: { sweepMs: Number(env.DT_SWEEP_MS ?? 250), pollMs: 100 },
} as any);
await gnl.follow('__warm__');

const body = (req: any): Promise<any> => new Promise((res) => { let b = ''; req.on('data', (d: any) => (b += d)); req.on('end', () => res(b ? JSON.parse(b) : {})); });
const json = (res: any, s: number, v: unknown) => res.writeHead(s, { 'content-type': 'application/json' }).end(JSON.stringify(v));
const server = createServer(async (req, res) => {
  const url = new URL(req.url ?? '/', 'http://x');
  try {
    if (req.method === 'POST' && url.pathname === '/run') {
      const b = await body(req);
      const r: any = await gnl.stream('a', { runId: b.runId, prompt: 'bill it', context: sealRequestContext({}, { resourceId: b.who, orgId: b.org }) } as any);
      await r.consumeStream();
      return json(res, 200, { ok: true });
    }
    if (req.method === 'GET' && url.pathname === '/outcome') return json(res, 200, (await readRunOutcome(journal, url.searchParams.get('runId')!)) ?? null);
    res.writeHead(404).end();
  } catch (e: any) { json(res, 500, { error: String(e?.stack ?? e) }); }
});
server.listen(0, '127.0.0.1', () => writeReady(readyFile, `${(server.address() as any).port} ${process.pid}`));
