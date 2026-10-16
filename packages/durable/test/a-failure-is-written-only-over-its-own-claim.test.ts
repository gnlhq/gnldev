// An attempt that lost its claim does not write its failure over the attempt that took it over.
//
// An attempt can outlive its claim: its process stalls (here: its storage connection fails) for longer
// than `claimTtl`, the claim is judged stale and another worker takes the call over and runs it. When the
// first attempt then failed, it wrote as if it still held the call — 'failed' over the live claim of the
// attempt that took it over, and 'released' over the duplicate marker that attempt had claimed. Measured,
// with the second attempt still in its body:
//   - a resume of the same call met 'failed', asked recover() ("not done" — nothing had landed yet) and
//     ran the call a third time alongside it;
//   - an identical call (another toolCallId) under `sideEffectDuplicates: 'block'` met a released marker
//     and ran — the concurrent duplicate the block exists to stop.
// A failure, and the marker's release, are written only over this attempt's own claim (compare-and-set).
// Postgres runs when GNL_PG_URL is set.
import { describe, it, expect, vi, beforeAll, afterAll } from 'vitest';
import { durableTool } from '../src/durable-tool.js';
import { InMemoryStorage, RunBusyError, type Storage } from '../src/index.js';
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
const unique = () => `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
const gate = () => { let open!: () => void; const p = new Promise<void>((r) => { open = r; }); return { p, open }; };
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const settled = <T>(p: Promise<T>) => p.then((v) => v, (e) => e);

/** The same journal, whose compare-and-set writes fail while `stalled()` — a process cut off from storage. */
function stalling(journal: Journal, stalled: () => boolean): Journal {
  return new Proxy(journal as any, {
    get(t, p) {
      // Another process, with no liveness on the store (as one cut off from it is judged, its session gone):
      // its claims are judged by their age (process-liveness.ts bindOwnLiveness, liveness.ts stampIsLive).
      if (p === 'processLiveness') return undefined;
      const v = t[p];
      if (typeof v !== 'function') return v;
      if (p === 'putIfMatch') return async (...args: unknown[]) => { if (stalled()) throw new Error('ECONNRESET'); return v.apply(t, args); };
      return v.bind(t);
    },
  }) as Journal;
}

const TTL = 150;

describe.each(STORES)('a failure and the claim it no longer holds — %s', (_name, make) => {
  /**
   * A takes c1 and stalls past its claim TTL; B, a resume of c1, judges the claim stale and takes the
   * call over — recover() said "not done" (B takes over A's stale duplicate marker too), or a human
   * approved the retry (B claims no marker: A's in-flight one still stands for it). Then A's storage
   * comes back and its body fails. Returns with B still in its body.
   */
  async function lostThenFailed(by: 'recover' | 'approval') {
    const storage = await make();
    const runId = `r-k3-lost-${unique()}`;
    let executions = 0;
    const inA = gate(); const failA = gate();
    const inB = gate(); const finishB = gate();
    const tool = {
      sideEffect: true, claimTtlMs: TTL,
      // Nothing has landed: A fails before its effect, B is still in its body.
      ...(by === 'recover' ? { recover: async () => ({ done: false as const }) } : {}),
      execute: async () => {
        const n = ++executions;
        if (n === 1) { inA.open(); await failA.p; throw new Error('provider 502'); }
        if (n === 2) { inB.open(); await finishB.p; return { chargeId: 'ch_b' }; }
        return { chargeId: `ch_${n}` };
      },
    };
    const ctx = (journal: Journal, approvals?: Record<string, boolean>) =>
      ({ journal, runId, limits: { sideEffectDuplicates: 'block' }, ...(approvals ? { approvals } : {}) }) as unknown as DurableCtx;
    const call = (journal: Journal, toolCallId: string, approvals?: Record<string, boolean>) =>
      settled(durableTool(tool as any, ctx(journal, approvals), 'charge').execute!({ amount: 5 }, { toolCallId } as any));

    let stalled = false;
    const a = call(stalling(storage.runs, () => stalled), 'c1');
    await inA.p;
    stalled = true;
    await sleep(TTL * 3);
    const b = call(storage.runs, 'c1', by === 'approval' ? { c1: true } : undefined);
    await inB.p;
    expect(executions).toBe(2);
    stalled = false;
    await sleep(TTL);
    failA.open();
    await a;
    const finish = async () => {
      finishB.open();
      expect(await b).toEqual({ chargeId: 'ch_b' });
      expect(((await storage.runs.get(`${runId}:tool:c1`)) as { status?: string }).status).toBe('succeeded');
    };
    return { call: (id: string) => call(storage.runs, id), executions: () => executions, finish };
  }

  for (const by of ['recover', 'approval'] as const) {
    it(`the call's record: a resume of the call is still busy while the attempt that took it over runs (taken over by ${by})`, async () => {
      const t = await lostThenFailed(by);
      const d = await t.call('c1');
      expect(t.executions()).toBe(2);
      expect(d).toBeInstanceOf(RunBusyError);
      await t.finish();
    });

    it(`the duplicate marker: an identical call is still a blocked duplicate while that attempt runs (taken over by ${by})`, async () => {
      const t = await lostThenFailed(by);
      const c = await t.call('c2');
      expect(t.executions()).toBe(2);
      expect((c as { __gnl_limit_exceeded?: { kind?: string } }).__gnl_limit_exceeded?.kind).toBe('duplicateSideEffect');
      await t.finish();
    });
  }
}, 60_000);
