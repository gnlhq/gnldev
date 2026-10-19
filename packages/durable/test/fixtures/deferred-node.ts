// Child process for the background-tool scenarios: ONE app process built on `createGnl` (the registry
// is where a background tool's task and continuation are run), a conversation store over the storage's
// own message table, and a small HTTP door in front of it.
//
//   argv: <kind sqlite|postgres> <db path | url> <readyFile> <effectsFile>
//   env:  DF_TASK_MS   how long the background tool's body takes
//         DF_RECOVER=1 the tool answers the crash ladder from the effects file (recover())
//         DF_KILL      where this process SIGKILLs itself, once per store (the first process to get there):
//                      body-end (after the effect, before its record), before-write / after-write (around
//                      the append of the result to the thread), after-answer (after the continuation's answer)
//                      before-wake (the task has ended; the first store write of its wake has not happened)
//                      mid-answer (the continuation's answer is streaming: its first word is out, the rest is not)
//         DF_FAULT     wake-error: the first store write of the wake fails, once per store (`.faulted`)
//                      task-call: every write of a task's call record fails (the call never runs; `.taskfault`)
//         DF_CONT_FAIL=once the first model call of a continuation fails, once per store (`.contfailed`)
//         DF_TASK_ALIGN=1 every body ends on a whole second (tasks started together end on one tick)
//         DF_TASK_GATE=<file> the body ends only once that file exists (the test decides when, not a clock)
//         DF_WAKE_DELAY=<toolCallId>:<ms> that call's wake writes its first record late (once)
//         DF_CONT_MS   gap between the words of a continuation's answer (default 1 ms)
//         DF_SWEEP_MS, DF_POLL_MS, DF_LONG_MS (gap between the words of a "long" answer)
//
// A prompt `twin <topic>` calls the background tool twice in one step (call-1, call-2): two tasks that
// end together, and so two wakes of one thread at once.
//
// Files beside the effects file: `.started` (a body began), `.calls` (every model call: pid, kind, text),
// `.killed` (the one self-kill happened).
import { createServer } from 'node:http';
import { appendFileSync, readFileSync, existsSync, writeFileSync } from 'node:fs';
import { writeReady } from './write-ready.js';
import { tool } from 'ai';
import { z } from 'zod';
import { armFixtureWatchdog } from './watchdog.js';
import { createGnl, gnlTool, eraseSubject, purgeThread, purgeRun, readRunOutcome, asReaderJournal, type Journal, type Memory } from '../../src/index.js';
import { SqliteStorage } from '../../src/sqlite-storage.js';
import { PostgresStorage } from '../../src/postgres-storage.js';

armFixtureWatchdog(Number(process.env.DF_DEADLINE_MS ?? 120_000));

const [kind, where, readyFile, effectsFile] = process.argv.slice(2) as [string, string, string, string];
const env = process.env;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const storage: any = kind === 'sqlite' ? new SqliteStorage(where) : new PostgresStorage({ connectionString: where });
if (kind === 'postgres') storage.pool?.on?.('error', () => {});
const journal = storage.runs as unknown as Journal;

// The wake of a task writes first under its continuation's id (`cont:…`): the point where a store error
// or a kill lands between the task's end and the agent's wake.
const slowed = new Set<string>();
for (const m of ['put', 'putIfAbsent', 'putIfMatch'] as const) {
  const orig = (journal as any)[m]?.bind(journal);
  if (!orig) continue;
  (journal as any)[m] = async (key: string, ...rest: unknown[]) => {
    if (env.DF_FAULT === 'task-call' && typeof key === 'string' && /^task:.*:tool:/.test(decodeURIComponent(key))) {
      appendFileSync(`${effectsFile}.taskfault`, `${process.pid} ${Date.now()} ${decodeURIComponent(key)}\n`);
      throw new Error('store refuses the call record (injected)');
    }
    if (typeof key === 'string' && decodeURIComponent(key).includes('cont:')) {
      if (env.DF_TRACE) appendFileSync(`${effectsFile}.trace`, `${Date.now()} ${m} ${decodeURIComponent(key)}\n`);
      killPoint('before-wake');
      // DF_WAKE_DELAY=<toolCallId>:<ms>: that call's wake is slow to write (once) — a slow store between a
      // wake's look at the thread and its continuation's birth.
      const [slowCall, slowMs] = (env.DF_WAKE_DELAY ?? '').split(':');
      if (slowCall && decodeURIComponent(key).includes(`:${slowCall}`) && !slowed.has(slowCall)) { slowed.add(slowCall); await sleep(Number(slowMs)); }
      if (env.DF_FAULT === 'wake-error' && !existsSync(`${effectsFile}.faulted`)) {
        writeFileSync(`${effectsFile}.faulted`, `${process.pid} ${decodeURIComponent(key)}\n`);
        throw new Error('store unavailable (injected)');
      }
    }
    return orig(key, ...rest);
  };
}

/** Kills this process here — once per store: the first process that reaches the point. */
function killPoint(point: string): void {
  if (env.DF_KILL !== point || existsSync(`${effectsFile}.killed`)) return;
  writeFileSync(`${effectsFile}.killed`, `${process.pid} ${point}\n`);
  process.kill(process.pid, 'SIGKILL');
}

const textOf = (m: any): string => {
  if (typeof m?.content === 'string') return m.content;
  if (!Array.isArray(m?.content)) return '';
  return m.content.map((p: any) => (p.type === 'text' ? p.text : p.type === 'tool-call' ? `[call ${p.toolName}]` : p.type === 'tool-result' ? `[result ${JSON.stringify(p.output?.value ?? p.output)}]` : '')).join('');
};
const isResult = (m: any) => m?.role === 'user' && textOf(m).startsWith('Background task');

/** The conversation store: the storage's message table, each batch at most once (its identity in the same transaction). */
const memory: Memory = {
  async getMessages(threadId) {
    const out: any[] = [];
    let cursor: string | undefined;
    do {
      const page = await storage.memory.getMessages(threadId, { limit: 500, ...(cursor ? { cursor } : {}) });
      out.push(...page.items.map((r: any) => r.message));
      cursor = page.nextCursor;
    } while (cursor);
    return out;
  },
  async append(threadId, messages) {
    await storage.memory.appendMessages(threadId, messages.map((message: any) => ({ threadId, role: message.role, text: textOf(message), ts: Date.now(), message })));
  },
  async appendOnce(threadId, messages, batchKey) {
    const theResult = messages.some(isResult);
    if (theResult) killPoint('before-write');
    const wrote = await storage.memory.appendMessagesOnce(threadId, messages.map((message: any) => ({ threadId, role: message.role, text: textOf(message), ts: Date.now(), message })), batchKey);
    if (theResult) killPoint('after-write');
    if (batchKey.startsWith('mem-appended:cont:')) killPoint('after-answer');
    return wrote;
  },
  async retract(threadId, batchKey) { await storage.memory.retractBatch?.(threadId, batchKey); },
};

// ── the agent's model: deterministic, decided by the prompt (so a replay or a takeover decides the same) ──
const usage = { inputTokens: { total: 1, noCache: 1, cacheRead: undefined, cacheWrite: undefined }, outputTokens: { total: 1, text: 1, reasoning: undefined } };
function lastUser(prompt: any[]): { text: string; toolAfter: boolean } {
  let i = prompt.length - 1;
  while (i >= 0 && prompt[i].role !== 'user') i--;
  return { text: i >= 0 ? textOf(prompt[i]) : '', toolAfter: prompt.slice(i + 1).some((m: any) => m.role === 'tool') };
}
const model: any = {
  specificationVersion: 'v4', provider: 'scripted', modelId: 'deferred', supportedUrls: {},
  doGenerate: async () => { throw new Error('stream only'); },
  doStream: async ({ prompt, abortSignal }: any) => {
    const { text, toolAfter } = lastUser(prompt);
    const cont = text.startsWith('Background task');
    appendFileSync(`${effectsFile}.calls`, `${process.pid} ${cont ? 'cont' : 'turn'} ${Date.now()} ${JSON.stringify(text.slice(0, 60))}\n`);
    if (cont && env.DF_CONT_FAIL === 'once' && !existsSync(`${effectsFile}.contfailed`)) {
      writeFileSync(`${effectsFile}.contfailed`, `${process.pid}\n`);
      throw new Error('provider unavailable (injected)');
    }
    const twin = !cont && !toolAfter && text.startsWith('twin');
    const callsTool = twin || (!cont && !toolAfter && text.startsWith('research'));
    const words = cont ? ['noted:', text.slice(0, 40)] : text.startsWith('long') ? Array.from({ length: 30 }, (_, i) => `w${i}`) : ['ok', text];
    const gap = text.startsWith('long') ? Number(env.DF_LONG_MS ?? 60) : cont ? Number(env.DF_CONT_MS ?? 1) : 1;
    return {
      stream: new ReadableStream({
        async start(c) {
          c.enqueue({ type: 'stream-start', warnings: [] });
          if (callsTool) {
            const topic = text.slice(text.indexOf(' ') + 1);
            c.enqueue({ type: 'tool-call', toolCallId: 'call-1', toolName: 'research', input: JSON.stringify({ topic }) });
            if (twin) c.enqueue({ type: 'tool-call', toolCallId: 'call-2', toolName: 'research', input: JSON.stringify({ topic: `${topic} again` }) });
            c.enqueue({ type: 'finish', finishReason: { unified: 'tool-calls', raw: 'tool-calls' }, usage });
            c.close();
            return;
          }
          c.enqueue({ type: 'text-start', id: 't' });
          for (const w of words) {
            await sleep(gap);
            if (abortSignal?.aborted) { c.error(abortSignal.reason ?? new Error('aborted')); return; }
            c.enqueue({ type: 'text-delta', id: 't', delta: `${w} ` });
            if (cont) killPoint('mid-answer');
          }
          c.enqueue({ type: 'text-end', id: 't' });
          c.enqueue({ type: 'finish', finishReason: { unified: 'stop', raw: 'stop' }, usage });
          if (cont) appendFileSync(`${effectsFile}.calls`, `${process.pid} cont-end ${Date.now()} ${JSON.stringify(text.slice(0, 60))}\n`);
          c.close();
        },
      }),
    };
  },
};

/** The background tool: a long side effect — one line in the effects file per execution. */
const research = gnlTool(tool({
  description: 'deep research, takes a while',
  inputSchema: z.object({ topic: z.string() }),
  execute: async ({ topic }: { topic: string }, opts: any) => {
    appendFileSync(`${effectsFile}.started`, `${process.pid} ${topic}\n`);
    // DF_TASK_ALIGN=1: every body ends on the same second boundary (two tasks end on one timer tick).
    const ms = Number(env.DF_TASK_MS ?? 300);
    if (env.DF_TASK_GATE) while (!existsSync(env.DF_TASK_GATE)) await sleep(20);
    else await sleep(env.DF_TASK_ALIGN === '1' ? Math.ceil((Date.now() + ms) / 1000) * 1000 - Date.now() : ms);
    appendFileSync(effectsFile, `${process.pid} ${opts?.idempotencyKey ?? topic}\n`);
    killPoint('body-end');
    return `report on ${topic}`;
  },
}), {
  background: true,
  sideEffect: true,
  ...(env.DF_RECOVER === '1' ? {
    recover: async (_input: unknown, { idempotencyKey }: { idempotencyKey: string }) => {
      const lines = existsSync(effectsFile) ? readFileSync(effectsFile, 'utf8') : '';
      return lines.includes(idempotencyKey) ? { done: true, output: 'recovered report' } : { done: false };
    },
  } : {}),
} as any);

const gnl = createGnl({
  storage,
  memory,
  agents: { a: { model, tools: { research } } },
  detached: { sweepMs: Number(env.DF_SWEEP_MS ?? 300), pollMs: Number(env.DF_POLL_MS ?? 100) },
} as any);

// The registry makes its executor (and its sweep) on its first call: this process sweeps from its start,
// as a process that never served a request must to continue what a dead one left.
await gnl.follow('__warm__');

const body = (req: any): Promise<any> => new Promise((res) => { let b = ''; req.on('data', (d: any) => (b += d)); req.on('end', () => res(b ? JSON.parse(b) : {})); });
const json = (res: any, status: number, v: unknown) => res.writeHead(status, { 'content-type': 'application/json' }).end(JSON.stringify(v));

const server = createServer(async (req, res) => {
  const url = new URL(req.url ?? '/', 'http://x');
  try {
    if (req.method === 'POST' && url.pathname === '/chat') {
      // One turn of the conversation, followed to its end on this connection.
      const b = await body(req);
      const t0 = Date.now();
      let r: any;
      try {
        r = await gnl.stream('a', { runId: b.runId, threadId: b.threadId, prompt: b.text, resourceId: b.caller ?? 'alice', ...(b.approvals ? { approvals: b.approvals } : {}) } as any);
      } catch (e: any) {
        return json(res, ['RunOwnerMismatchError', 'RunActorMismatchError', 'RunThreadMismatchError', 'ThreadOwnerMismatchError'].includes(e?.name) ? 404 : 409, { error: String(e?.message ?? e), name: e?.name });
      }
      await r.consumeStream();
      const steps = await r.steps;
      return json(res, 200, { state: r.state, ms: Date.now() - t0, results: steps.flatMap((s: any) => s.toolResults.map((x: any) => x.output)), text: steps[steps.length - 1]?.text });
    }
    if (req.method === 'GET' && url.pathname === '/thread') {
      const msgs = await memory.getMessages(url.searchParams.get('threadId')!);
      return json(res, 200, msgs.map((m: any) => ({ role: m.role, text: textOf(m) })));
    }
    if (req.method === 'GET' && url.pathname === '/outcome') {
      return json(res, 200, (await readRunOutcome(journal, url.searchParams.get('runId')!)) ?? null);
    }
    if (req.method === 'POST' && url.pathname === '/erase') {
      const b = await body(req);
      if (b.kind === 'subject') await eraseSubject(storage, b.subject);
      else if (b.kind === 'thread') await purgeThread(asReaderJournal(journal), b.threadId, { allowInFlight: true, memory: storage.memory });
      else await purgeRun(asReaderJournal(journal) as any, b.runId);
      return json(res, 200, {});
    }
    if (req.method === 'GET' && url.pathname === '/keys') {
      return json(res, 200, await (journal as any).listKeys(url.searchParams.get('prefix') ?? ''));
    }
    res.writeHead(404).end();
  } catch (e: any) {
    json(res, 500, { error: String(e?.stack ?? e) });
  }
});

server.listen(0, '127.0.0.1', () => {
  writeReady(readyFile, `${(server.address() as any).port} ${process.pid}`);
});
