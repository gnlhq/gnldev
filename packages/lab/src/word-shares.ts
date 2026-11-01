// "Which words decided it?" — a message cut into parts, every subset of them asked once, and the value a
// probability the model gives: one model call per subset, no repeats.
//
// Measured (nemotron-3.5-lightning on NVIDIA NIM, 8 word groups, 256 subsets, twice): the same subset's
// probability moved by a median 0.005 between two runs, so one call per subset is enough for the large
// shares; it is not exact — the largest move was 0.57 — so the result carries both rounds when asked.
// The question it answers is about one decision, the next one, not the whole run.
//
// A provider that gives no probability for a tool call (OpenAI's chat and responses APIs return none for
// one — measured: `logprobs.content` is null on every tool call) is asked `samples` times instead:
// sampledToolChoice's value is the share of those tries whose first call is the tool, and it carries its
// variance, so every word's share comes with how far it can be off by chance.
//
// toolChoiceProbability reads that probability from an OpenAI-compatible endpoint: the tool call is
// forced, and the probability of the target tool is read from the logprobs of the token that starts
// its name. A provider that returns no logprobs (Anthropic's API has none) is an error, not a zero. A
// token that begins two tool names is left out (the value is then a lower bound by its probability).
import { generateText, stepCountIs, type LanguageModel, type ModelMessage, type ToolSet } from 'ai';
import { refuseUnknownNames } from '@gnldev/options';
import { runTrials, coalitions, coalitionKey, shapley, type RunTrialsOptions } from '@gnldev/experiment';
import { WORD_SHARES_NAMES, TOOL_CHOICE_NAMES, SAMPLED_TOOL_CHOICE_NAMES } from './option-names.js';

/** A value measured with noise: what each word's share is then off by is known. */
export interface NoisyValue { value: number; variance: number }

export interface WordSharesOptions {
  /** The message cut into parts (at most 12), joined with a space to make each subset's text. */
  words: readonly string[];
  /**
   * A text's value — for instance the probability a model picks a tool (`toolChoiceProbability`), or the
   * share of tries that pick it (`sampledToolChoice`, which also says its variance).
   */
  value: (text: string) => Promise<number | NoisyValue>;
  /** Calls at once (default 3). */
  concurrency?: number;
  /** What a subset with no word is sent as (default '.'): a provider refuses an empty message. */
  empty?: string;
  /** How often a subset whose call failed is asked again (default 2). */
  retries?: number;
  /** Called as subsets get their value: `done` of `total` subsets, and the failures so far. */
  onProgress?: RunTrialsOptions['onProgress'];
  /** Aborted: no further subset is asked and wordShares throws the abort reason. */
  signal?: AbortSignal;
}

export interface WordSharesResult {
  /**
   * In the order of `words`. `sd` — present when every value said its variance — is the share's standard
   * deviation by chance: each subset is measured apart, so it is exact for the measured variances.
   */
  shares: Array<{ word: string; share: number; sd?: number }>;
  /** The value of the whole message, and of none of it. */
  full: number;
  none: number;
  values: Record<string, number>;
  calls: number;
}

export async function wordShares(opts: WordSharesOptions): Promise<WordSharesResult> {
  refuseUnknownNames('wordShares', opts, WORD_SHARES_NAMES);
  const ids = opts.words.map((_, i) => `w${i}`);
  const subsets = coalitions(ids);
  const text = (on: Set<string>) => opts.words.filter((_, i) => on.has(`w${i}`)).join(' ') || (opts.empty ?? '.');
  const values: Record<string, number> = {};
  const variances: Record<string, number> = {};
  let pending = subsets, calls = 0, lastError = '', got = 0;
  for (let pass = 0; pass <= (opts.retries ?? 2) && pending.length > 0; pass++) {
    const r = await runTrials(pending.map((on) => () => opts.value(text(on))), {
      concurrency: opts.concurrency ?? 3, ...(opts.signal ? { signal: opts.signal } : {}),
      ...(opts.onProgress ? { onProgress: (p) => opts.onProgress!({ ...p, done: got + p.done - p.failed, total: subsets.length }) } : {}),
    });
    calls += pending.length;
    const again: Set<string>[] = [];
    r.outcomes.forEach((o, i) => {
      const v = o.ok ? (typeof o.value === 'number' ? { value: o.value } : o.value) : undefined;
      if (v && Number.isFinite(v.value)) {
        const key = coalitionKey(pending[i]!);
        values[key] = v.value;
        if ('variance' in v && Number.isFinite(v.variance)) variances[key] = v.variance;
        got++;
      } else { again.push(pending[i]!); lastError = o.ok ? `value ${JSON.stringify(o.value)}` : o.error; }
    });
    pending = again;
  }
  if (pending.length > 0) throw new Error(`@gnldev/lab: wordShares: ${pending.length} subset(s) had no value after retries — ${lastError}`);
  const phi = shapley(ids, values);
  const noisy = Object.keys(variances).length === subsets.length;
  return {
    shares: opts.words.map((w, i) => ({ word: w, share: phi[`w${i}`]!, ...(noisy ? { sd: Math.sqrt(shapleyVariance(ids, `w${i}`, variances)) } : {}) })),
    full: values[coalitionKey(ids)]!, none: values['∅']!, values, calls,
  };
}

const factorial = (n: number): number => (n <= 1 ? 1 : n * factorial(n - 1));
/**
 * A Shapley value is a weighted sum of the subsets' values, each subset once: with T holding the word,
 * weight (|T|−1)!(n−|T|)!/n!; without it, −|T|!(n−|T|−1)!/n!. Measured apart, their variances add with the
 * weights squared.
 * @internal
 */
export function shapleyVariance(ids: readonly string[], id: string, variances: Record<string, number>): number {
  const n = ids.length;
  let v = 0;
  for (const on of coalitions(ids)) {
    const k = on.size;
    const w = on.has(id) ? (factorial(k - 1) * factorial(n - k)) / factorial(n) : (factorial(k) * factorial(n - k - 1)) / factorial(n);
    v += w * w * (variances[coalitionKey(on)] ?? 0);
  }
  return v;
}

export interface SampledToolChoiceOptions {
  model: LanguageModel;
  /** The tools offered — their definitions only: nothing is run, the first step's call is read and the try ends. */
  tools: ToolSet;
  /** The tool whose share of tries is the value. */
  tool: string;
  system?: string;
  /** Messages before the text. */
  before?: readonly ModelMessage[];
  /** Tries per text (default 5). */
  samples?: number;
}

/** What sampledToolChoice's tries took so far. */
export interface SampledSpend { calls: number; inputTokens: number; outputTokens: number }

/**
 * A value for `wordShares` from any provider: the share of `samples` tries whose first call is `tool`
 * (none counts as not it), with its variance. A share of 0 or 1 is not taken as certain: the variance is
 * that of (picked + 1) / (samples + 2), so a word cannot look exact because five tries agreed.
 */
export function sampledToolChoice(opts: SampledToolChoiceOptions): ((text: string) => Promise<NoisyValue>) & { spent: SampledSpend } {
  refuseUnknownNames('sampledToolChoice', opts, SAMPLED_TOOL_CHOICE_NAMES);
  if (!(opts.tool in opts.tools)) throw new TypeError(`@gnldev/lab: sampledToolChoice: '${opts.tool}' is not among the tools offered`);
  const k = opts.samples ?? 5;
  if (!Number.isInteger(k) || k < 1) throw new RangeError('@gnldev/lab: sampledToolChoice: samples must be a whole number of at least 1');
  // Definitions only: a tool without `execute` ends the try at its call.
  const tools = Object.fromEntries(Object.entries(opts.tools).map(([n, t]) => [n, { ...t, execute: undefined }])) as ToolSet;
  const spent: SampledSpend = { calls: 0, inputTokens: 0, outputTokens: 0 };
  const value = async (text: string): Promise<NoisyValue> => {
    const tries = await Promise.all(Array.from({ length: k }, async () => {
      const r = await generateText({ model: opts.model, tools, ...(opts.system ? { system: opts.system } : {}), stopWhen: stepCountIs(1), messages: [...(opts.before ?? []), { role: 'user', content: text }] });
      spent.calls++; spent.inputTokens += r.totalUsage.inputTokens ?? 0; spent.outputTokens += r.totalUsage.outputTokens ?? 0;
      return r.steps[0]?.toolCalls[0]?.toolName === opts.tool;
    }));
    const picked = tries.filter(Boolean).length;
    const p = (picked + 1) / (k + 2);
    return { value: picked / k, variance: (p * (1 - p)) / k };
  };
  return Object.assign(value, { spent });
}

export interface ToolChoiceProbabilityOptions {
  /** An OpenAI-compatible endpoint, e.g. https://integrate.api.nvidia.com/v1 */
  baseURL: string;
  apiKey: string;
  model: string;
  /** The tools offered, in the OpenAI chat format (`{ type: 'function', function: { name, description, parameters } }`). */
  tools: ReadonlyArray<{ type: 'function'; function: { name: string; description?: string; parameters?: unknown } }>;
  /** The tool whose probability is the value. */
  tool: string;
  system?: string;
  /** Chat messages before the text (OpenAI format), and after it (e.g. a lookup already made). */
  before?: readonly unknown[];
  after?: readonly unknown[];
  /** Alternatives read per token (default 10). */
  topLogprobs?: number;
  /** Fields added to every request body, e.g. `{ chat_template_kwargs: { enable_thinking: false } }`. */
  body?: Record<string, unknown>;
  /** The fetch to use (default globalThis.fetch) — `retryingFetch` for a flaky provider. */
  fetch?: typeof fetch;
}

/** A value for `wordShares`: the probability the model's next call is `tool`, given a user message. */
export function toolChoiceProbability(opts: ToolChoiceProbabilityOptions): (text: string) => Promise<number> {
  refuseUnknownNames('toolChoiceProbability', opts, TOOL_CHOICE_NAMES);
  const names = opts.tools.map((t) => t.function.name);
  if (!names.includes(opts.tool)) throw new TypeError(`@gnldev/lab: toolChoiceProbability: '${opts.tool}' is not among the tools offered`);
  const f = opts.fetch ?? globalThis.fetch;
  const url = opts.baseURL.replace(/\/$/, '') + '/chat/completions';
  return async (text: string) => {
    const res = await f(url, {
      method: 'POST',
      headers: { Authorization: `Bearer ${opts.apiKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: opts.model, max_tokens: 60, logprobs: true, top_logprobs: opts.topLogprobs ?? 10, tool_choice: 'required', tools: opts.tools,
        messages: [...(opts.system ? [{ role: 'system', content: opts.system }] : []), ...(opts.before ?? []), { role: 'user', content: text }, ...(opts.after ?? [])],
        ...opts.body,
      }),
    });
    if (!res.ok) throw new Error(`@gnldev/lab: toolChoiceProbability: the provider answered ${res.status}: ${(await res.text()).slice(0, 200)}`);
    const j = (await res.json()) as { choices?: Array<{ logprobs?: { content?: Array<{ token: string; logprob: number; top_logprobs?: Array<{ token: string; logprob: number }> }> } }> };
    const lp = j.choices?.[0]?.logprobs?.content;
    if (!lp || lp.length === 0) throw new Error(`@gnldev/lab: toolChoiceProbability: '${opts.model}' returned no logprobs — this provider cannot answer which words decided`);
    // The tool name starts right after `"name"` + `:` + `"`, however the provider spaces it.
    let joined = '';
    const starts = lp.map((t) => { const s = joined.length; joined += t.token; return s; });
    const m = /"name"\s*:\s*"/.exec(joined);
    const at = m ? m.index + m[0].length : -1;
    const i = starts.findIndex((s, k) => s <= at && at < s + lp[k]!.token.length);
    if (i < 0) throw new Error(`@gnldev/lab: toolChoiceProbability: no tool name in the answer's tokens — the call was not made as a tool call`);
    const offset = at - starts[i]!;
    // An alternative that begins two tool names (measured on NIM: 're' for replaceOrder and refundOrder)
    // cannot be split from one token. It is left out, so the value is a lower bound by that much; when
    // most of the probability is such tokens the value means nothing, and that is an error.
    let p = 0, resolved = 0, unresolved = 0;
    const shared: string[] = [];
    for (const alt of lp[i]!.top_logprobs ?? [{ token: lp[i]!.token, logprob: lp[i]!.logprob }]) {
      const piece = alt.token.slice(offset);
      if (piece.length === 0) continue;
      const fits = names.filter((n) => n.startsWith(piece) || piece.startsWith(n));
      const mass = Math.exp(alt.logprob);
      if (fits.length > 1) { unresolved += mass; shared.push(`'${piece}' (${fits.join(', ')})`); continue; }
      resolved += mass;
      if (fits[0] === opts.tool) p += mass;
    }
    if (unresolved > resolved) throw new Error(`@gnldev/lab: toolChoiceProbability: most of the probability is on tokens that begin more than one tool name — ${shared.join(', ')}; rename the tools so their first token differs`);
    return p;
  };
}
