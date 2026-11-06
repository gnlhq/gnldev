// AUDIT A2 fixture: ONE app process (createGnl over Postgres), two roles.
//   argv: <role start|read> <pg url> <runId> <variant text|tool>
//   start: starts the run detached, waits until it is mid-flight (first text event, or the tool body
//          began), then closes the storage (what a server's shutdown does), prints what the log holds, exits.
//   read:  a fresh process on the same database: waits for its sweep, then a caller asks gnl.run() for
//          the same run id; prints what it got.
import { tool } from 'ai';
import { z } from 'zod';
import { createGnl, STAFF, readRunEvents } from '../../src/index.js';
import { PostgresStorage } from '../../src/postgres-storage.js';
import { streamingModel, textOf } from '../detached/models.js';

const [role, url, runId, variant] = process.argv.slice(2) as [string, string, string, string];
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
let toolStarted = 0;
const effect = tool({ description: 'effect', inputSchema: z.object({ order: z.string() }), execute: async () => { toolStarted++; await sleep(1_500); return 'done'; } });
Object.assign(effect, { sideEffect: true });
const model = variant === 'tool'
  ? streamingModel({ words: ['answer ', 'after ', 'tool '], gapMs: 10, tool: { name: 'effect', input: { order: 'o-1' } } })
  : streamingModel({ words: Array.from({ length: 40 }, (_, i) => `w${i} `), gapMs: 100 });

const storage = new PostgresStorage({ connectionString: url });
(storage as any).pool?.on?.('error', () => {});
const gnl: any = createGnl({ storage, agents: { a: { model, ...(variant === 'tool' ? { tools: { effect } } : {}) } }, detached: { sweepMs: 200, pollMs: 50 } } as any);
const journal: any = storage.runs;
const statuses = (evs: any[]) => evs.filter((e) => e.kind === 'status').map((e) => e.data.state);

if (role === 'start') {
  await gnl.stream('a', { runId, prompt: 'go', caller: STAFF });
  for (let i = 0; i < 400; i++) {
    const evs = await readRunEvents(journal, runId);
    if (variant === 'tool' ? toolStarted > 0 : evs.some((e: any) => e.kind === 'text')) break;
    await sleep(25);
  }
  await sleep(100);
  await storage.close();
  const peek = new PostgresStorage({ connectionString: url });
  const evs = await readRunEvents(peek.runs as any, runId);
  const out = { role, pid: process.pid, statuses: statuses(evs), text: textOf(evs as any), exec: await (peek.runs as any).get(`__exec__:/${encodeURIComponent(runId)}#`) ?? null, outcome: await (peek.runs as any).get(`${runId}:outcome`) ?? null, tool: await (peek.runs as any).get(`${runId}:tool:call-1`) ?? null };
  await peek.close();
  console.log(`A2RESULT ${JSON.stringify(out)}`);
  process.exit(0);
} else {
  await sleep(1_500); // this process's sweep: does it continue the run?
  let result: unknown;
  try {
    const r = await gnl.run('a', { runId, caller: STAFF });
    result = { ok: true, text: r.text, finishReason: r.finishReason };
  } catch (e: any) { result = { ok: false, name: e?.name, code: e?.code, message: String(e?.message ?? e).slice(0, 300) }; }
  const evs = await readRunEvents(journal, runId);
  const out = { role, pid: process.pid, result, statuses: statuses(evs), outcome: await journal.get(`${runId}:outcome`) ?? null, tool: await journal.get(`${runId}:tool:call-1`) ?? null };
  await storage.close();
  console.log(`A2RESULT ${JSON.stringify(out)}`);
  process.exit(0);
}
