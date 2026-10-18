// GetOrgUsage returns zero usage
// when it can't list runs, so isBudgetExceeded is always false — a configured budget silently never fires.
// Mirror of C4: checkBudget now emits a LOUD one-time warn (once per store) naming the disabled cap.
import { describe, it, expect, vi, afterEach } from 'vitest';
import { checkBudget, budgetsEnforceable } from '../src/budget.js';
import { InMemoryJournal } from '../src/journal.js';

afterEach(() => vi.restoreAllMocks());

/** A store with every guarantee, and deliberately NO `listRuns` (usage cannot be computed). */
class NoListRunsJournal extends InMemoryJournal {
  override listRuns = undefined as never;
  override listRunsPaged = undefined as never;
}

const unenforceableWarns = (spy: ReturnType<typeof vi.spyOn>) =>
  spy.mock.calls.filter((c) => String(c[0]).includes('does not implement `listRuns`'));

describe('C5 — budget on a journal without listRuns', () => {
  it('budgetsEnforceable is false and checkBudget WARNS while failing open (exceeded=false)', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const j = new NoListRunsJournal();
    expect(budgetsEnforceable(j)).toBe(false);

    const check = await checkBudget(j, 'acme', { usdLimit: 1 });
    expect(check.exceeded).toBe(false); // fail-open: unchanged behavior
    expect(unenforceableWarns(warn)).toHaveLength(1); // but LOUD now
    expect(String(unenforceableWarns(warn)[0][0])).toContain('NOT ENFORCED');
  });

  it('does NOT warn when no budget is configured (zero-cost early exit, nothing to enforce)', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const j = new NoListRunsJournal();
    const check = await checkBudget(j, 'acme'); // no journal budget, no fallback
    expect(check.exceeded).toBe(false);
    expect(unenforceableWarns(warn)).toHaveLength(0);
  });

  it('warns ONCE per store across multiple checks (once-per-store WeakSet)', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const j = new NoListRunsJournal();
    await checkBudget(j, 'acme', { usdLimit: 1 });
    await checkBudget(j, 'acme', { usdLimit: 1 });
    expect(unenforceableWarns(warn)).toHaveLength(1);
  });
});
