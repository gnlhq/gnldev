// An agent's latest conversations, each played again under one candidate setting, and what it adds up to.
//
// The question a change has to answer before it is applied: on the work this agent actually did, how
// often would the candidate have done different work (a divergence), skipped a call, or done the calls
// in another order — and what would it have cost? Each run is a replayCounterfactual: no tool executes.
// A run that could not be replayed (no recorded input, a model error, a timeout) is listed apart and
// counts toward nothing.
import { refuseUnknownNames } from '@gnldev/options';
import { REPLAY_AGENT_NAMES } from './option-names.js';
import { readerOf } from './journal-of.js';
import { replayCounterfactual, type CounterfactualOptions, type CounterfactualResult } from './replay.js';

export interface ReplayAgentOptions extends Omit<CounterfactualOptions, 'runId'> {
  /** The agent's registry name; its latest completed runs are replayed. */
  agent: string;
  /** How many of them (default 20). */
  limit?: number;
  /** Replays at once (default 2). */
  concurrency?: number;
}

export interface ReplayAgentSummary {
  /** Runs replayed to the end or to a divergence. */
  replayed: number;
  /** Of those, how many diverged — the candidate made a call the recorded run never made. */
  diverged: number;
  divergenceRate: number;
  /** Runs where the candidate skipped a call the recorded run made. */
  missedCallRuns: number;
  /** Runs where the candidate made the same calls in another order. */
  reorderedRuns: number;
  recordedCostUsd: number;
  candidateCostUsd: number;
  /** Candidate over recorded cost; NaN when a side is unpriced or the recorded side cost nothing. */
  costRatio: number;
  recordedTokens: number;
  candidateTokens: number;
  /** Every model step on both sides was found in the price table. */
  priced: boolean;
}

export interface ReplayAgentResult {
  agent: string;
  runs: CounterfactualResult[];
  /** Runs that could not be replayed, and why. */
  errors: Array<{ runId: string; error: string }>;
  summary: ReplayAgentSummary;
}

/** Replays an agent's latest completed runs with one candidate setting and sums them up. */
export async function replayAgent(opts: ReplayAgentOptions): Promise<ReplayAgentResult> {
  refuseUnknownNames('replayAgent', opts, REPLAY_AGENT_NAMES);
  const { agent, limit, concurrency, ...rest } = opts;
  const journal = readerOf(opts.journal);
  if (typeof journal.listRunsPaged !== 'function') throw new TypeError('@gnldev/optimizer: replayAgent needs a journal that lists runs by agent');
  const page = await journal.listRunsPaged({ agent, status: 'completed', limit: limit ?? 20 });
  const ids = page.items.map((r) => r.runId);
  const runs: Array<CounterfactualResult | undefined> = new Array(ids.length);
  const errors: ReplayAgentResult['errors'] = [];
  let next = 0;
  const worker = async () => {
    for (let i = next++; i < ids.length; i = next++) {
      try {
        runs[i] = await replayCounterfactual({ ...rest, journal, runId: ids[i]! });
      } catch (e) {
        errors.push({ runId: ids[i]!, error: (e as Error)?.name === 'TimeoutError' ? `no answer within ${rest.timeoutMs ?? 120_000} ms` : String((e as Error)?.message ?? e) });
      }
    }
  };
  await Promise.all(Array.from({ length: Math.max(1, concurrency ?? 2) }, worker));
  const done = runs.filter((r): r is CounterfactualResult => r !== undefined);
  const sum = (f: (r: CounterfactualResult) => number) => done.reduce((a, r) => a + f(r), 0);
  const recordedCostUsd = sum((r) => r.recorded.costUsd);
  const candidateCostUsd = sum((r) => r.candidate.costUsd);
  const priced = done.every((r) => r.recorded.priced && r.candidate.priced);
  const diverged = done.filter((r) => r.divergence !== undefined).length;
  return {
    agent,
    runs: done,
    errors,
    summary: {
      replayed: done.length,
      diverged,
      divergenceRate: done.length ? diverged / done.length : NaN,
      missedCallRuns: done.filter((r) => r.missed.length > 0).length,
      reorderedRuns: done.filter((r) => r.reordered).length,
      recordedCostUsd,
      candidateCostUsd,
      costRatio: priced && recordedCostUsd > 0 ? candidateCostUsd / recordedCostUsd : NaN,
      recordedTokens: sum((r) => r.recorded.inputTokens + r.recorded.outputTokens),
      candidateTokens: sum((r) => r.candidate.inputTokens + r.candidate.outputTokens),
      priced,
    },
  };
}
