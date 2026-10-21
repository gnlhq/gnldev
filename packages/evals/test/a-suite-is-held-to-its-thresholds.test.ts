// checkEvalThresholds / assertEvalThresholds: what makes an eval suite fail a gate. The traps a gate
// must not have: a misspelled scorer name that is never checked (so the gate never closes), and a case
// that crashed being averaged in as a 0 that a lenient mean still passes.
import { describe, it, expect } from 'vitest';
import { checkEvalThresholds, assertEvalThresholds, EvalThresholdError } from '../src/thresholds.js';
import type { EvalDatasetResult } from '../src/dataset.js';

const result = (cases: Array<{ id: string; s?: Record<string, number>; error?: string }>): EvalDatasetResult => {
  const names = [...new Set(cases.flatMap((c) => Object.keys(c.s ?? {})))];
  return {
    datasetId: 'd1',
    cases: cases.map((c) => ({ caseId: c.id, output: c.error ? '' : 'out', scores: Object.fromEntries(Object.entries(c.s ?? {}).map(([k, v]) => [k, { score: v, reason: `r-${c.id}` }])), ...(c.error ? { error: c.error } : {}) })),
    aggregate: Object.fromEntries(names.map((n) => [n, cases.reduce((a, c) => a + (c.s?.[n] ?? 0), 0) / cases.length])),
  };
};

describe('a suite is held to its thresholds', () => {
  const r = result([{ id: 'a', s: { faith: 1, tone: 0.9 } }, { id: 'b', s: { faith: 0.6, tone: 0.8 } }]);

  it('a number is the least mean: 0.8 passes at a mean of 0.8, fails at 0.81', () => {
    expect(checkEvalThresholds(r, { faith: 0.8 })).toEqual({ pass: true, failures: [] });
    expect(checkEvalThresholds(r, { faith: 0.81 }).failures).toEqual([{ scorer: 'faith', rule: 'mean', want: 0.81, got: 0.8 }]);
  });

  it('`every` names each case under it, with the scorer\'s reason', () => {
    expect(checkEvalThresholds(r, { faith: { every: 0.7 } }).failures).toEqual([{ scorer: 'faith', rule: 'every', want: 0.7, got: 0.6, caseId: 'b', reason: 'r-b' }]);
    expect(checkEvalThresholds(r, { faith: { mean: 0.5, every: 0.5 } }).pass).toBe(true);
  });

  it('a threshold naming a scorer the suite does not have fails — a typo cannot pass a gate', () => {
    expect(checkEvalThresholds(r, { faithfulnes: 0.1 }).failures).toEqual([{ scorer: 'faithfulnes', rule: 'missing' }]);
  });

  it('a case that did not finish fails the suite, even when the mean of the rest would pass', () => {
    const crashed = result([{ id: 'a', s: { faith: 1 } }, { id: 'b', s: { faith: 1 } }, { id: 'c', error: 'timed out' }]);
    expect(crashed.aggregate.faith).toBeCloseTo(2 / 3);
    expect(checkEvalThresholds(crashed, { faith: 0.5 }).failures).toEqual([{ scorer: '*', rule: 'case-error', caseId: 'c', reason: 'timed out' }]);
    expect(checkEvalThresholds(crashed, {}).pass).toBe(false);
  });

  it('refuses a threshold that is not a score: out of 0–1, not a number, or naming neither rule', () => {
    expect(() => checkEvalThresholds(r, { faith: 80 })).toThrow(/number from 0 to 1/);
    expect(() => checkEvalThresholds(r, { faith: { every: Number.NaN } })).toThrow(/number from 0 to 1/);
    expect(() => checkEvalThresholds(r, { faith: {} })).toThrow(/neither `mean` nor `every`/);
  });

  it('assertEvalThresholds throws an EvalThresholdError that reads as a report', () => {
    let err: unknown;
    try { assertEvalThresholds(r, { faith: 0.9, tone: { every: 0.85 }, nope: 0.1 }); } catch (e) { err = e; }
    expect(err).toBeInstanceOf(EvalThresholdError);
    expect((err as EvalThresholdError).failures.map((f) => f.rule)).toEqual(['mean', 'every', 'missing']);
    expect((err as Error).message).toBe([
      "@gnldev/evals: dataset 'd1' fell short:",
      '  faith: mean 0.800 < 0.900',
      '  tone: case b scored 0.800 < 0.850 (r-b)',
      '  nope: no scorer by this name in the suite (a misspelled name would otherwise pass unchecked)',
    ].join('\n'));
    expect(() => assertEvalThresholds(r, { faith: 0.8 })).not.toThrow();
  });
});
