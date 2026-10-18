// The store conformance kit is only as good as what it catches. Each store in naive-stores.ts breaks one
// guarantee; each must be refused where it enters, or fail at least one of the kit's scenarios — and the
// control, which breaks nothing, must pass every one. Measured before the kit grew (raporlar, Mod 3):
// the kit caught 4 of these 8; a store with no guarantees at all passed 20 of 21 scenarios.
import { describe, it, expect } from 'vitest';
import { journalConformance } from '../src/testing.js';
import { missingGuarantees } from '../src/journal.js';
import { toJournal } from '../src/index.js';
import { NAIVE_STORES, wrap } from './naive-stores.js';
import { mysqlStores } from './real-backends.js';

/** Runs the kit's scenarios against one store, outside the runner, and returns the titles that failed. */
async function failedScenarios(make: () => any, close?: (journal: any) => Promise<void>): Promise<string[]> {
  const scenarios: Array<[string, () => Promise<void>]> = [];
  journalConformance('probe', async () => { const journal = await make(); return { journal, ...(close ? { close: () => close(journal) } : {}) }; }, {
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

// The same on a real server: a MySQL / MariaDB journal passes every scenario, and the same journal with
// one guarantee broken the way N2 / N3 break it (read, wait, write) fails one.
const tick = () => new Promise((r) => setTimeout(r, 0));
for (const [name, make] of mysqlStores(' (real)')) {
  describe(`a store that breaks a guarantee is caught — ${name}`, () => {
    const opened = new Map<any, { close(): Promise<void> }>();
    const journalOf = (over: (t: any) => Record<string, unknown>) => async () => {
      const s = await make();
      const j = over === NONE ? toJournal(s.runs) : wrap(over, [], toJournal(s.runs));
      opened.set(j, s);
      return j;
    };
    const close = async (j: any) => { await opened.get(j)?.close(); opened.delete(j); };
    const NONE = () => ({});
    const variants: Array<[string, (t: any) => Record<string, unknown>]> = [
      ['CONTROL (nothing)', NONE],
      ['N2 (putIfMatch reads, waits, then writes)', (t) => ({ putIfMatch: async (k: string, e: unknown, v: unknown) => { const cur = await t.get(k); await tick(); if (cur === undefined || JSON.stringify(cur) !== JSON.stringify(e)) return false; await t.put(k, v); return true; } })],
      ['N3 (putIfAbsent reads, waits, then writes)', (t) => ({ putIfAbsent: async (k: string, v: unknown) => { const had = await t.get(k); await tick(); if (had !== undefined) return false; await t.put(k, v); return true; } })],
    ];
    for (const [id, over] of variants) {
      it(id, async () => {
        const failed = await failedScenarios(journalOf(over), close);
        if (over === NONE) expect(failed, 'a correct store passes every scenario').toEqual([]);
        else expect(failed.length, `${id} slipped through`).toBeGreaterThan(0);
      }, 600_000);
    }
  });
}
