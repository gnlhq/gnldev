// A repeat on another channel is a repeat of work that MAY have run, from the moment the work starts.
//
// The cross-channel id (XID: "this person's work with this business identity was done, here is where")
// was written AFTER the call's `succeeded` record, best-effort. Where that id is a DECISION — a
// duplicate policy that refuses ('block', 'skip', 'reflect') or asks ('suspend') — a process that died
// between the record and the id, or in the body, left nothing for the other channel to find. Measured
// on the headless preset with a transactional tool: the same payment from a second channel ran again
// (paid = 2; without the death it is refused, paid = 1), and resuming the first run did not write the
// id back, so the gap was permanent.
//
// The id is now claimed IN FLIGHT before the effect (compare-and-set), like the duplicate marker: an
// in-flight id met by another call is "may have run" (blocked or asked about), never "nothing"; a stale
// one is taken over only by the call that left it; success completes it; a failure before the body
// gives it back. Under 'warn' the id stays what it was — written after success, best-effort.
// Postgres runs when GNL_PG_URL is set.
import { describe, it, expect, vi, beforeAll, beforeEach, afterAll } from 'vitest';
import { durableTool } from '../src/durable-tool.js';
import { InMemoryStorage, type Storage, purgeResource, withOrg, xidKey } from '../src/index.js';
import { SqliteStorage } from '../src/sqlite-storage.js';
import { PostgresStorage } from '../src/postgres-storage.js';
import { createGnl } from '../src/registry.js';
import { inMemoryLiveness } from '../src/process-liveness.js';
import type { DurableCtx, Journal } from '../src/journal.js';
import { createMockModel, countToolResults, toolCallResult, finalTextResult } from './mock.js';

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
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const settled = <T>(p: Promise<T>) => p.then((v) => v, (e) => e);

/** The journal of a process that dies at its first write `dies` picks: that write never lands or returns. */
function diesAt(journal: Journal, dies: (key: string, value: unknown) => boolean, onDeath: () => void = () => {}): Journal {
  let dead = false;
  return new Proxy(journal as any, {
    get(t, p) {
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
      if (p === 'now') return async () => (t.now ? await t.now() : Date.now()) + ms;
      const v = t[p];
      return typeof v === 'function' ? v.bind(t) : v;
    },
  }) as Journal;
}

/** The write that records the work as DONE under its cross-channel id (not an in-flight or released one). */
const isCompletedXid = (key: string, value: unknown) =>
  key.startsWith('xid:') && typeof value === 'object' && value !== null &&
  !(value as { inFlight?: boolean }).inFlight && !(value as { released?: boolean }).released;

type Action = 'block' | 'suspend' | 'skip' | 'reflect' | 'warn';
// One person per test: the Postgres store is shared by every test in the file.
let USER = '';
let ID_KEY = '';
beforeEach(() => { USER = `u-${unique()}`; ID_KEY = xidKey(USER, 'pay', { ref: 'f-9' }); });

function payTool(counter: { paid: number }, body?: () => Promise<unknown>, extra: Record<string, unknown> = {}) {
  return {
    sideEffect: true, semanticIdentity: { keys: ['ref'], amountFields: ['amount'] },
    recover: async () => ({ done: false as const }),
    execute: async () => { counter.paid++; if (body) return body(); return { ok: counter.paid }; },
    ...extra,
  };
}
const ctxOf = (journal: Journal, runId: string, channel: string, action: Action, more: Record<string, unknown> = {}) =>
  ({ journal, runId, channel, identity: { kind: 'user', id: USER, runId }, limits: { sideEffectDuplicates: action }, ...more }) as unknown as DurableCtx;
const pay = (tool: object, ctx: DurableCtx, toolCallId: string) =>
  durableTool(tool as any, ctx, 'pay').execute!({ ref: 'F-9', amount: 50 }, { toolCallId } as any);

/** What a refusal or a question looks like: the call did not run. */
function expectNotRun(out: unknown, action: Action): void {
  const o = out as { __gnl_limit_exceeded?: { kind?: string }; __gnl_suspend?: { kind?: string } };
  if (action === 'suspend') expect(o.__gnl_suspend?.kind).toBe('duplicate');
  else expect(o.__gnl_limit_exceeded?.kind).toBe('duplicateSideEffect');
}

describe.each(STORES)('a cross-channel id is claimed before the effect — %s', (_name, make) => {
  for (const action of ['block', 'suspend', 'skip', 'reflect'] as const) {
    it(`'${action}': the process dies between the record and the id; the same work from another channel does not run again`, async () => {
      const storage = await make();
      const counter = { paid: 0 };
      const died = gate();
      void pay(payTool(counter), ctxOf(diesAt(storage.runs, isCompletedXid, died.open), `ch-${unique()}`, 'chat', action), 'a1');
      await died.p;
      expect(counter.paid).toBe(1);
      for (const ms of [0, 120_000]) {
        const out = await settled(pay(payTool(counter), ctxOf(later(storage.runs, ms), `bt-${unique()}`, 'batch', action), `b-${ms}`));
        expect(counter.paid).toBe(1);
        expectNotRun(out, action);
      }
    });

    it(`'${action}': the process dies in the body; the same work from another channel, live or after the claim TTL, does not run`, async () => {
      const storage = await make();
      const counter = { paid: 0 };
      const inBody = gate();
      void pay(payTool(counter, async () => { inBody.open(); return new Promise(() => {}); }), ctxOf(storage.runs, `ch-${unique()}`, 'chat', action), 'a1');
      await inBody.p;
      for (const ms of [0, 120_000]) {
        const out = await settled(pay(payTool(counter), ctxOf(later(storage.runs, ms), `bt-${unique()}`, 'batch', action), `b-${ms}`));
        expect(counter.paid).toBe(1);
        expectNotRun(out, action);
      }
    });
  }

  it('resuming the run that died between the record and the id completes the id', async () => {
    const storage = await make();
    const counter = { paid: 0 };
    const runId = `ch-${unique()}`;
    const died = gate();
    void pay(payTool(counter), ctxOf(diesAt(storage.runs, isCompletedXid, died.open), runId, 'chat', 'block'), 'a1');
    await died.p;
    // The resume replays the call from its record — no second effect — and finishes what the death left.
    expect(await pay(payTool(counter), ctxOf(later(storage.runs, 120_000), runId, 'chat', 'block'), 'a1')).toEqual({ ok: 1 });
    expect(counter.paid).toBe(1);
    const rec = await storage.runs.get<{ inFlight?: boolean; first?: { runId?: string; toolCallId?: string } }>(ID_KEY);
    expect(rec?.inFlight).toBeUndefined();
    expect(rec?.first).toMatchObject({ runId, toolCallId: 'a1' });
  });

  it('a stale in-flight id is taken over by the call that left it, and that call completes it', async () => {
    const storage = await make();
    const counter = { paid: 0 };
    const runId = `ch-${unique()}`;
    const inBody = gate();
    void pay(payTool(counter, async () => { inBody.open(); return new Promise(() => {}); }), ctxOf(storage.runs, runId, 'chat', 'block'), 'a1');
    await inBody.p;
    // Its crash ladder says the effect did not land (recover: not done) and runs it again.
    expect(await pay(payTool(counter), ctxOf(later(storage.runs, 120_000), runId, 'chat', 'block'), 'a1')).toEqual({ ok: 2 });
    expect(counter.paid).toBe(2);
    const rec = await storage.runs.get<{ inFlight?: boolean; first?: { runId?: string; toolCallId?: string } }>(ID_KEY);
    expect(rec?.inFlight).toBeUndefined();
    expect(rec?.first).toMatchObject({ runId, toolCallId: 'a1' });
    // And the other channel now meets the completed id.
    expectNotRun(await pay(payTool(counter), ctxOf(later(storage.runs, 120_000), `bt-${unique()}`, 'batch', 'block'), 'b1'), 'block');
    expect(counter.paid).toBe(2);
  });

  it('a failure before the body starts gives the id back; the other channel then runs the work once', async () => {
    const storage = await make();
    const counter = { paid: 0 };
    const runId = `ch-${unique()}`;
    // An approved call whose approval cannot be spent: it fails after its claims and before its body.
    const failing = new Proxy(storage.runs as any, {
      get(t, p) {
        const v = t[p];
        if (p === 'put') return async (k: string, val: unknown) => { if (k.includes(':approval:')) throw new Error('storage down'); return v.call(t, k, val); };
        return typeof v === 'function' ? v.bind(t) : v;
      },
    }) as Journal;
    const ctx = ctxOf(failing, runId, 'chat', 'block', { approvals: { a1: true }, limits: { sideEffectDuplicates: 'block', approvalScope: 'attempt' } });
    await expect(pay(payTool(counter), ctx, 'a1')).rejects.toThrow('storage down');
    expect(counter.paid).toBe(0);
    expect(await pay(payTool(counter), ctxOf(storage.runs, `bt-${unique()}`, 'batch', 'block'), 'b1')).toEqual({ ok: 1 });
    expect(counter.paid).toBe(1);
  });

  it('a failure in the body gives the id back, as it gives the duplicate marker back', async () => {
    const storage = await make();
    const counter = { paid: 0 };
    await expect(pay(payTool(counter, async () => { throw new Error('declined'); }), ctxOf(storage.runs, `ch-${unique()}`, 'chat', 'block'), 'a1')).rejects.toThrow('declined');
    expect(await pay(payTool(counter), ctxOf(storage.runs, `bt-${unique()}`, 'batch', 'block'), 'b1')).toEqual({ ok: 2 });
  });

  it('a live attempt keeps its in-flight id past the claim TTL and the dedup window', async () => {
    const storage = await make();
    const counter = { paid: 0 };
    const TTL = 150;
    const inBody = gate();
    const finish = gate();
    const limits = { sideEffectDuplicates: { action: 'block', ttlMs: 100 } };
    const a = settled(pay(payTool(counter, async () => { inBody.open(); await finish.p; return { ok: 1 }; }, { claimTtlMs: TTL }), ctxOf(storage.runs, `ch-${unique()}`, 'chat', 'block', { limits }), 'a1'));
    await inBody.p;
    await sleep(TTL * 3);
    const b = settled(pay(payTool(counter, undefined, { claimTtlMs: TTL }), ctxOf(storage.runs, `bt-${unique()}`, 'batch', 'block', { limits }), 'b1'));
    await Promise.race([b, sleep(200)]);
    expect(counter.paid).toBe(1);
    finish.open();
    expectNotRun(await b, 'block');
    expect(await a).toEqual({ ok: 1 });
    expect(counter.paid).toBe(1);
  });

  it("'warn' keeps the id best-effort: nothing is claimed before the effect", async () => {
    const storage = await make();
    const counter = { paid: 0 };
    const inBody = gate();
    const finish = gate();
    const a = settled(pay(payTool(counter, async () => { inBody.open(); await finish.p; return { ok: 1 }; }), ctxOf(storage.runs, `ch-${unique()}`, 'chat', 'warn'), 'a1'));
    await inBody.p;
    expect(await storage.runs.get(ID_KEY)).toBeUndefined();
    finish.open();
    await a;
    expect(await storage.runs.get(ID_KEY)).toMatchObject({ first: { toolCallId: 'a1' } });
  });

  it('an in-flight id is erased with the person, and the attempt finishing afterwards does not write it back', async () => {
    const storage = await make();
    const counter = { paid: 0 };
    const inBody = gate();
    const finish = gate();
    const a = settled(pay(payTool(counter, async () => { inBody.open(); await finish.p; return { ok: 1 }; }), ctxOf(storage.runs, `ch-${unique()}`, 'chat', 'block'), 'a1'));
    await inBody.p;
    expect(await storage.runs.get(ID_KEY)).toMatchObject({ inFlight: true });
    await purgeResource(storage.runs, USER);
    expect(await storage.runs.get(ID_KEY)).toBeUndefined();
    finish.open();
    await a;
    expect(await storage.runs.get(ID_KEY)).toBeUndefined();
  });

  it("one organization's in-flight id does not reach another organization's same person", async () => {
    const storage = await make();
    const counter = { paid: 0 };
    const inBody = gate();
    void pay(payTool(counter, async () => { inBody.open(); return new Promise(() => {}); }), ctxOf(withOrg(storage.runs, `oa${unique()}`), `ch-${unique()}`, 'chat', 'block'), 'a1');
    await inBody.p;
    expect(await pay(payTool(counter), ctxOf(withOrg(storage.runs, `ob${unique()}`), `bt-${unique()}`, 'batch', 'block'), 'b1')).toEqual({ ok: 2 });
  });

  it('headless preset, transactional tool: a death before the id leaves a repeat from another channel refused', async () => {
    const storage = await make();
    let paid = 0;
    const tool = {
      description: 'pay', sideEffect: true, effectClass: 'transactional', recover: async () => ({ done: false as const }),
      semanticIdentity: { keys: ['ref'], amountFields: ['amount'] }, execute: async () => { paid++; return { ok: true }; },
    };
    const model = (id: string) => createMockModel(async ({ prompt }: any) =>
      countToolResults(prompt) === 0 ? toolCallResult('pay', id, { ref: 'F-9', amount: 50 }) : finalTextResult('ok'));
    const ch1 = `ch1-${unique()}`;
    const died = gate();
    const dying = diesAt(storage.runs, isCompletedXid, died.open);
    // A death simulated INSIDE this process: a store's process liveness would (rightly) call it alive, so
    // both registries run with this process's own in-memory identity, as a single process does.
    void createGnl({ journal: dying as any, liveness: inMemoryLiveness(), preset: 'headless', agents: { p: { model: model('a1'), tools: { pay: tool } } } })
      .run('p', { runId: ch1, prompt: 'pay', threadId: `thread-A-${ch1}`, resourceId: USER, channel: 'chat' });
    await died.p;
    expect(paid).toBe(1);
    const second = await createGnl({ journal: storage.runs as any, liveness: inMemoryLiveness(), preset: 'headless', agents: { p: { model: model('b1'), tools: { pay: tool } } } })
      .run('p', { runId: `bt1-${unique()}`, prompt: 'pay', threadId: `thread-B-${ch1}`, resourceId: USER, channel: 'batch' })
      .then(() => 'finished', (e) => `refused: ${String(e?.message)}`);
    expect(paid).toBe(1);
    expect(second).toMatch(/^refused/);
  });
}, 60_000);
