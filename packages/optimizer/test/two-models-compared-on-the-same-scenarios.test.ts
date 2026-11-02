// Two models on the same scenarios: what the candidate costs as a share of the baseline, and where it
// does worse. A model that could not be asked is left out of the comparison, not counted as worse.
import { describe, it, expect } from 'vitest';
import { createMockModel } from '../../durable/test/mock.js';
import { DEFAULT_SUITE } from '@gnldev/experiment';
import { oracleModel } from '../../experiment/test/oracle.js';
import { compareOnSuite } from '../src/index.js';

describe('two models compared on the same scenarios', () => {
  it('the cost ratio of two models and the scenarios one does worse on', async () => {
    const pricing = { big: { inputPer1M: 10, outputPer1M: 40 }, small: { inputPer1M: 1, outputPer1M: 4 } };
    const c = await compareOnSuite({ baseline: oracleModel('big'), candidate: oracleModel('small'), pricing });
    expect(c.costRatio).toBeCloseTo(0.1, 9);
    expect(c.compared).toHaveLength(26);
    expect(c.regressions).toEqual([]);
    expect(c.baseline.results.every((r) => r.priced)).toBe(true);
  });

  it('a model that cannot be asked is left out of the comparison', async () => {
    const down = createMockModel(async () => { throw new Error('Not Found'); });
    down.modelId = 'down';
    const c = await compareOnSuite({ baseline: down, candidate: oracleModel('small'), scenarios: DEFAULT_SUITE.slice(0, 3) });
    expect(c.compared).toEqual([]);
    expect(c.improvements).toEqual([]);
  });

  it('a misspelled option is refused', async () => {
    await expect(compareOnSuite({ baseline: oracleModel('a'), candidate: oracleModel('b'), scenarioz: [] } as any)).rejects.toThrow(/scenarioz/);
  });
});
