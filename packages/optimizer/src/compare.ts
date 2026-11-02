// Two models on the same scenarios: what the candidate costs as a share of the baseline, and the
// scenarios it does worse on. The scenarios and the runner are @gnldev/experiment's; the comparison is
// the optimizer's question.
import type { LanguageModel } from 'ai';
import { refuseUnknownNames } from '@gnldev/options';
import { runSuite, type RunSuiteOptions, type ScenarioResult, type SuiteResult } from '@gnldev/experiment';
import { COMPARE_NAMES } from './option-names.js';

export interface CompareOptions extends Omit<RunSuiteOptions, 'model'> {
  baseline: LanguageModel;
  candidate: LanguageModel;
}

export interface Comparison {
  baseline: SuiteResult;
  candidate: SuiteResult;
  /** Scenarios both models ran — the only ones compared. */
  compared: string[];
  /** Candidate cost as a share of the baseline's (0.2 = 80% cheaper), over the compared scenarios. */
  costRatio: number;
  /** Scenarios the baseline passed and the candidate failed. */
  regressions: string[];
  /** Scenarios the baseline failed and the candidate passed. */
  improvements: string[];
}

/** The same scenarios on two models: what the candidate costs, and where it does worse. */
export async function compareOnSuite(opts: CompareOptions): Promise<Comparison> {
  refuseUnknownNames('compareOnSuite', opts, COMPARE_NAMES);
  const { baseline: b, candidate: c, ...rest } = opts;
  const [baseline, candidate] = await Promise.all([runSuite({ ...rest, model: b }), runSuite({ ...rest, model: c })]);
  const byId = new Map(candidate.results.map((r) => [r.id, r]));
  const both = baseline.results.filter((r) => r.error === undefined && byId.get(r.id)?.error === undefined);
  const cost = (rs: ScenarioResult[]) => rs.reduce((a, r) => a + r.costUsd, 0);
  const baseCost = cost(both);
  return {
    baseline,
    candidate,
    compared: both.map((r) => r.id),
    costRatio: baseCost > 0 ? cost(both.map((r) => byId.get(r.id)!)) / baseCost : NaN,
    regressions: both.filter((r) => r.pass && !byId.get(r.id)!.pass).map((r) => r.id),
    improvements: both.filter((r) => !r.pass && byId.get(r.id)!.pass).map((r) => r.id),
  };
}
