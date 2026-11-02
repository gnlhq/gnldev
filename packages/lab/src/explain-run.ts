// "What brought this call about?" — a recorded run's parts, each left out in turn, the run played again.
//
// The parts are what the run was given: sections of its system prompt, messages of its input, and the
// results of tools it called — one part may hold several of them (a section and messages: what memory
// put in the system text and in the conversation). Every subset of them is replayed `trials` times (no
// tool is ever run — each call is answered from the recording) and the value of a subset is how often
// the run's own calls came out again — or, with `match: 'expect'`, how often a play did what a right
// answer does (judgePlay; a play that cannot be judged is left out of its subset's rate). Each part's
// share is its Shapley value over those subsets.
//
// Three things are said before any share, because each was measured to mislead when left unsaid:
// - representative: with every part present, how often the recorded calls come out again. Measured on
//   12 recorded runs: 6 came out again in fewer than 2 trials of 3 — the recording was one draw of
//   several, and shares computed from it are weak.
// - dependsOnParts: when the outcome is the same with every part and with none, the shares sum to zero.
//   They can still be large and opposite (a misleading message and the one that corrects it); "%" of a
//   zero total means nothing.
// - noise: each share is computed again from two halves of the trials; the difference is shown beside
//   it. Shares within ±0.08 moved between two runs of the same experiment.
import type { LanguageModel, ToolSet } from 'ai';
import type { ModelPricing } from '@gnldev/durable';
import { refuseUnknownNames } from '@gnldev/options';
import {
  replayCounterfactual, maskConversation, runTrials, coalitions, coalitionKey, shapley, wilson,
  type CallSignature, type Expectation, type Interval, type JournalSource, type ToolAnswer, type TrialsProgress,
} from '@gnldev/experiment';
import { EXPLAIN_RUN_NAMES } from './option-names.js';
import { judgePlay } from './judge.js';

export interface ExplainRunOptions {
  /** Where the run is: a store's `runs`, the store, or a journal. Only read. */
  journal: JournalSource;
  runId: string;
  /** The model the run is played again with — the shares are this model's. */
  model: LanguageModel;
  /** The agent's tool definitions; `execute` is never called. */
  tools?: ToolSet;
  /** The system prompt as named sections, in order; each is a part. Omitted: the recorded prompt is kept whole. */
  systemSections?: Record<string, string>;
  /** Text every played run's system prompt starts with, never left out. */
  systemBase?: string;
  /**
   * Input messages grouped into parts, by position in the run's input. The last user message is usually
   * kept out of every part. A name that is also a system section is one part: both go and come together.
   */
  messages?: Record<string, number[]>;
  /** Results of tools the run calls, hidden while it plays: part name → tool name (or names). */
  toolResults?: Record<string, string | readonly string[]>;
  /** Replays per subset (default 3). */
  trials?: number;
  /** Replays at once (default 4). */
  concurrency?: number;
  /**
   * What a subset's value counts. 'calls' (default): plays that made the recorded calls again, the same
   * tools with the same arguments, in order. 'names': the same tools in order. 'expect': plays that did
   * what `expect` asks — a failed run's recorded calls are the wrong ones, so this is the value a
   * diagnosis needs: a part with a negative share pulls the play away from the right answer.
   */
  match?: 'calls' | 'names' | 'expect';
  /** What a right answer does — required with `match: 'expect'`. */
  expect?: Expectation;
  /** Results for calls the recording never made (see replayCounterfactual). */
  answers?: readonly ToolAnswer[];
  /** With every part present, the rate below which the recording is reported as not representative (default 2/3). */
  representativeAt?: number;
  maxSteps?: number;
  timeoutMs?: number;
  pricing?: Record<string, ModelPricing>;
  /** Called after every replay — see runTrials. */
  onProgress?: (progress: TrialsProgress) => void;
  /** Aborted: no further replay starts and explainRun throws the abort reason. */
  signal?: AbortSignal;
  /** A replay the provider refused (429) is played again after a pause, one at a time — see runTrials. */
  throttle?: { waitMs?: number; maxWaits?: number };
}

export interface PartShare {
  part: string;
  share: number;
  /** |share from one half of the trials − share from the other|; NaN with a single trial. */
  noise: number;
}

export interface ExplainRunResult {
  runId: string;
  parts: string[];
  /** The calls the run itself made — the outcome every replay is compared with. */
  recordedCalls: CallSignature[];
  /** With every part present: how often the recorded calls came out again. */
  representative: Interval & { ok: boolean };
  /** False when the outcome with no part is within one trial of the outcome with every part. */
  dependsOnParts: boolean;
  /** Largest to smallest. */
  shares: PartShare[];
  /** Each subset's rate (keyed by `coalitionKey`). */
  values: Record<string, number>;
  replays: number;
  /** Replays that could not run — left out of every rate. */
  failed: number;
  /** With `match: 'expect'`: plays that stopped where they could not be judged — left out of every rate. */
  undetermined?: number;
  inputTokens: number;
  outputTokens: number;
  costUsd: number;
  priced: boolean;
}

/** How many replays an explanation costs: every subset of the parts, `trials` times. */
export function explainRunSize(parts: number, trials = 3): number {
  return 2 ** parts * trials;
}

const sig = (calls: readonly CallSignature[], match: 'calls' | 'names') => JSON.stringify(calls.map((c) => (match === 'names' ? c.toolName : [c.toolName, c.argsHash])));

export async function explainRun(opts: ExplainRunOptions): Promise<ExplainRunResult> {
  refuseUnknownNames('explainRun', opts, EXPLAIN_RUN_NAMES);
  const trials = opts.trials ?? 3;
  if (!Number.isInteger(trials) || trials < 1) throw new RangeError('@gnldev/lab: explainRun: trials must be a whole number ≥ 1');
  const match = opts.match ?? 'calls';
  if (match === 'expect' && !opts.expect) throw new TypeError("@gnldev/lab: explainRun: match 'expect' needs `expect` — what a right answer does");
  const sections = Object.entries(opts.systemSections ?? {});
  const messageParts = Object.entries(opts.messages ?? {});
  const toolParts = Object.entries(opts.toolResults ?? {}).map(([p, t]) => [p, typeof t === 'string' ? [t] : [...t]] as const);
  // A name in two maps is one part: the system text and the messages it names go together.
  const parts = [...new Set([...sections.map(([p]) => p), ...messageParts.map(([p]) => p), ...toolParts.map(([p]) => p)])];
  if (parts.length === 0) throw new TypeError('@gnldev/lab: explainRun: name at least one part (systemSections, messages or toolResults)');
  const subsets = coalitions(parts); // refuses duplicates and more than 12

  const system = (on: Set<string>) =>
    sections.length === 0 && opts.systemBase === undefined
      ? undefined
      : [opts.systemBase, ...sections.filter(([p]) => on.has(p)).map(([, t]) => t)].filter((x) => x !== undefined).join('\n\n');
  const replay = (on: Set<string>) => async () => {
    const prepareStep = maskConversation({
      dropInput: messageParts.filter(([p]) => !on.has(p)).flatMap(([, at]) => at),
      hideToolResults: toolParts.filter(([p]) => !on.has(p)).flatMap(([, names]) => names),
    });
    const s = system(on);
    return replayCounterfactual({
      journal: opts.journal, runId: opts.runId, model: opts.model, prepareStep: prepareStep as never,
      ...(opts.tools ? { tools: opts.tools } : {}),
      ...(s !== undefined ? { system: s } : {}),
      ...(opts.maxSteps !== undefined ? { maxSteps: opts.maxSteps } : {}),
      ...(opts.timeoutMs !== undefined ? { timeoutMs: opts.timeoutMs } : {}),
      ...(opts.pricing ? { pricing: opts.pricing } : {}),
      ...(opts.answers?.length ? { answers: opts.answers } : {}),
    });
  };

  const jobs: Array<{ key: string; trial: number; run: () => ReturnType<ReturnType<typeof replay>> }> = [];
  for (const on of subsets) for (let t = 0; t < trials; t++) jobs.push({ key: coalitionKey(on), trial: t, run: replay(on) });
  const done = await runTrials(jobs.map((j) => j.run), {
    ...(opts.concurrency !== undefined ? { concurrency: opts.concurrency } : {}),
    ...(opts.onProgress ? { onProgress: opts.onProgress } : {}),
    ...(opts.signal ? { signal: opts.signal } : {}),
    ...(opts.throttle ? { throttle: opts.throttle } : {}),
  });

  let recordedCalls: CallSignature[] | undefined;
  const hits: Record<string, number[][]> = {}; // key → [half 0 hits, half 1 hits]
  const sameAll: number[] = []; // with every part present: the recorded calls made again (representative)
  const allKey = coalitionKey(parts);
  let inputTokens = 0, outputTokens = 0, costUsd = 0, priced = true, undetermined = 0;
  done.outcomes.forEach((o, i) => {
    if (!o.ok) return;
    const r = o.value;
    recordedCalls ??= r.recorded.calls;
    const same = sig(r.candidate.calls, match === 'names' ? 'names' : 'calls') === sig(r.recorded.calls, match === 'names' ? 'names' : 'calls') ? 1 : 0;
    const j = jobs[i]!;
    if (j.key === allKey) sameAll.push(same);
    inputTokens += r.candidate.inputTokens; outputTokens += r.candidate.outputTokens;
    costUsd += r.candidate.costUsd; priced &&= r.candidate.priced;
    let value = same;
    if (match === 'expect') {
      const judged = judgePlay(opts.expect!, r.trace, r.candidate.text);
      if (judged.verdict === 'undetermined') { undetermined++; return; }
      value = judged.verdict === 'pass' ? 1 : 0;
    }
    ((hits[j.key] ??= [[], []])[j.trial % 2]!).push(value);
  });
  if (!recordedCalls) throw new Error(`@gnldev/lab: explainRun: none of ${jobs.length} replays of '${opts.runId}' could run — ${(done.outcomes.find((o) => !o.ok) as { error: string }).error}`);

  const rate = (xs: number[]) => xs.reduce((a, b) => a + b, 0) / xs.length;
  const values: Record<string, number> = {};
  for (const on of subsets) {
    const k = coalitionKey(on);
    const all = [...(hits[k]?.[0] ?? []), ...(hits[k]?.[1] ?? [])];
    if (all.length === 0) {
      const first = done.outcomes.find((o, i) => !o.ok && jobs[i]!.key === k) as { error: string } | undefined;
      if (!first && match === 'expect') {
        throw new Error(`@gnldev/lab: explainRun: every replay of {${k}} stopped at a call no one answered and could not be judged against the expectation — answer it (answers) and explain again`);
      }
      throw new Error(`@gnldev/lab: explainRun: every replay of {${k}} failed — no share can be computed without it${first ? `; the first: ${first.error}` : ''}`);
    }
    values[k] = rate(all);
  }
  const phi = shapley(parts, values);
  let noise: Record<string, number> | undefined;
  if (trials >= 2 && subsets.every((on) => (hits[coalitionKey(on)]?.[0]?.length ?? 0) > 0 && (hits[coalitionKey(on)]?.[1]?.length ?? 0) > 0)) {
    const half = (h: 0 | 1) => shapley(parts, Object.fromEntries(subsets.map((on) => [coalitionKey(on), rate(hits[coalitionKey(on)]![h]!)])));
    const a = half(0), b = half(1);
    noise = Object.fromEntries(parts.map((p) => [p, Math.abs(a[p]! - b[p]!)]));
  }

  const rep = wilson(sameAll.reduce((a, b) => a + b, 0), sameAll.length);
  return {
    runId: opts.runId,
    parts,
    recordedCalls,
    representative: { ...rep, ok: rep.value >= (opts.representativeAt ?? 2 / 3) },
    dependsOnParts: Math.abs(values[allKey]! - values['∅']!) >= 1 / trials,
    shares: parts.map((p) => ({ part: p, share: phi[p]!, noise: noise?.[p] ?? NaN })).sort((x, y) => y.share - x.share),
    values,
    replays: jobs.length,
    failed: done.failed,
    ...(match === 'expect' ? { undetermined } : {}),
    inputTokens, outputTokens, costUsd, priced,
  };
}
