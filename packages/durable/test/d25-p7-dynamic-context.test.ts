// d25 P2 madde 7 (identity/KARAR-4): when no door sealed the call, the dynamic `tools` / `system` / `model`
// argument is filled with the identity the engine RESOLVED for the run (user, org, thread) — direct
// `gnl.run`, a continuation, a takeover (real two-process scenarios: d25-p2-takeover.test.ts). A door's seal
// is never overridden; the developer's own keys survive; and an anonymous call whose dynamic tool set comes
// back EMPTY is not silent (a warning or an error — the test accepts either).
import { describe, it, expect, vi, afterEach } from 'vitest';
import { InMemoryStorage } from '../src/in-memory-storage.js';
import { createGnl, serverIdentityOf, sealRequestContext } from '../src/registry.js';
import { user, staff } from '../src/run-identity.js';
import { tool } from 'ai';
import { z } from 'zod';
import { createMockModel, finalTextResult } from './mock.js';

afterEach(() => vi.restoreAllMocks());
const view = (ctx: Record<string, unknown>) => ({ ...serverIdentityOf(ctx), org: ctx.org, role: ctx.role });
const gnlWith = (seen: Array<Record<string, unknown>>, extra: Record<string, unknown> = {}) => createGnl({ storage: new InMemoryStorage(), agents: { a: {
  model: createMockModel(async () => finalTextResult('ok')),
  tools: (ctx: Record<string, unknown>) => { seen.push(view(ctx)); return {}; },
  system: (ctx: Record<string, unknown>) => { seen.push({ sys: true, ...view(ctx) }); return 'sys'; },
  ...extra,
} } } as any);

describe('P2-7 unsealed calls: the context carries the identity the engine resolved', () => {
  it('direct run with resourceId: tools AND system see the user', async () => {
    const seen: Array<Record<string, unknown>> = [];
    await gnlWith(seen).run('a', { runId: 'x1', prompt: 'x', resourceId: 'ayse' } as any);
    expect(seen.length).toBeGreaterThanOrEqual(2);
    for (const s of seen) expect(s).toMatchObject({ resourceId: 'ayse' });
  });

  it('a caller with an org (what a takeover / continuation passes): user AND org are filled, `org` is the documented name', async () => {
    const seen: Array<Record<string, unknown>> = [];
    await gnlWith(seen).run('a', { runId: 'x2', prompt: 'x', caller: user('u1', 'org-1') } as any);
    for (const s of seen) expect(s).toMatchObject({ resourceId: 'u1', orgId: 'org-1', org: 'org-1' });
  });

  it('stream path: same (the rule is not run()-only)', async () => {
    const seen: Array<Record<string, unknown>> = [];
    const r: any = await gnlWith(seen).stream('a', { runId: 'x3', prompt: 'x', caller: user('u1', 'org-1') } as any);
    await r.consumeStream?.();
    expect(seen.length).toBeGreaterThanOrEqual(1);
    for (const s of seen) expect(s).toMatchObject({ resourceId: 'u1', orgId: 'org-1' });
  });

  it('staff caller: the staff fact is filled, not a user', async () => {
    const seen: Array<Record<string, unknown>> = [];
    await gnlWith(seen).run('a', { runId: 'x4', prompt: 'x', caller: staff('org-9') } as any);
    for (const s of seen) { expect(s).toMatchObject({ staff: true }); expect(s.resourceId).toBeUndefined(); }
  });

  it('the thread the run belongs to is filled too', async () => {
    const seen: Array<Record<string, unknown>> = [];
    await gnlWith(seen).run('a', { runId: 'x5', prompt: 'x', resourceId: 'ayse', threadId: 'T-7' } as any);
    for (const s of seen) expect(s).toMatchObject({ resourceId: 'ayse', threadId: 'T-7' });
  });

  it('the developer\'s own context keys survive next to the filled identity', async () => {
    const seen: Array<Record<string, unknown>> = [];
    await gnlWith(seen).run('a', { runId: 'x6', prompt: 'x', resourceId: 'ayse', context: { role: 'admin' } } as any);
    for (const s of seen) expect(s).toMatchObject({ resourceId: 'ayse', role: 'admin' });
  });

  it('a client cannot feed the identity through the context of an UNSEALED call: the engine\'s own value wins', async () => {
    const seen: Array<Record<string, unknown>> = [];
    await gnlWith(seen).run('a', { runId: 'x7', prompt: 'x', resourceId: 'ayse', context: { __gnl_resourceId: 'victim', __gnl_orgId: 'other-org', org: 'other-org' } } as any);
    for (const s of seen) { expect(s.resourceId).toBe('ayse'); expect(s.orgId).not.toBe('other-org'); expect(s.org).not.toBe('other-org'); }
  });

  it('control: a door-sealed call is untouched (the seal is the identity, `caller` does not override it)', async () => {
    const seen: Array<Record<string, unknown>> = [];
    await gnlWith(seen).run('a', { runId: 'x8', prompt: 'x', context: sealRequestContext({}, { resourceId: 'u1', orgId: 'org-1' }) } as any);
    for (const s of seen) expect(s).toMatchObject({ resourceId: 'u1', org: 'org-1' });
  });

  it('the dynamic `model` function is resolved with the same context', async () => {
    const seen: Array<Record<string, unknown>> = [];
    const g = createGnl({ storage: new InMemoryStorage(), agents: { a: {
      model: (ctx: Record<string, unknown>) => { seen.push(view(ctx)); return createMockModel(async () => finalTextResult('ok')); },
    } } } as any);
    await g.run('a', { runId: 'x9', prompt: 'x', resourceId: 'ayse' } as any);
    expect(seen.length).toBeGreaterThanOrEqual(1);
    for (const s of seen) expect(s).toMatchObject({ resourceId: 'ayse' });
  });
});

describe('P2-7 an anonymous call with an empty dynamic tool set is not silent', () => {
  /** "Visible": the run rejects, or something was warned/logged about it, or the result carries warnings. */
  async function visibleOutcome(run: () => Promise<any>) {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    let rejected: unknown; let result: any;
    try { result = await run(); } catch (e) { rejected = e; }
    const logged = [...warn.mock.calls, ...err.mock.calls].map((c) => c.join(' ')).join('\n');
    const warnings = Array.isArray(result?.warnings) ? result.warnings.length : 0;
    return { rejected, logged, warnings, visible: rejected !== undefined || /tool/i.test(logged) || warnings > 0 };
  }
  const identityGated = () => createGnl({ storage: new InMemoryStorage(), agents: { a: {
    model: createMockModel(async () => finalTextResult('paid, thanks')),
    tools: (ctx: Record<string, unknown>) => (serverIdentityOf(ctx).resourceId
      ? { pay: tool({ description: 'p', inputSchema: z.object({}), execute: async () => 'ok' }) } : {}),
  } } } as any);

  it('no identity at all + tool set comes back empty: a warning or an error, not a silent "paid, thanks"', async () => {
    const o = await visibleOutcome(() => identityGated().run('a', { runId: 'e1', prompt: 'pay HSR-9' } as any));
    expect(o.visible, `silent: rejected=${String(o.rejected)} logged=${JSON.stringify(o.logged)}`).toBe(true);
  });

  it('control: the same agent with an identity gets its tools and nothing is raised', async () => {
    const o = await visibleOutcome(() => identityGated().run('a', { runId: 'e2', prompt: 'pay HSR-9', resourceId: 'ayse' } as any));
    expect(o.rejected).toBeUndefined();
  });

  it('control: an agent that declares NO tools at all stays quiet (empty by design)', async () => {
    const g = createGnl({ storage: new InMemoryStorage(), agents: { a: { model: createMockModel(async () => finalTextResult('hi')) } } } as any);
    const o = await visibleOutcome(() => g.run('a', { runId: 'e3', prompt: 'hi' } as any));
    expect(o.rejected).toBeUndefined();
    expect(o.logged).not.toMatch(/tool/i);
  });
});
