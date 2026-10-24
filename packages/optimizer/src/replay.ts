// Counterfactual replay: a recorded run, played again under another setting, without running a tool.
//
// The question it answers is "would this agent have done the same work, for less?" — asked of the
// conversations the agent actually had, not of a benchmark. The recorded run's first input is handed to
// the candidate model with the agent's real tool definitions; every tool's execute is replaced by a
// lookup in the recorded run. A call the recorded run made (same tool, same arguments) gets the
// recorded result. A call it did not make has no result to give, so the replay stops there and reports
// a divergence: the candidate would have done different work. A real tool is never called — a replay
// cannot refund, charge or send anything.
//
// It writes nothing: the source journal is only read, and the candidate runs as a plain AI SDK call.
import { generateText, stepCountIs, wrapLanguageModel, type LanguageModel, type ModelMessage, type Tool, type ToolSet } from 'ai';
import {
  argsHash,
  effectivePricingTable,
  reconstructState,
  runKeys,
  settleModelContent,
  usageAndCostFromModelValue,
  type ModelPricing,
} from '@gnldev/durable';
import { refuseUnknownNames } from '@gnldev/options';
import { REPLAY_NAMES } from './option-names.js';
import { unwrapOutput } from './tool-output.js';
import { readerOf, type JournalSource } from './journal-of.js';

/** A tool call, as the replay compares them: the tool and a hash of its arguments. */
export interface CallSignature {
  toolName: string;
  argsHash: string;
}

export interface CounterfactualOptions {
  /** Where the recorded run is: the store's `runs`, the store, or a journal. Only read. */
  journal: JournalSource;
  /** The recorded run to play again. */
  runId: string;
  /** The candidate model. */
  model: LanguageModel;
  /**
   * The agent's tool definitions — the journal keeps results, not schemas. Their `execute` is never
   * called; the replay answers from the recorded run.
   */
  tools?: ToolSet;
  /** The system prompt; the recorded one when omitted. */
  system?: string;
  /** Most model steps the candidate may take (default 20). */
  maxSteps?: number;
  /** Longest the candidate may take, in ms (default 120000) — a provider that never answers would hold the replay forever. */
  timeoutMs?: number;
  /**
   * A per-step context policy (the AI SDK's `prepareStep`) — how a lever such as masking old tool
   * outputs is tried without changing the agent.
   */
  prepareStep?: Parameters<typeof generateText>[0]['prepareStep'];
  /** Prices, for both sides. The journal's `__pricing__`/the defaults when omitted. */
  pricing?: Record<string, ModelPricing>;
}

export interface CounterfactualSide {
  text: string;
  calls: CallSignature[];
  costUsd: number;
  /** Every model step was found in the price table. */
  priced: boolean;
  inputTokens: number;
  outputTokens: number;
  cachedTokens: number;
  cacheWriteTokens: number;
  modelSteps: number;
}

export interface CounterfactualResult {
  runId: string;
  recorded: CounterfactualSide;
  candidate: CounterfactualSide;
  /** The first call the recorded run never made — the replay stopped after its step. */
  divergence?: { at: number; call: CallSignature };
  /** Calls the recorded run made that the candidate did not make (before any divergence). */
  missed: CallSignature[];
  /** The candidate made the recorded calls in another order. */
  reordered: boolean;
}

/** The replay could not start: the run is not in the journal, or has no recorded input. */
export class ReplaySourceError extends Error {
  constructor(message: string) { super(message); this.name = 'ReplaySourceError'; }
}

type RecordedCall = CallSignature & { output: unknown };

/** The recorded run's tool calls with their results, in order — paired by `reconstructState`. */
function recordedCalls(messages: ModelMessage[]): RecordedCall[] {
  const outputs = new Map<string, unknown>();
  for (const m of messages) {
    if (m.role !== 'tool' || !Array.isArray(m.content)) continue;
    for (const p of m.content as any[]) if (p?.type === 'tool-result') outputs.set(p.toolCallId, unwrapOutput(p.output));
  }
  const out: RecordedCall[] = [];
  for (const m of messages) {
    if (m.role !== 'assistant' || !Array.isArray(m.content)) continue;
    for (const p of m.content as any[]) {
      if (p?.type !== 'tool-call' || !outputs.has(p.toolCallId)) continue;
      out.push({ toolName: p.toolName, argsHash: argsHash(parseInput(p.input)), output: outputs.get(p.toolCallId) });
    }
  }
  return out;
}

function parseInput(input: unknown): unknown {
  if (typeof input !== 'string') return input;
  try { return JSON.parse(input); } catch { return input; }
}


function textOf(content: any[]): string {
  return content.filter((p) => p?.type === 'text').map((p) => p.text).join('');
}

function sideOf(values: unknown[], pricing: Record<string, ModelPricing>, text: string, calls: CallSignature[]): CounterfactualSide {
  const side: CounterfactualSide = { text, calls, costUsd: 0, priced: true, inputTokens: 0, outputTokens: 0, cachedTokens: 0, cacheWriteTokens: 0, modelSteps: 0 };
  for (const v of values) {
    const u = usageAndCostFromModelValue(v, { pricing });
    if (!u) continue;
    side.modelSteps++;
    side.costUsd += u.costUsd;
    side.priced &&= u.priced;
    side.inputTokens += u.inputTokens;
    side.outputTokens += u.outputTokens;
    side.cachedTokens += u.cachedTokens;
    side.cacheWriteTokens += u.cacheWriteTokens;
  }
  return side;
}

/**
 * Plays `runId` again with `model` (and `system`, `prepareStep`), answering every tool call from the
 * recorded run and never executing a tool. Compares cost and calls with the recorded run.
 */
export async function replayCounterfactual(opts: CounterfactualOptions): Promise<CounterfactualResult> {
  refuseUnknownNames('replayCounterfactual', opts, REPLAY_NAMES);
  const { runId } = opts;
  const journal = readerOf(opts.journal);
  const input = await journal.get<{ prompt?: unknown; messages?: unknown; system?: unknown }>(runKeys.input(runId));
  if (!input) throw new ReplaySourceError(`@gnldev/optimizer: no recorded input for run '${runId}' — only a run started by GNL can be replayed`);
  const entries = await journal.readRun(runId);
  const seed = Array.isArray(input.messages) ? { messages: input.messages } : { prompt: input.prompt as string };
  const { messages: recordedMessages } = reconstructState(entries, entries.length, seed);
  const recorded = recordedCalls(recordedMessages as ModelMessage[]);

  // Both sides priced from ONE table: the caller's, or the journal's `__pricing__` over the defaults —
  // two tables would make the comparison measure the tables.
  const pricing = opts.pricing ?? (await effectivePricingTable(journal as never));
  const modelValues = entries.filter((e) => e.kind === 'model').map((e) => e.value);
  const lastModel = modelValues.at(-1);
  const recordedSide = sideOf(modelValues, pricing, lastModel ? textOf(settleModelContent(lastModel)) : '', recorded.map(({ toolName, argsHash: h }) => ({ toolName, argsHash: h })));

  // Candidate side.
  const unused = [...recorded];
  const made: CallSignature[] = [];
  let divergence: CounterfactualResult['divergence'];
  const tools: Record<string, Tool> = {};
  for (const [name, def] of Object.entries(opts.tools ?? {})) {
    tools[name] = {
      ...def,
      execute: async (args: unknown) => {
        const call = { toolName: name, argsHash: argsHash(args) };
        made.push(call);
        const i = unused.findIndex((r) => r.toolName === call.toolName && r.argsHash === call.argsHash);
        if (i === -1) {
          divergence ??= { at: made.length - 1, call };
          return { error: 'GNL replay: the recorded run never made this call, so it has no result to give' };
        }
        return unused.splice(i, 1)[0]!.output;
      },
    } as Tool;
  }
  const seen: unknown[] = [];
  const model = wrapLanguageModel({
    model: opts.model as any,
    middleware: {
      specificationVersion: 'v3',
      wrapGenerate: async ({ doGenerate, model: m }: any) => {
        const r = await doGenerate();
        seen.push({ usage: r.usage, response: { modelId: r.response?.modelId ?? m.modelId } });
        return r;
      },
    } as any,
  });
  const system = opts.system ?? (typeof input.system === 'string' ? input.system : undefined);
  const result = await generateText({
    model,
    ...(Array.isArray(input.messages) ? { messages: input.messages as ModelMessage[] } : { prompt: String(input.prompt ?? '') }),
    ...(system !== undefined ? { system } : {}),
    tools,
    stopWhen: [stepCountIs(opts.maxSteps ?? 20), () => divergence !== undefined],
    abortSignal: AbortSignal.timeout(opts.timeoutMs ?? 120_000),
    ...(opts.prepareStep ? { prepareStep: opts.prepareStep } : {}),
  } as any);
  const candidateSide = sideOf(seen, pricing, divergence ? '' : result.text, made);

  const matched = made.filter((c, i) => !(divergence && i >= divergence.at));
  const recordedOrder = recorded.map((r) => `${r.toolName}:${r.argsHash}`).filter((k) => matched.some((c) => `${c.toolName}:${c.argsHash}` === k));
  const reordered = matched.map((c) => `${c.toolName}:${c.argsHash}`).join('|') !== recordedOrder.join('|');
  return {
    runId,
    recorded: recordedSide,
    candidate: candidateSide,
    ...(divergence ? { divergence } : {}),
    missed: divergence ? [] : unused.map(({ toolName, argsHash: h }) => ({ toolName, argsHash: h })),
    reordered: !divergence && reordered,
  };
}
