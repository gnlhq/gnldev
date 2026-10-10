// A call that another worker is running is busy — no gate turns it into a question, a refusal or a nudge.
//
// The gates before a call's claim (a guard's require-approval, the duplicate guard, the taint guard, the
// loop nudge) decide on the record as they read it. They ran on a 'running' record as well — a claim
// another worker holds while it is in the call's body — and the decision is written by compare-and-set
// over exactly that record, so it matched: a worker resuming the run without the approval wrote
// 'suspended' over the live claim, and a worker carrying the approval then took that question over and
// ran the call while the first was still in its body. Measured: 2 executions. (The confirm gate and the
// semantic gate already answered a fresh call only.)
//
// A fresh 'running' record now meets the claim ladder before any gate: the call is busy, like a claim
// that lost ('args' mode waits for its outcome). Postgres runs when GNL_PG_URL is set.
import { describe, it, expect, vi, beforeAll, afterAll } from 'vitest';
import { durableTool } from '../src/durable-tool.js';
import { InMemoryStorage, RunBusyError, type Storage } from '../src/index.js';
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
const statusOf = async (journal: Journal, key: string) => ((await journal.get(key)) as { status?: string } | undefined)?.status;

function heldCharge() {
  let executions = 0;
  const inBody = gate();
  const finish = gate();
  const tool = { sideEffect: true, execute: async (a: { amount: number }) => { executions++; inBody.open(); await finish.p; return { chargeId: `ch_${executions}`, amount: a.amount }; } };
  return { tool, executions: () => executions, inBody: inBody.p, finish: finish.open };
}

describe.each(STORES)('a gate and a live claim — %s', (_name, make) => {
  const gates: Array<[string, (runId: string, journal: Journal) => Promise<Partial<DurableCtx>>]> = [
    ["a guard's require-approval", async () => ({ guard: askApproval as never })],
    ['the taint guard (suspend)', async (runId, journal) => {
      await markRunTainted(journal, runId, { toolCallId: 'fetch-1', toolName: 'fetch', source: 'tool' });
      return { limits: { taintedSideEffects: 'suspend' } } as Partial<DurableCtx>;
    }],
  ];
  for (const [name, setup] of gates) {
    it(`${name}: a worker without the approval is busy, and an approved worker cannot run the call a second time`, async () => {
      const storage = await make();
      const runId = `r-live-${unique()}`;
      const toolKey = `${runId}:tool:c1`;
      const extra = await setup(runId, storage.runs);
      const { tool, executions, inBody, finish } = heldCharge();
      const call = (approvals?: Record<string, boolean>) =>
        durableTool(tool as any, { journal: storage.runs, runId, ...extra, ...(approvals ? { approvals } : {}) } as unknown as DurableCtx, 'charge')
          .execute!({ amount: 11 }, { toolCallId: 'c1' } as any);

      const aCall = call({ c1: true }); // A, approved, is in the body
      await inBody;
      const b = await call().then((v) => v, (e) => e); // B resumes without the approval
      expect(await statusOf(storage.runs, toolKey)).toBe('running');
      expect(b).toBeInstanceOf(RunBusyError);
      // C carries the approval: the record is A's live claim, not a question.
      const c = call({ c1: true }).then((v) => v, (e) => e);
      await Promise.race([c, new Promise((r) => setTimeout(r, 300))]);
      expect(executions()).toBe(1);
      finish();
      expect(await c).toBeInstanceOf(RunBusyError);
      expect(await aCall).toEqual({ chargeId: 'ch_1', amount: 11 });
      expect(executions()).toBe(1);
      expect(await statusOf(storage.runs, toolKey)).toBe('succeeded');
    });
  }
  it("'args' mode: a worker without the approval waits for the live call's outcome instead of asking", async () => {
    const storage = await make();
    const runId = `r-live-args-${unique()}`;
    const { tool, executions, inBody, finish } = heldCharge();
    Object.assign(tool, { idempotency: 'args' });
    const call = (toolCallId: string, approvals?: Record<string, boolean>) =>
      durableTool(tool as any, { journal: storage.runs, runId, guard: askApproval as never, ...(approvals ? { approvals } : {}) } as unknown as DurableCtx, 'charge')
        .execute!({ amount: 12 }, { toolCallId } as any);

    const aCall = call('c1', { c1: true });
    await inBody;
    const bCall = call('c2'); // same arguments, no approval: it waits, it does not suspend A's claim
    await new Promise((r) => setTimeout(r, 100));
    finish();
    expect(await aCall).toEqual({ chargeId: 'ch_1', amount: 12 });
    expect(await bCall).toEqual({ chargeId: 'ch_1', amount: 12 });
    expect(executions()).toBe(1);
  });
}, 60_000);
