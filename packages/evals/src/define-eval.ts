import { refuseUnknownNames, optionNames } from '@gnldev/options';
import type { Dataset, EvalRunner } from './dataset.js';
import type { Scorer } from './scorer.js';
import type { EvalThreshold } from './thresholds.js';

/** One suite `gnl eval` runs: a dataset, how to run a case, how to score it, and what must pass. */
export interface EvalSpec {
  dataset: Dataset;
  run: EvalRunner;
  scorers: Scorer[];
  /** Per scorer name: the least mean, or `{ mean?, every? }`. Without it the suite reports and never fails. */
  thresholds?: Record<string, EvalThreshold>;
  /** How many cases run at once (default 1). */
  concurrency?: number;
}

const EVAL_SPEC_NAMES = optionNames<EvalSpec>()(['dataset', 'run', 'scorers', 'thresholds', 'concurrency']);

/**
 * The default export of an `*.eval.ts` file `gnl eval` runs. Checks the names now, so a misspelled
 * `threshold` is an error where it is written rather than a gate that never closes.
 */
export function defineEval(spec: EvalSpec): EvalSpec {
  refuseUnknownNames('defineEval', spec, EVAL_SPEC_NAMES);
  if (!spec.dataset || typeof spec.dataset.id !== 'string' || !Array.isArray(spec.dataset.cases)) throw new TypeError('@gnldev/evals: defineEval needs `dataset` with an `id` and `cases`');
  if (typeof spec.run !== 'function') throw new TypeError('@gnldev/evals: defineEval needs `run`, the function that answers one case');
  if (!Array.isArray(spec.scorers) || spec.scorers.length === 0) throw new TypeError('@gnldev/evals: defineEval needs at least one scorer');
  return spec;
}
