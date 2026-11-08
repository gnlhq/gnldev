// CONFIRM AND APPROVE — engine level (d25 approval policy, step 2; KARAR-1 "KULLANICI KARARI — ADIM 2 / POLİTİKA").
//
// Two different questions, two different people:
//   CONFIRM (consent) — "are you sure?". The person who asked for the work answers it; an authorised
//                       person (staff, the application server) may answer it too.
//   APPROVE (permission) — "may this happen?". Only an authorised person answers yes. The requester's
//                       yes is refused: a typed error with a string `code`, nothing journaled, no effect.
//                       Anybody's NO goes through (no effect, recorded as denied).
// An approve question exists only because the developer added one; with no rule at all nobody is asked.
//
// Where the rules live:
//   the AGENT's guard — allow | deny | confirm (new) | approve (new name; 'require-approval' = approve);
//   the TOOL itself    — `confirm` and `approve`, each `true`, `{ reason }` or `(args) => false | string | true`.
// Order: the agent's guard first, then the tool's own rule. A guard deny ends it (the tool's rule is never asked).
//
// Engine identities used here (the engine's own `Caller`): `user('u-ayse')` is the requester (an end user
// whose run it is), `STAFF` is the authorised side. A door maps its tokens onto these (see the server tests).
//
// New API (guard 'confirm'/'approve', tool `approve`, function `confirm`) is passed through `as never` / `as any`
// so this file compiles against today's types: a red here is "the behaviour does not exist", not a type error.
import { describe, it, expect, beforeAll, vi } from 'vitest';
import { z } from 'zod';
import * as durable from '../src/index.js';
import { InMemoryStorage, createGnl, runDurable, STAFF, user, InMemoryJournal, providerIdOf, mintCallId, type Storage } from '../src/index.js';
import { createMockModel, toolCallResult, finalTextResult, countToolResults } from './mock.js';

beforeAll(() => { vi.spyOn(console, 'warn').mockImplementation(() => {}); });

const AYSE = user('u-ayse');

type Call = { name: string; id: string; input: object };
const script = (calls: Call[]) => createMockModel(async ({ prompt }: any) => {
  const next = calls[countToolResults(prompt)];
  return next ? toolCallResult(next.name, next.id, next.input) : finalTextResult('done');
});
const oneRefund = (amount = 12500) => script([{ name: 'refund', id: 'call_0', input: { amount } }]);

/** A refund tool; `extra` adds the tool's own rule (`confirm`, `approve`, …). `effects` counts real refunds. */
const refundTool = (effects: { n: number }, extra: Record<string, unknown> = {}) => ({
  description: 'refund an order', inputSchema: z.object({ amount: z.number() }).passthrough(),
  execute: async () => { effects.n++; return { refunded: true }; }, ...extra,
});

// Call ids are GNL ids (`call_0.gnl-<run>-<step>-<n>`): `ids` reads a result's interrupts as the provider's ids
// (what the model issued); `gid` is the GNL id of the `index`-th call of model step `step` of a run.
const ids = (r: any): string[] => (r?.interrupts ?? []).map((i: any) => providerIdOf(i.toolCallId));
const gid = (runId: string, callId = 'call_0', step = 0, index = 0) => mintCallId(callId, runId, step, index);

async function answersFor(storage: Storage, toolCallId: string): Promise<any[]> {
  const keys = (await storage.runs.listKeys('')).filter((k) => k.includes(':approval:') && providerIdOf(k.slice(k.lastIndexOf(':approval:') + ':approval:'.length)) === toolCallId);
  return Promise.all(keys.map((k) => storage.runs.get(k)));
}

const settle = <T>(p: Promise<T>) => p.then((r) => ({ ok: true as const, r }), (e: any) => ({ ok: false as const, e }));

/** The refusal of a requester's yes on an approve question: typed, coded, and exported by the engine. */
function expectTypedRefusal(out: { ok: boolean; e?: any; r?: any }, what: string) {
  expect(out.ok, `${what}: the requester's yes on an approve question was accepted (no refusal)`).toBe(false);
  const e = out.e;
  expect(e).toBeInstanceOf(Error);
  expect(typeof e.code === 'string' && e.code.length > 0, `${what}: the refusal has no string code (${e?.name}: ${e?.message})`).toBe(true);
  expect(e.name, 'a plain Error is not a typed refusal').not.toBe('Error');
  const cls = Object.values(durable).find((v) => typeof v === 'function' && (v as { name?: string }).name === e.name) as (new (...a: any[]) => unknown) | undefined;
  expect(cls, `${what}: the refusal's class '${e.name}' is not exported by @gnldev/durable`).toBeDefined();
  expect(e instanceof cls!).toBe(true);
  return { name: e.name as string, code: e.code as string };
}

/** The reference refusal (a guard 'approve'), against which every other path must use the same name and code. */
async function referenceRefusal(): Promise<{ name: string; code: string }> {
  const effects = { n: 0 };
  const gnl = createGnl({ storage: new InMemoryStorage(), agents: { a: { model: oneRefund(), tools: { refund: refundTool(effects) }, guard: () => ({ action: 'approve' }) } } } as never);
  await gnl.run('a', { runId: 'ref', prompt: 'go', caller: AYSE } as never);
  return expectTypedRefusal(await settle(gnl.run('a', { runId: 'ref', prompt: 'go', caller: AYSE, approvals: { [gid('ref')]: true } } as never)), 'reference');
}

interface Rule { name: string; agent: (effects: { n: number }) => Record<string, unknown> }
/** Every way an APPROVE question can be declared. */
const APPROVE_RULES: Rule[] = [
  { name: "guard 'approve'", agent: (e) => ({ model: oneRefund(), tools: { refund: refundTool(e) }, guard: () => ({ action: 'approve', reason: 'a representative decides' }) }) },
  { name: "guard 'require-approval' (the old name = approve)", agent: (e) => ({ model: oneRefund(), tools: { refund: refundTool(e) }, guard: () => ({ action: 'require-approval', reason: 'a representative decides' }) }) },
  { name: 'tool approve: true', agent: (e) => ({ model: oneRefund(), tools: { refund: refundTool(e, { approve: true }) } }) },
  { name: 'tool approve: { reason }', agent: (e) => ({ model: oneRefund(), tools: { refund: refundTool(e, { approve: { reason: (a: any) => `refund ${a.amount}?` } }) } }) },
  { name: 'tool approve: (args) => true', agent: (e) => ({ model: oneRefund(), tools: { refund: refundTool(e, { approve: () => true }) } }) },
  { name: 'tool approve: (args) => string', agent: (e) => ({ model: oneRefund(), tools: { refund: refundTool(e, { approve: (a: any) => `refund ${a.amount} needs a representative` }) } }) },
  { name: "guard 'allow' + tool approve: true (the guard passes, the tool still asks)", agent: (e) => ({ model: oneRefund(), tools: { refund: refundTool(e, { approve: true }) }, guard: () => ({ action: 'allow' }) }) },
];
/** Every way a CONFIRM question can be declared. */
const CONFIRM_RULES: Rule[] = [
  { name: "guard 'confirm'", agent: (e) => ({ model: oneRefund(), tools: { refund: refundTool(e) }, guard: () => ({ action: 'confirm', reason: 'are you sure?' }) }) },
  { name: 'tool confirm: true (unchanged)', agent: (e) => ({ model: oneRefund(), tools: { refund: refundTool(e, { confirm: true }) } }) },
  { name: 'tool confirm: { reason } (unchanged)', agent: (e) => ({ model: oneRefund(), tools: { refund: refundTool(e, { confirm: { reason: (a: any) => `refund ${a.amount}?` } }) } }) },
  { name: 'tool confirm: (args) => true', agent: (e) => ({ model: oneRefund(), tools: { refund: refundTool(e, { confirm: () => true }) } }) },
  { name: 'tool confirm: (args) => string', agent: (e) => ({ model: oneRefund(), tools: { refund: refundTool(e, { confirm: (a: any) => `refund ${a.amount}?` }) } }) },
];

function gnlWith(rule: Rule) {
  const effects = { n: 0 };
  const storage = new InMemoryStorage();
  const gnl = createGnl({ storage, agents: { a: rule.agent(effects) } } as never);
  const asked = new Map<string, string>();
  /** The requester starts her run; the question is asked. */
  const ask = async (runId: string) => {
    const r: any = await gnl.run('a', { runId, prompt: 'refund my order', caller: AYSE } as never);
    expect(ids(r), `precondition (${rule.name}): the question is asked`).toEqual(['call_0']);
    asked.set(runId, r.interrupts[0].toolCallId); // the id the system gave the question: what a client answers
    expect(effects.n).toBe(0);
    return r;
  };
  const answer = (runId: string, caller: unknown, decision: boolean) =>
    settle(gnl.run('a', { runId, prompt: 'refund my order', caller, approvals: { [asked.get(runId)!]: decision } } as never));
  return { gnl, storage, effects, ask, answer };
}

describe('APPROVE — only an authorised person says yes (engine, gnl.run)', () => {
  let ref: { name: string; code: string };
  beforeAll(async () => { ref = await referenceRefusal().catch(() => ({ name: '<none>', code: '<none>' })); });

  for (const rule of APPROVE_RULES) {
    it(`${rule.name}: the requester's yes is refused (typed, coded), nothing journaled, no refund`, async () => {
      const s = gnlWith(rule);
      await s.ask('r1');
      const out = await s.answer('r1', AYSE, true);
      const got = expectTypedRefusal(out, rule.name);
      expect(got, 'every approve path refuses with the same error name and code').toEqual(ref);
      expect(s.effects.n, 'the refund happened on the requester\'s own yes').toBe(0);
      expect(await answersFor(s.storage, 'call_0'), 'a refused answer was written to the journal').toEqual([]);
      // …and the question is still open: staff can still answer it afterwards.
      const staff = await s.answer('r1', STAFF, true);
      expect(staff.ok, String(staff.e)).toBe(true);
      expect(s.effects.n).toBe(1);
    });

    it(`${rule.name}: the requester's no goes through — no refund, recorded as denied`, async () => {
      const s = gnlWith(rule);
      await s.ask('r2');
      const out = await s.answer('r2', AYSE, false);
      expect(out.ok, `the requester's no was refused: ${out.e}`).toBe(true);
      expect(s.effects.n).toBe(0);
      expect((out.r.interrupts ?? []).length, 'the run still waits after a no').toBe(0);
      const rows = await answersFor(s.storage, 'call_0');
      expect(rows.map((r) => r?.decision)).toEqual([false]);
    });

    it(`${rule.name}: staff's yes runs the refund exactly once`, async () => {
      const s = gnlWith(rule);
      await s.ask('r3');
      const out = await s.answer('r3', STAFF, true);
      expect(out.ok, String(out.e)).toBe(true);
      expect(s.effects.n).toBe(1);
      await s.answer('r3', STAFF, true);
      expect(s.effects.n, 'a repeated yes ran the refund twice').toBe(1);
    });
  }

  it('the reason of the question is the one the rule gave (approve: (args) => string)', async () => {
    const s = gnlWith(APPROVE_RULES.find((r) => r.name === 'tool approve: (args) => string')!);
    const r = await s.ask('r4');
    expect(String(r.interrupts[0].reason)).toContain('refund 12500 needs a representative');
  });
});

describe('CONFIRM — the requester answers; staff may answer too (engine, gnl.run)', () => {
  for (const rule of CONFIRM_RULES) {
    it(`${rule.name}: the requester's yes runs the refund once`, async () => {
      const s = gnlWith(rule);
      await s.ask('c1');
      const out = await s.answer('c1', AYSE, true);
      expect(out.ok, `the requester could not answer her own confirm question: ${out.e}`).toBe(true);
      expect(s.effects.n).toBe(1);
    });

    it(`${rule.name}: staff's yes runs the refund once`, async () => {
      const s = gnlWith(rule);
      await s.ask('c2');
      const out = await s.answer('c2', STAFF, true);
      expect(out.ok, String(out.e)).toBe(true);
      expect(s.effects.n).toBe(1);
    });

    it(`${rule.name}: the requester's no runs nothing`, async () => {
      const s = gnlWith(rule);
      await s.ask('c3');
      const out = await s.answer('c3', AYSE, false);
      expect(out.ok, String(out.e)).toBe(true);
      expect(s.effects.n).toBe(0);
    });
  }

  it('confirm: (args) => string — the question carries that text', async () => {
    const s = gnlWith(CONFIRM_RULES.find((r) => r.name === 'tool confirm: (args) => string')!);
    const r = await s.ask('c4');
    expect(String(r.interrupts[0].reason)).toContain('refund 12500?');
  });
});

describe('a conditional rule asks only when it says so', () => {
  const small = (rule: Record<string, unknown>) => {
    const effects = { n: 0 };
    const gnl = createGnl({ storage: new InMemoryStorage(), agents: { a: { model: oneRefund(50), tools: { refund: refundTool(effects, rule) } } } } as never);
    return { gnl, effects };
  };
  const threshold = (text: string) => (a: any) => (a.amount > 1000 ? text : false);

  it('confirm: (args) => false — no question, the refund runs (a 50 refund under a 1000 threshold)', async () => {
    const { gnl, effects } = small({ confirm: threshold('sure?') });
    const r: any = await gnl.run('a', { runId: 'k1', prompt: 'go', caller: AYSE } as never);
    expect(r.interrupts ?? []).toEqual([]);
    expect(effects.n, 'confirm returning false still asked (or blocked) the call').toBe(1);
  });

  it('approve: (args) => false — no question, the refund runs, even for an end user', async () => {
    const { gnl, effects } = small({ approve: threshold('a representative decides') });
    const r: any = await gnl.run('a', { runId: 'k2', prompt: 'go', caller: AYSE } as never);
    expect(r.interrupts ?? []).toEqual([]);
    expect(effects.n).toBe(1);
  });

  it('the same threshold over 1000 asks — confirm with its text; approve with its text and a staff-only yes', async () => {
    const effects = { n: 0 };
    const gnl = createGnl({ storage: new InMemoryStorage(), agents: {
      c: { model: oneRefund(5000), tools: { refund: refundTool(effects, { confirm: threshold('refund 5000, sure?') }) } },
      p: { model: oneRefund(5000), tools: { refund: refundTool(effects, { approve: threshold('over the limit') }) } },
    } } as never);
    const c: any = await gnl.run('c', { runId: 'k3', prompt: 'go', caller: AYSE } as never);
    expect(c.interrupts.map((i: any) => i.reason)).toEqual(['refund 5000, sure?']);
    const p: any = await gnl.run('p', { runId: 'k4', prompt: 'go', caller: AYSE } as never);
    expect(p.interrupts.map((i: any) => i.reason)).toEqual(['over the limit']);
    expect(effects.n).toBe(0);
    expectTypedRefusal(await settle(gnl.run('p', { runId: 'k4', prompt: 'go', caller: AYSE, approvals: { [p.interrupts[0].toolCallId]: true } } as never)), 'threshold approve');
    expect(effects.n).toBe(0);
  });

  it('the rule function receives the call\'s arguments', async () => {
    const seen: unknown[] = [];
    const { gnl } = small({ approve: (a: unknown) => { seen.push(a); return false; } });
    await gnl.run('a', { runId: 'k5', prompt: 'go', caller: AYSE } as never);
    expect(seen.length, 'approve function was never called').toBeGreaterThan(0);
    expect(seen[0]).toMatchObject({ amount: 50 });
  });
});

describe('order — the agent\'s guard first, then the tool\'s own rule', () => {
  it('guard deny: the tool\'s confirm/approve functions are never called, no question, no refund', async () => {
    const effects = { n: 0 };
    const asked = { confirm: 0, approve: 0 };
    const gnl = createGnl({ storage: new InMemoryStorage(), agents: { a: {
      model: oneRefund(), guard: () => ({ action: 'deny', reason: 'not here' }),
      tools: { refund: refundTool(effects, { confirm: () => { asked.confirm++; return true; }, approve: () => { asked.approve++; return true; } }) },
    } } } as never);
    const r: any = await gnl.run('a', { runId: 'o1', prompt: 'go', caller: AYSE } as never);
    expect(r.interrupts ?? []).toEqual([]);
    expect(effects.n).toBe(0);
    expect(asked, 'a guard deny still consulted the tool\'s own rule').toEqual({ confirm: 0, approve: 0 });
  });

  it('guard allow + tool approve: the question is asked; requester refused, staff runs it', async () => {
    const s = gnlWith(APPROVE_RULES.find((r) => r.name.startsWith("guard 'allow'"))!);
    await s.ask('o2');
    expectTypedRefusal(await s.answer('o2', AYSE, true), 'allow+approve');
    expect(s.effects.n).toBe(0);
    expect((await s.answer('o2', STAFF, true)).ok).toBe(true);
    expect(s.effects.n).toBe(1);
  });
});

describe('no rule — no question (regression)', () => {
  it('no guard, no confirm, no approve: the tool runs for an end user without any question', async () => {
    const effects = { n: 0 };
    const gnl = createGnl({ storage: new InMemoryStorage(), agents: { a: { model: oneRefund(), tools: { refund: refundTool(effects) } } } } as never);
    const r: any = await gnl.run('a', { runId: 'n1', prompt: 'go', caller: AYSE } as never);
    expect(r.interrupts ?? []).toEqual([]);
    expect(effects.n).toBe(1);
  });

  it('a guard that allows everything: the same', async () => {
    const effects = { n: 0 };
    const gnl = createGnl({ storage: new InMemoryStorage(), agents: { a: { model: oneRefund(), tools: { refund: refundTool(effects) }, guard: () => ({ action: 'allow' }) } } } as never);
    const r: any = await gnl.run('a', { runId: 'n2', prompt: 'go', caller: AYSE } as never);
    expect(r.interrupts ?? []).toEqual([]);
    expect(effects.n).toBe(1);
  });
});

describe('backward compatible — a guard returning require-approval, answered by staff', () => {
  it('runDurable (no registry): require-approval + staff yes on resume runs once, as before', async () => {
    const effects = { n: 0 };
    const journal = new InMemoryJournal();
    const args = { journal, runId: 'bc1', model: oneRefund(), prompt: 'go', caller: STAFF, tools: { refund: refundTool(effects) }, guard: async () => ({ action: 'require-approval' as const, reason: 'a human decides' }) };
    const first: any = await runDurable(args as never);
    expect(ids(first)).toEqual(['call_0']);
    await runDurable({ ...args, approvals: { [first.interrupts[0].toolCallId]: true } } as never);
    expect(effects.n).toBe(1);
  });

  it('runDurable: an end user\'s run, require-approval — her yes is refused, staff\'s yes runs it', async () => {
    const effects = { n: 0 };
    const journal = new InMemoryJournal();
    const base = { journal, runId: 'bc2', model: oneRefund(), prompt: 'go', tools: { refund: refundTool(effects) }, guard: async () => ({ action: 'require-approval' as const }) };
    await runDurable({ ...base, caller: AYSE } as never);
    expectTypedRefusal(await settle(runDurable({ ...base, caller: AYSE, approvals: { [gid('bc2')]: true } } as never)), 'runDurable require-approval');
    expect(effects.n).toBe(0);
    const ok = await settle(runDurable({ ...base, caller: STAFF, approvals: { [gid('bc2')]: true } } as never));
    expect(ok.ok, String((ok as any).e)).toBe(true);
    expect(effects.n).toBe(1);
  });
});

describe('a question over an attempt in doubt ("may already have happened") is an APPROVE question', () => {
  // The SideEffectRetryBlockedError path (durable README "re-run with approvals"): a side effect whose
  // first attempt FAILED after it may have reached the provider is not retried without a human. No rule
  // was declared — the crash created the question — and step 2 says it is answered as approve.
  const setup = () => {
    let n = 0;
    const journal = new InMemoryJournal();
    const tools = { refund: { description: 'refund', inputSchema: z.object({}).passthrough(), sideEffect: true, execute: async () => { n++; if (n === 1) throw new Error('provider 502 after the request left'); return { refunded: true }; } } };
    const model = script([{ name: 'refund', id: 'call_0', input: { amount: 12500 } }]);
    const run = (caller: unknown, approvals?: Record<string, boolean>) =>
      settle(runDurable({ journal, runId: 'doubt', model, tools, prompt: 'go', caller, ...(approvals ? { approvals } : {}) } as never));
    return { run, journal, effects: () => n };
  };

  it('the requester\'s yes to the in-doubt retry is refused (typed, coded); nothing journaled; no retry', async () => {
    const { run, journal, effects } = setup();
    await run(AYSE); // the first attempt fails
    const refused = await run(AYSE);
    expect(refused.ok === false && refused.e?.name, 'precondition: the in-doubt call is refused').toBe('SideEffectRetryBlockedError');
    expectTypedRefusal(await run(AYSE, { [gid('doubt')]: true }), 'in-doubt (SideEffectRetryBlocked)');
    expect(effects(), 'the requester released a retry that may double the refund').toBe(1);
    expect(await journal.get(durable.runKeys.approval('doubt', gid('doubt')))).toBeUndefined();
  });

  it('staff\'s yes to the in-doubt retry runs it once (the documented remedy)', async () => {
    const { run, effects } = setup();
    await run(AYSE);
    await run(AYSE);
    const ok = await run(STAFF, { [gid('doubt')]: true });
    expect(ok.ok, String((ok as any).e)).toBe(true);
    expect(effects()).toBe(2);
  });

  it('the in-doubt question over a CONFIRM tool is still approve: the requester answered the first confirm, but not the retry', async () => {
    // A tool the requester may confirm. Its approved first attempt fails after leaving; the model asks
    // again with the same args (a new id, 'args' idempotency → the same record) and is refused until
    // somebody answers. Whether the effect already
    // happened is not a consent question — the requester cannot know, an authorised person checks.
    let n = 0;
    const storage = new InMemoryStorage();
    const refund = {
      description: 'refund', inputSchema: z.object({ amount: z.number() }).passthrough(), confirm: true,
      sideEffect: true, idempotency: 'args', maxRetries: 5,
      execute: async () => { n++; if (n === 1) throw new Error('provider 502 after the request left'); return { refunded: true }; },
    };
    const gnl = createGnl({ storage, agents: { a: { model: script([{ name: 'refund', id: 'call_0', input: { amount: 12500 } }, { name: 'refund', id: 'call_1', input: { amount: 12500 } }]), tools: { refund } } } } as never);
    const go = (caller: unknown, approvals?: Record<string, boolean>) => settle(gnl.run('a', { runId: 'doubt-c', prompt: 'go', caller, ...(approvals ? { approvals } : {}) } as never));
    const first: any = await go(AYSE);
    expect(first.ok && ids(first.r), 'precondition: the confirm question').toEqual(['call_0']);
    const second: any = await go(AYSE, { [first.r.interrupts[0].toolCallId]: true });
    expect(n, 'precondition: the confirmed first attempt ran and failed').toBe(1);
    // Measured on release/0.17.1: the repeat (call_1, same args) is refused as SideEffectRetryBlockedError,
    // whose remedy names `approvals['call_1']=true` — that refusal IS the in-doubt question.
    expect(second.ok === false && second.e?.name, 'precondition: the in-doubt refusal').toBe('SideEffectRetryBlockedError');
    expect(String(second.e.message)).toContain(`approvals['${gid('doubt-c', 'call_1', 1)}']`);
    expectTypedRefusal(await go(AYSE, { [gid('doubt-c', 'call_1', 1)]: true }), 'in-doubt over confirm');
    expect(n, 'the requester released a retry that may double the refund').toBe(1);
    const ok = await go(STAFF, { [gid('doubt-c', 'call_1', 1)]: true });
    expect(ok.ok, String((ok as any).e)).toBe(true);
    expect(n).toBe(2);
  });
  it('the in-doubt question under a guard that said CONFIRM is approve: the requester confirmed call_0, but cannot release the in-doubt call_1', async () => {
    let n = 0;
    const refund = {
      description: 'refund', inputSchema: z.object({ amount: z.number() }).passthrough(),
      sideEffect: true, idempotency: 'args', maxRetries: 5,
      execute: async () => { n++; if (n === 1) throw new Error('provider 502 after the request left'); return { refunded: true }; },
    };
    const gnl = createGnl({ storage: new InMemoryStorage(), agents: { a: {
      model: script([{ name: 'refund', id: 'call_0', input: { amount: 12500 } }, { name: 'refund', id: 'call_1', input: { amount: 12500 } }]),
      tools: { refund }, guard: () => ({ action: 'confirm', reason: 'sure?' }),
    } } } as never);
    const go = (caller: unknown, approvals?: Record<string, boolean>) => settle(gnl.run('a', { runId: 'doubt-g', prompt: 'go', caller, ...(approvals ? { approvals } : {}) } as never));
    const first: any = await go(AYSE);
    expect(first.ok && ids(first.r), 'precondition: the guard\'s confirm question').toEqual(['call_0']);
    const second: any = await go(AYSE, { [first.r.interrupts[0].toolCallId]: true });
    expect(n, 'precondition: the confirmed first attempt ran and failed').toBe(1);
    expect(second.ok && ids(second.r), 'precondition: the in-doubt question over call_1').toEqual(['call_1']);
    expect(String(second.r.interrupts[0].reason)).toMatch(/MAY already have happened/);
    expectTypedRefusal(await go(AYSE, { [second.r.interrupts[0].toolCallId]: true }), 'in-doubt under guard confirm');
    expect(n).toBe(1);
    expect((await go(STAFF, { [second.r.interrupts[0].toolCallId]: true })).ok).toBe(true);
    expect(n).toBe(2);
  });
});

describe('approvers (createGnl) — a custom rule is called and its answer applied', () => {
  it('approvers: () => false — even staff\'s yes on an approve question is refused with the same code', async () => {
    const effects = { n: 0 };
    const gnl = createGnl({ storage: new InMemoryStorage(), approvers: () => false, agents: { a: { model: oneRefund(), tools: { refund: refundTool(effects, { approve: true }) } } } } as never);
    await gnl.run('a', { runId: 'ap1', prompt: 'go', caller: AYSE } as never);
    expectTypedRefusal(await settle(gnl.run('a', { runId: 'ap1', prompt: 'go', caller: STAFF, approvals: { [gid('ap1')]: true } } as never)), 'approvers false');
    expect(effects.n).toBe(0);
  });

  it('approvers receives the question\'s tool and arguments; its true lets staff\'s yes through', async () => {
    const effects = { n: 0 };
    const seen: unknown[] = [];
    const gnl = createGnl({ storage: new InMemoryStorage(), approvers: (ctx: unknown) => { seen.push(ctx); return true; }, agents: { a: { model: oneRefund(), tools: { refund: refundTool(effects, { approve: true }) } } } } as never);
    await gnl.run('a', { runId: 'ap2', prompt: 'go', caller: AYSE } as never);
    const ok = await settle(gnl.run('a', { runId: 'ap2', prompt: 'go', caller: STAFF, approvals: { [gid('ap2')]: true } } as never));
    expect(ok.ok, String((ok as any).e)).toBe(true);
    expect(effects.n).toBe(1);
    expect(seen.length, 'approvers was never called').toBeGreaterThan(0);
    const flat = JSON.stringify(seen[0]);
    expect(flat, 'approvers ctx does not name the tool').toContain('refund');
    expect(flat, 'approvers ctx does not carry the arguments').toContain('12500');
  });

  it('approvers is not consulted for a requester\'s NO (a no always goes through)', async () => {
    const effects = { n: 0 };
    const gnl = createGnl({ storage: new InMemoryStorage(), approvers: () => false, agents: { a: { model: oneRefund(), tools: { refund: refundTool(effects, { approve: true }) } } } } as never);
    await gnl.run('a', { runId: 'ap3', prompt: 'go', caller: AYSE } as never);
    const out = await settle(gnl.run('a', { runId: 'ap3', prompt: 'go', caller: AYSE, approvals: { [gid('ap3')]: false } } as never));
    expect(out.ok, String((out as any).e)).toBe(true);
    expect(effects.n).toBe(0);
  });

});
