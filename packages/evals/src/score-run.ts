import { runScoreSample, scoreRunMemoized, assertDistinctScorerNames } from '@gnldev/durable';
import type { JournalReader, Journal, JournalEntry } from '@gnldev/durable';
import type { Scorer, ScoreResult, ScoreSample } from './scorer.js';

export interface ScoreRunResult {
  runId: string;
  /** The output that was scored: what the run returned — after its output processors, when it had any. */
  output: string;
  /** The question the input-reading scorers were given (`opts.input`, else the run's journaled input). */
  input?: string;
  scores: Record<string, ScoreResult>;
}

export interface ScoreRunOptions {
  /** Reference value for `exactMatch`/`contains`-style scorers. */
  expected?: string;
  /**
   * Memoize each score in the journal (default true when the journal is writable). A memo is replayed
   * only for the same sample (output, question, expected, context): score the run again with another
   * `expected`, or after an upgrade that completed the sample, and the scorer runs again.
   */
  memo?: boolean;
  /**
   * The question, as `sample.input`. Default: the run's own journaled input — its prompt, or the last
   * user turn of its messages. Pass it when the run's input is not the question (a wrapped prompt).
   */
  input?: string;
  /**
   * `sample.context` for `faithfulness`/`hallucination`/`contextPrecision`. Not derived by default: a
   * run's tool results are not all retrieval context (a calculator's result is not a source), so which
   * of them count is yours to say — a function receives the run's journal entries (model and tool
   * rows, in order) and returns the context, e.g. the results of your retrieval tool.
   */
  context?: string | string[] | ((entries: JournalEntry[]) => string | string[] | undefined);
}

/**
 * Scores a run from its JOURNAL TRACE (post-execution, deterministic). Same journal → same
 * output → same score for rule-based scorers. If the journal is writable, each scorer result is
 * memoized under `${runId}:proc:eval:${name}` → even llmJudge returns the SAME score on resume, for the same sample
 * (something most eval frameworks don't have: journal-based replayable scoring). Can be disabled with `memo:false`.
 */
export async function scoreRun(
  reader: JournalReader,
  runId: string,
  scorers: Scorer[],
  opts: ScoreRunOptions = {},
): Promise<ScoreRunResult> {
  assertDistinctScorerNames(scorers, '@gnldev/evals scoreRun');
  const entries = await reader.readRun(runId);
  const j = reader as Partial<Journal>;
  const context = typeof opts.context === 'function' ? opts.context(entries) : opts.context;
  // The sample is the run-scoring owner's (durable's runScoreSample): the output the run RETURNED
  // (after its output processors — never the raw model text a redactor removed), the question from the
  // run's frozen `:input`, and `runId` for trajectory-style scorers — the same sample an agent's
  // `scorers` built when the run completed, so a run scored there is replayed here, not judged again.
  const sample: ScoreSample = await runScoreSample(j, runId, { entries, input: opts.input, expected: opts.expected, context });
  const { output, input } = sample;

  const canMemo = opts.memo !== false && typeof j.get === 'function' && typeof j.put === 'function';

  const scores: Record<string, ScoreResult> = {};
  for (const s of scorers) {
    scores[s.name] = canMemo ? await scoreRunMemoized(j as Journal, runId, s, sample) : await s.score(sample);
  }
  return { runId, output, ...(input !== undefined ? { input } : {}), scores };
}
