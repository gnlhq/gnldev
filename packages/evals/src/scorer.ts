// Scorer interface + rule-based built-ins (deterministic → same sample, same score).

import { refuseUnknownNames } from '@gnldev/options';
import { EMBEDDING_SIMILARITY_OPTS_NAMES } from './option-names.js';
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
  /**
   * What the score depends on besides the sample (a rubric, a model, a threshold). A memoized score
   * (`scoreRun`, an agent's `scorers`, `evalDataset`) is replayed only for the same fingerprint, so an
   * edited rubric re-scores instead of replaying the old score under the same name. Default: the source
   * text of `score` — set this when the behaviour comes from values the function closes over. The
   * built-in factories set it from their options.
   */
  fingerprint?: string;
  score(sample: ScoreSample): Promise<ScoreResult> | ScoreResult;
}

/**
 * A fingerprint from a factory's options: the kind plus the options as JSON, with a RegExp as its
 * source and flags and a model as its provider and id. Functions are left out (an `embed` callback
 * cannot be compared); a factory whose behaviour hinges on one should take a `fingerprint` option.
 */
export function optionsFingerprint(kind: string, options: unknown): string {
  return `${kind}:${JSON.stringify(options ?? null, (_k, v) => {
    if (v instanceof RegExp) return `/${v.source}/${v.flags}`;
    if (v && typeof v === 'object' && typeof (v as { modelId?: unknown }).modelId === 'string') {
      const m = v as { provider?: unknown; modelId: string };
      return `model:${String(m.provider ?? '')}/${m.modelId}`;
    }
    return v;
  })}`;
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
    fingerprint: optionsFingerprint('contains', { substr }),
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
    fingerprint: optionsFingerprint('regex', { re }),
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
  refuseUnknownNames('embeddingSimilarity', opts, EMBEDDING_SIMILARITY_OPTS_NAMES);
  return {
    name: 'embedding-similarity',
    fingerprint: optionsFingerprint('embedding-similarity', { threshold: opts?.threshold }),
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
