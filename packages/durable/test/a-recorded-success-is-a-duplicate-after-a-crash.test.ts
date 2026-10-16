// A call whose process stopped mid-flight is not "nothing happened" to a repeat of it.
//
// A side effect claims the duplicate marker (sideEffectDuplicates — "these arguments are running / ran in
// this request") 'in flight' before its body and finishes it AFTER the call's own record is written. A
// process that died anywhere in between — in the body, or between a SUCCEEDED record and the marker's
// finish — left an in-flight marker, and an in-flight marker past its claim TTL was taken over by the
// next call with the same arguments. Measured: under `sideEffectDuplicates: 'block'` and the default
// 'suspend', a repeat of a charge that had succeeded ran with no block and no question — two executions.
//
// A stale in-flight marker is now taken over only by the call that left it (its crash ladder — recover,
// an approval — decides whether it runs again). Any other call is a repeat of something that may have
// run: blocked or asked about, never run silently. Postgres runs when GNL_PG_URL is set.
import { describe, it, expect, vi, beforeAll, afterAll } from 'vitest';
import { durableTool } from '../src/durable-tool.js';
import { InMemoryStorage, type Storage } from '../src/index.js';
import { SqliteStorage } from '../src/sqlite-storage.js';
import { PostgresStorage } from '../src/postgres-storage.js';
import type { DurableCtx, Journal } from '../src/journal.js';

beforeAll(() => { vi.spyOn(console, 'warn').mockImplementation(() => {}); });
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
const gate = () => { let open!: () => void; const p = new Promise<void>((r) => { open = r; }); return { p, open }; };
const unique = () => `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;

/**
 * The journal of a process that dies at its first write `dies` picks: that write never lands and never
 * returns, and nothing after it runs — the process is gone.
 */
function diesAt(journal: Journal, dies: (key: string, value: unknown) => boolean, onDeath: () => void = () => {}): Journal {
  let dead = false;
  return new Proxy(journal as any, {
    get(t, p) {
      // Another process, with no liveness on the store (as one cut off from it is judged, its session gone):
      // its claims are judged by their age (process-liveness.ts bindOwnLiveness, liveness.ts stampIsLive).
      if (p === 'processLiveness') return undefined;
      const v = t[p];
      if (typeof v !== 'function') return v;
      return async (...args: unknown[]) => {
        if (dead) return new Promise(() => {});
        if ((p === 'put' || p === 'putIfAbsent' || p === 'putIfMatch') && dies(args[0] as string, args[p === 'putIfMatch' ? 2 : 1])) {
          dead = true;
          onDeath();
          return new Promise(() => {});
        }
        return v.apply(t, args);
      };
    },
  }) as Journal;
}

/** The same journal, read by a process whose shared clock is `ms` later. */
function later(journal: Journal, ms: number): Journal {
  return new Proxy(journal as any, {
    get(t, p) {
      // Another process, with no liveness on the store (as one cut off from it is judged, its session gone):
      // its claims are judged by their age (process-liveness.ts bindOwnLiveness, liveness.ts stampIsLive).
      if (p === 'processLiveness') return undefined;
      if (p === 'now') return async () => (t.now ? await t.now() : Date.now()) + ms;
      const v = t[p];
      return typeof v === 'function' ? v.bind(t) : v;
    },
  }) as Journal;
}

const isFinishedMarker = (key: string, value: unknown) =>
  key.includes(':proc:dup-') && typeof value === 'object' && value !== null && !(value as { inFlight?: boolean }).inFlight && !(value as { released?: boolean }).released;
const isSucceededRecord = (key: string, value: unknown) =>
  key.includes(':tool:c1') && (value as { status?: string })?.status === 'succeeded';

describe.each(STORES)('a recorded success and its duplicate marker — %s', (_name, make) => {
  for (const action of ['block', 'suspend'] as const) {
    for (const [where, dies] of [
      ['between the record and the marker', isFinishedMarker],
      ['between the marker and the record', isSucceededRecord],
    ] as const) {
      it(`'${action}': the process dies ${where}; a repeat of the call does not run again`, async () => {
        const storage = await make();
        const runId = `r-dup-${action}-${unique()}`;
        let executions = 0;
        const tool = { sideEffect: true, execute: async (a: { amount: number }) => { executions++; return { chargeId: `ch_${executions}`, amount: a.amount }; } };
        const ctx = (journal: Journal) => ({ journal, runId, limits: { sideEffectDuplicates: action } }) as unknown as DurableCtx;

        // The first process runs c1 and dies at the chosen write; its call never returns.
        const died = gate();
        void durableTool(tool as any, ctx(diesAt(storage.runs, dies, died.open)), 'charge').execute!({ amount: 5 }, { toolCallId: 'c1' } as any);
        await died.p;
        expect(executions).toBe(1);

        // Another process, after the in-flight marker's claim TTL: the model repeats the call.
        const out = await durableTool(tool as any, ctx(later(storage.runs, 120_000)), 'charge')
          .execute!({ amount: 5 }, { toolCallId: 'c2' } as any);
        expect(executions).toBe(1);
        if (action === 'block') expect((out as { __gnl_limit_exceeded?: { kind?: string } }).__gnl_limit_exceeded?.kind).toBe('duplicateSideEffect');
        else expect((out as { __gnl_suspend?: { kind?: string } }).__gnl_suspend?.kind).toBe('duplicate');
      });
    }
  }
  it('the call that left the stale marker still takes it over when its crash ladder lets it run', async () => {
    const storage = await make();
    const runId = `r-dup-own-${unique()}`;
    let executions = 0;
    let charged = false;
    const tool = {
      sideEffect: true,
      // The provider says the first attempt never reached it.
      recover: async () => (charged ? { done: true as const, output: { chargeId: 'ch_1' } } : { done: false as const }),
      execute: async (a: { amount: number }) => { executions++; if (executions > 1) charged = true; return { chargeId: `ch_${executions}`, amount: a.amount }; },
    };
    const ctx = (journal: Journal) => ({ journal, runId, limits: { sideEffectDuplicates: 'block' } }) as unknown as DurableCtx;
    // The first process dies in the body, before anything reached the provider.
    const inBody = gate();
    void durableTool({ ...tool, execute: async () => { executions++; inBody.open(); return new Promise(() => {}); } } as any, ctx(storage.runs), 'charge')
      .execute!({ amount: 6 }, { toolCallId: 'c1' } as any);
    await inBody.p;
    const out = await durableTool(tool as any, ctx(later(storage.runs, 120_000)), 'charge').execute!({ amount: 6 }, { toolCallId: 'c1' } as any);
    expect(out).toEqual({ chargeId: 'ch_2', amount: 6 });
    expect(executions).toBe(2); // one attempt that never reached the provider, one that did
    // And a repeat of it now meets a finished marker.
    const again = await durableTool(tool as any, ctx(later(storage.runs, 120_000)), 'charge').execute!({ amount: 6 }, { toolCallId: 'c2' } as any);
    expect((again as { __gnl_limit_exceeded?: { kind?: string } }).__gnl_limit_exceeded?.kind).toBe('duplicateSideEffect');
    expect(executions).toBe(2);
  });

  it('a stale marker past the dedup window ages out like a finished one', async () => {
    const storage = await make();
    const runId = `r-dup-window-${unique()}`;
    let executions = 0;
    const tool = { sideEffect: true, execute: async (a: { amount: number }) => { executions++; return { chargeId: `ch_${executions}`, amount: a.amount }; } };
    const ctx = (journal: Journal) => ({ journal, runId, limits: { sideEffectDuplicates: { action: 'block', ttlMs: 60_000 } } }) as unknown as DurableCtx;
    const died = gate();
    void durableTool(tool as any, ctx(diesAt(storage.runs, isFinishedMarker, died.open)), 'charge').execute!({ amount: 7 }, { toolCallId: 'c1' } as any);
    await died.p;
    expect(executions).toBe(1);
    // Inside the window it is a duplicate; past it, it is not.
    const inside = await durableTool(tool as any, ctx(later(storage.runs, 45_000)), 'charge').execute!({ amount: 7 }, { toolCallId: 'c2' } as any);
    expect((inside as { __gnl_limit_exceeded?: { kind?: string } }).__gnl_limit_exceeded?.kind).toBe('duplicateSideEffect');
    const past = await durableTool(tool as any, ctx(later(storage.runs, 120_000)), 'charge').execute!({ amount: 7 }, { toolCallId: 'c3' } as any);
    expect(past).toEqual({ chargeId: 'ch_2', amount: 7 });
  });
}, 60_000);
