import { durableProcessorStep, runKeys } from '@gnldev/durable';
import type { JournalReader, Journal, JournalEntry } from '@gnldev/durable';
import { assertDistinctScorerNames, inputText, type Scorer, type ScoreResult, type ScoreSample } from './scorer.js';

export interface ScoreRunResult {
  runId: string;
  output: string;
  /** The question the input-reading scorers were given (`opts.input`, else the run's journaled input). */
  input?: string;
  scores: Record<string, ScoreResult>;
}

export interface ScoreRunOptions {
  /** Reference value for `exactMatch`/`contains`-style scorers. */
  expected?: string;
  /** Memoize each score in the journal (default true when the journal is writable). */
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

/** Extracts the output to be scored from the journal trace (the text of the last model entry). */
function extractFinalText(entries: JournalEntry[]): string {
  const models = entries.filter((e) => e.kind === 'model');
  const last = models[models.length - 1];
  const content = ((last?.value as any)?.content ?? []) as any[];
  return content.filter((p) => p?.type === 'text').map((p) => p.text).join('');
}

/**
 * Scores a run from its JOURNAL TRACE (post-execution, deterministic). Same journal → same
 * output → same score for rule-based scorers. If the journal is writable, each scorer result is
 * memoized under `${runId}:proc:eval:${name}` → even llmJudge returns the SAME score on resume
 * (something most eval frameworks don't have: journal-based replayable scoring). Can be disabled with `memo:false`.
 */
export async function scoreRun(
  reader: JournalReader,
  runId: string,
  scorers: Scorer[],
  opts: ScoreRunOptions = {},
): Promise<ScoreRunResult> {
  assertDistinctScorerNames(scorers, 'scoreRun');
  const entries = await reader.readRun(runId);
  const output = extractFinalText(entries);
  const j = reader as Partial<Journal>;
  // The question: the run's frozen `:input` (prompt/messages), which `readRun` does not list — it is
  // read by key when the reader can. Without it answerRelevancy/completeness scored 0 through this
  // function on every run ("input required"), and the judge was never asked.
  const input = opts.input ?? (typeof j.get === 'function' ? inputText(await j.get(runKeys.input(runId))) : undefined);
  const context = typeof opts.context === 'function' ? opts.context(entries) : opts.context;
  // runId is included so trajectory-style scorers (see trajectory.ts's trajectoryScorerFor) can look
  // this run's decision sequence back up without any extra wiring at the call site (P1.1).
  const sample: ScoreSample = {
    output, expected: opts.expected, runId,
    ...(input !== undefined ? { input } : {}),
    ...(context !== undefined ? { context } : {}),
  };

  const canMemo = opts.memo !== false && typeof j.get === 'function' && typeof j.put === 'function';

  const scores: Record<string, ScoreResult> = {};
  for (const s of scorers) {
    scores[s.name] = canMemo
      ? await durableProcessorStep(j as Journal, runId, `eval:${s.name}`, () => s.score(sample))
      : await s.score(sample);
  }
  return { runId, output, ...(input !== undefined ? { input } : {}), scores };
}
