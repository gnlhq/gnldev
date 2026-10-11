// An attempt that is still running keeps its claim, however long it runs.
//
// The claim was dated once, when the attempt took it (and once more when a timeout fired), and read as a
// crash `claimTtl` later. A tool without a timeout that legitimately ran longer than that — or one that
// kept running after its timeout — was "crashed" to every other worker while it was in its body: a resume
// asked recover() (the effect had not landed yet — "not done") and ran the call alongside it, and a
// same-arguments call in 'args' mode stopped waiting and ran it too. Measured: 2 executions.
//
// The attempt renews its own claim (compare-and-set over its own stamp) while it is alive, until its
// outcome is written. Postgres runs when GNL_PG_URL is set.
import { describe, it, expect, vi, beforeAll, afterAll } from 'vitest';
import { durableTool } from '../src/durable-tool.js';
import { InMemoryStorage, RunBusyError, StepTimeoutError, type Storage } from '../src/index.js';
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
const statusOf = async (journal: Journal, key: string) => ((await journal.get(key)) as { status?: string } | undefined)?.status;

const TTL = 150;

/** A charge that runs until `finish` and lands then; recover() answers what the provider has. */
function longCharge(extra: Record<string, unknown> = {}) {
  let executions = 0;
  let landed = false;
  const inBody = gate();
  const finish = gate();
  const tool = {
    sideEffect: true, claimTtlMs: TTL, ...extra,
    recover: async () => (landed ? { done: true as const, output: { chargeId: 'ch_1' } } : { done: false as const }),
    execute: async () => { executions++; inBody.open(); await finish.p; landed = true; return { chargeId: `ch_${executions}` }; },
  };
  return { tool, executions: () => executions, inBody: inBody.p, finish: finish.open };
}

describe.each(STORES)('a live attempt and its claim — %s', (_name, make) => {
  it('a tool without a timeout, running past the claim TTL: a resume is busy, it does not run the call again', async () => {
    const storage = await make();
    const runId = `r-k3-live-${unique()}`;
    const { tool, executions, inBody, finish } = longCharge();
    const call = () => durableTool(tool as any, { journal: storage.runs, runId } as unknown as DurableCtx, 'charge').execute!({ amount: 1 }, { toolCallId: 'c1' } as any);

    const a = call();
    await inBody;
    await sleep(TTL * 3); // A is alive, in its body, three claim TTLs later
    const b = settled(call());
    await Promise.race([b, sleep(200)]);
    expect(executions()).toBe(1);
    finish();
    expect(await b).toBeInstanceOf(RunBusyError);
    expect(await a).toEqual({ chargeId: 'ch_1' });
    expect(await call()).toEqual({ chargeId: 'ch_1' });
    expect(executions()).toBe(1);
  });

  it('a side effect still running long after its timeout: a resume is busy, it does not run the call again', async () => {
    const storage = await make();
    const runId = `r-k3-late-${unique()}`;
    const { tool, executions, finish } = longCharge({ timeoutMs: TTL });
    const call = () => durableTool(tool as any, { journal: storage.runs, runId } as unknown as DurableCtx, 'charge').execute!({ amount: 2 }, { toolCallId: 'c1' } as any);

    expect(await settled(call())).toBeInstanceOf(StepTimeoutError);
    await sleep(TTL * 3); // the attempt is still in flight
    const b = await settled(call());
    expect(executions()).toBe(1);
    expect(b).toBeInstanceOf(RunBusyError);
    finish();
    await vi.waitFor(async () => expect(await statusOf(storage.runs, `${runId}:tool:c1`)).toBe('succeeded'));
    expect(await call()).toEqual({ chargeId: 'ch_1' });
    expect(executions()).toBe(1);
  });

  it("'args' mode: a call with the same arguments waits for the live attempt's outcome past the claim TTL", async () => {
    const storage = await make();
    const runId = `r-k3-args-${unique()}`;
    const { tool, executions, inBody, finish } = longCharge({ idempotency: 'args' });
    const call = (toolCallId: string) => durableTool(tool as any, { journal: storage.runs, runId } as unknown as DurableCtx, 'charge').execute!({ amount: 3 }, { toolCallId } as any);

    const a = call('c1');
    await inBody;
    const b = settled(call('c2'));
    await sleep(TTL * 3);
    expect(executions()).toBe(1);
    finish();
    expect(await a).toEqual({ chargeId: 'ch_1' });
    expect(await b).toEqual({ chargeId: 'ch_1' });
    expect(executions()).toBe(1);
  });
}, 60_000);
