// A call's decision — suspend for a question, deny, reflect — is written only over what it was decided on.
//
// Two workers resuming the same run reach the same tool call. Each reads the call's record first and then
// decides: the duplicate guard, a guard's require-approval, a confirm gate. The decision was written with a
// plain `put`, after the read — so whatever the other worker did to the record in between was overwritten.
// Measured with N processes driving the same runs (C+ step E1, raporlar/2026-10-07-db-yapisi/ekler/cplus-e):
//
//   * worker A runs call c1 and records it succeeded, with its duplicate marker (first: c1);
//   * worker B, which read c1's record before A finished, reads that marker, takes c1 for a repeat of
//     itself and writes 'suspended' over A's result: "already succeeded … (first: c1). A human must
//     approve executing it again." Approving it runs c1 a second time.
//   * worker B without the approval and worker A with it: B's 'suspended' lands on A's live 'running'
//     claim, and a third worker holding the approval takes that over and runs the call while A is still
//     in its body — two executions, nobody asked.
//
// The decision now replaces only the record it was made on (compare-and-set): if the record moved, the
// call answers from what is there now — a result, a question already asked — or is busy, like a claim
// that lost. Postgres runs when GNL_PG_URL is set. Not on pg-mem: its `ON CONFLICT DO NOTHING` reports a
// row it did not write (critical-wf-lock-forensics.test.ts), so a second claim of the same call "wins"
// there and the race this file is about cannot be staged.
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
  // The database GNL_PG_URL names, as it is: every test below uses its own runId, so they share it.
  STORES.push(['postgres (real)', async () => {
    const s = new PostgresStorage({ connectionString: PG_URL });
    ends.push(() => s.close());
    return s;
  }]);
}
const unique = () => `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;

const gate = () => { let open!: () => void; const p = new Promise<void>((r) => { open = r; }); return { p, open }; };

/** The journal as one worker sees it, paused once before the first `get` of a key `pauseOn` picks. */
function pausedAt(journal: Journal, pauseOn: (key: string) => boolean, until: Promise<void>): { journal: Journal; reached: Promise<void> } {
  const r = gate();
  let paused = false;
  const j = new Proxy(journal as any, {
    get(t, p) {
      const v = t[p];
      if (typeof v !== 'function') return v;
      if (p !== 'get') return v.bind(t);
      return async (key: string, ...rest: unknown[]) => {
        if (!paused && pauseOn(key)) { paused = true; r.open(); await until; }
        return v.call(t, key, ...rest);
      };
    },
  });
  return { journal: j as Journal, reached: r.p };
}

function charge() {
  let executions = 0;
  const inBody = gate();
  let hold: Promise<void> = Promise.resolve();
  const tool = {
    sideEffect: true,
    execute: async (a: { amount: number }) => { executions++; inBody.open(); await hold; return { chargeId: `ch_${executions}`, amount: a.amount }; },
  };
  return { tool, executions: () => executions, inBody: inBody.p, holdBody: (p: Promise<void>) => { hold = p; } };
}

const statusOf = async (journal: Journal, key: string) => ((await journal.get(key)) as { status?: string } | undefined)?.status;
const askApproval = () => ({ action: 'require-approval' as const, reason: 'a human decides' });

describe.each(STORES)('a decision and a concurrent execution of the same call — %s', (_name, make) => {
  it('the duplicate guard does not take a call for a repeat of itself: the result another worker recorded stands', async () => {
    const storage = await make();
    const runId = `r-dup-self-${unique()}`;
    const toolKey = `${runId}:tool:c1`;
    const { tool, executions } = charge();
    const call = (journal: Journal, approvals?: Record<string, boolean>) =>
      durableTool(tool as any, { journal, runId, ...(approvals ? { approvals } : {}) } as unknown as DurableCtx, 'charge').execute!({ amount: 20 }, { toolCallId: 'c1' } as any);

    // B has read c1's record (none yet) and stops before it reads the duplicate marker.
    const aDone = gate();
    const b = pausedAt(storage.runs, (k) => k.includes('dup-charge-'), aDone.p);
    const bCall = call(b.journal);
    await b.reached;
    // A runs c1 to the end: the record is succeeded and the marker names c1.
    expect(await call(storage.runs)).toEqual({ chargeId: 'ch_1', amount: 20 });
    aDone.open();

    // B answers with A's result; nothing was asked, nothing overwritten.
    expect(await bCall).toEqual({ chargeId: 'ch_1', amount: 20 });
    expect(await statusOf(storage.runs, toolKey)).toBe('succeeded');
    expect(executions()).toBe(1);
    // An approval for c1 (a resume carrying one) replays the result; it does not run c1 again.
    expect(await call(storage.runs, { c1: true })).toEqual({ chargeId: 'ch_1', amount: 20 });
    expect(executions()).toBe(1);
  });

  it('a worker without the approval does not suspend a call another worker finished with it', async () => {
    const storage = await make();
    const runId = `r-approved-done-${unique()}`;
    const toolKey = `${runId}:tool:c1`;
    const { tool, executions } = charge();
    const decide = gate();
    const read = gate();
    const call = (approvals: Record<string, boolean> | undefined, guard: DurableCtx['guard']) =>
      durableTool(tool as any, { journal: storage.runs, runId, guard, ...(approvals ? { approvals } : {}) } as unknown as DurableCtx, 'charge')
        .execute!({ amount: 5 }, { toolCallId: 'c1' } as any);

    // B (no approval) has read the record and is deciding when A (approved) runs the call to the end.
    const bCall = call(undefined, async () => { read.open(); await decide.p; return askApproval(); });
    await read.p;
    expect(await call({ c1: true }, askApproval as never)).toEqual({ chargeId: 'ch_1', amount: 5 });
    decide.open();

    expect(await bCall).toEqual({ chargeId: 'ch_1', amount: 5 });
    expect(await statusOf(storage.runs, toolKey)).toBe('succeeded');
    expect(await call({ c1: true }, askApproval as never)).toEqual({ chargeId: 'ch_1', amount: 5 });
    expect(executions()).toBe(1);
  });

  it('a worker without the approval does not suspend a call another worker is running: a third approved worker cannot take it over', async () => {
    const storage = await make();
    const runId = `r-approved-live-${unique()}`;
    const toolKey = `${runId}:tool:c1`;
    const { tool, executions, inBody, holdBody } = charge();
    const finish = gate();
    holdBody(finish.p);
    const decide = gate();
    const read = gate();
    const call = (approvals: Record<string, boolean> | undefined, guard: DurableCtx['guard']) =>
      durableTool(tool as any, { journal: storage.runs, runId, guard, ...(approvals ? { approvals } : {}) } as unknown as DurableCtx, 'charge')
        .execute!({ amount: 7 }, { toolCallId: 'c1' } as any);

    const bCall = call(undefined, async () => { read.open(); await decide.p; return askApproval(); });
    await read.p;
    const aCall = call({ c1: true }, askApproval as never); // A claims c1 and is in its body
    await inBody;
    decide.open();
    await expect(bCall).rejects.toBeInstanceOf(RunBusyError); // B lost to a live executor, like a claim that lost
    expect(await statusOf(storage.runs, toolKey)).toBe('running');

    // C carries the approval too. The record is A's live claim, not a question: C is busy, it does not run c1.
    await expect(call({ c1: true }, askApproval as never)).rejects.toBeInstanceOf(RunBusyError);
    finish.open();
    expect(await aCall).toEqual({ chargeId: 'ch_1', amount: 7 });
    expect(executions()).toBe(1);
    expect(await statusOf(storage.runs, toolKey)).toBe('succeeded');
  });
}, 60_000);
