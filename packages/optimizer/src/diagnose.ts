// Where an agent's money goes, read from its own journal.
//
// Two numbers decide what is worth trying, and both are read from what the provider billed:
//   · the REPEATED PREFIX — every model step after the first re-sends the run's opening (system prompt,
//     tool definitions, the first messages). The first step's input tokens are that opening; a later
//     step re-sends min(opening, its input). What the provider already read from cache is reported per
//     step, so what is left is what a cache breakpoint could still save.
//   · SHARED INSTRUCTIONS — runs that start with the same system prompt re-send it run after run. A
//     provider keeps a cache for a few minutes, so a run that starts soon after another with the same
//     instructions could read them from cache. The journal keeps the instructions, not their token
//     count, so this one is an ESTIMATE too (the instructions alone; tool definitions only add to it).
//   · OLD TOOL OUTPUT — a tool result keeps riding along in every later step. The journal keeps the
//     result, not its token count, so this one is an ESTIMATE (4 characters to a token) and says so.
// Nothing here calls a model. What a change does to quality is a replay's question, not this one's.
import {
  flattenUsage,
  modelRecordFacts,
  priceFor,
  reconstructState,
  runKeys,
  usageAndCostFromModelValue,
  effectivePricingTable,
  type ModelPricing,
} from '@gnldev/durable';
import { refuseUnknownNames } from '@gnldev/options';
import { DIAGNOSE_NAMES } from './option-names.js';
import { unwrapOutput } from './tool-output.js';
import { readerOf, type JournalSource } from './journal-of.js';

export interface DiagnoseOptions {
  /** Where the agent's runs are: the store's `runs`, the store, or a journal. Only read. */
  journal: JournalSource;
  /** The agent's registry name (`createGnl` key). */
  agent: string;
  /** How many of its latest completed runs to read (default 200). */
  limit?: number;
  /** A tool result older than this many steps counts as old (default 2). */
  keepLast?: number;
  /**
   * The smallest prefix a provider caches, in tokens (default 1024 — OpenAI's floor, Anthropic's for
   * most models; Gemini's is higher). A shorter opening is never counted as cacheable.
   */
  minCacheTokens?: number;
  /** Prices. The journal's `__pricing__` over the defaults when omitted. */
  pricing?: Record<string, ModelPricing>;
}

export interface Finding {
  lever: 'cache' | 'mask-old-tool-output';
  /** Input tokens it concerns on the runs read. */
  tokens: number;
  /** What it would have saved on the runs read, in USD — absent when the model is not in the price table. */
  estimatedSavingUsd?: number;
  /** True when quality can change, so a replay must show it holds before it is applied. */
  needsReplay: boolean;
  /** The number behind it, in one sentence. */
  why: string;
}

export interface AgentDiagnosis {
  agent: string;
  runs: number;
  modelSteps: number;
  costUsd: number;
  inputTokens: number;
  outputTokens: number;
  cachedTokens: number;
  cacheWriteTokens: number;
  byModel: Record<string, { steps: number; costUsd: number }>;
  /**
   * Input tokens that re-sent each run's opening in later steps; how many were not read from cache; how
   * many of those came from runs whose opening is long enough for a provider to cache (`minCacheTokens`);
   * and the median opening.
   */
  repeatedPrefix: { tokens: number; uncachedTokens: number; cacheableUncachedTokens: number; share: number; medianOpening: number };
  /**
   * ESTIMATED input tokens of instructions a run's first step re-sent because another run with the same
   * system prompt started less than five minutes before it (`runs` of them); how many of those were not
   * read from cache, from instructions long enough for a provider to cache (`minCacheTokens`).
   */
  sharedInstructions: { estimatedTokens: number; cacheableUncachedTokens: number; runs: number; share: number };
  /** ESTIMATED input tokens of tool results older than `keepLast` steps, carried in later steps. */
  oldToolOutput: { estimatedTokens: number; share: number; keepLast: number };
  /** Ordered by estimated saving, largest first (unpriced ones after, by tokens). */
  findings: Finding[];
  /** What was seen and why it is not a finding, one sentence each. */
  notes: string[];
}

/**
 * How long a run's instructions stay in a provider's cache after the run that sent them: the shortest
 * a provider keeps one (Anthropic's default is 5 minutes; OpenAI keeps a prefix 5 to 10 minutes idle).
 */
const CACHE_WINDOW_MS = 5 * 60_000;

const approxTokens = (v: unknown): number => Math.ceil((typeof v === 'string' ? v : JSON.stringify(v ?? '')).length / 4);

/** Reads an agent's latest completed runs and says where their input tokens went. */
export async function diagnoseAgent(opts: DiagnoseOptions): Promise<AgentDiagnosis> {
  refuseUnknownNames('diagnoseAgent', opts, DIAGNOSE_NAMES);
  const { agent } = opts;
  const journal = readerOf(opts.journal);
  const keepLast = opts.keepLast ?? 2;
  const minCache = opts.minCacheTokens ?? 1024;
  const pricing = opts.pricing ?? (await effectivePricingTable(journal as never));
  if (typeof journal.listRunsPaged !== 'function') {
    throw new TypeError('@gnldev/optimizer: diagnoseAgent needs a journal that lists runs by agent (listRunsPaged)');
  }
  const page = await journal.listRunsPaged({ agent, status: 'completed', limit: opts.limit ?? 200 });

  const d: AgentDiagnosis = {
    agent, runs: 0, modelSteps: 0, costUsd: 0, inputTokens: 0, outputTokens: 0, cachedTokens: 0, cacheWriteTokens: 0,
    byModel: {}, repeatedPrefix: { tokens: 0, uncachedTokens: 0, cacheableUncachedTokens: 0, share: 0, medianOpening: 0 },
    sharedInstructions: { estimatedTokens: 0, cacheableUncachedTokens: 0, runs: 0, share: 0 },
    oldToolOutput: { estimatedTokens: 0, share: 0, keepLast }, findings: [], notes: [],
  };
  let cacheSaving = 0;
  let maskSaving = 0;
  let cachePriced = true;
  let maskPriced = true;
  const openings: number[] = [];
  const starts: Array<{ at: number; system: string; tokens: number; input: number; cached: number; price: ModelPricing | undefined }> = [];

  for (const run of page.items) {
    const entries = await journal.readRun(run.runId);
    const models = entries.filter((e) => e.kind === 'model');
    if (models.length === 0) continue;
    d.runs++;
    const steps = models.map((e) => {
      const u = usageAndCostFromModelValue(e.value, { pricing })!;
      const flat = flattenUsage(modelRecordFacts(e.value).usage);
      return { u, flat };
    });
    for (const { u } of steps) {
      if (!u) continue;
      d.modelSteps++;
      d.costUsd += u.costUsd;
      d.inputTokens += u.inputTokens;
      d.outputTokens += u.outputTokens;
      d.cachedTokens += u.cachedTokens;
      d.cacheWriteTokens += u.cacheWriteTokens;
      const bm = (d.byModel[u.modelId] ??= { steps: 0, costUsd: 0 });
      bm.steps++;
      bm.costUsd += u.costUsd;
    }

    // Repeated prefix: the first step's input is the opening every later step re-sends.
    const opening = steps[0]!.flat.inputTokens;
    const price = priceFor(steps[0]!.u.modelId, pricing);
    let runUncached = 0;
    for (const { flat } of steps.slice(1)) {
      const resent = Math.min(opening, flat.inputTokens);
      d.repeatedPrefix.tokens += resent;
      const uncached = Math.max(0, resent - flat.cachedTokens);
      d.repeatedPrefix.uncachedTokens += uncached;
      runUncached += uncached;
    }
    if (steps.length > 1) openings.push(opening);
    if (opening >= minCache && runUncached > 0) {
      d.repeatedPrefix.cacheableUncachedTokens += runUncached;
      if (!price) cachePriced = false;
      else {
        const read = price.cachedInputPer1M ?? price.inputPer1M;
        const write = price.cacheWritePer1M ?? price.inputPer1M;
        // Saved: the re-sent tokens read at the cache rate. Paid: one write of the opening per run.
        cacheSaving += (runUncached / 1e6) * (price.inputPer1M - read) - (opening / 1e6) * (write - price.inputPer1M);
      }
    }

    const input = await journal.get<{ prompt?: unknown; messages?: unknown; system?: unknown }>(runKeys.input(run.runId));
    if (input?.system !== undefined && input.system !== '' && typeof run.createdAt === 'number') {
      starts.push({ at: run.createdAt, system: JSON.stringify(input.system), tokens: approxTokens(input.system), input: steps[0]!.flat.inputTokens, cached: steps[0]!.flat.cachedTokens, price });
    }

    // Old tool output: a result produced at step j rides along in every step k > j; old once k - j > keepLast.
    const seed = Array.isArray(input?.messages) ? { messages: input!.messages as unknown[] } : { prompt: String(input?.prompt ?? '') };
    const { messages } = reconstructState(entries, entries.length, seed as never);
    const produced: Array<{ step: number; tokens: number }> = [];
    let step = -1;
    for (const m of messages as any[]) {
      if (m.role === 'assistant') step++;
      else if (m.role === 'tool' && Array.isArray(m.content)) {
        for (const p of m.content) if (p?.type === 'tool-result') produced.push({ step, tokens: approxTokens(unwrapOutput(p.output)) });
      }
    }
    let runOld = 0;
    for (let k = 1; k < steps.length; k++) {
      for (const r of produced) if (r.step >= 0 && k - r.step > keepLast) runOld += r.tokens;
    }
    d.oldToolOutput.estimatedTokens += runOld;
    if (runOld > 0) {
      if (price) maskSaving += (runOld / 1e6) * price.inputPer1M;
      else maskPriced = false;
    }
  }

  // Shared instructions: a run's first step, when a run with the same instructions started within the
  // cache window before it. Saved: the part not already read from cache, at the cache rate. Paid: one
  // write of the instructions for each burst of runs.
  starts.sort((a, b) => a.at - b.at);
  const last = new Map<string, number>();
  let sharedSaving = 0;
  let sharedShort = 0;
  for (const r of starts) {
    const prev = last.get(r.system);
    last.set(r.system, r.at);
    const shared = Math.min(r.tokens, r.input);
    const read = r.price ? (r.price.cachedInputPer1M ?? r.price.inputPer1M) : 0;
    const write = r.price ? (r.price.cacheWritePer1M ?? r.price.inputPer1M) : 0;
    if (prev === undefined || r.at - prev > CACHE_WINDOW_MS) {
      if (shared >= minCache && r.price) sharedSaving -= (shared / 1e6) * (write - r.price.inputPer1M);
      continue;
    }
    d.sharedInstructions.runs++;
    d.sharedInstructions.estimatedTokens += shared;
    const uncached = Math.max(0, shared - r.cached);
    if (shared < minCache) { sharedShort += uncached; continue; }
    d.sharedInstructions.cacheableUncachedTokens += uncached;
    if (!r.price) cachePriced = false;
    else sharedSaving += (uncached / 1e6) * (r.price.inputPer1M - read);
  }

  if (d.inputTokens > 0) {
    d.sharedInstructions.share = d.sharedInstructions.estimatedTokens / d.inputTokens;
    d.repeatedPrefix.share = d.repeatedPrefix.tokens / d.inputTokens;
    d.oldToolOutput.share = d.oldToolOutput.estimatedTokens / d.inputTokens;
  }
  const sorted = openings.slice().sort((a, b) => a - b);
  d.repeatedPrefix.medianOpening = sorted.length ? sorted[Math.floor((sorted.length - 1) / 2)]! : 0;
  const unpriced = ' The model is not in the price table, so no dollar figure is given.';
  const withinRuns = d.repeatedPrefix.cacheableUncachedTokens > 0 && (!cachePriced || cacheSaving > 0);
  const acrossRuns = d.sharedInstructions.cacheableUncachedTokens > 0 && (!cachePriced || sharedSaving > 0);
  if (withinRuns || acrossRuns) {
    const tokens = (withinRuns ? d.repeatedPrefix.cacheableUncachedTokens : 0) + (acrossRuns ? d.sharedInstructions.cacheableUncachedTokens : 0);
    const saving = (withinRuns ? cacheSaving : 0) + (acrossRuns ? sharedSaving : 0);
    const why = [
      withinRuns ? `${pct(d.repeatedPrefix.cacheableUncachedTokens, d.inputTokens)} of input re-sent each run's opening on later steps without a cache read.` : '',
      acrossRuns ? `About ${pct(d.sharedInstructions.cacheableUncachedTokens, d.inputTokens)} of input (estimated) re-sent the same instructions in ${d.sharedInstructions.runs} run${d.sharedInstructions.runs === 1 ? '' : 's'} that started within ${CACHE_WINDOW_MS / 60_000} minutes of another, without a cache read.` : '',
      `A cache mark (Anthropic) or a cache key (OpenAI) reads it at the cache rate, after one write${withinRuns ? ' per run' : ' per burst of runs'}.${cachePriced ? '' : unpriced}`,
    ].filter(Boolean).join(' ');
    d.findings.push({ lever: 'cache', tokens, ...(cachePriced ? { estimatedSavingUsd: saving } : {}), needsReplay: false, why });
  }
  if (sharedShort > 0 && d.sharedInstructions.cacheableUncachedTokens === 0) {
    d.notes.push(`About ${pct(sharedShort, d.inputTokens)} of input (estimated) re-sent the same instructions run after run, but they are shorter than a provider caches (${minCache}); a cache mark would not be honored.`);
  }
  if (d.repeatedPrefix.uncachedTokens > 0 && d.repeatedPrefix.cacheableUncachedTokens === 0) {
    d.notes.push(`${pct(d.repeatedPrefix.uncachedTokens, d.inputTokens)} of input re-sent each run's opening, but the openings (median ${d.repeatedPrefix.medianOpening} tokens) are shorter than a provider caches (${minCache}); a cache mark would not be honored.`);
  }
  if (d.oldToolOutput.estimatedTokens > 0) {
    d.findings.push({
      lever: 'mask-old-tool-output', tokens: d.oldToolOutput.estimatedTokens, ...(maskPriced ? { estimatedSavingUsd: maskSaving } : {}), needsReplay: true,
      why: `About ${pct(d.oldToolOutput.estimatedTokens, d.inputTokens)} of input (estimated) was tool output more than ${keepLast} steps old; whether the agent still needs it is a replay's answer.${maskPriced ? '' : unpriced}`,
    });
  }
  d.findings.sort((a, b) => (b.estimatedSavingUsd ?? -1) - (a.estimatedSavingUsd ?? -1) || b.tokens - a.tokens);
  return d;
}

function pct(part: number, whole: number): string {
  return whole > 0 ? `${Math.round((part / whole) * 100)}%` : '0%';
}
