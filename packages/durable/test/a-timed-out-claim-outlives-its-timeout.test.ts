// A side effect that timed out is still running — its claim says so for a full claim TTL after the timeout.
//
// A timeout stops the wait, not the attempt: the claim stays 'running' and the attempt settles the record
// when it ends, so a retry meanwhile meets 'running' and waits (a-timed-out-side-effect-settles-itself).
// But the claim was dated from the START of the attempt, and its TTL is max(30 s, timeoutMs): a tool
// declaring `timeoutMs: 60_000` timed out exactly when its claim went stale. The retry that followed the
// timeout met a crashed attempt, asked recover() — "not done", the first attempt was still in flight —
// and ran the effect a second time. Measured: 2 executions.
//
// The claim is renewed when the timeout fires (compare-and-set over this attempt's own stamp): the attempt
// is known to be alive then. Postgres runs when GNL_PG_URL is set.
import { describe, it, expect, vi, beforeAll, afterAll } from 'vitest';
import { durableTool } from '../src/durable-tool.js';
import { InMemoryStorage, RunBusyError, StepTimeoutError, type Storage } from '../src/index.js';
import { SqliteStorage } from '../src/sqlite-storage.js';
import { PostgresStorage } from '../src/postgres-storage.js';
import type { DurableCtx } from '../src/journal.js';

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

describe.each(STORES)('a timed-out side effect and its claim — %s', (_name, make) => {
  // The claim TTL equal to the timeout is what the default gives every tool with `timeoutMs` >= 30 s
  // (max(30 s, timeoutMs)); stated here so the test runs in milliseconds. `TTL_ENV=default` runs the
  // default formula itself with a 31 s timeout.
  const real = process.env.TTL_ENV === 'default';
  const TIMEOUT = real ? 31_000 : 200;
  it(`a retry right after the timeout waits; it does not run the effect again (timeout ${TIMEOUT} ms)`, async () => {
    const storage = await make();
    const runId = `r-timeout-${unique()}`;
    let executions = 0;
    let landed = false;
    const finish = gate();
    const tool = {
      sideEffect: true,
      timeoutMs: TIMEOUT,
      ...(real ? {} : { claimTtlMs: TIMEOUT }),
      recover: async () => (landed ? { done: true as const, output: { chargeId: 'ch_1' } } : { done: false as const }),
      execute: async () => { executions++; await finish.p; landed = true; return { chargeId: `ch_${executions}` }; },
    };
    const call = () => durableTool(tool as any, { journal: storage.runs, runId } as unknown as DurableCtx, 'charge').execute!({ amount: 1 }, { toolCallId: 'c1' } as any);

    // The timeout fires; the attempt is still in flight.
    expect(await call().then((v) => v, (e) => e)).toBeInstanceOf(StepTimeoutError);
    await new Promise((r) => setTimeout(r, 30)); // the retry, a moment later
    const retry = await call().then((v) => v, (e) => e);
    expect(executions).toBe(1);
    expect(retry).toBeInstanceOf(RunBusyError);
    finish.open();
    // The late attempt settles its record.
    await vi.waitFor(async () => expect(((await storage.runs.get(`${runId}:tool:c1`)) as { status?: string })?.status).toBe('succeeded'));
    expect(await call()).toEqual({ chargeId: 'ch_1' });
    expect(executions).toBe(1);
  }, real ? 120_000 : 60_000);
});
