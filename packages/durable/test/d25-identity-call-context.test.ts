// d25 identity küme — K1 (doğrulama) testleri, release/0.17.1 üzerinde.
// Konu: araç tarafı kancalarına (idempotencyKey, recover, lookup, compensate, tools/system dinamik
// argüman, onaylı çalıştırma) çağıranın kimliği ve sonucun anlamı nasıl taşınıyor.
// Bulgu no'ları: d25-fix/identity/RAPOR.md. Düzeltme UYGULANMADI (onay kapısı): bu testler bugün kırmızıdır
// ve kararlar onaylanınca yeşile dönmesi beklenir. `refused` yardımcısı henüz yok; testler onun yokluğunda
// bugünkü tek yolu (değer döndürmek) kullanır, böylece aynı test öncesini ve sonrasını ölçer.
import { describe, it, expect } from 'vitest';
import { tool, stepCountIs } from 'ai';
import { z } from 'zod';
import * as durable from '../src/index.js';
import { InMemoryJournal } from '../src/journal.js';
import { InMemoryStorage } from '../src/in-memory-storage.js';
import { runDurable } from '../src/run.js';
import { createGnl, serverIdentityOf, sealRequestContext } from '../src/registry.js';
import { withIdempotency } from '../src/idempotent-tools.js';
import { compensateRun } from '../src/compensation.js';
import { identityOf, userIdOf, toolContextFor, runIdentity, user } from '../src/run-identity.js';
import { createMockModel, countToolResults, toolCallResult, finalTextResult } from './mock.js';

const refusedOr: <T>(v: T) => T = ((durable as any).refused ?? ((v: unknown) => v)) as any;
const as = (who: string, toolCallId = who) => ({ toolCallId, messages: [], gnl: toolContextFor(runIdentity(user(who), `r-${who}`)) });
/** A model that calls `name` with `args` once per request, then finishes. */
const callsOnce = (name: string, args: unknown, id = 'c1') => createMockModel(async ({ prompt }: any) => {
  const lastUser = prompt.map((m: any) => m.role).lastIndexOf('user');
  return countToolResults(prompt.slice(lastUser)) === 0 ? toolCallResult(name, id, args) : finalTextResult('done');
});

describe('F1 idempotencyKey sees who calls', () => {
  it('F1a the key function is handed the call context (identityOf works on it)', async () => {
    const seen: unknown[] = [];
    const book = Object.assign(tool({ description: 'b', inputSchema: z.object({ slot: z.string() }), execute: async () => ({ ok: true }) }),
      { sideEffect: true, idempotencyWindow: 'cross-run' as const, idempotencyKey: (i: any, o?: unknown) => { seen.push(userIdOf(identityOf(o))); return i.slot; } });
    const t = withIdempotency({ book }, { journal: new InMemoryJournal() });
    await t.book.execute!({ slot: 'sat' }, as('ayse') as never);
    expect(seen).toEqual(['ayse']);
  });

  it('F1b a per-person business key (person+slot) lets two people book the same slot', async () => {
    let runs = 0;
    const book = Object.assign(tool({ description: 'b', inputSchema: z.object({ slot: z.string() }), execute: async () => { runs++; return { ok: true }; } }),
      { sideEffect: true, idempotencyWindow: 'cross-run' as const, idempotencyKey: (i: any, o?: unknown) => `${userIdOf(identityOf(o))}:${i.slot}` });
    const t = withIdempotency({ book }, { journal: new InMemoryJournal() });
    await t.book.execute!({ slot: 'sat' }, as('ayse') as never);
    await t.book.execute!({ slot: 'sat' }, as('mehmet') as never);
    expect(runs).toBe(2);
  });

  it('F1c sibling, agent path: two users\' runs, same arguments, per-person key', async () => {
    let runs = 0;
    const book = durable.gnlTool(tool({ description: 'b', inputSchema: z.object({ slot: z.string() }), execute: async () => { runs++; return { ok: true }; } }),
      { sideEffect: true, idempotencyWindow: 'cross-run', idempotencyKey: (i: any, o?: unknown) => `${userIdOf(identityOf(o))}:${i.slot}` } as any);
    const journal = new InMemoryJournal();
    for (const who of ['ayse', 'mehmet']) {
      await runDurable({ runId: `r-${who}`, journal, model: callsOnce('book', { slot: 'sat' }), tools: { book }, prompt: 'x', stopWhen: stepCountIs(4), resourceId: who });
    }
    expect(runs).toBe(2);
  });
});

describe('F2/F3 a refusal (nothing happened) does not hold the work', () => {
  const payTool = (state: { paid: number; granted: Set<string> }) => Object.assign(tool({
    description: 'pay', inputSchema: z.object({ claimNo: z.string() }),
    execute: async (_i, o) => {
      const who = userIdOf(identityOf(o))!;
      if (!state.granted.has(who)) return refusedOr({ error: 'Ödeme onayı yalnız eksper içindir.' });
      state.paid++; return { paid: true };
    },
  }), { sideEffect: true, idempotencyWindow: 'cross-run' as const, idempotencyKey: (i: any) => i.claimNo });

  it('F2a 09-sigorta: an unauthorized user\'s refusal does not lock the claim for the expert', async () => {
    const state = { paid: 0, granted: new Set(['eksper']) };
    const t = withIdempotency({ pay: payTool(state) }, { journal: new InMemoryJournal() });
    expect(await t.pay.execute!({ claimNo: 'HSR-9' }, as('ali') as never)).toMatchObject({ error: expect.any(String) });
    let expert: unknown; let err: unknown;
    try { expert = await t.pay.execute!({ claimNo: 'HSR-9' }, as('eksper') as never); } catch (e) { err = e; }
    expect((err as Error | undefined)?.message).toBeUndefined();
    expect(expert).toEqual({ paid: true });
    expect(state.paid).toBe(1);
  });

  it('F2b sibling: the same user, granted later, is not served their old refusal', async () => {
    const state = { paid: 0, granted: new Set<string>() };
    const t = withIdempotency({ pay: payTool(state) }, { journal: new InMemoryJournal() });
    await t.pay.execute!({ claimNo: 'HSR-10' }, as('ali', 'call-1') as never);
    state.granted.add('ali');
    expect(await t.pay.execute!({ claimNo: 'HSR-10' }, as('ali', 'call-2') as never)).toEqual({ paid: true });
    expect(state.paid).toBe(1);
  });

  it('F3a 04-bilet: a business rejection ("out of stock") is not a done duplicate in the next request (keyless, thread dup guard)', async () => {
    let stock = 0; let runs = 0;
    const reserve = durable.gnlTool(tool({ description: 'r', inputSchema: z.object({ event: z.string(), n: z.number() }), execute: async () => {
      runs++; return stock >= 2 ? { ok: true } : refusedOr({ ok: false, reason: 'stok yok' });
    } }), { sideEffect: true } as any);
    const journal = new InMemoryJournal();
    const limits = { sideEffectDuplicates: { action: 'suspend' as const, scope: 'thread' as const } };
    await runDurable({ runId: 'b1', threadId: 'T', journal, model: callsOnce('reserve', { event: 'konser', n: 2 }, 'c1'), tools: { reserve }, prompt: 'x', stopWhen: stepCountIs(4), resourceId: 'ayse', limits } as any);
    stock = 10;
    const r2: any = await runDurable({ runId: 'b2', threadId: 'T', journal, model: callsOnce('reserve', { event: 'konser', n: 2 }, 'c2'), tools: { reserve }, prompt: 'x', stopWhen: stepCountIs(4), resourceId: 'ayse', limits } as any);
    expect(r2.interrupts ?? []).toEqual([]);
    expect(runs).toBe(2);
  });

  it('F3b sibling: args mode, same request — the model retries after the rejection with a new call id', async () => {
    let stock = 0; let runs = 0;
    const reserve = durable.gnlTool(tool({ description: 'r', inputSchema: z.object({ event: z.string() }), execute: async () => {
      runs++; const r = stock > 0 ? { ok: true } : refusedOr({ ok: false, reason: 'stok yok' }); stock = 5; return r;
    } }), { sideEffect: true, idempotency: 'args' } as any);
    const m = createMockModel(async ({ prompt }: any) => {
      const n = countToolResults(prompt);
      return n < 2 ? toolCallResult('reserve', `c${n}`, { event: 'konser' }) : finalTextResult('done');
    });
    await runDurable({ runId: 'b3', journal: new InMemoryJournal(), model: m, tools: { reserve }, prompt: 'x', stopWhen: stepCountIs(5), resourceId: 'ayse' });
    expect(runs).toBe(2);
  });
});

describe('F4 recover / lookup / compensate see who the call is for', () => {
  it('F4a recover() is handed the call context', async () => {
    const seen: unknown[] = []; let n = 0;
    const charge = Object.assign(tool({ description: 'c', inputSchema: z.object({ id: z.string() }), execute: async () => { if (n++ === 0) throw new Error('timeout'); return { ok: 1 }; } }),
      { sideEffect: true, idempotencyWindow: 'cross-run' as const, recover: async (_i: unknown, o: unknown) => { seen.push(userIdOf(identityOf(o))); return { done: true as const, output: { ok: 'recovered' } }; } });
    const t = withIdempotency({ charge }, { journal: new InMemoryJournal() });
    await t.charge.execute!({ id: 'x' }, as('ayse') as never).catch(() => undefined);
    await t.charge.execute!({ id: 'x' }, as('ayse') as never);
    expect(seen).toEqual(['ayse']);
  });

  it('F4b sibling: lookup() is handed the call context', async () => {
    const seen: unknown[] = [];
    const charge = Object.assign(tool({ description: 'c', inputSchema: z.object({ id: z.string() }), execute: async () => ({ ok: 1 }) }),
      { sideEffect: true, lookup: async (_i: unknown, o: unknown) => { seen.push(userIdOf(identityOf(o))); return { exists: false as const }; } });
    await runDurable({ runId: 'lk', journal: new InMemoryJournal(), model: callsOnce('charge', { id: 'x' }), tools: { charge }, prompt: 'x', stopWhen: stepCountIs(4), resourceId: 'ayse' });
    expect(seen).toEqual(['ayse']);
  });

  it('F4c sibling: compensate() (compensateRun) is handed the run owner', async () => {
    const seen: unknown[] = [];
    const book = Object.assign(tool({ description: 'b', inputSchema: z.object({ id: z.string() }), execute: async () => ({ booked: 1 }) }),
      { sideEffect: true, compensate: async (_i: unknown, _o: unknown, opts: unknown) => { seen.push(userIdOf(identityOf(opts))); return { cancelled: 1 }; } });
    const journal = new InMemoryJournal();
    await runDurable({ runId: 'saga', journal, model: callsOnce('book', { id: 'h1' }), tools: { book }, prompt: 'x', stopWhen: stepCountIs(4), resourceId: 'ayse' });
    await compensateRun('saga', { journal, tools: { book } as never });
    expect(seen).toEqual(['ayse']);
  });
});

describe('F5 the dynamic tools/system context carries the run\'s caller', () => {
  const probeAgent = (seen: Array<Record<string, unknown>>) => ({
    model: createMockModel(async () => finalTextResult('ok')),
    tools: (ctx: Record<string, unknown>) => { seen.push({ ...serverIdentityOf(ctx), org: ctx.org }); return {}; },
  });

  it('F5a control: a door-sealed call — the tools function sees the user and org', async () => {
    const seen: Array<Record<string, unknown>> = [];
    await createGnl({ storage: new InMemoryStorage(), agents: { a: probeAgent(seen) } } as any)
      .run('a', { runId: 'd0', prompt: 'x', context: sealRequestContext({}, { resourceId: 'u1', orgId: 'org-1' }) } as any);
    expect(seen[0]).toMatchObject({ resourceId: 'u1', org: 'org-1' });
  });

  it('F5b continuation shape (what a takeover passes: caller, no context) — tools function sees nobody', async () => {
    const seen: Array<Record<string, unknown>> = [];
    await createGnl({ storage: new InMemoryStorage(), agents: { a: probeAgent(seen) } } as any)
      .run('a', { runId: 'd1', prompt: 'x', caller: user('u1', 'org-1') } as any);
    expect(seen[0]).toMatchObject({ resourceId: 'u1', org: 'org-1' });
  });

  it('F5c 09-sigorta: a direct gnl.run with resourceId — tools function sees nobody, tool set silently empty', async () => {
    const seen: Array<Record<string, unknown>> = [];
    await createGnl({ storage: new InMemoryStorage(), agents: { a: probeAgent(seen) } } as any)
      .run('a', { runId: 'd2', prompt: 'x', resourceId: 'ayse' } as any);
    expect(seen[0]).toMatchObject({ resourceId: 'ayse' });
  });
});

describe('F6 what execute is told about the call', () => {
  it('F6a a confirm-approved call tells execute it was approved', async () => {
    const seen: unknown[] = [];
    const send = durable.gnlTool(tool({ description: 's', inputSchema: z.object({ po: z.string() }), execute: async (_i, o) => { seen.push((o as any).gnl?.approved); return { sent: 1 }; } }),
      { sideEffect: true, confirm: true } as any);
    const storage = new InMemoryStorage();
    const cfg = { storage, agents: { a: { model: callsOnce('send', { po: 'P1' }), tools: { send } } } } as any;
    const r1: any = await createGnl(cfg).run('a', { runId: 'cf', prompt: 'x', resourceId: 'ayse' } as any);
    await createGnl(cfg).run('a', { runId: 'cf', prompt: 'x', resourceId: 'ayse', approvals: { [r1.interrupts[0].toolCallId]: true } } as any);
    expect(seen).toEqual([true]);
  });

  it('F6b a keyless tool still gets options.idempotencyKey (runId:toolCallId)', async () => {
    const seen: unknown[] = [];
    const t = Object.assign(tool({ description: 't', inputSchema: z.object({}), execute: async (_i, o) => { seen.push((o as any).idempotencyKey); return 1; } }), { sideEffect: true });
    await runDurable({ runId: 'k1', journal: new InMemoryJournal(), model: callsOnce('t', {}), tools: { t }, prompt: 'x', stopWhen: stepCountIs(4), resourceId: 'ayse' });
    // format-agnostic: one string that names the run and the model's call id (the engine decorates the call id)
    expect(seen).toHaveLength(1);
    expect(typeof seen[0]).toBe('string');
    expect(String(seen[0]).startsWith('k1:')).toBe(true);
    expect(String(seen[0])).toContain('c1');
  });
});
