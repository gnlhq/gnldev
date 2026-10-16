// An approval answers the question it was asked — not "run beside the same work, live, elsewhere".
//
// A human who says yes to "'pay' requires explicit confirmation before it runs" was asked whether to
// pay. They were not asked whether to pay a second time while the same payment (same person, same
// business identity) is being executed from another channel right now. The cross-channel id and the
// duplicate marker are claimed in flight before the effect, but an approved call skipped both: the
// approval was read as the answer to every question (release audit E5, measured under 'block': the
// confirmed call ran beside the live one — 2 executions).
//
// Now only an approval of the DUPLICATE question itself lets a call past a live in-flight duplicate.
// Any other approval meets the duplicate policy: 'block' refuses, 'suspend' asks the duplicate question.
// Completed work is unchanged: an approval of a question that told the human about it still runs.
//
// Postgres runs when GNL_PG_URL is set.
import { describe, it, expect, vi, beforeAll, afterAll } from 'vitest';
import { durableTool } from '../src/durable-tool.js';
import { InMemoryStorage, type Storage } from '../src/index.js';
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
const settled = <T>(p: Promise<T>) => p.then((v) => v, (e) => e);

function setup(storage: Storage, action: 'block' | 'suspend') {
  const res = `u-${unique()}`;
  const counter = { executions: 0 };
  const inBodyA = gate();
  const finishA = gate();
  const tool = {
    sideEffect: true, confirm: true,
    semanticIdentity: { keys: ['orderId'], amountFields: ['amount'] },
    execute: async () => { const me = ++counter.executions; if (me === 1) { inBodyA.open(); await finishA.p; } return { paid: me }; },
  };
  const ctxOf = (runId: string, channel: string, approvals?: Record<string, boolean>) =>
    ({ journal: storage.runs, runId, threadId: `t-${runId}`, channel, limits: { sideEffectDuplicates: { action } }, approvals, identity: { kind: 'user', id: res, runId } }) as unknown as DurableCtx;
  const pay = (ctx: DurableCtx, toolCallId: string, args: object = { orderId: 'O-1', amount: 5 }) =>
    durableTool(tool as any, ctx, 'pay').execute!(args, { toolCallId } as any) as Promise<any>;
  return { counter, inBodyA, finishA, ctxOf, pay };
}

describe.each(STORES)('an approval answers only the question it was asked — %s', (_name, make) => {
  it("E5 'block': a confirmed call does not run while the same work is live in another channel", async () => {
    const s = setup(await make(), 'block');
    const runB = `rB-${unique()}`;
    expect((await s.pay(s.ctxOf(runB, 'chat'), 'b1')).__gnl_suspend?.kind).toBe('confirm');
    const a = settled(s.pay(s.ctxOf(`rA-${unique()}`, 'api', { a1: true }), 'a1'));
    await s.inBodyA.p;
    const b = await s.pay(s.ctxOf(runB, 'chat', { b1: true }), 'b1');
    expect(b.__gnl_limit_exceeded?.kind).toBe('duplicateSideEffect');
    s.finishA.open();
    expect(await a).toEqual({ paid: 1 });
    expect(s.counter.executions).toBe(1);
  });

  it("E5 sibling 'suspend': the confirmed call is asked the duplicate question; approving THAT runs it", async () => {
    const s = setup(await make(), 'suspend');
    const runB = `rB-${unique()}`;
    expect((await s.pay(s.ctxOf(runB, 'chat'), 'b1')).__gnl_suspend?.kind).toBe('confirm');
    const a = settled(s.pay(s.ctxOf(`rA-${unique()}`, 'api', { a1: true }), 'a1'));
    await s.inBodyA.p;
    const q = await s.pay(s.ctxOf(runB, 'chat', { b1: true }), 'b1');
    expect(q.__gnl_suspend?.kind).toBe('duplicate');
    expect(q.__gnl_suspend?.reason).toMatch(/has not finished/);
    expect(s.counter.executions).toBe(1);
    s.finishA.open();
    expect(await a).toEqual({ paid: 1 });
    // The human now answers the question that was actually about the repeat.
    expect(await s.pay(s.ctxOf(runB, 'chat', { b1: true }), 'b1')).toEqual({ paid: 2 });
    expect(s.counter.executions).toBe(2);
  });

  it('E5 sibling (completed work): an approval of a question that named the completed work still runs it', async () => {
    const s = setup(await make(), 'block');
    s.finishA.open();
    expect(await s.pay(s.ctxOf(`rA-${unique()}`, 'api', { a1: true }), 'a1')).toEqual({ paid: 1 });
    const runB = `rB-${unique()}`;
    const q = await s.pay(s.ctxOf(runB, 'chat'), 'b1');
    expect(q.__gnl_suspend?.kind).toBe('confirm');
    expect(q.__gnl_suspend?.reason).toMatch(/ALREADY COMPLETED/);
    expect(await s.pay(s.ctxOf(runB, 'chat', { b1: true }), 'b1')).toEqual({ paid: 2 });
  });

  it('E5 sibling (same run, run marker): an approved twin of a call live in its body is not run beside it', async () => {
    const s = setup(await make(), 'block');
    const runId = `rS-${unique()}`;
    // Different identity so the cross-channel id does not decide: only the run's duplicate marker does.
    const a = settled(s.pay(s.ctxOf(runId, 'chat', { a1: true }), 'a1', { orderId: 'O-2', amount: 5 }));
    await s.inBodyA.p;
    const twin = await s.pay(s.ctxOf(runId, 'chat', { a2: true }), 'a2', { orderId: 'O-2', amount: 5 });
    expect(twin.__gnl_limit_exceeded?.kind).toBe('duplicateSideEffect');
    s.finishA.open();
    expect(await a).toEqual({ paid: 1 });
    expect(s.counter.executions).toBe(1);
  });
}, 60_000);
