// K2 (decision 2a): a body that is still running `unheededAfterMs` after its right to run was lost (or
// its hold time ran out) did not observe its signal: warn ONCE per grant. A body that stops in time, a
// cancel and a release warn nothing.
import { describe, it, expect, vi, afterEach } from 'vitest';
import { executionGrant } from '../src/execution-grant.js';

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
afterEach(() => vi.restoreAllMocks());
const warned = (spy: ReturnType<typeof vi.spyOn>) => spy.mock.calls.map((c) => String(c[0])).filter((m) => /still running/.test(m));

describe('executionGrant unheededAfterMs', () => {
  it('lease-lost and the body still running after the window: exactly one warning, naming the unit', async () => {
    const spy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const g = executionGrant('unit-1', { unheededAfterMs: 50 });
    g.revoke('lease-lost');
    g.revoke('lease-lost');
    await sleep(200);
    await g.dispose();
    const w = warned(spy);
    expect(w).toHaveLength(1);
    expect(w[0]).toContain('unit-1');
    expect(w[0]).toMatch(/lease was lost/);
    // No package's words: a grant given none names no ctx.run (events, for one, has none).
    expect(w[0]).not.toMatch(/ctx\./);
  });
  it("the warning is said in the package's words (`unheeded`): its body, its signal, its advice", async () => {
    const spy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const unheeded = { body: 'the handler', signal: 'meta.signal', lost: 'LOST-ADVICE.', timeout: 'TIMEOUT-ADVICE.' };
    const a = executionGrant('unit-l', { unheededAfterMs: 30, unheeded });
    a.revoke('lease-lost');
    const b = executionGrant('unit-t', { maxHoldMs: 10, unheededAfterMs: 30, unheeded });
    await sleep(150);
    await a.dispose(); await b.dispose();
    const w = warned(spy);
    expect(w).toHaveLength(2);
    expect(w.find((m) => m.startsWith('unit-l'))).toMatch(/but the handler is still running 30 ms later — meta\.signal may not be observed .* LOST-ADVICE\.$/);
    expect(w.find((m) => m.startsWith('unit-t'))).toMatch(/hold time \(maxHoldMs\) is up, but the handler is still running .* TIMEOUT-ADVICE\.$/);
  });
  it('the body stops (dispose) inside the window: no warning', async () => {
    const spy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const g = executionGrant('unit-2', { unheededAfterMs: 80 });
    g.revoke('lease-lost');
    await sleep(10);
    await g.dispose();
    await sleep(200);
    expect(warned(spy)).toHaveLength(0);
  });
  it('timeout: one warning that names the time limit, not a takeover', async () => {
    const spy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const g = executionGrant('unit-3', { maxHoldMs: 30, unheededAfterMs: 50 });
    await sleep(250);
    await g.dispose();
    const w = warned(spy);
    expect(w).toHaveLength(1);
    expect(w[0]).toMatch(/maxHoldMs/);
    expect(w[0]).not.toMatch(/lease was lost/);
  });
  it('canceled and released are not losses: no warning', async () => {
    const spy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    for (const why of ['canceled', 'released'] as const) {
      const g = executionGrant(`unit-${why}`, { unheededAfterMs: 30 });
      g.revoke(why);
      await sleep(120);
      await g.dispose();
    }
    expect(warned(spy)).toHaveLength(0);
  });
  it('a lease lost after a timeout (first revocation wins): still one warning in all', async () => {
    const spy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const g = executionGrant('unit-4', { maxHoldMs: 20, unheededAfterMs: 40 });
    await sleep(30);
    g.revoke('lease-lost');
    await sleep(200);
    await g.dispose();
    expect(warned(spy)).toHaveLength(1);
  });
});
