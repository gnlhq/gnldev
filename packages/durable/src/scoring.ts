// The rules every scoring runner shares — @gnldev/evals' `evalDataset` and `scoreRun`, and an agent's
// `scorers` in `createGnl`. They live HERE, below all three, because the third runner is in this
// package and @gnldev/evals depends on this one, not the other way round.
//
// Round 1 fixed the two evals runners with their own copies of these rules and left the registry's
// runner on the old ones (measured: two scorers named 'judge' on an agent → the second replayed the
// first's memo; a run started with `messages` gave `answerRelevancy` no question). One owner makes
// the fourth runner correct by construction instead of by a later audit.
import type { Journal } from './journal.js';
import { runKeys } from './journal.js';
import { argsHash } from './hash.js';

/** The fields a scorer reads. Every runner builds it with `scoreSample`. */
export interface ScoreSampleFields {
  /** The output being scored (usually the agent's final text). */
  output: string;
  /** The question, as text — see `inputText`. */
  input?: string;
  /** Reference value (exactMatch/contains-style scorers). */
  expected?: string;
  /** Retrieval context for faithfulness/hallucination/contextPrecision-style judges. */
  context?: string | string[];
  /** The durable run the sample came from, for journal-backed scorers (trajectory). */
  runId?: string;
  [k: string]: unknown;
}

/** Text of one message content: a string, or the `text` parts of a content array. */
function contentText(content: unknown): string | undefined {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    const text = content
      .filter((p) => p && typeof p === 'object' && (p as { type?: unknown }).type === 'text')
      .map((p) => String((p as { text?: unknown }).text ?? ''))
      .join('');
    return text.length > 0 ? text : undefined;
  }
  return undefined;
}

/** The last user turn of a message list. */
function lastUserText(messages: unknown[]): string | undefined {
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i] as { role?: unknown; content?: unknown } | undefined;
    if (m && m.role === 'user') return contentText(m.content);
  }
  return undefined;
}

/**
 * The QUESTION a run's or a case's input stands for, as text — what `answerRelevancy`/`completeness`
 * judge the output against.
 *
 *   string                         → itself
 *   { prompt } / { messages }      → the prompt, or the last user turn (a run's journaled input has
 *                                    this shape, and so does a typical runner input object)
 *   a message array                → its last user turn
 *   anything else                  → JSON (a structured case input still reaches the judge whole)
 */
export function inputText(input: unknown): string | undefined {
  if (input == null) return undefined;
  if (typeof input === 'string') return input;
  if (Array.isArray(input)) return lastUserText(input) ?? JSON.stringify(input);
  if (typeof input === 'object') {
    const { prompt, messages } = input as { prompt?: unknown; messages?: unknown };
    if (typeof prompt === 'string') return prompt;
    const fromPrompt = Array.isArray(prompt) ? lastUserText(prompt) : undefined;
    if (fromPrompt !== undefined) return fromPrompt;
    const fromMessages = Array.isArray(messages) ? lastUserText(messages) : undefined;
    if (fromMessages !== undefined) return fromMessages;
  }
  try {
    return JSON.stringify(input);
  } catch {
    return undefined;
  }
}

/**
 * THE sample a scorer is given, from whatever a runner has: `input` in any shape a run or case takes
 * (read as text by `inputText`), and the other fields as they are. A field with nothing in it is left
 * out rather than set to `undefined`, so a scorer's `'input' in sample` means what it says.
 */
export function scoreSample(fields: {
  output: string;
  input?: unknown;
  expected?: string;
  context?: string | string[];
  runId?: string;
}): ScoreSampleFields {
  const input = inputText(fields.input);
  return {
    output: fields.output,
    ...(input !== undefined ? { input } : {}),
    ...(fields.expected !== undefined ? { expected: fields.expected } : {}),
    ...(fields.context !== undefined ? { context: fields.context } : {}),
    ...(fields.runId !== undefined ? { runId: fields.runId } : {}),
  };
}

/**
 * A score is known by its scorer's NAME everywhere a runner keeps it: the result record
 * (`scores[name]`), a dataset's aggregate, and the journal memo (`eval:<name>`). Two scorers with one
 * name therefore became one — measured, the second of two default-named `llmJudge` rubrics was
 * answered with the first one's memoized score and its model was never asked.
 *
 * Refused rather than keyed by position: a position is not an identity across runs, and the memo is
 * read on the NEXT run — reordering the scorer list would hand each scorer another's stored score,
 * silently. A name is what a reader of the result looks up, so it has to be unique.
 */
export function assertDistinctScorerNames(scorers: readonly { name: string }[], runner: string): void {
  const seen = new Map<string, number>();
  scorers.forEach((s, i) => {
    const first = seen.get(s.name);
    if (first !== undefined) {
      throw new Error(
        `${runner}: scorers[${first}] and scorers[${i}] are both named '${s.name}', and a score is ` +
        `kept under its scorer's name (result, aggregate, journal memo), so one would overwrite the other. ` +
        `Give one a name: pass \`name\` to the factory (llmJudge({ name: 'polite', ... }), faithfulness({ model, name })), ` +
        `or rename any scorer with a spread: { ...contains('x'), name: 'has-x' }.`,
      );
    }
    seen.set(s.name, i);
  });
}

/**
 * `durableProcessorStep` for a score: memoized under the same key (`<runId>:proc:<step>`, in the same
 * `{ v }` shape the Studio scores route and `rebuildMetrics` read), and replayed only for the SAME
 * basis — the sample (or case) it was computed from, hashed. A record with another basis, or none,
 * is recomputed and replaced.
 *
 * Why: a memo is only as good as the input it was computed on. 0.9.0 gave the judges no `input`, and
 * memoized their `0` ("input required"); keyed by name alone, that 0 was replayed after the upgrade,
 * forever, for every run scored before it. The same holds whenever the sample changes under a memo —
 * a different `expected` or `context` passed to `scoreRun` for an already-scored run. Exactly-once on
 * resume is kept: a resumed run builds the same sample, so it hits.
 */
export async function memoizeScoring<T>(
  journal: Journal,
  runId: string,
  step: string,
  basisOf: unknown,
  compute: () => Promise<T> | T,
): Promise<T> {
  const key = runKeys.proc(runId, step);
  const basis = argsHash(basisOf);
  const hit = await journal.get<{ v: T; basis?: string }>(key);
  if (hit !== undefined && hit.basis === basis) return hit.v;
  const v = await compute();
  await journal.put(key, { v, basis });
  return v;
}
