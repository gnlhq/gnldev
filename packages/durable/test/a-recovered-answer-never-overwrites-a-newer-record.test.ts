// The provider's answer about a crashed attempt is written only over the attempt it was asked about.
//
// A side effect whose claim went stale (its process stopped) asks `recover()` whether it happened. When
// the answer is "yes — here is the output", that output was recorded with a plain `put`, without this
// call holding any claim. Two workers resuming the same run both judged the stale claim; the first asked
// the provider ("not done"), took the call over and ran it to the end; the second's slower probe then
// came back "done" — the first one's charge — and its `put` replaced the first one's record. Measured:
// the run's output was `{ chargeId: 'ch_1', amount: 8, receipt: 'r-1' }`, and every replay after it got
// the probe's `{ chargeId: 'ch_1' }` instead. Landing on the first worker's live claim instead, it
// recorded a success for a call still in its body.
//
// The answer is now written by compare-and-set over the record it was asked about. When that record has
// moved, the call answers from what is there now, or is busy — like a claim that lost. Postgres runs when
// GNL_PG_URL is set.
import { describe, it, expect, vi, beforeAll, afterAll } from 'vitest';
import { durableTool } from '../src/durable-tool.js';
import { InMemoryStorage, RunBusyError, stampFormat, type Storage } from '../src/index.js';
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

/** A charge whose provider remembers it, and whose `recover()` can be held open per caller. */
function provider() {
  let executions = 0;
  let charged: { chargeId: string } | undefined;
  const inBody = gate();
  let hold: Promise<void> = Promise.resolve();
  const make = (probeHeld: Promise<void> = Promise.resolve(), probing?: () => void) => ({
    sideEffect: true,
    recover: async () => {
      probing?.();
      await probeHeld;
      return charged ? { done: true as const, output: { ...charged } } : { done: false as const };
    },
    execute: async (a: { amount: number }) => {
      executions++;
      charged = { chargeId: `ch_${executions}` };
      inBody.open();
      await hold;
      return { chargeId: `ch_${executions}`, amount: a.amount, receipt: `r-${executions}` };
    },
  });
  return { make, executions: () => executions, inBody: inBody.p, holdBody: (p: Promise<void>) => { hold = p; } };
}

const recordOf = async (journal: Journal, key: string) => (await journal.get(key)) as { status?: string; output?: unknown } | undefined;

describe.each(STORES)('a recovered answer and a newer record — %s', (_name, make) => {
  it('a slow "done" does not replace the record of the worker that ran the call', async () => {
    const storage = await make();
    const runId = `r-recover-${unique()}`;
    const key = `${runId}:tool:c1`;
    await storage.runs.put(key, stampFormat({ status: 'running', startedAt: 1, attempts: 1 })); // a crashed attempt
    const p = provider();
    const call = (tool: object) =>
      durableTool(tool as any, { journal: storage.runs, runId } as unknown as DurableCtx, 'charge').execute!({ amount: 8 }, { toolCallId: 'c1' } as any);

    // B judges the stale claim and asks the provider; its answer is slow.
    const bProbe = gate(); const bAsking = gate();
    const bCall = call(p.make(bProbe.p, bAsking.open));
    await bAsking.p;
    // A asks ("not done"), takes the call over and runs it to the end.
    const aOut = await call(p.make());
    expect(aOut).toEqual({ chargeId: 'ch_1', amount: 8, receipt: 'r-1' });
    // B's answer arrives: done — A's charge.
    bProbe.open();
    const bOut = await bCall;

    expect(p.executions()).toBe(1);
    expect((await recordOf(storage.runs, key))?.output).toEqual(aOut);
    expect(bOut).toEqual(aOut);
    expect(await call(p.make())).toEqual(aOut); // a later replay returns what the run got
  });

  it('a "done" does not record a success over a live claim', async () => {
    const storage = await make();
    const runId = `r-recover-live-${unique()}`;
    const key = `${runId}:tool:c1`;
    await storage.runs.put(key, stampFormat({ status: 'running', startedAt: 1, attempts: 1 }));
    const p = provider();
    const finish = gate();
    p.holdBody(finish.p);
    const call = (tool: object) =>
      durableTool(tool as any, { journal: storage.runs, runId } as unknown as DurableCtx, 'charge').execute!({ amount: 9 }, { toolCallId: 'c1' } as any);

    const bProbe = gate(); const bAsking = gate();
    const bCall = call(p.make(bProbe.p, bAsking.open)).then((v) => v, (e) => e);
    await bAsking.p;
    const aCall = call(p.make()); // A takes over and is in its body: the provider has the charge
    await p.inBody;
    bProbe.open();
    const bOut = await bCall;

    expect((await recordOf(storage.runs, key))?.status).toBe('running'); // A's claim, untouched
    expect(bOut).toBeInstanceOf(RunBusyError);
    finish.open();
    expect(await aCall).toEqual({ chargeId: 'ch_1', amount: 9, receipt: 'r-1' });
    expect(p.executions()).toBe(1);
  });
}, 60_000);
