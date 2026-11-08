// d25 approval policy — what the acceptance files (d25-a1-*, d25-a2-*) do not pin, written against the GNL ids a
// run really hands out (every id is read from the interrupt the run returned).
//
//   · two questions over one call (consent, then permission) and an authorised yes that answers both;
//   · an unasked NO is kept and stops the call (KARAR-1 2c), an unasked YES is ignored and warned about;
//   · a sub-agent's approve question: the requester is refused at the parent, staff answers, the child runs once;
//   · the unattributed answer is read as authorised and said once;
//   · `limits.taintedSideEffects: 'confirm'` puts the taint question to the requester.
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { z } from 'zod';
import { InMemoryStorage, createGnl, STAFF, user, runDurable, InMemoryJournal } from '../src/index.js';
import { resetUnattributedWarning } from '../src/approval-authority.js';
import { mintCallId } from '../src/call-identity.js';
import { createMockModel, toolCallResult, finalTextResult, countToolResults } from './mock.js';

const AYSE = user('u-ayse');
type Call = { name: string; id: string; input: object };
const script = (calls: Call[]) => createMockModel(async ({ prompt }: any) => {
  const next = calls[countToolResults(prompt)];
  return next ? toolCallResult(next.name, next.id, next.input) : finalTextResult('done');
});
const refundTool = (effects: { n: number }, extra: Record<string, unknown> = {}) => ({
  description: 'refund', inputSchema: z.object({ amount: z.number() }).passthrough(),
  execute: async () => { effects.n++; return { refunded: true }; }, ...extra,
});
const settle = <T>(p: Promise<T>) => p.then((r) => ({ ok: true as const, r }), (e: any) => ({ ok: false as const, e }));
const ids = (r: any): string[] => (r.interrupts ?? []).map((i: any) => i.toolCallId);

beforeEach(() => { vi.spyOn(console, 'warn').mockImplementation(() => {}); resetUnattributedWarning(); });

describe('two questions over one call: consent first, permission second', () => {
  const build = (guardAction: 'confirm' | 'approve') => {
    const effects = { n: 0 };
    const gnl = createGnl({ storage: new InMemoryStorage(), agents: { a: {
      model: script([{ name: 'refund', id: 'call_0', input: { amount: 12500 } }]),
      tools: { refund: refundTool(effects, { approve: true }) },
      guard: () => ({ action: guardAction, reason: 'guard asks' }),
    } } } as never);
    const go = (caller: unknown, approvals?: Record<string, boolean>) => settle(gnl.run('a', { runId: 'r', prompt: 'go', caller, ...(approvals ? { approvals } : {}) } as never));
    return { effects, go };
  };

  it('guard confirm + tool approve: the requester consents, then the permission question is put; the requester cannot answer it; staff does, and it runs once', async () => {
    const s = build('confirm');
    const first: any = await s.go(AYSE);
    expect(first.r.interrupts.map((i: any) => [i.kind, i.needs])).toEqual([['guard', 'confirm']]);
    const id = ids(first.r)[0]!;
    const second: any = await s.go(AYSE, { [id]: true });
    expect(second.ok, String(second.e)).toBe(true);
    expect(s.effects.n, 'consent alone ran a call that also needs permission').toBe(0);
    expect(second.r.interrupts.map((i: any) => [i.toolCallId, i.kind, i.needs])).toEqual([[id, 'approve', 'approve']]);
    const refused = await s.go(AYSE, { [id]: true });
    expect(refused.ok === false && refused.e?.name).toBe('ApprovalNotPermittedError');
    expect(s.effects.n).toBe(0);
    expect((await s.go(STAFF, { [id]: true })).ok).toBe(true);
    expect(s.effects.n).toBe(1);
  });

  it('an authorised yes at the first question answers both: staff\'s yes on the consent question runs it at once', async () => {
    const s = build('confirm');
    const id = ids((await s.go(AYSE) as any).r)[0]!;
    const out: any = await s.go(STAFF, { [id]: true });
    expect(out.ok, String(out.e)).toBe(true);
    expect(s.effects.n).toBe(1);
  });

  it('guard approve + tool confirm: consent is put first (the tool\'s), and a staff yes answers the guard\'s permission too', async () => {
    const effects = { n: 0 };
    const gnl = createGnl({ storage: new InMemoryStorage(), agents: { a: {
      model: script([{ name: 'refund', id: 'call_0', input: { amount: 1 } }]),
      tools: { refund: refundTool(effects, { confirm: true }) }, guard: () => ({ action: 'approve' }),
    } } } as never);
    const go = (caller: unknown, approvals?: Record<string, boolean>) => settle(gnl.run('a', { runId: 'r2', prompt: 'go', caller, ...(approvals ? { approvals } : {}) } as never));
    const first: any = await go(AYSE);
    expect(first.r.interrupts.map((i: any) => i.needs)).toEqual(['confirm']);
    const id = ids(first.r)[0]!;
    const afterConsent: any = await go(AYSE, { [id]: true });
    expect(afterConsent.r.interrupts.map((i: any) => i.needs), 'the guard\'s permission question was not put after her consent').toEqual(['approve']);
    expect(effects.n).toBe(0);
    expect((await go(STAFF, { [id]: true })).ok).toBe(true);
    expect(effects.n).toBe(1);
  });

  it('a requester\'s NO at any stage ends it: nothing runs', async () => {
    const s = build('confirm');
    const id = ids((await s.go(AYSE) as any).r)[0]!;
    await s.go(AYSE, { [id]: true }); // consent; now the permission question
    const out: any = await s.go(AYSE, { [id]: false });
    expect(out.ok, String(out.e)).toBe(true);
    expect(s.effects.n).toBe(0);
  });
});

describe('an unasked answer (KARAR-1 2c)', () => {
  it('an unasked NO is kept and stops the call when it comes; an unasked YES is ignored and said once in the log', async () => {
    const effects = { n: 0 };
    const gnl = createGnl({ storage: new InMemoryStorage(), agents: { a: {
      model: script([{ name: 'refund', id: 'call_0', input: { amount: 12500 } }]),
      tools: { refund: refundTool(effects, { confirm: true }) },
    } } } as never);
    const warn = vi.mocked(console.warn);
    const yes: any = await gnl.run('a', { runId: 'y', prompt: 'go', caller: STAFF, approvals: { call_0: true } } as never);
    expect(effects.n).toBe(0);
    expect(ids(yes), 'the unasked yes skipped the question').toHaveLength(1);
    expect(warn.mock.calls.some((c) => String(c[0]).includes('approval ignored')), 'the ignored yes was not said').toBe(true);
    const no: any = await gnl.run('a', { runId: 'n', prompt: 'go', caller: STAFF, approvals: { [mintCallId('call_0', 'n', 0, 0)]: false } } as never); // the id a call will have is predictable
    expect(effects.n, 'a stored no let the call run').toBe(0);
    expect(ids(no), 'a stored no still asked').toEqual([]);
  });
});

describe('a sub-agent\'s approve question', () => {
  it('the requester is refused at the parent; staff answers; the child\'s call runs once', async () => {
    const effects = { n: 0 };
    const gnl = createGnl({ storage: new InMemoryStorage(), agents: {
      sub: { model: script([{ name: 'refund', id: 'call_0', input: { amount: 1 } }]), tools: { refund: refundTool(effects) }, guard: () => ({ action: 'approve' }) },
      parent: { model: script([{ name: 'agent_sub', id: 'call_0', input: { task: 'refund' } }]), agents: ['sub'] },
    } } as never);
    const go = (caller: unknown, approvals?: Record<string, boolean>) => settle(gnl.run('parent', { runId: 'nest', prompt: 'go', caller, ...(approvals ? { approvals } : {}) } as never));
    const first: any = await go(AYSE);
    const id = ids(first.r)[0]!;
    expect(first.r.interrupts[0].needs).toBe('approve');
    const refused = await go(AYSE, { [id]: true });
    expect(refused.ok === false && refused.e?.name).toBe('ApprovalNotPermittedError');
    expect(effects.n).toBe(0);
    const done: any = await go(STAFF, { [id]: true });
    expect(done.ok, String(done.e)).toBe(true);
    expect(effects.n).toBe(1);
  });
});

describe('the unattributed answer', () => {
  it('a direct call that names nobody answers an approve question as authorised, and says so ONCE', async () => {
    const effects = { n: 0 };
    const mk = (runId: string) => {
      const journal = new InMemoryJournal();
      const args = { journal, runId, model: script([{ name: 'refund', id: 'call_0', input: { amount: 1 } }]), prompt: 'go', tools: { refund: refundTool(effects) }, guard: () => ({ action: 'approve' as const }) };
      return { args, journal };
    };
    const warn = vi.mocked(console.warn);
    for (const runId of ['u1', 'u2']) {
      const { args } = mk(runId);
      const first: any = await runDurable(args as never);
      await runDurable({ ...args, approvals: { [ids(first)[0]!]: true } } as never);
    }
    expect(effects.n).toBe(2);
    expect(warn.mock.calls.filter((c) => String(c[0]).includes('caller nobody named')).length, 'said once per process').toBe(1);
  });
});

describe('taintedSideEffects: confirm', () => {
  it('puts the taint question as consent: the requester answers it; the default (suspend) is permission', async () => {
    const fetchPage = { description: 'read', inputSchema: z.object({}).passthrough(), untrusted: true, sideEffect: false, execute: async () => ({ page: 'x' }) };
    const run = async (taint: 'confirm' | 'suspend') => {
      const effects = { n: 0 };
      const gnl = createGnl({ storage: new InMemoryStorage(), agents: { a: {
        model: script([{ name: 'fetchPage', id: 'call_0', input: {} }, { name: 'refund', id: 'call_1', input: { amount: 1 } }]),
        tools: { fetchPage, refund: refundTool(effects, { sideEffect: true }) },
      } } } as never);
      const go = (caller: unknown, approvals?: Record<string, boolean>) => settle(gnl.run('a', { runId: `t-${taint}`, prompt: 'go', caller, limits: { taintedSideEffects: taint }, ...(approvals ? { approvals } : {}) } as never));
      const asked: any = await go(AYSE);
      const id = ids(asked.r)[0]!;
      return { needs: asked.r.interrupts[0].needs, answer: await go(AYSE, { [id]: true }), effects };
    };
    const c = await run('confirm');
    expect(c.needs).toBe('confirm');
    expect(c.answer.ok, String((c.answer as any).e)).toBe(true);
    expect(c.effects.n).toBe(1);
    const s = await run('suspend');
    expect(s.needs).toBe('approve');
    expect(s.answer.ok).toBe(false);
    expect(s.effects.n).toBe(0);
  });
});
