// A body that finished after its call was taken over answers its caller with the CALL'S record — never
// with a result the journal does not hold.
//
// Measured on Postgres (2026-10-18, raporlar/2026-10-18-session-cut S1b): a live process whose liveness
// session was cut kept running its body; another process took the call over and settled it. The first
// body then finished, could not write its success (the record was no longer its own — kept as a late
// report, "a DIFFERENT result"), and handed its OWN output to its caller anyway: that caller saw
// `{ok:"holder"}` while the journal, and every later reader, said `{ok:true}`. One call, two answers.
//
// The rule: when the attempt's success could not be the call's record, the caller gets what a fresh call
// would get — the record that answers the call, or, while another attempt still holds it, busy.
//
// Postgres runs when GNL_PG_URL is set.
import { describe, it, expect, vi, beforeAll, afterAll } from 'vitest';
import { durableTool } from '../src/durable-tool.js';
import { InMemoryStorage, RunBusyError, type Storage } from '../src/index.js';
import { SqliteStorage } from '../src/sqlite-storage.js';
import { PostgresStorage } from '../src/postgres-storage.js';
import { runKeys } from '../src/journal.js';
import type { DurableCtx, Journal } from '../src/journal.js';

beforeAll(() => { vi.spyOn(console, 'warn').mockImplementation(() => undefined); });
const ends: Array<() => Promise<unknown>> = [];
afterAll(async () => { for (const e of ends.reverse()) await e(); });

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
const gate = () => { let open!: () => void; const p = new Promise<void>((r) => { open = r; }); return { p, open }; };
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const settled = <T>(p: Promise<T>) => p.then((v) => v, (e) => e);

/**
 * The journal as ONE worker sees it (the harness of a-an-attempt-that-lost-its-call-writes-and-starts-nothing):
 * `cut()` pauses every call it makes until `heal()` — that worker is partitioned from the store, and with no
 * liveness of its own its claims are judged by their age.
 */
function partitioned(journal: Journal) {
  let down: ReturnType<typeof gate> | undefined;
  const j = new Proxy(journal as any, {
    get(t, p) {
      if (p === 'processLiveness') return undefined;
      const v = t[p];
      if (typeof v !== 'function') return v;
      return async (...a: unknown[]) => {
        while (down) await down.p;
        return v.apply(t, a);
      };
    },
  }) as Journal;
  return { journal: j, cut() { down = gate(); }, heal() { const d = down; down = undefined; d?.open(); } };
}

const TTL = 150;
const ctxOf = (journal: Journal, runId: string) => ({ journal, runId }) as unknown as DurableCtx;
const charge = (tool: object, ctx: DurableCtx) =>
  durableTool(tool as any, ctx, 'charge').execute!({ amount: 1 }, { toolCallId: 'c1' } as any);

describe.each(STORES)('a body that lost its call answers with the record — %s', (_name, make) => {
  it('the call was settled by the takeover: the late body\'s caller gets the settled result, not its own', async () => {
    const storage = await make();
    const runId = `r-two-answers-${unique()}`;
    let entries = 0;
    const inBodyA = gate();
    const resumeA = gate();
    const tool = {
      sideEffect: true, claimTtlMs: TTL,
      // The takeover asks downstream first: nothing landed yet, so it runs the call (as S1b's resumer did).
      recover: async () => ({ done: false as const }),
      execute: async () => {
        const me = ++entries;
        if (me === 1) { inBodyA.open(); await resumeA.p; }
        return { chargeId: `ch_${me}` };
      },
    };
    const A = partitioned(storage.runs);
    const a = settled(charge(tool, ctxOf(A.journal, runId)));
    await inBodyA.p;
    A.cut();
    await sleep(TTL * 3);
    const b = await charge(tool, ctxOf(storage.runs, runId));
    expect(b).toEqual({ chargeId: 'ch_2' });
    A.heal();
    resumeA.open();
    // Both callers hold the one answer the journal holds.
    expect(await a).toEqual({ chargeId: 'ch_2' });
    expect(await storage.runs.get(runKeys.tool(runId, 'c1'))).toMatchObject({ status: 'succeeded', output: { chargeId: 'ch_2' } });
  });

  it('sibling: the takeover still holds the call when the late body finishes — its caller is told busy, not given a result', async () => {
    const storage = await make();
    const runId = `r-two-answers-busy-${unique()}`;
    let entries = 0;
    const inBodyA = gate();
    const resumeA = gate();
    const inBodyB = gate();
    const resumeB = gate();
    const tool = {
      sideEffect: true, claimTtlMs: TTL,
      // The takeover asks downstream first: nothing landed yet, so it runs the call (as S1b's resumer did).
      recover: async () => ({ done: false as const }),
      execute: async () => {
        const me = ++entries;
        if (me === 1) { inBodyA.open(); await resumeA.p; }
        if (me === 2) { inBodyB.open(); await resumeB.p; }
        return { chargeId: `ch_${me}` };
      },
    };
    const A = partitioned(storage.runs);
    const a = settled(charge(tool, ctxOf(A.journal, runId)));
    await inBodyA.p;
    A.cut();
    await sleep(TTL * 3);
    // The takeover is held in this process (its hold is live here), so it stays live while A finishes.
    const b = settled(charge(tool, ctxOf(storage.runs, runId)));
    await inBodyB.p;
    A.heal();
    resumeA.open();
    const fromA = await a;
    expect(fromA).toBeInstanceOf(RunBusyError);
    resumeB.open();
    expect(await b).toEqual({ chargeId: 'ch_2' });
  });
});
