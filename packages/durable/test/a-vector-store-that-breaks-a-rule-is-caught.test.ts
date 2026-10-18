// The vector kit is only as good as what it catches. Each store in naive-vector-stores.ts breaks one rule
// and must fail the kit's scenario for THAT rule (not merely some scenario); the control, which breaks
// nothing, must pass every one. Measured before this kit (raporlar/2026-10-18-vector): the exported kit
// caught 1 of 10 such stores.
import { describe, it, expect } from 'vitest';
import { vectorStoreConformance } from '../src/testing.js';
import { NAIVE_VECTOR_STORES } from './naive-vector-stores.js';

/** Runs the kit's scenarios against one store, outside the runner, and returns the ids that failed. */
async function failedScenarios(make: () => unknown): Promise<string[]> {
  const scenarios: Array<[string, () => Promise<void>]> = [];
  vectorStoreConformance('probe', make as never, {
    describe: (_n: string, fn: () => void) => fn(),
    it: (title: string, fn: () => Promise<void>) => { scenarios.push([title, fn]); },
  });
  const failed: string[] = [];
  for (const [title, fn] of scenarios) { try { await fn(); } catch { failed.push(title.split(' ')[0]!); } }
  return failed;
}

describe('a vector store that breaks a rule is caught', () => {
  for (const [id, { breaks, caughtBy, make }] of Object.entries(NAIVE_VECTOR_STORES)) {
    it(`${id} (${breaks})${caughtBy ? ` — caught by ${caughtBy}` : ''}`, async () => {
      const failed = await failedScenarios(make);
      if (id === 'CONTROL') expect(failed, 'a correct store passes every scenario').toEqual([]);
      else expect(failed, `${id} must fail ${caughtBy}`).toContain(caughtBy);
    }, 60_000);
  }
});
