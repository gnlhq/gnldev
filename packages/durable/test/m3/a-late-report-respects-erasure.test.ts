// Every late report is written through ONE fenced writer (call-outcome.ts `keepLateReport`): written,
// then the fence is read — the writer's run deleted (its own fence, its parent's: the erasure rule's
// lineage), or the call's record gone (a thread's or a request's deletion took it) — and a report
// written for an erased owner is taken back. And the deletion that takes a window's record takes its
// late reports (siblings of release audit B6).
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { InMemoryStorage, runKeys, claimRunOwner, user, purgeRun, purgeThread, type Journal } from '../../src/index.js';
import { SqliteStorage } from '../../src/sqlite-storage.js';
import { PostgresStorage } from '../../src/postgres-storage.js';
import { Attempt, compareAndSet } from '../../src/attempt.js';
import { stampFormat } from '../../src/format.js';
import { minted, withMintOf } from '../../src/run-id-grammar.js';
import type { ErasureBaseline } from '../../src/erasure-fence.js';

beforeAll(() => { vi.spyOn(console, 'warn').mockImplementation(() => {}); });
const unique = () => `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;

const ends: Array<() => Promise<unknown>> = [];
afterAll(async () => { for (const e of ends.reverse()) await e(); });
const PG_URL = process.env.GNL_PG_URL;
const STORES: Array<[string, () => Promise<any>]> = [['in-memory', async () => new InMemoryStorage()], ['sqlite', async () => new SqliteStorage(':memory:')]];
if (PG_URL) {
  STORES.push(['postgres (real)', async () => {
    const s = new PostgresStorage({ connectionString: PG_URL });
    ends.push(() => s.close());
    await s.init?.();
    return s;
  }]);
}

/** A late attempt of `runId` on the call `key`, which another attempt already settled. */
function lateAttempt(journal: Journal, runId: string, key: string, at: number, baseline?: ErasureBaseline) {
  const stamp = stampFormat({ status: 'running', startedAt: at, attempts: 1, claimTtlMs: 60_000, idempotencyKey: `${runId}:call-1`, proc: 'A' }) as any;
  const write = (rec: any, expected: unknown) => compareAndSet(journal, key, expected, stampFormat(rec));
  return new Attempt(journal, key, undefined, stamp, performance.now(), 'effect', write, { runId, ...(baseline ? { baseline } : {}) });
}

/** Runs `erase` when the late attempt reads its report's key — between its read of the call and its write. */
function eraseOnReportRead(journal: Journal & Record<string, any>, recordKey: string, erase: () => Promise<unknown>) {
  const origGet = journal.get.bind(journal);
  let erased = false;
  journal.get = async (k: string) => {
    if (k === runKeys.lateOf(recordKey) && !erased) { erased = true; await erase(); }
    return origGet(k);
  };
  return { erased: () => erased, restore: () => { journal.get = origGet; } };
}

describe.each(STORES)('late reports and erasure (%s)', (_n, make) => {
  it("a background task's late report, written as its parent is erased, is taken back (the erasure rule's lineage)", async () => {
    const storage = await make();
    const journal = storage.runs as Journal & Record<string, any>;
    const parent = `p-late-${unique()}`;
    const task = `task:${parent}:call-1`;
    await claimRunOwner(journal as any, parent, user('alice'));
    await claimRunOwner(journal as any, task, user('alice'), withMintOf({}, minted({ runId: task }))); // the engine begins a task: its mark
    const key = runKeys.tool(task, 'call-1');
    const at = journal.now ? await journal.now() : Date.now();
    await journal.put(key, stampFormat({ status: 'succeeded', output: 'by B', toolName: 'effect' }));
    // The parent's deletion fences the parent; the task's own records are still there when the report lands.
    const hook = eraseOnReportRead(journal, key, () => purgeRun(journal as any, parent));
    await lateAttempt(journal, task, key, at, { lineage: [parent] }).succeed({ status: 'succeeded', output: 'secret by A', toolName: 'effect' } as any);
    hook.restore();
    expect({ erased: hook.erased(), report: await journal.get(runKeys.lateOf(key)), record: (await journal.get<any>(key))?.status })
      .toEqual({ erased: true, report: undefined, record: 'succeeded' });
  });

  it("a thread-window call's late report, written as the thread is deleted, leaves nothing of the thread", async () => {
    const storage = await make();
    const journal = storage.runs as Journal & Record<string, any>;
    const thread = `t-late-${unique()}`;
    const key = runKeys.toolThread(thread, 'effect', 'aaaaaaaaaaaaaaaa');
    const at = journal.now ? await journal.now() : Date.now();
    await journal.put(key, stampFormat({ status: 'succeeded', output: 'by B', toolName: 'effect' }));
    const hook = eraseOnReportRead(journal, key, () => purgeThread(journal as any, thread, { allowInFlight: true }));
    await lateAttempt(journal, `r-late-${unique()}`, key, at).succeed({ status: 'succeeded', output: 'secret by A', toolName: 'effect' } as any);
    hook.restore();
    expect({ erased: hook.erased(), left: await journal.listKeys!(`xthr:${thread}:`) }).toEqual({ erased: true, left: [] });
  });

  it("a request-window call's late report goes with the request's run", async () => {
    const storage = await make();
    const journal = storage.runs as Journal & Record<string, any>;
    const request = `req-late-${unique()}`;
    await claimRunOwner(journal as any, request, user('alice'));
    const key = runKeys.toolRequest(request, 'effect', 'bbbbbbbbbbbbbbbb');
    const at = journal.now ? await journal.now() : Date.now();
    await journal.put(key, stampFormat({ status: 'succeeded', output: 'by B', toolName: 'effect' }));
    await lateAttempt(journal, request, key, at).succeed({ status: 'succeeded', output: 'secret by A', toolName: 'effect' } as any);
    expect((await journal.get<any>(runKeys.lateOf(key)))?.late?.[0]?.output).toBe('secret by A');
    await purgeRun(journal as any, request);
    expect(await journal.listKeys!(`xreq:${request}:`)).toEqual([]);
  });
});
