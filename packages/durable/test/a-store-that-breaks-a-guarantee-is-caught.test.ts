// The store conformance kit is only as good as what it catches. Each store in naive-stores.ts breaks one
// guarantee; each must be refused where it enters, or fail at least one of the kit's scenarios — and the
// control, which breaks nothing, must pass every one. Measured before the kit grew (raporlar, Mod 3):
// the kit caught 4 of these 8; a store with no guarantees at all passed 20 of 21 scenarios.
import { describe, it, expect } from 'vitest';
import { journalConformance } from '../src/testing.js';
import { missingGuarantees } from '../src/journal.js';
import { NAIVE_STORES } from './naive-stores.js';

/** Runs the kit's scenarios against one store, outside the runner, and returns the titles that failed. */
async function failedScenarios(make: () => any): Promise<string[]> {
  const scenarios: Array<[string, () => Promise<void>]> = [];
  journalConformance('probe', () => ({ journal: make() }), {
    describe: (_n: string, fn: () => void) => fn(),
    it: (title: string, fn: () => Promise<void>) => { scenarios.push([title, fn]); },
    timeout: 60_000,
  });
  const failed: string[] = [];
  for (const [title, fn] of scenarios) { try { await fn(); } catch { failed.push(title.split(' ')[0]!); } }
  return failed;
}

describe('a store that breaks a guarantee is caught', () => {
  for (const [id, { breaks, make }] of Object.entries(NAIVE_STORES)) {
    it(`${id} (${breaks})`, async () => {
      const refused = missingGuarantees(make()).length > 0;
      const failed = await failedScenarios(make);
      if (id === 'CONTROL') {
        expect(refused).toBe(false);
        expect(failed, 'a correct store passes every scenario').toEqual([]);
      } else {
        expect(refused || failed.length > 0, `${id} slipped through: refused=${refused}, failed=${failed.join(',')}`).toBe(true);
      }
    }, 120_000);
  }
});
