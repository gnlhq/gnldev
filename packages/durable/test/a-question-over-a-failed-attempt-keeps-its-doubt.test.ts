// A question asked over a failed or crashed attempt does not make that attempt disappear.
//
// The gates before a call's claim — a guard's require-approval, the taint guard, the duplicate guard — ran
// on a STALE 'running' record (a crash) and on a 'failed' one too, and wrote their decision over it. The
// record that said "attempt N did not report back, its effect may have happened" became a plain question,
// and an approved resume took the question over as a FIRST attempt:
//   - the attempt counter started again from 1, so approved retries never reached `maxRetries`
//     (measured: 4 executions with `maxRetries: 2`);
//   - recover() was never asked, so an effect that had landed ran again (measured: 2 executions, the
//     provider would have answered "done");
//   - an advisory nudge told the model the call "was NOT executed" over an attempt that had run, and the
//     model's repeat ran it again with no human anywhere (measured: 2 executions).
// The confirm and semantic gates already answered a fresh call only ("the ladder owns this state").
//
// A question over an attempt in doubt now keeps it: the suspended record carries its counter, the
// question says the effect may have happened, and the approved resume meets the crash ladder (recover,
// maxRetries) as the attempt would have. A nudge is not given over it. Postgres runs when GNL_PG_URL is set.
import { describe, it, expect, vi, beforeAll, afterAll } from 'vitest';
import { durableTool } from '../src/durable-tool.js';
import { InMemoryStorage, RetryLimitExceededError, SideEffectRetryBlockedError, type Storage } from '../src/index.js';
import { SqliteStorage } from '../src/sqlite-storage.js';
import { PostgresStorage } from '../src/postgres-storage.js';
import { markRunTainted } from '../src/taint.js';
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
const askApproval = () => ({ action: 'require-approval' as const, reason: 'a human decides' });
const settled = <T>(p: Promise<T>) => p.then((v) => v, (e) => e);

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

const isSucceededRecord = (key: string, value: unknown) =>
  key.endsWith(':tool:c1') && (value as { status?: string })?.status === 'succeeded';

/** A charge whose provider keeps the effect: recover() answers "done" once it has landed. */
function landingCharge() {
  let executions = 0;
  let landed = false;
  const tool = {
    sideEffect: true,
    recover: async () => (landed ? { done: true as const, output: { chargeId: 'ch_1' } } : { done: false as const }),
    execute: async () => { executions++; landed = true; return { chargeId: `ch_${executions}` }; },
  };
  return { tool, executions: () => executions };
}

describe.each(STORES)('a question over an attempt in doubt — %s', (_name, make) => {
  for (const [shape, ids, limits] of [
    ["'args' mode, the model retrying with new ids", (k: number) => `c${k}`, {}],
    ["approvalScope 'attempt', the same call resumed", () => 'c1', { approvalScope: 'attempt' }],
  ] as const) {
    it(`a guard's question over a failed attempt keeps its counter: approved retries stop at maxRetries (${shape})`, async () => {
      const storage = await make();
      const runId = `r-k3-retries-${unique()}`;
      let executions = 0;
      const tool = {
        sideEffect: true, maxRetries: 2,
        ...(shape.startsWith("'args'") ? { idempotency: 'args' as const } : {}),
        execute: async () => { executions++; throw new Error('provider 502'); },
      };
      const call = (toolCallId: string, approvals?: Record<string, boolean>) =>
        settled(durableTool(tool as any, { journal: storage.runs, runId, guard: askApproval as never, limits, ...(approvals ? { approvals } : {}) } as unknown as DurableCtx, 'charge')
          .execute!({ amount: 7 }, { toolCallId } as any));

      let last: unknown;
      for (let k = 1; k <= 4; k++) {
        await call(ids(k)); // the guard asks
        last = await call(ids(k), { [ids(k)]: true }); // a human approves
      }
      expect(executions).toBe(2);
      expect(last).toBeInstanceOf(RetryLimitExceededError);
    });
  }

  it('the taint question over a crashed attempt: approving it asks recover() first — an effect that landed does not run again', async () => {
    const storage = await make();
    const runId = `r-k3-taint-${unique()}`;
    const { tool, executions } = landingCharge();
    const ctx = (journal: Journal, approvals?: Record<string, boolean>) =>
      ({ journal, runId, limits: { taintedSideEffects: 'suspend' }, ...(approvals ? { approvals } : {}) }) as unknown as DurableCtx;

    // The first process charges and dies before the call's record is written.
    const died = gate();
    void durableTool(tool as any, ctx(diesAt(storage.runs, isSucceededRecord, died.open)), 'charge').execute!({ amount: 9 }, { toolCallId: 'c1' } as any);
    await died.p;
    expect(executions()).toBe(1);
    // A fetch the same step ran in parallel had marked the run tainted.
    await markRunTainted(storage.runs, runId, { toolCallId: 'fetch-1', toolName: 'fetch', source: 'tool' });

    // Another process resumes after the claim TTL: without an approval, then with the human's.
    const resumed = later(storage.runs, 120_000);
    const first = await settled(durableTool(tool as any, ctx(resumed), 'charge').execute!({ amount: 9 }, { toolCallId: 'c1' } as any));
    // The question says what it was asked over.
    expect((first as { __gnl_suspend?: { reason?: string } })?.__gnl_suspend?.reason).toMatch(/MAY already have happened/);
    const out = (first as { __gnl_suspend?: unknown })?.__gnl_suspend
      ? await durableTool(tool as any, ctx(resumed, { c1: true }), 'charge').execute!({ amount: 9 }, { toolCallId: 'c1' } as any)
      : first;
    expect(executions()).toBe(1);
    expect(out).toEqual({ chargeId: 'ch_1' });
  });

  it("an approval given before the first attempt: the resume after its crash still asks recover() first", async () => {
    const storage = await make();
    const runId = `r-k3-guard-${unique()}`;
    const { tool, executions } = landingCharge();
    const ctx = (journal: Journal) =>
      ({ journal, runId, guard: askApproval as never, approvals: { c1: true } }) as unknown as DurableCtx;

    const died = gate();
    void durableTool(tool as any, ctx(diesAt(storage.runs, isSucceededRecord, died.open)), 'charge').execute!({ amount: 3 }, { toolCallId: 'c1' } as any);
    await died.p;
    expect(executions()).toBe(1);

    // The approval stands for the call (approvalScope 'call', the default); the provider has the charge.
    const out = await durableTool(tool as any, ctx(later(storage.runs, 120_000)), 'charge').execute!({ amount: 3 }, { toolCallId: 'c1' } as any);
    expect(executions()).toBe(1);
    expect(out).toEqual({ chargeId: 'ch_1' });
  });

  it('an advisory nudge is not given over a crashed attempt: the model is not told it did not run', async () => {
    const storage = await make();
    const runId = `r-k3-reflect-${unique()}`;
    let executions = 0;
    const tool = { sideEffect: true, execute: async () => { executions++; return { chargeId: `ch_${executions}` }; } };
    const ctx = (journal: Journal) =>
      ({ journal, runId, limits: { taintedSideEffects: 'reflect', sideEffectDuplicates: 'warn' } }) as unknown as DurableCtx;

    const died = gate();
    void durableTool(tool as any, ctx(diesAt(storage.runs, isSucceededRecord, died.open)), 'charge').execute!({ amount: 4 }, { toolCallId: 'c1' } as any);
    await died.p;
    await markRunTainted(storage.runs, runId, { toolCallId: 'fetch-1', toolName: 'fetch', source: 'tool' });

    const resumed = later(storage.runs, 120_000);
    const r = await settled(durableTool(tool as any, ctx(resumed), 'charge').execute!({ amount: 4 }, { toolCallId: 'c1' } as any));
    // The model reads the tool result. Told the call was NOT executed, it repeats it (a new toolCallId).
    if ((r as { __gnl_reflected?: boolean })?.__gnl_reflected) {
      await settled(durableTool(tool as any, ctx(resumed), 'charge').execute!({ amount: 4 }, { toolCallId: 'c2' } as any));
    }
    expect(executions).toBe(1);
    expect(r).toBeInstanceOf(SideEffectRetryBlockedError);
  });
}, 60_000);
