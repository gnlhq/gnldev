// A takeover replaces only the record it judged — never a claim another worker took since.
//
// The reclaim ladder decides on one read (an approved question, a failed attempt, a stale claim) and
// then re-reads the record to use as the compare-and-set operand. Two workers resuming the same run with
// the same approval both judged the 'suspended' record; the first took it over and entered the tool's
// body; the second re-read — now the first one's fresh 'running' claim — and its compare-and-set
// MATCHED it: it replaced a live claim and ran the tool alongside the first. Measured with N processes
// driving the same runs (C+ step E1, raporlar/2026-10-07-db-yapisi/ekler/cplus-e): a side effect
// executed twice on an approved resume, with no crash anywhere. The same holds for two workers that
// both judged a stale claim: the second replaced the first one's takeover.
//
// A fresh 'running' claim found at the re-read is a live executor: the call is busy, like a claim that
// lost. Postgres runs when GNL_PG_URL is set. Not on pg-mem: its `ON CONFLICT DO NOTHING` reports a row
// it did not write (critical-wf-lock-forensics.test.ts), so the race cannot be staged there.
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
  // The database GNL_PG_URL names, as it is: every test below uses its own runId, so they share it.
  STORES.push(['postgres (real)', async () => {
    const s = new PostgresStorage({ connectionString: PG_URL });
    ends.push(() => s.close());
    return s;
  }]);
}
const unique = () => `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
const gate = () => { let open!: () => void; const p = new Promise<void>((r) => { open = r; }); return { p, open }; };

/** One worker's view of the journal: paused once, at the `nth` `get` of `key`, until `until` resolves. */
function pausedAtRead(journal: Journal, key: string, nth: number, until: Promise<void>): { journal: Journal; reached: Promise<void> } {
  const r = gate();
  let reads = 0;
  const j = new Proxy(journal as any, {
    get(t, p) {
      const v = t[p];
      if (typeof v !== 'function') return v;
      if (p !== 'get') return v.bind(t);
      return async (k: string, ...rest: unknown[]) => {
        if (k === key && ++reads === nth) { r.open(); await until; }
        return v.call(t, k, ...rest);
      };
    },
  });
  return { journal: j as Journal, reached: r.p };
}

/** A side effect that holds its body open until `finish` — so the first executor is live when the second arrives. */
function heldCharge() {
  let executions = 0;
  const inBody = gate();
  const finish = gate();
  const tool = { sideEffect: true, execute: async (a: { amount: number }) => { executions++; inBody.open(); await finish.p; return { chargeId: `ch_${executions}`, amount: a.amount }; } };
  return { tool, executions: () => executions, inBody: inBody.p, finish: finish.open };
}

const statusOf = async (journal: Journal, key: string) => ((await journal.get(key)) as { status?: string } | undefined)?.status;

describe.each(STORES)('a takeover and a live claim — %s', (_name, make) => {
  it('two workers resume an approved question: the second does not take over the first one\'s live claim', async () => {
    const storage = await make();
    const runId = `r-approved-${unique()}`;
    const toolKey = `${runId}:tool:c1`;
    const sentinel = { __gnl_suspend: { toolCallId: 'c1', toolName: 'charge', args: { amount: 3 }, reason: 'a human decides', kind: 'guard' } };
    await storage.runs.put(toolKey, stampFormat({ status: 'suspended', output: sentinel, toolName: 'charge' }));
    const { tool, executions, inBody, finish } = heldCharge();
    const ask = () => ({ action: 'require-approval' as const, reason: 'a human decides' });
    const call = (journal: Journal) =>
      durableTool(tool as any, { journal, runId, guard: ask, approvals: { c1: true } } as unknown as DurableCtx, 'charge')
        .execute!({ amount: 3 }, { toolCallId: 'c1' } as any);

    // B has judged the 'suspended' record and stops before its re-read (the second read of the key).
    const aIn = gate();
    const b = pausedAtRead(storage.runs, toolKey, 2, aIn.p);
    const bCall = call(b.journal);
    await b.reached;
    const aCall = call(storage.runs); // A takes the question over and is in its body
    await inBody;
    aIn.open();

    // B must not be in the body next to A's. (Bounded wait: a B that did enter it would wait for `finish`.)
    const bSettled = bCall.then(() => 'returned', (e) => e);
    await Promise.race([bSettled, new Promise((r) => setTimeout(r, 300))]);
    expect(executions()).toBe(1);
    finish();
    expect(await bSettled).toBeInstanceOf(RunBusyError);
    expect(await aCall).toEqual({ chargeId: 'ch_1', amount: 3 });
    expect(await statusOf(storage.runs, toolKey)).toBe('succeeded');
    expect(await call(storage.runs)).toEqual({ chargeId: 'ch_1', amount: 3 }); // and a later resume replays it
    expect(executions()).toBe(1);
  });

  it('two workers judge the same stale claim: the second does not take over the first one\'s takeover', async () => {
    const storage = await make();
    const runId = `r-stale-${unique()}`;
    const toolKey = `${runId}:tool:c1`;
    // A crashed attempt, long expired (the clock the claim gate reads is the journal's).
    await storage.runs.put(toolKey, stampFormat({ status: 'running', startedAt: 1, attempts: 1 }));
    const { tool, executions, inBody, finish } = heldCharge();
    Object.assign(tool, { idempotent: true, sideEffect: false }); // repeating a crashed attempt is allowed: the ladder takes it over
    const call = (journal: Journal) =>
      durableTool(tool as any, { journal, runId } as unknown as DurableCtx, 'charge').execute!({ amount: 4 }, { toolCallId: 'c1' } as any);

    const aIn = gate();
    const b = pausedAtRead(storage.runs, toolKey, 2, aIn.p);
    const bCall = call(b.journal);
    await b.reached;
    const aCall = call(storage.runs);
    await inBody;
    aIn.open();

    // B must not be in the body next to A's. (Bounded wait: a B that did enter it would wait for `finish`.)
    const bSettled = bCall.then(() => 'returned', (e) => e);
    await Promise.race([bSettled, new Promise((r) => setTimeout(r, 300))]);
    expect(executions()).toBe(1);
    finish();
    expect(await bSettled).toBeInstanceOf(RunBusyError);
    expect(await aCall).toEqual({ chargeId: 'ch_1', amount: 4 });
    expect(executions()).toBe(1);
  });
}, 60_000);
