// A run that ended outside the execution that follows it is still read whole from its event log.
//
// Measured (raporlar/2026-10-12-settle-final, Postgres, real processes, three partitions in a row): in 9
// of 45 completed trials a reader of the run saw the call's blocked answers and then `completed` — no
// tool-result with the call's real output, no answer text — although the call's record held the result.
// How: the late process, unfrozen, finishes its body, records the result and its own stream goes on to
// the end — it writes the run's outcome, but its events are refused (their numbers were taken by later
// executions). The execution that then picks the run up found the outcome `completed` and wrote only
// that status. A follower must see every event the run produced (D6): the rest is replayed from the
// journal (no model call, no tool call) through the one writer.
//
// Sibling: a process that dies after the run's outcome is written and before its last events are.
import { describe, it, expect, vi, beforeAll, afterAll, afterEach } from 'vitest';
import { tool } from 'ai';
import { z } from 'zod';
import {
  InMemoryStorage, DetachedRuns, streamDurable, installProcessLiveness, runKeys, claimRunOwner, user, readRunEvents,
  type Storage, type ProcessLiveness, type Journal,
} from '../src/index.js';
import { SqliteStorage } from '../src/sqlite-storage.js';
import { PostgresStorage } from '../src/postgres-storage.js';
import { stampFormat } from '../src/format.js';
import { execKey } from '../src/exec-record.js';
import { textOf } from './detached/models.js';

beforeAll(() => { vi.spyOn(console, 'warn').mockImplementation(() => {}); });
const ends: Array<() => Promise<unknown>> = [];
afterAll(async () => { for (const e of ends.reverse()) await e(); });
const perTest: Array<() => Promise<unknown>> = [];
afterEach(async () => {
  for (const e of perTest.splice(0).reverse()) await e();
  installProcessLiveness(undefined);
});

const PG_URL = process.env.GNL_PG_URL;
const STORES: Array<[string, () => Promise<Storage>]> = [
  ['in-memory', async () => new InMemoryStorage()],
  ['sqlite', async () => new SqliteStorage(':memory:')],
];
if (PG_URL) {
  STORES.push(['postgres (real)', async () => {
    const s = new PostgresStorage({ connectionString: PG_URL });
    ends.push(() => s.close());
    return s;
  }]);
}
const unique = () => `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const until = async (what: string, ok: () => Promise<boolean>, ms = 8_000) => {
  const end = Date.now() + ms;
  while (!(await ok())) { if (Date.now() > end) throw new Error(`timed out: ${what}`); await sleep(20); }
};

const MAX = 3;
const TTL = 60_000;
const usage = { inputTokens: { total: 1, noCache: 1, cacheRead: undefined, cacheWrite: undefined }, outputTokens: { total: 1, text: 1, reasoning: undefined } };

/** Calls `effect` once, then answers with what the call returned. Counts its calls. */
function echoModel(calls: { n: number }): any {
  return {
    specificationVersion: 'v3', provider: 'scripted', modelId: 'echo', supportedUrls: {},
    doGenerate: async () => { throw new Error('stream only'); },
    doStream: async ({ prompt }: any) => {
      calls.n++;
      const result = (prompt as any[]).flatMap((m) => (m.role === 'tool' ? m.content : [])).find((p: any) => p.type === 'tool-result');
      return {
        stream: new ReadableStream({
          start(c) {
            c.enqueue({ type: 'stream-start', warnings: [] });
            if (!result) {
              c.enqueue({ type: 'tool-call', toolCallId: 'call-1', toolName: 'effect', input: JSON.stringify({ order: 'o-1' }) });
              c.enqueue({ type: 'finish', finishReason: { unified: 'tool-calls', raw: 'tool-calls' }, usage });
            } else {
              c.enqueue({ type: 'text-start', id: 't' });
              c.enqueue({ type: 'text-delta', id: 't', delta: `saw ${JSON.stringify(result.output?.value ?? result.output)}` });
              c.enqueue({ type: 'text-end', id: 't' });
              c.enqueue({ type: 'finish', finishReason: { unified: 'stop', raw: 'stop' }, usage });
            }
            c.close();
          },
        }),
      };
    },
  };
}

function processD(): ProcessLiveness {
  const d: ProcessLiveness = { id: `D-${unique()}`, isAlive: async (id) => id === d.id, confirm: async () => true, close: async () => {} };
  installProcessLiveness(d);
  return d;
}

const effectTool = (executions: { n: number }) => Object.assign(
  tool({ description: 'a side effect', inputSchema: z.object({ order: z.string() }), execute: async () => { executions.n++; return 'ran again'; } }),
  { maxRetries: MAX, claimTtlMs: TTL, sideEffect: true, recover: async () => ({ done: false as const }) },
);

describe.each(STORES)('a run that ended outside the execution that follows it — %s', (_name, make) => {
  it('the late process ends the run itself (its events refused): a reader still gets the call\'s result and the answer', async () => {
    const storage = await make();
    const journal = storage.runs as unknown as Journal;
    const runId = `r-whole-${unique()}`;
    const d = processD();
    await claimRunOwner(journal as any, runId, user('alice'));
    const key = runKeys.tool(runId, 'call-1');
    const at = journal.now ? await journal.now() : Date.now();
    // The call at its ceiling: attempt 3 held by 'C' (gone), started, never reported.
    await journal.put(key, stampFormat({ status: 'running', startedAt: at, attempts: MAX, claimTtlMs: TTL, idempotencyKey: `${runId}:call-1`, proc: 'C' }));
    const executions = { n: 0 };
    const calls = { n: 0 };
    const launch = (signal: AbortSignal) => streamDurable({ journal, runId, model: echoModel(calls), tools: { effect: effectTool(executions) }, prompt: 'do it', resourceId: 'alice', abortSignal: signal } as any);
    // The interleaving measured: the late process's outcome lands after the continuing execution has
    // launched and before it looks at the outcome. (Its launch writes the run's 'running' outcome ahead;
    // the late process's 'completed' is written over it.)
    let lateOutcome: unknown;
    const resumeLaunch = async (signal: AbortSignal) => {
      const r = await launch(signal);
      if (lateOutcome !== undefined) await journal.put(runKeys.outcome(runId), lateOutcome);
      return r;
    };
    // No timer here: the test sweeps by hand, so the late process ends the run before anyone resumes it.
    const runs = new DetachedRuns({ journal, liveness: d, resume: () => resumeLaunch, sweepMs: 0, outcomeAskMs: 60_000 });
    perTest.push(() => runs.close());
    await runs.start({ runId, launch });
    const events = () => readRunEvents(journal, runId, 0);
    const lastState = async () => { const st = (await events()).filter((e) => e.kind === 'status'); return (st[st.length - 1]?.data as any)?.state; };
    await until('the run parks on the call', async () => (await lastState()) === 'waiting-outcome');
    await until('its execution record is parked', async () => (await journal.get<any>(execKey(undefined, runId)))?.status === 'parked');

    // C wakes up: its body lands the effect, it records the result, and its stream goes on to the run's
    // end — what the late process does with the execution it was given. Its events are not written (the
    // numbers it holds are taken); the run's journal gets the result, the answer and the outcome.
    await journal.put(key, stampFormat({ status: 'succeeded', output: 'done o-1', toolName: 'effect', idempotencyKey: `${runId}:call-1` }));
    const late = await streamDurable({ journal, runId, model: echoModel(calls), tools: { effect: effectTool(executions) }, prompt: 'do it', resourceId: 'alice' } as any) as any;
    for await (const _ of late.fullStream) { /* the late process's stream, to its end */ }
    expect(await late.text).toContain('done o-1');
    const modelCalls = calls.n;
    lateOutcome = await journal.get(runKeys.outcome(runId));
    expect(lateOutcome, 'the late process ended the run').toMatchObject({ status: 'completed' });

    await runs.sweep();
    await until('the run is read as completed', async () => (await lastState()) === 'completed');
    const evs = await events();
    const results = evs.filter((e) => e.kind === 'tool-result').map((e) => (e.data as any).output);
    expect(results, 'the reader sees the call\'s real result after the blocked one').toContain('done o-1');
    expect(textOf(evs as any), 'and the answer the run gave').toContain('done o-1');
    expect(calls.n, 'replayed from the journal: no model call').toBe(modelCalls);
    expect(executions.n, 'and no tool call').toBe(0);
  });
});
