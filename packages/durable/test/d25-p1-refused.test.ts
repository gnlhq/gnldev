// d25 P1 (KARARLAR-26 madde 1, identity/KARAR-3): `return refused(...)` — the tool author says "nothing
// was done in this call". The engine takes that as the answer to THAT call only and frees the work key and
// the ownership. Nothing else is read as a refusal: `{ ok:false }` / `{ error }` stay done (negative control).
//
// Spec by behaviour. The one name fixed by the decision file is the `refused` helper exported from the
// package index (`@gnldev/durable`). Tests do not depend on the toolCallId format.
import { describe, it, expect, afterEach } from 'vitest';
import { tool, stepCountIs } from 'ai';
import { z } from 'zod';
import * as durable from '../src/index.js';
import { InMemoryJournal } from '../src/journal.js';
import { runDurable } from '../src/run.js';
import { withIdempotency } from '../src/idempotent-tools.js';
import { compensateRun } from '../src/compensation.js';
import { identityOf, userIdOf, toolContextFor, runIdentity, user } from '../src/run-identity.js';
import { createMockModel, countToolResults, toolCallResult, finalTextResult } from './mock.js';

/** The helper under test. Missing => every test that uses it fails with this message (red before the fix). */
let helperMissing = false;
const refused = <T,>(v: T): T => {
  const f = (durable as any).refused;
  if (typeof f !== 'function') { helperMissing = true; throw new Error('@gnldev/durable does not export refused()'); }
  return f(v);
};
// A body that throws because the helper is missing must not make a test pass by accident (a thrown body is a
// "failed" call): any use of the missing helper fails the test here.
afterEach(() => { if (helperMissing) { helperMissing = false; throw new Error('refused() is not exported from @gnldev/durable'); } });
const as = (who: string, toolCallId: string, runId = `r-${who}`) => ({ toolCallId, messages: [], gnl: toolContextFor(runIdentity(user(who), runId)) });
const callsOnce = (name: string, args: unknown, id: string) => createMockModel(async ({ prompt }: any) => {
  const lastUser = prompt.map((m: any) => m.role).lastIndexOf('user');
  return countToolResults(prompt.slice(lastUser)) === 0 ? toolCallResult(name, id, args) : finalTextResult('done');
});

const payTool = (state: { paid: number; calls: number; granted: Set<string> }, window: 'cross-run' | 'thread' | 'run' = 'cross-run') => Object.assign(tool({
  description: 'pay', inputSchema: z.object({ claimNo: z.string() }),
  execute: async (_i, o) => {
    state.calls++;
    const who = userIdOf(identityOf(o))!;
    if (!state.granted.has(who)) return refused({ error: 'only the adjuster may pay' });
    state.paid++; return { paid: true };
  },
}), { sideEffect: true, idempotencyWindow: window, idempotencyKey: (i: any) => i.claimNo });

describe('P1 refused(): the work stays free (cross-run window)', () => {
  it('a refused call by an unauthorized user does not lock the claim for the adjuster', async () => {
    const state = { paid: 0, calls: 0, granted: new Set(['eksper']) };
    const t = withIdempotency({ pay: payTool(state) }, { journal: new InMemoryJournal() });
    expect(await t.pay.execute!({ claimNo: 'HSR-9' }, as('ali', 'x1') as never)).toMatchObject({ error: expect.any(String) });
    expect(await t.pay.execute!({ claimNo: 'HSR-9' }, as('eksper', 'x2') as never)).toEqual({ paid: true });
    expect(state.paid).toBe(1);
  });

  it('the same user, granted later, gets a real run (not his old refusal)', async () => {
    const state = { paid: 0, calls: 0, granted: new Set<string>() };
    const t = withIdempotency({ pay: payTool(state) }, { journal: new InMemoryJournal() });
    await t.pay.execute!({ claimNo: 'HSR-10' }, as('ali', 'x1') as never);
    state.granted.add('ali');
    expect(await t.pay.execute!({ claimNo: 'HSR-10' }, as('ali', 'x2') as never)).toEqual({ paid: true });
    expect(state.paid).toBe(1);
  });

  it('after the refusal frees the work, it still runs ONCE: three adjusters at once pay once', async () => {
    const state = { paid: 0, calls: 0, granted: new Set(['e1', 'e2', 'e3']) };
    const t = withIdempotency({ pay: payTool(state) }, { journal: new InMemoryJournal() });
    state.granted.delete('ali');
    await t.pay.execute!({ claimNo: 'HSR-11' }, as('ali', 'x0') as never);
    await Promise.allSettled(['e1', 'e2', 'e3'].map((w, i) => t.pay.execute!({ claimNo: 'HSR-11' }, as(w, `y${i}`) as never)));
    expect(state.paid).toBe(1);
  });

  it('a later REAL success still locks the work: after pay, another adjuster is not paid again', async () => {
    const state = { paid: 0, calls: 0, granted: new Set(['e1', 'e2']) };
    const t = withIdempotency({ pay: payTool(state) }, { journal: new InMemoryJournal() });
    await t.pay.execute!({ claimNo: 'HSR-12' }, as('ali', 'x0') as never);
    await t.pay.execute!({ claimNo: 'HSR-12' }, as('e1', 'x1') as never);
    await Promise.resolve(t.pay.execute!({ claimNo: 'HSR-12' }, as('e2', 'x2') as never)).catch(() => undefined);
    expect(state.paid).toBe(1);
  });

  it('agent path: refused in run A, the same work in run B by another user runs once', async () => {
    const state = { paid: 0, calls: 0, granted: new Set(['eksper']) };
    const pay = durable.gnlTool(payTool(state) as any, { sideEffect: true, idempotencyWindow: 'cross-run', idempotencyKey: (i: any) => i.claimNo } as any);
    const journal = new InMemoryJournal();
    await runDurable({ runId: 'pa', journal, model: callsOnce('pay', { claimNo: 'HSR-20' }, 'k1'), tools: { pay }, prompt: 'x', stopWhen: stepCountIs(4), resourceId: 'ali' });
    const rb: any = await runDurable({ runId: 'pb', journal, model: callsOnce('pay', { claimNo: 'HSR-20' }, 'k2'), tools: { pay }, prompt: 'x', stopWhen: stepCountIs(4), resourceId: 'eksper' });
    expect(state.paid).toBe(1);
    expect(rb.interrupts ?? []).toEqual([]);
  });
});

describe('P1 refused(): replay of the call\'s own answer', () => {
  it('the SAME call asked again (resume after a crash) gets the same refusal, without running the body', async () => {
    const state = { paid: 0, calls: 0, granted: new Set<string>() };
    const t = withIdempotency({ pay: payTool(state) }, { journal: new InMemoryJournal() });
    const a = await t.pay.execute!({ claimNo: 'HSR-30' }, as('ali', 'same', 'r1') as never);
    const b = await t.pay.execute!({ claimNo: 'HSR-30' }, as('ali', 'same', 'r1') as never);
    expect(b).toEqual(a);
    expect(state.calls).toBe(1);
  });
});

describe('P1 refused(): other windows and modes', () => {
  it('thread window, keyless tool: a refused stock check is not a "done duplicate" in the next request', async () => {
    let stock = 0; let runs = 0;
    const reserve = durable.gnlTool(tool({ description: 'r', inputSchema: z.object({ event: z.string(), n: z.number() }), execute: async () => {
      runs++; return stock >= 2 ? { ok: true } : refused({ ok: false, reason: 'out of stock' });
    } }), { sideEffect: true } as any);
    const journal = new InMemoryJournal();
    const limits = { sideEffectDuplicates: { action: 'suspend' as const, scope: 'thread' as const } };
    await runDurable({ runId: 'b1', threadId: 'T', journal, model: callsOnce('reserve', { event: 'e', n: 2 }, 'q1'), tools: { reserve }, prompt: 'x', stopWhen: stepCountIs(4), resourceId: 'ayse', limits } as any);
    stock = 10;
    const r2: any = await runDurable({ runId: 'b2', threadId: 'T', journal, model: callsOnce('reserve', { event: 'e', n: 2 }, 'q2'), tools: { reserve }, prompt: 'x', stopWhen: stepCountIs(4), resourceId: 'ayse', limits } as any);
    expect(r2.interrupts ?? []).toEqual([]);
    expect(runs).toBe(2);
  });

  it('thread window + cross-run keyed tool: the refusal does not keep the thread\'s duplicate marker either', async () => {
    const state = { paid: 0, calls: 0, granted: new Set<string>() };
    const pay = durable.gnlTool(payTool(state, 'thread') as any, { sideEffect: true, idempotencyWindow: 'thread', idempotencyKey: (i: any) => i.claimNo } as any);
    const journal = new InMemoryJournal();
    await runDurable({ runId: 't1', threadId: 'TT', journal, model: callsOnce('pay', { claimNo: 'C1' }, 'a1'), tools: { pay }, prompt: 'x', stopWhen: stepCountIs(4), resourceId: 'ali' } as any);
    state.granted.add('ali');
    await runDurable({ runId: 't2', threadId: 'TT', journal, model: callsOnce('pay', { claimNo: 'C1' }, 'a2'), tools: { pay }, prompt: 'x', stopWhen: stepCountIs(4), resourceId: 'ali' } as any);
    expect(state.paid).toBe(1);
  });

  it('args mode, one request: the model retries after the refusal with a new call id and the body runs again', async () => {
    let stock = 0; let runs = 0;
    const reserve = durable.gnlTool(tool({ description: 'r', inputSchema: z.object({ event: z.string() }), execute: async () => {
      runs++; const r = stock > 0 ? { ok: true } : refused({ ok: false, reason: 'out of stock' }); stock = 5; return r;
    } }), { sideEffect: true, idempotency: 'args' } as any);
    const m = createMockModel(async ({ prompt }: any) => {
      const n = countToolResults(prompt);
      return n < 2 ? toolCallResult('reserve', `z${n}`, { event: 'e' }) : finalTextResult('done');
    });
    await runDurable({ runId: 'b3', journal: new InMemoryJournal(), model: m, tools: { reserve }, prompt: 'x', stopWhen: stepCountIs(5), resourceId: 'ayse' });
    expect(runs).toBe(2);
  });
});

describe('P1 refused(): the answer is the same value, nothing else changes', () => {
  it('the model receives the value as given; no marker leaks into the output or its JSON', async () => {
    const seenByModel: string[] = [];
    const pay = durable.gnlTool(tool({ description: 'p', inputSchema: z.object({ n: z.string() }), execute: async () => refused({ ok: false, reason: 'no stock' }) }), { sideEffect: true } as any);
    const m = createMockModel(async ({ prompt }: any) => {
      if (countToolResults(prompt) === 0) return toolCallResult('pay', 'm1', { n: 'a' });
      seenByModel.push(JSON.stringify(prompt.filter((x: any) => x.role === 'tool')));
      return finalTextResult('done');
    });
    const r: any = await runDurable({ runId: 'm', journal: new InMemoryJournal(), model: m, tools: { pay }, prompt: 'x', stopWhen: stepCountIs(4), resourceId: 'ayse' });
    expect(seenByModel[0]).toContain('no stock');
    expect(seenByModel[0]).not.toMatch(/refused|__gnl/);
    expect(r.text).toBe('done');
    const direct = refused({ ok: false, reason: 'x' });
    expect(direct).toEqual({ ok: false, reason: 'x' });
    expect(JSON.stringify(direct)).toBe(JSON.stringify({ ok: false, reason: 'x' }));
  });

  it('compensateRun treats a refused call as "no effect": compensate is not called for it', async () => {
    let compensated = 0;
    const book = Object.assign(tool({ description: 'b', inputSchema: z.object({ id: z.string() }), execute: async () => refused({ ok: false, reason: 'full' }) }),
      { sideEffect: true, compensate: async () => { compensated++; return { cancelled: 1 }; } });
    const journal = new InMemoryJournal();
    await runDurable({ runId: 'sg', journal, model: callsOnce('book', { id: 'h1' }, 'c1'), tools: { book }, prompt: 'x', stopWhen: stepCountIs(4), resourceId: 'ayse' });
    await compensateRun('sg', { journal, tools: { book } as never });
    expect(compensated).toBe(0);
  });
});

describe('P1 negative control: a plain {ok:false} / {error} is NOT a refusal (engine does not guess)', () => {
  it('a plain {error} result keeps the work done: the second user is stopped, the body runs once', async () => {
    let runs = 0;
    const pay = Object.assign(tool({ description: 'pay', inputSchema: z.object({ claimNo: z.string() }), execute: async () => { runs++; return { error: 'no' }; } }),
      { sideEffect: true, idempotencyWindow: 'cross-run' as const, idempotencyKey: (i: any) => i.claimNo });
    const t = withIdempotency({ pay }, { journal: new InMemoryJournal() });
    await t.pay.execute!({ claimNo: 'N1' }, as('ali', 'x1') as never);
    await Promise.resolve(t.pay.execute!({ claimNo: 'N1' }, as('eksper', 'x2') as never)).catch(() => undefined);
    expect(runs).toBe(1);
  });

  it('a plain {ok:false} in the same run with a new call id is replayed, not re-run (args mode)', async () => {
    let runs = 0;
    const reserve = durable.gnlTool(tool({ description: 'r', inputSchema: z.object({ event: z.string() }), execute: async () => { runs++; return { ok: false }; } }), { sideEffect: true, idempotency: 'args' } as any);
    const m = createMockModel(async ({ prompt }: any) => {
      const n = countToolResults(prompt);
      return n < 2 ? toolCallResult('reserve', `w${n}`, { event: 'e' }) : finalTextResult('done');
    });
    await runDurable({ runId: 'nc', journal: new InMemoryJournal(), model: m, tools: { reserve }, prompt: 'x', stopWhen: stepCountIs(5), resourceId: 'ayse' });
    expect(runs).toBe(1);
  });
});

describe('P1 back-compat: records written before refused() existed', () => {
  it('an old "succeeded" record that holds a refusal-shaped value stays done (not silently freed); new calls use refused()', async () => {
    const journal = new InMemoryJournal();
    let runs = 0;
    const key = (i: any) => i.claimNo;
    const old = Object.assign(tool({ description: 'pay', inputSchema: z.object({ claimNo: z.string() }), execute: async () => { runs++; return { error: 'old style' }; } }),
      { sideEffect: true, idempotencyWindow: 'cross-run' as const, idempotencyKey: key });
    await withIdempotency({ pay: old }, { journal }).pay.execute!({ claimNo: 'OLD' }, as('ali', 'o1') as never);
    const next = Object.assign(tool({ description: 'pay', inputSchema: z.object({ claimNo: z.string() }), execute: async () => { runs++; return refused({ error: 'new style' }); } }),
      { sideEffect: true, idempotencyWindow: 'cross-run' as const, idempotencyKey: key });
    const again = await withIdempotency({ pay: next }, { journal }).pay.execute!({ claimNo: 'OLD' }, as('ali', 'o2') as never).catch((e) => e);
    expect(runs).toBe(1);
    expect(again).toBeDefined();
  });

  it('a fresh work key written with refused() on the new engine behaves as freed in the same journal', async () => {
    const journal = new InMemoryJournal();
    const state = { paid: 0, calls: 0, granted: new Set<string>() };
    await withIdempotency({ pay: payTool(state) }, { journal }).pay.execute!({ claimNo: 'NEW' }, as('ali', 'n1') as never);
    state.granted.add('eksper');
    expect(await withIdempotency({ pay: payTool(state) }, { journal }).pay.execute!({ claimNo: 'NEW' }, as('eksper', 'n2') as never)).toEqual({ paid: true });
  });
});
