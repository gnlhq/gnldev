// Scorer interface + rule-based built-ins (deterministic → same sample, same score).

export interface ScoreSample {
  /** The output being scored (usually the agent's final text). */
  output: string;
  /** Expected/reference value (for exactMatch/contains). */
  expected?: string;
  /** Optional extra context. */
  input?: string;
  /**
   * CONVENTION: the RAG/retrieval context read by context-based LLM-judge scorers (see `scorers.ts` —
   * faithfulness, hallucination, contextPrecision). Can be a single string or multiple retrieved
   * chunks (string[]). If this field is missing/empty, those scorers do NOT silently return 1.0 —
   * they return score 0 + "context required" in the reason.
   */
  context?: string | string[];
  /**
   * CONVENTION (P1.1): the durable runId this sample was produced from, if any.
   * Populated automatically by `scoreRun` and `evalDataset` (see score-run.ts/dataset.ts) — lets
   * journal-backed scorers (e.g. `trajectoryScorerFor` in trajectory.ts) look the run back up without
   * every caller having to thread it through by hand.
   */
  runId?: string;
  [k: string]: unknown;
}

export interface ScoreResult {
  /** 0.0–1.0. */
  score: number;
  reason?: string;
}

export interface Scorer {
  name: string;
  score(sample: ScoreSample): Promise<ScoreResult> | ScoreResult;
}

/** Is the output exactly equal to expected (trimmed)? */
export function exactMatch(): Scorer {
  return {
    name: 'exact-match',
    score: (s) => {
      const ok = (s.output ?? '').trim() === (s.expected ?? '').trim();
      return { score: ok ? 1 : 0, reason: ok ? 'exactly equal' : 'not equal' };
    },
  };
}

/** Does the output contain the given substring (or expected, if not given)? */
export function contains(substr?: string): Scorer {
  return {
    name: 'contains',
    score: (s) => {
      const needle = substr ?? s.expected ?? '';
      const ok = needle.length > 0 && (s.output ?? '').includes(needle);
      return { score: ok ? 1 : 0, reason: ok ? `"${needle}" found` : `"${needle}" missing` };
    },
  };
}

/** Does the output match the regex? */
export function regexScore(re: RegExp): Scorer {
  return {
    name: 'regex',
    score: (s) => {
      const ok = new RegExp(re.source, re.flags).test(s.output ?? '');
      return { score: ok ? 1 : 0, reason: ok ? 'regex matched' : 'regex did not match' };
    },
  };
}

/** Cosine similarity between two vectors (clamped to 0..1; 0 for a zero vector). */
function cosine(a: number[], b: number[]): number {
  const n = Math.min(a.length, b.length);
  let dot = 0, na = 0, nb = 0;
  for (let i = 0; i < n; i++) {
    dot += a[i]! * b[i]!;
    na += a[i]! * a[i]!;
    nb += b[i]! * b[i]!;
  }
  if (na === 0 || nb === 0) return 0;
  const sim = dot / (Math.sqrt(na) * Math.sqrt(nb));
  return sim < 0 ? 0 : sim > 1 ? 1 : sim;
}

/**
 * Semantic similarity scorer: vectorizes output and expected with `embed` and returns their cosine
 * similarity as the score — catches near-meaning matches that exact string matching would miss.
 * `embed` is provider-agnostic: e.g. for the AI SDK, `(t) => embed({ model, value: t }).then(r => r.embedding)`.
 * If `threshold` is given, `score` is 0 below / 1 above that threshold (pass-fail); otherwise the raw
 * similarity (0..1).
 */
export function embeddingSimilarity(
  embed: (text: string) => Promise<number[]>,
  opts?: { threshold?: number },
): Scorer {
  return {
    name: 'embedding-similarity',
    score: async (s) => {
      const [ov, ev] = await Promise.all([embed(s.output ?? ''), embed(s.expected ?? '')]);
      const sim = cosine(ov, ev);
      if (opts?.threshold !== undefined) {
        const ok = sim >= opts.threshold;
        return { score: ok ? 1 : 0, reason: `similarity ${sim.toFixed(3)} ${ok ? '≥' : '<'} threshold ${opts.threshold}` };
      }
      return { score: sim, reason: `cosine similarity ${sim.toFixed(3)}` };
    },
  };
}

/**
 * A score is known by its scorer's NAME everywhere a runner keeps it: the result record
 * (`scores[name]`), the dataset aggregate, and the journal memo (`eval:<name>`). Two scorers with one
 * name therefore became one — measured, `scoreRun` answered the second of two default-named `llmJudge`
 * rubrics with the first one's memoized score and never asked its model.
 *
 * Refused rather than keyed by position: a position is not an identity across runs, and the memo is
 * read on the NEXT run — reordering the scorer list would hand each scorer another's stored score,
 * silently. A name is what a reader of the result looks up, so it has to be unique.
 */
export function assertDistinctScorerNames(scorers: readonly Scorer[], runner: string): void {
  const seen = new Map<string, number>();
  scorers.forEach((s, i) => {
    const first = seen.get(s.name);
    if (first !== undefined) {
      throw new Error(
        `@gnldev/evals ${runner}: scorers[${first}] and scorers[${i}] are both named '${s.name}', and a score is ` +
        `kept under its scorer's name (result, aggregate, journal memo), so one would overwrite the other. ` +
        `Give one a name: pass \`name\` to the factory (llmJudge({ name: 'polite', ... }), faithfulness({ model, name })), ` +
        `or rename any scorer with a spread: { ...contains('x'), name: 'has-x' }.`,
      );
    }
    seen.set(s.name, i);
  });
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
 * The QUESTION a sample's `input` stands for, as text — what `answerRelevancy`/`completeness` judge the
 * output against.
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
