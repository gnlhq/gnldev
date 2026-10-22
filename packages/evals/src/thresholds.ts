import type { EvalDatasetResult } from './dataset.js';

/**
 * What one scorer must reach for a suite to pass. A number is the least mean (`{ mean: n }`); `every`
 * is the least score of each case. Scores are 0–1, higher is better, as every built-in scorer reports.
 */
export type EvalThreshold = number | { mean?: number; every?: number };

/** One way a suite fell short. */
export interface EvalThresholdFailure {
  scorer: string;
  /** `mean` / `every`: under the threshold; `missing`: the suite has no scorer by that name; `case-error`: a case did not finish. */
  rule: 'mean' | 'every' | 'missing' | 'case-error';
  want?: number;
  got?: number;
  caseId?: string;
  reason?: string;
}

/** Thrown by `assertEvalThresholds`; `failures` says which scorer, which rule, which case. */
export class EvalThresholdError extends Error {
  readonly failures: EvalThresholdFailure[];
  constructor(datasetId: string, failures: EvalThresholdFailure[]) {
    super(`@gnldev/evals: dataset '${datasetId}' fell short:\n${failures.map(describe).join('\n')}`);
    this.name = 'EvalThresholdError';
    this.failures = failures;
  }
}

function describe(f: EvalThresholdFailure): string {
  switch (f.rule) {
    case 'missing': return `  ${f.scorer}: no scorer by this name in the suite (a misspelled name would otherwise pass unchecked)`;
    case 'case-error': return `  case ${f.caseId}: did not finish — ${f.reason ?? 'error'}`;
    case 'mean': return `  ${f.scorer}: mean ${fmt(f.got)} < ${fmt(f.want)}`;
    case 'every': return `  ${f.scorer}: case ${f.caseId} scored ${fmt(f.got)} < ${fmt(f.want)}${f.reason ? ` (${f.reason})` : ''}`;
  }
}
const fmt = (n: number | undefined) => (n === undefined ? '?' : n.toFixed(3));

function bound(scorer: string, rule: string, v: unknown): number | undefined {
  if (v === undefined) return undefined;
  if (typeof v !== 'number' || !Number.isFinite(v) || v < 0 || v > 1) {
    throw new TypeError(`@gnldev/evals: threshold ${scorer}.${rule} is a number from 0 to 1 (scores are 0–1)`);
  }
  return v;
}

/**
 * Holds a suite's result to thresholds, per scorer. A case that did not finish fails the suite whatever
 * the thresholds say — its scores count as 0 in the means, but a suite that crashed on a case has not
 * passed. A threshold naming a scorer the suite does not have fails too, so a typo cannot pass a gate.
 */
export function checkEvalThresholds(
  result: EvalDatasetResult,
  thresholds: Record<string, EvalThreshold>,
): { pass: boolean; failures: EvalThresholdFailure[] } {
  const failures: EvalThresholdFailure[] = [];
  for (const c of result.cases) if (c.error !== undefined) failures.push({ scorer: '*', rule: 'case-error', caseId: c.caseId, reason: c.error });
  for (const [scorer, t] of Object.entries(thresholds)) {
    const rule = typeof t === 'number' ? { mean: t } : t;
    if (rule === null || typeof rule !== 'object') throw new TypeError(`@gnldev/evals: threshold ${scorer} is a number or { mean?, every? }`);
    const mean = bound(scorer, 'mean', rule.mean);
    const every = bound(scorer, 'every', rule.every);
    if (mean === undefined && every === undefined) throw new TypeError(`@gnldev/evals: threshold ${scorer} names neither \`mean\` nor \`every\``);
    if (!(scorer in result.aggregate)) { failures.push({ scorer, rule: 'missing' }); continue; }
    if (mean !== undefined && result.aggregate[scorer]! < mean) failures.push({ scorer, rule: 'mean', want: mean, got: result.aggregate[scorer] });
    if (every !== undefined) {
      for (const c of result.cases) {
        if (c.error !== undefined) continue; // already a case-error
        const s = c.scores[scorer];
        const got = s?.score ?? 0;
        if (got < every) failures.push({ scorer, rule: 'every', want: every, got, caseId: c.caseId, ...(s?.reason ? { reason: s.reason } : {}) });
      }
    }
  }
  return { pass: failures.length === 0, failures };
}

/** `checkEvalThresholds`, throwing `EvalThresholdError` when it does not pass — for a test (Vitest, Jest, node:test). */
export function assertEvalThresholds(result: EvalDatasetResult, thresholds: Record<string, EvalThreshold>): void {
  const { pass, failures } = checkEvalThresholds(result, thresholds);
  if (!pass) throw new EvalThresholdError(result.datasetId, failures);
}
