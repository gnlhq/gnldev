// d25 P2 madde 5 (identity/KARAR-1): recover, lookup, compensate and idempotencyKey get the SAME call
// context `execute` gets (`identityOf(opts)` works in each); the "approved" fact is in the context.
//
// Spec by behaviour: only `identityOf(opts)` and `opts.gnl.approved` (named by the decision) are read.
// Existing fields stay (idempotencyKey / toolCallId / runId) — back-compat is asserted too.
import { describe, it, expect } from 'vitest';
import { tool, stepCountIs } from 'ai';
import { z } from 'zod';
import * as durable from '../src/index.js';
import { InMemoryJournal } from '../src/journal.js';
import { InMemoryStorage } from '../src/in-memory-storage.js';
import { runDurable } from '../src/run.js';
import { createGnl, sealRequestContext } from '../src/registry.js';
import { withIdempotency } from '../src/idempotent-tools.js';
import { compensateRun } from '../src/compensation.js';
import { identityOf, toolContextFor, runIdentity, user } from '../src/run-identity.js';
import { createMockModel, countToolResults, toolCallResult, finalTextResult } from './mock.js';

const seenBy = (o: unknown) => { const i: any = identityOf(o); return { kind: i.kind, id: i.id, orgId: i.orgId, runId: i.runId }; };
const AYSE = { kind: 'user', id: 'ayse', orgId: 'org-1', runId: 'h1' };
const callsOnce = (name: string, args: unknown, id = 'c1') => createMockModel(async ({ prompt }: any) => {
  const lastUser = prompt.map((m: any) => m.role).lastIndexOf('user');
  return countToolResults(prompt.slice(lastUser)) === 0 ? toolCallResult(name, id, args) : finalTextResult('done');
});
const sealed = () => sealRequestContext({}, { resourceId: 'ayse', orgId: 'org-1' });
const callCtx = (toolCallId: string) => ({ toolCallId, messages: [], gnl: toolContextFor(runIdentity(user('ayse', 'org-1'), 'h1')) });

/** One tool whose body and every hook write what they were told into `log`. */
function probeTool(log: Record<string, unknown[]>, opts: { failOnce?: boolean; shared?: boolean } = {}) {
  let n = 0;
  const push = (k: string, v: unknown) => (log[k] ??= []).push(v);
  return durable.gnlTool(tool({
    description: 'charge', inputSchema: z.object({ id: z.string() }),
    execute: async (_i, o) => { push('exec', seenBy(o)); if (opts.failOnce && n++ === 0) throw new Error('timeout'); return { charged: 1 }; },
  }), {
    sideEffect: true, idempotencyWindow: opts.shared === false ? 'run' : 'cross-run',
    idempotencyKey: (i: any, o?: unknown) => { push('idem', seenBy(o)); return i.id; },
    lookup: async (_i: unknown, o: unknown) => { push('lookup', seenBy(o)); return { exists: false as const }; },
    recover: async (_i: unknown, o: any) => { push('recover', { ...seenBy(o), key: o.idempotencyKey, call: o.toolCallId }); return { done: true as const, output: { charged: 'recovered' } }; },
    compensate: async (_i: unknown, _o: unknown, o: any) => { push('compensate', { ...seenBy(o), key: o.idempotencyKey, call: o.toolCallId, runId: o.runId }); return { cancelled: 1 }; },
  } as any);
}

describe('P2-5 the hooks see the call context execute sees (agent path through createGnl.run)', () => {
  it('idempotencyKey, lookup and execute agree on kind / user / org / run', async () => {
    const log: Record<string, unknown[]> = {};
    await createGnl({ storage: new InMemoryStorage(), agents: { a: { model: callsOnce('charge', { id: 'x' }), tools: { charge: probeTool(log) } } } } as any)
      .run('a', { runId: 'h1', prompt: 'x', context: sealed() } as any);
    expect(log.exec).toEqual([AYSE]);
    expect(log.idem?.[0]).toEqual(AYSE);
    expect(log.lookup?.[0]).toEqual(AYSE);
    // every call of every hook in the run says the same
    for (const k of ['idem', 'lookup']) for (const s of log[k] ?? []) expect(s).toEqual(AYSE);
  });

  it('recover (after a failed first attempt) is handed the context, and still the old fields', async () => {
    const log: Record<string, unknown[]> = {};
    const t = withIdempotency({ charge: probeTool(log, { failOnce: true }) } as any, { journal: new InMemoryJournal() }) as any;
    await t.charge.execute({ id: 'x' }, callCtx('t1')).catch(() => undefined);
    await t.charge.execute({ id: 'x' }, callCtx('t1'));
    expect(log.recover?.length).toBeGreaterThanOrEqual(1);
    expect(log.recover![0]).toMatchObject({ ...AYSE, call: 't1' });
    expect(typeof (log.recover![0] as any).key).toBe('string');
    expect((log.recover![0] as any).key.length).toBeGreaterThan(0);
  });

  it('compensate (compensateRun) is handed the RUN OWNER\'s context, same user/org/run as execute saw', async () => {
    const log: Record<string, unknown[]> = {};
    const journal = new InMemoryJournal();
    const charge = probeTool(log, { shared: false });
    await runDurable({ runId: 'h1', journal, model: callsOnce('charge', { id: 'x' }), tools: { charge }, prompt: 'x', stopWhen: stepCountIs(4), resourceId: 'ayse' });
    await compensateRun('h1', { journal, tools: { charge } as never });
    expect(log.compensate).toHaveLength(1);
    expect(log.compensate![0]).toMatchObject({ kind: 'user', id: 'ayse', runId: 'h1' });
    expect(log.compensate![0]).toMatchObject({ kind: (log.exec![0] as any).kind, id: (log.exec![0] as any).id, runId: (log.exec![0] as any).runId });
    // the old fields are still there
    expect(typeof (log.compensate![0] as any).call).toBe('string');
    expect(typeof (log.compensate![0] as any).key).toBe('string');
  });

  it('compensate sees the run owner\'s ORG too when the run was sealed with one (through the door)', async () => {
    const log: Record<string, unknown[]> = {};
    const storage = new InMemoryStorage();
    const cfg = { storage, agents: { a: { model: callsOnce('charge', { id: 'x' }), tools: { charge: probeTool(log, { shared: false }) } } } } as any;
    await createGnl(cfg).run('a', { runId: 'h1', prompt: 'x', context: sealed() } as any);
    await compensateRun('h1', { journal: storage.runs as any, tools: { charge: probeTool(log, { shared: false }) } as never });
    expect(log.compensate?.[0]).toMatchObject({ kind: 'user', id: 'ayse', orgId: 'org-1' });
  });
});

describe('P2-5 sibling: hooks work with the ordinary identity channel, nothing else required', () => {
  it('an idempotencyKey written with ONE argument (old style) still works and the key is used', async () => {
    let runs = 0;
    const book = Object.assign(tool({ description: 'b', inputSchema: z.object({ slot: z.string() }), execute: async () => { runs++; return { ok: 1 }; } }),
      { sideEffect: true, idempotencyWindow: 'cross-run' as const, idempotencyKey: (i: any) => i.slot });
    const t = withIdempotency({ book }, { journal: new InMemoryJournal() }) as any;
    await t.book.execute({ slot: 'sat' }, callCtx('u1'));
    await t.book.execute({ slot: 'sat' }, callCtx('u2'));
    expect(runs).toBe(1);
  });

  it('the idempotencyKey hook gets the same context on a RESUMED call (same call asked again)', async () => {
    const seen: unknown[] = [];
    const book = Object.assign(tool({ description: 'b', inputSchema: z.object({ slot: z.string() }), execute: async () => ({ ok: 1 }) }),
      { sideEffect: true, idempotencyWindow: 'cross-run' as const, idempotencyKey: (i: any, o?: unknown) => { seen.push(seenBy(o)); return i.slot; } });
    const t = withIdempotency({ book }, { journal: new InMemoryJournal() }) as any;
    await t.book.execute({ slot: 'sat' }, callCtx('u1'));
    await t.book.execute({ slot: 'sat' }, callCtx('u1'));
    expect(seen.length).toBeGreaterThanOrEqual(2);
    for (const s of seen) expect(s).toEqual(AYSE);
  });
});

describe('P2-5 approved: the call context says an approved call is approved', () => {
  const sendTool = (seen: Array<{ where: string; approved: unknown }>) => durable.gnlTool(tool({
    description: 's', inputSchema: z.object({ po: z.string() }),
    execute: async (_i, o) => { seen.push({ where: 'exec', approved: (o as any).gnl?.approved }); return { sent: 1 }; },
  }), { sideEffect: true, confirm: true } as any);

  it('after a human "yes", execute sees approved === true; the first (asking) pass never ran the body', async () => {
    const seen: Array<{ where: string; approved: unknown }> = [];
    const storage = new InMemoryStorage();
    const cfg = { storage, agents: { a: { model: callsOnce('send', { po: 'P1' }), tools: { send: sendTool(seen) } } } } as any;
    const r1: any = await createGnl(cfg).run('a', { runId: 'cf', prompt: 'x', resourceId: 'ayse' } as any);
    expect(seen).toEqual([]);
    await createGnl(cfg).run('a', { runId: 'cf', prompt: 'x', resourceId: 'ayse', approvals: { [r1.interrupts[0].toolCallId]: true } } as any);
    expect(seen).toEqual([{ where: 'exec', approved: true }]);
  });

  it('a tool that needed no approval is NOT told it was approved (never true)', async () => {
    const seen: unknown[] = [];
    const t = durable.gnlTool(tool({ description: 't', inputSchema: z.object({}), execute: async (_i, o) => { seen.push((o as any).gnl?.approved); return 1; } }), { sideEffect: true } as any);
    await runDurable({ runId: 'n1', journal: new InMemoryJournal(), model: callsOnce('t', {}), tools: { t }, prompt: 'x', stopWhen: stepCountIs(4), resourceId: 'ayse' });
    expect(seen).toHaveLength(1);
    expect(seen[0]).not.toBe(true);
  });

  it('keyless tools still get options.idempotencyKey (a string that names the run), approved or not', async () => {
    const seen: unknown[] = [];
    const t = Object.assign(tool({ description: 't', inputSchema: z.object({}), execute: async (_i, o) => { seen.push((o as any).idempotencyKey); return 1; } }), { sideEffect: true });
    await runDurable({ runId: 'k1', journal: new InMemoryJournal(), model: callsOnce('t', {}), tools: { t }, prompt: 'x', stopWhen: stepCountIs(4), resourceId: 'ayse' });
    expect(typeof seen[0]).toBe('string');
    expect(String(seen[0])).toContain('k1');
  });
});
