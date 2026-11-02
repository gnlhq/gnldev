// The playground: an agent written on the page — its prompt, its tools, what each tool returns — talked
// to and measured before it has a run of its own, or before its code changes. Nothing runs: every tool
// call is answered from what the person wrote (an answer for those arguments, else the tool's default), and
// a call nothing answers stops the play, named, for the person to answer. Nothing is written either: the
// definition and the conversation come with every request.
import { generateText, jsonSchema, stepCountIs, tool, type LanguageModel, type ModelMessage, type ToolSet } from 'ai';
import { argsHash, priceFor, type ModelPricing } from '@gnldev/durable';
import { refuseUnknownNames } from '@gnldev/options';
import { runTrials, wilson, newcombe, type Expectation, type Interval, type TracedCall, type TrialsProgress } from '@gnldev/experiment';
import { judgePlay } from './judge.js';
import { PLAY_AGENT_NAMES, MEASURE_AGENT_NAMES } from './option-names.js';

/** A tool as the page writes it, and what it returns. */
export interface PlaygroundTool {
  name: string;
  description: string;
  /** Its parameters, a JSON Schema (an object schema). */
  parameters: unknown;
  /** What it returns for these exact arguments. */
  answers?: Array<{ args: unknown; output: unknown }>;
  /** What it returns for any other arguments; without one such a call stops the play. */
  otherwise?: { output: unknown };
}

/** An agent as the page writes it. */
export interface PlaygroundAgent {
  system: string;
  tools: PlaygroundTool[];
}

export interface PlayAgentOptions {
  agent: PlaygroundAgent;
  model: LanguageModel;
  /** The conversation so far, ending with the user's message. */
  messages: ModelMessage[];
  maxSteps?: number;
  pricing?: Record<string, ModelPricing>;
}

/** A tool call in a play and where its answer came from: an answer for its arguments, the tool's default, or none (the play stopped). */
export interface PlaygroundCall { toolName: string; args: unknown; source: 'answer' | 'otherwise' | 'none'; output?: unknown }

export interface PlayAgentResult {
  /** The agent's answer ('' when it stopped at a call nothing answers). */
  text: string;
  calls: PlaygroundCall[];
  /** The call that stopped the play — answer it and play again. */
  stopped?: { toolName: string; args: unknown };
  /** The messages the play added (the agent's, and each tool's answer), to append to the conversation. */
  messages: ModelMessage[];
  inputTokens: number;
  outputTokens: number;
  costUsd: number;
  priced: boolean;
}

const NAME = /^[A-Za-z_][A-Za-z0-9_-]{0,63}$/;

/** The page's definition checked: tool names a provider takes, each once, parameters an object schema. */
function checked(agent: PlaygroundAgent): void {
  const seen = new Set<string>();
  for (const t of agent.tools) {
    if (!NAME.test(t.name)) throw new RangeError(`@gnldev/lab: tool name '${t.name}' must be letters, digits, '_' or '-', starting with a letter or '_'`);
    if (seen.has(t.name)) throw new RangeError(`@gnldev/lab: tool '${t.name}' is defined twice`);
    seen.add(t.name);
    const p = t.parameters as { type?: unknown } | null;
    if (!p || typeof p !== 'object' || p.type !== 'object') throw new RangeError(`@gnldev/lab: tool '${t.name}' needs its parameters as an object JSON Schema ({ "type": "object", … })`);
  }
}

/** The definition as AI SDK tools whose `execute` answers from the page, keeping each call it made. */
function toolsOf(agent: PlaygroundAgent, calls: PlaygroundCall[], onStop: (c: { toolName: string; args: unknown }) => void): ToolSet {
  return Object.fromEntries(agent.tools.map((t) => {
    const answers = new Map((t.answers ?? []).map((a) => [argsHash(a.args), a.output]));
    return [t.name, tool({
      description: t.description, inputSchema: jsonSchema(t.parameters as never),
      execute: async (args: unknown) => {
        const h = argsHash(args);
        if (answers.has(h)) { const output = answers.get(h); calls.push({ toolName: t.name, args, source: 'answer', output }); return output; }
        if (t.otherwise) { calls.push({ toolName: t.name, args, source: 'otherwise', output: t.otherwise.output }); return t.otherwise.output; }
        calls.push({ toolName: t.name, args, source: 'none' });
        onStop({ toolName: t.name, args });
        return { error: 'nothing answers this call' };
      },
    } as never)];
  })) as ToolSet;
}

/** One play of the conversation: the agent's next answer, every call answered from the page. */
export async function playAgent(opts: PlayAgentOptions): Promise<PlayAgentResult> {
  refuseUnknownNames('playAgent', opts, PLAY_AGENT_NAMES);
  checked(opts.agent);
  if (opts.messages.at(-1)?.role !== 'user') throw new RangeError('@gnldev/lab: playAgent: the conversation must end with the user\'s message');
  const calls: PlaygroundCall[] = [];
  let stopped: { toolName: string; args: unknown } | undefined;
  const r = await generateText({
    model: opts.model, system: opts.agent.system, messages: opts.messages,
    tools: toolsOf(opts.agent, calls, (c) => { stopped ??= c; }),
    stopWhen: [stepCountIs(opts.maxSteps ?? 10), () => stopped !== undefined],
  });
  const modelId = typeof opts.model === 'string' ? opts.model : (opts.model as { modelId?: string }).modelId;
  const price = modelId && opts.pricing ? priceFor(modelId, opts.pricing) : undefined;
  const inputTokens = r.totalUsage?.inputTokens ?? 0, outputTokens = r.totalUsage?.outputTokens ?? 0;
  return {
    text: stopped ? '' : r.text, calls, ...(stopped ? { stopped } : {}),
    // AI SDK 7 keeps only the last step in `response.messages`: every step's own, in order.
    messages: stopped ? [] : (r.steps.flatMap((x) => x.response.messages) as ModelMessage[]),
    inputTokens, outputTokens,
    costUsd: price ? (inputTokens / 1e6) * price.inputPer1M + (outputTokens / 1e6) * price.outputPer1M : 0, priced: !!price,
  };
}

export interface MeasureAgentOptions extends Omit<PlayAgentOptions, 'agent'> {
  agent: PlaygroundAgent;
  /** What a right answer does; every play is checked against it. */
  expect: Expectation;
  /** Plays (default 5). */
  trials?: number;
  /** Another definition played as many times beside it — "A" — with the difference between the two. */
  compareTo?: PlaygroundAgent;
  concurrency?: number;
  onProgress?: (progress: TrialsProgress) => void;
  signal?: AbortSignal;
  throttle?: { waitMs?: number; maxWaits?: number };
}

/** How the plays of one definition went. */
export interface PlaygroundMeasure {
  passed: number;
  failed: number;
  /** Plays that stopped at a call nothing answers, and were not settled by what they did. */
  undetermined: number;
  errored: number;
  /** Right answers among the plays that ran, an undetermined one counted wrong (95% Wilson). */
  passRate: Interval;
  /** Every way the plays went: the calls in order, how often, how many of those were right. */
  paths: Array<{ calls: TracedCall[]; text: string; count: number; passed: number; failures?: string[] }>;
  pending: Array<{ toolName: string; args: unknown }>;
}

export interface MeasureAgentResult {
  measure: PlaygroundMeasure;
  /** With `compareTo`: "A", measured the same way. */
  compared?: PlaygroundMeasure;
  /** With `compareTo`: this definition's rate minus A's (Newcombe, 95%); one that holds 0 does not tell them apart. */
  difference?: Interval;
  inputTokens: number;
  outputTokens: number;
  costUsd: number;
  priced: boolean;
}

/** The conversation's last turn played `trials` times — and, with `compareTo`, as many times by A. */
export async function measureAgent(opts: MeasureAgentOptions): Promise<MeasureAgentResult> {
  refuseUnknownNames('measureAgent', opts, MEASURE_AGENT_NAMES);
  const trials = opts.trials ?? 5;
  if (!Number.isInteger(trials) || trials < 1) throw new RangeError('@gnldev/lab: measureAgent: trials must be a whole number ≥ 1');
  if (!((opts.expect.calls?.length ?? 0) + (opts.expect.forbidden?.length ?? 0) + (opts.expect.answerIncludes?.length ?? 0))) {
    throw new RangeError('@gnldev/lab: measureAgent needs `expect` — what a right answer does');
  }
  checked(opts.agent);
  if (opts.compareTo) checked(opts.compareTo);
  const base = { model: opts.model, messages: opts.messages, ...(opts.maxSteps !== undefined ? { maxSteps: opts.maxSteps } : {}), ...(opts.pricing ? { pricing: opts.pricing } : {}) };
  const jobs = [
    ...Array.from({ length: trials }, () => () => playAgent({ ...base, agent: opts.agent })),
    ...(opts.compareTo ? Array.from({ length: trials }, () => () => playAgent({ ...base, agent: opts.compareTo! })) : []),
  ];
  const done = await runTrials(jobs, {
    ...(opts.concurrency !== undefined ? { concurrency: opts.concurrency } : {}),
    ...(opts.onProgress ? { onProgress: opts.onProgress } : {}),
    ...(opts.signal ? { signal: opts.signal } : {}),
    ...(opts.throttle ? { throttle: opts.throttle } : {}),
  });
  let inputTokens = 0, outputTokens = 0, costUsd = 0, priced = true;
  const tally = (outcomes: typeof done.outcomes): PlaygroundMeasure => {
    let passed = 0, failed = 0, undetermined = 0, errored = 0;
    const paths = new Map<string, PlaygroundMeasure['paths'][number]>();
    const pending = new Map<string, { toolName: string; args: unknown }>();
    for (const o of outcomes) {
      if (!o.ok) { errored++; continue; }
      const r = o.value;
      inputTokens += r.inputTokens; outputTokens += r.outputTokens; costUsd += r.costUsd; priced &&= r.priced;
      // An answer written on the page reads, to the judge, as a result the recording did not hold.
      const trace: TracedCall[] = r.calls.map((c) => ({ toolName: c.toolName, args: c.args, source: c.source === 'none' ? 'none' : 'answer' }));
      const v = judgePlay(opts.expect, trace, r.text);
      if (v.verdict === 'pass') passed++; else if (v.verdict === 'fail') failed++; else undetermined++;
      if (r.stopped) pending.set(`${r.stopped.toolName}:${argsHash(r.stopped.args)}`, r.stopped);
      const key = trace.map((c) => `${c.toolName}:${argsHash(c.args)}:${c.source}`).join('|');
      const p = paths.get(key) ?? { calls: trace, text: r.text, count: 0, passed: 0, ...(v.verdict === 'fail' ? { failures: v.failures } : {}) };
      p.count++; if (v.verdict === 'pass') p.passed++;
      paths.set(key, p);
    }
    return { passed, failed, undetermined, errored, passRate: wilson(passed, passed + failed + undetermined), paths: [...paths.values()].sort((a, b) => b.count - a.count), pending: [...pending.values()] };
  };
  const measure = tally(done.outcomes.slice(0, trials));
  const compared = opts.compareTo ? tally(done.outcomes.slice(trials)) : undefined;
  const ran = (m: PlaygroundMeasure) => m.passed + m.failed + m.undetermined;
  const difference = compared && ran(measure) && ran(compared) ? newcombe({ successes: measure.passed, n: ran(measure) }, { successes: compared.passed, n: ran(compared) }) : undefined;
  return { measure, ...(compared ? { compared } : {}), ...(difference ? { difference } : {}), inputTokens, outputTokens, costUsd, priced };
}
