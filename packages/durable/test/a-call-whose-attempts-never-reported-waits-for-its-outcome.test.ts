// A call whose attempts never reported waits for its outcome; it is not declared failed.
//
// At the retry ceiling a call whose last attempts started their body and never reported was given up
// at once: RetryLimitExceededError, the run `failed`. An attempt judged gone because it was cut off from
// the store (a partition: its sessions terminated) is not necessarily stopped — it can still be in the
// body and land the effect after that verdict. Measured (raporlar/2026-10-12-ag-kopmasi, Postgres, real
// processes, three partitions in a row): recover() said "not done" while the holders were frozen, the
// run ended `failed` 20/20, and the effect then landed once.
//
// The rule: when the tool can still report (recover(), or `idempotent: true`), the call's outcome is
// UNKNOWN at the ceiling, not failed. The run parks (`waiting-outcome`) and continues from the call's
// recorded result whenever one arrives — written by a late attempt, by a later recover(), or by an
// operator. One path settles the call: its record. No attempt is started again (the ceiling holds).
// Postgres runs when GNL_PG_URL is set.
import { describe, it, expect, vi, beforeAll, afterAll, afterEach } from 'vitest';
import { tool } from 'ai';
import { z } from 'zod';
import {
  InMemoryStorage, DetachedRuns, streamDurable, installProcessLiveness, eraseSubject, pendingWork, runKeys, claimRunOwner, user, readRunEvents,
  type Storage, type ProcessLiveness, type Journal,
} from '../src/index.js';
import { SqliteStorage } from '../src/sqlite-storage.js';
import { PostgresStorage } from '../src/postgres-storage.js';
import { Attempt, compareAndSet } from '../src/attempt.js';
import { stampFormat } from '../src/format.js';
import { execKey } from '../src/exec-record.js';
import { textOf } from './detached/models.js';

beforeAll(() => { vi.spyOn(console, 'warn').mockImplementation(() => {}); });
const ends: Array<() => Promise<unknown>> = [];
afterAll(async () => { for (const e of ends.reverse()) await e(); });
// Each test's executor stops with it: on a shared store (Postgres) another test's sweep would continue
// this test's runs with its own tool.
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

/** Calls `effect` once, then answers with what the call returned — what the model saw. */
function echoModel(): any {
  return {
    specificationVersion: 'v3', provider: 'scripted', modelId: 'echo', supportedUrls: {},
    doGenerate: async () => { throw new Error('stream only'); },
    doStream: async ({ prompt }: any) => {
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

/** This process is 'D'. The call's holders 'A' (the first attempt) and 'C' (the last) are judged gone. */
function processD(): ProcessLiveness {
  const d: ProcessLiveness = { id: `D-${unique()}`, isAlive: async (id) => id === d.id, confirm: async () => true, close: async () => {} };
  installProcessLiveness(d);
  return d;
}

/** The provider: whether the effect landed, and how often the body ran here. */
function provider() {
  return { landed: false, executions: 0 };
}

function effectTool(p: ReturnType<typeof provider>, kind: 'recover' | 'idempotent' | 'none') {
  const t = tool({ description: 'a side effect', inputSchema: z.object({ order: z.string() }), execute: async () => { p.executions++; return 'ran again'; } });
  return Object.assign(t, {
    maxRetries: MAX, claimTtlMs: TTL,
    ...(kind === 'recover' ? { sideEffect: true, recover: async () => (p.landed ? { done: true as const, output: 'recovered o-1' } : { done: false as const }) } : {}),
    ...(kind === 'idempotent' ? { idempotent: true } : {}),
    ...(kind === 'none' ? { sideEffect: false } : {}),
  });
}

/** The call at its ceiling: attempt 3, held by 'C' (gone), started its body and never reported. */
async function callAtCeiling(journal: Journal, runId: string) {
  await claimRunOwner(journal as any, runId, user('alice'));
  const key = runKeys.tool(runId, 'call-1');
  const at = journal.now ? await journal.now() : Date.now();
  const stampC = stampFormat({ status: 'running', startedAt: at, attempts: MAX, claimTtlMs: TTL, idempotencyKey: `${runId}:call-1`, proc: 'C' });
  await journal.put(key, stampC);
  return { key, stampC, at };
}

/** A late attempt (held by `proc`) that finished its body: what Attempt.succeed writes for it. */
function lateAttempt(journal: Journal, runId: string, key: string, proc: string, attempts: number, at: number) {
  const stamp = stampFormat({ status: 'running', startedAt: at, attempts, claimTtlMs: TTL, idempotencyKey: `${runId}:call-1`, proc }) as any;
  const write = (rec: any, expected: unknown) => compareAndSet(journal, key, expected, stampFormat({ ...rec, idempotencyKey: `${runId}:call-1` }));
  return new Attempt(journal, key, undefined, stamp, performance.now(), 'effect', write, { runId });
}

async function startRun(storage: Storage, runId: string, tool: unknown, d: ProcessLiveness, outcomeAskMs = 40) {
  const journal = storage.runs as unknown as Journal;
  const launch = (signal: AbortSignal) => streamDurable({ journal, runId, model: echoModel(), tools: { effect: tool }, prompt: 'do it', resourceId: 'alice', abortSignal: signal } as any);
  const runs = new DetachedRuns({ journal, liveness: d, resume: () => launch, sweepMs: 25, outcomeAskMs });
  perTest.push(() => runs.close());
  await runs.start({ runId, launch });
  // What a reader of the run sees: its last status, and the answer's text (a retried step discarded).
  const state = async () => {
    const evs = await readRunEvents(journal, runId, 0);
    const st = evs.filter((e) => e.kind === 'status');
    return { last: st[st.length - 1]?.data as any, text: textOf(evs as any), all: evs };
  };
  return { journal, runs, state };
}

describe.each(STORES)('a call at its retry ceiling whose attempts never reported — %s', (_name, make) => {
  it('the run waits for the outcome (not failed); a late attempt reports it; the run continues from it and the model sees it', async () => {
    const storage = await make();
    const runId = `r-out-${unique()}`;
    const d = processD();
    const { key, at } = await callAtCeiling(storage.runs as unknown as Journal, runId);
    const p = provider();
    // The tool is not asked again in this test (a long first wait): only the late report moves the run.
    const { journal, runs, state } = await startRun(storage, runId, effectTool(p, 'recover'), d, 60_000);

    await until('the run parks on the call', async () => (await state()).last?.state === 'waiting-outcome');
    await until('its execution record is parked on the call', async () => (await journal.get<any>(execKey(undefined, runId)))?.status === 'parked');
    const parked = await journal.get<any>(execKey(undefined, runId));
    expect(parked, 'parked on the call, visible').toMatchObject({ status: 'parked', awaits: { key } });
    expect((await runs.pending()).map((x) => x.reason).join(), 'pending names it').toMatch(/outcome/);

    // A — the first attempt, frozen and cut off, wakes up: its body lands the effect and it reports.
    p.landed = true;
    expect(await lateAttempt(journal, runId, key, 'A', 1, at).succeed({ status: 'succeeded', output: 'done o-1', toolName: 'effect' } as any), 'the late report is recorded over the gone claim').toBe(true);

    await until('the run continues and completes', async () => (await state()).last?.state === 'completed');
    const end = await state();
    expect(end.text, 'the model saw what happened').toContain('done o-1');
    expect(p.executions, 'never started again').toBe(0);
    await until('nothing left parked', async () => (await journal.get(execKey(undefined, runId))) === undefined);
  });

  it('nothing reports, but recover() answers "done" later: the run is continued to ask again and completes', async () => {
    const storage = await make();
    const runId = `r-out-${unique()}`;
    const d = processD();
    await callAtCeiling(storage.runs as unknown as Journal, runId);
    const p = provider();
    const { state } = await startRun(storage, runId, effectTool(p, 'recover'), d);
    await until('the run parks on the call', async () => (await state()).last?.state === 'waiting-outcome');
    p.landed = true; // the effect landed; its attempt died before it could report
    await until('recover() is asked again and the run completes', async () => (await state()).last?.state === 'completed');
    expect((await state()).text).toContain('recovered o-1');
    expect(p.executions).toBe(0);
  });

  it('idempotent: true (the key makes a late result stand): parked, then settled by the late attempt', async () => {
    const storage = await make();
    const runId = `r-out-${unique()}`;
    const d = processD();
    const { key, at } = await callAtCeiling(storage.runs as unknown as Journal, runId);
    const p = provider();
    const { journal, state } = await startRun(storage, runId, effectTool(p, 'idempotent'), d);
    await until('the run parks on the call', async () => (await state()).last?.state === 'waiting-outcome');
    // C, the last attempt, reports after all.
    expect(await lateAttempt(journal, runId, key, 'C', MAX, at).succeed({ status: 'succeeded', output: 'done o-1 by C', toolName: 'effect' } as any)).toBe(true);
    await until('completes', async () => (await state()).last?.state === 'completed');
    expect((await state()).text).toContain('done o-1 by C');
    expect(p.executions).toBe(0);
  });

  it('a second late report after the call is settled is kept as evidence, not written over the result and not dropped', async () => {
    const storage = await make();
    const runId = `r-out-${unique()}`;
    const d = processD();
    const { key, at } = await callAtCeiling(storage.runs as unknown as Journal, runId);
    const p = provider();
    const { journal, state } = await startRun(storage, runId, effectTool(p, 'recover'), d);
    await until('the run parks', async () => (await state()).last?.state === 'waiting-outcome');
    expect(await lateAttempt(journal, runId, key, 'A', 1, at).succeed({ status: 'succeeded', output: 'by A', toolName: 'effect' } as any)).toBe(true);
    expect(await lateAttempt(journal, runId, key, 'B', 2, at).succeed({ status: 'succeeded', output: 'by B', toolName: 'effect' } as any)).toBe(false);
    await until('completes', async () => (await state()).last?.state === 'completed');
    expect((await state()).text).toContain('by A');
    expect(await journal.get<any>(runKeys.proc(runId, 'late-call-1'))).toMatchObject({ late: [{ attempt: 2, output: 'by B', sameAsSettled: false }] });
  });

  it('a live claim is never written over by a late report — it is kept as evidence; when that attempt is gone too, the call settles from it (not run again, not given up)', async () => {
    const storage = await make();
    const journal = storage.runs as unknown as Journal;
    const runId = `r-out-${unique()}`;
    const d = processD();
    await claimRunOwner(journal as any, runId, user('alice'));
    const key = runKeys.tool(runId, 'call-1');
    const at = journal.now ? await journal.now() : Date.now();
    // Attempt 2 is held by a live process (this one); attempt 1 (A) finishes late.
    const live = stampFormat({ status: 'running', startedAt: at, attempts: 2, claimTtlMs: TTL, idempotencyKey: `${runId}:call-1`, proc: d.id });
    await journal.put(key, live);
    expect(await lateAttempt(journal, runId, key, 'A', 1, at).succeed({ status: 'succeeded', output: 'by A', toolName: 'effect' } as any)).toBe(false);
    expect(await journal.get<any>(key), 'the live claim stands').toMatchObject({ status: 'running', proc: d.id });
    expect(await journal.get<any>(runKeys.proc(runId, 'late-call-1')), 'the late success is kept').toMatchObject({ late: [{ attempt: 1, output: 'by A' }] });
    // Attempt 2's process dies before it reports (below the ceiling: the ladder would run the call again).
    await journal.put(key, { ...(live as any), proc: 'gone' });
    const p = provider();
    const { state } = await startRun(storage, runId, effectTool(p, 'recover'), d);
    await until('completes from the kept report', async () => (await state()).last?.state === 'completed');
    expect((await state()).text).toContain('by A');
    expect(p.executions, 'not run again').toBe(0);
  });

  it('nothing can report (no recover(), no key): the ceiling\'s verdict, as before — failed', async () => {
    const storage = await make();
    const runId = `r-out-${unique()}`;
    const d = processD();
    await callAtCeiling(storage.runs as unknown as Journal, runId);
    const p = provider();
    const { state } = await startRun(storage, runId, effectTool(p, 'none'), d);
    await until('the run fails', async () => (await state()).last?.state === 'failed');
    expect((await state()).last?.error?.code).toBe('retry_limit_exceeded');
  });

  it('the parked run is erased whole: its execution record, the call, the evidence — and a late report revives nothing', async () => {
    const storage = await make();
    const runId = `r-out-${unique()}`;
    const d = processD();
    const { key, at } = await callAtCeiling(storage.runs as unknown as Journal, runId);
    const p = provider();
    const { journal, state } = await startRun(storage, runId, effectTool(p, 'recover'), d);
    await until('the run parks', async () => (await state()).last?.state === 'waiting-outcome');
    await journal.put(runKeys.proc(runId, 'late-call-1'), { late: [{ attempt: 9, output: 'x' }] });
    await eraseSubject(storage, 'alice');
    expect(await journal.get(execKey(undefined, runId)), 'execution record').toBeUndefined();
    expect(await journal.get(key), 'the call').toBeUndefined();
    expect(await journal.get(runKeys.proc(runId, 'late-call-1')), 'the evidence').toBeUndefined();
    expect(await lateAttempt(journal, runId, key, 'A', 1, at).succeed({ status: 'succeeded', output: 'by A', toolName: 'effect' } as any), 'nothing written into an erased run').toBe(false);
    await sleep(200);
    expect(await journal.get(key)).toBeUndefined();
    expect(await journal.get(execKey(undefined, runId))).toBeUndefined();
  });

  it('gnl pending lists the call in doubt (blocking), and an operator\'s "done" continues the run', async () => {
    const storage = await make();
    const runId = `r-out-${unique()}`;
    const d = processD();
    await callAtCeiling(storage.runs as unknown as Journal, runId);
    const p = provider();
    const { journal, state } = await startRun(storage, runId, effectTool(p, 'recover'), d);
    await until('the run parks', async () => (await state()).last?.state === 'waiting-outcome');
    const work = await pendingWork(journal);
    const call = work.inDoubt.find((c) => c.runId === runId);
    expect(call, 'in doubt').toBeDefined();
    expect(work.blocking).toBe(true);
    const { declareInDoubtDone } = await import('../src/pending-work.js');
    expect(await declareInDoubtDone(journal, call!, { by: 'ops', output: 'checked by hand' })).toBe(true);
    await until('completes', async () => (await state()).last?.state === 'completed');
    expect((await state()).text).toContain('checked by hand');
    expect(p.executions).toBe(0);
  });
});
