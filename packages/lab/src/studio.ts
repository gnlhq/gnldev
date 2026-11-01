// The object Studio's Lab tab calls (`createStudioApp({ lab: studioLab(...) })`).
//
// Studio hands every call the reader of the request it serves — scoped to the caller's organization —
// so a run the caller may not see is not found. This side holds what Studio must not: the agents' tool
// definitions (from the same config createGnl is given) and the models an explanation may use. Shaped to
// Studio's `StudioLab` by structure, so neither package depends on the other.
//
// The parts are proposed from the run's own record, never typed in: the recorded system prompt cut at
// blank lines, each earlier turn of the input (a user message and what followed it), and each tool the
// run called. The last user message is never a part — without it there is nothing to answer. More than
// `maxParts` and the oldest turns are merged first, then the system prompt's sections.
//
// A memory run's parts are named by where they came from — observations, recall, the recent window, the
// working memory in the system prompt — as the run's own layout proves it (@gnldev/durable
// readRunMemoryLayout). A memory run without a layout is not guessed at: its parts are the plain turns,
// each marked `source: 'unknown'`, and the plan says why. A tool call and its result are never split
// between two parts: a provider refuses a conversation that holds one without the other.
import { asSchema, jsonSchema, tool, type LanguageModel, type ModelMessage, type ToolSet } from 'ai';
import { argsHash, effectivePricingTable, priceFor, runKeys, type JournalReader, type ModelPricing } from '@gnldev/durable';
import { refuseUnknownNames } from '@gnldev/options';
import { readerOf, usageOfRun, type JournalSource } from './journal.js';
import { explainRun, explainRunSize, type ExplainRunResult } from './explain-run.js';
import { bestForm, promptSection, withTool, withoutTool, type BestFormResult, type Component } from './best-form.js';
import { checkPrune, type PruneCheckResult } from './prune-check.js';
import { wordShares, toolChoiceProbability, sampledToolChoice, type WordSharesResult } from './word-shares.js';
import { openAIMessagesOf } from './openai-messages.js';
import { DEFAULT_SUITE, recordedTrace, type Expectation, type Scenario, type ToolAnswer, type TrialsProgress } from '@gnldev/experiment';
import { runCapsule, capsuleSystemOf, type CapsuleResult, type CapsuleSystem } from './capsule.js';
import { proposeParts, sourcesOf, cut, textOf, type LabPart, type LabLayout, type Proposed } from './parts.js';
import { threadPlan, diagnoseTurn, type ThreadPlanResult, type DiagnoseTurnResult } from './thread-diagnose.js';
import { playAgent, measureAgent, type PlaygroundAgent, type PlayAgentResult, type MeasureAgentResult } from './playground.js';
import { scenarioOfRun, scenarioOfPlayground, saveScenario, listScenarios, findScenario, deleteScenario, updateScenario, runScenarios, type SavedScenario, type ScenarioEdit, type RunScenariosResult } from './saved-scenarios.js';

export { proposeParts, type LabPart, type LabLayout, type PartSources } from './parts.js';
import { STUDIO_LAB_NAMES } from './option-names.js';

export interface StudioLabOptions {
  /** The config createGnl is given — its agents are offered, and their tools answer a replay. */
  config: { agents?: Record<string, { tools?: unknown; system?: unknown }> };
  /** The models an explanation may use, by the name Studio shows. */
  models: Record<string, LanguageModel>;
  /** Prices. The journal's `__pricing__` over the defaults when omitted. */
  pricing?: Record<string, ModelPricing>;
  /** Most parts proposed for a run, or sections of a new agent's prompt (default 6 — 64 subsets). */
  maxParts?: number;
  /**
   * The scenarios a new agent's forms are tried on, per agent name (default: @gnldev/experiment's
   * DEFAULT_SUITE). Their tools are fakes that run; the agent's own tools never do.
   */
  scenarios?: Record<string, readonly Scenario[]>;
  /**
   * The models (by the name Studio shows) whose provider gives a token's probability for a tool call — an
   * OpenAI-compatible endpoint that returns `logprobs` on one (NVIDIA NIM does; OpenAI's API does not).
   * "Which words decided" reads that probability once per subset of words; any other model is asked
   * `samples` times per subset instead and the share of tries is the value.
   */
  logprobs?: Record<string, { baseURL: string; apiKey: string; model: string; body?: Record<string, unknown>; fetch?: typeof fetch }>;
}

export interface LabPlan {
  runId: string;
  agent: string;
  parts: LabPart[];
  layout: LabLayout;
  trials: number;
  replays: number;
  /** The recorded run's tokens — what one replay of the whole input costs, roughly. */
  tokensPerReplay: number;
  /**
   * What the replays are expected to take in all. Each part is left out of half of them, so a replay's
   * input is the recorded input less half the parts' share of it (by characters of the system sections
   * and messages; a tool result's size is not in the input record and is counted whole). Compare it with
   * what the explanation reports it spent.
   */
  estimatedTokens: number;
  /** `estimatedTokens` at the chosen model's price; absent when it is unpriced. */
  estimatedCostUsd?: number;
}

export interface LabExplanation extends ExplainRunResult {
  agent: string;
  model: string;
  partsDetail: LabPart[];
}

export interface LabScenario { id: string; category: string; prompt: string }

export interface LabFormPlan {
  agent: string;
  /** The agent's system prompt cut at blank lines: each section is a component. */
  components: LabPart[];
  scenarios: number;
  trials: number;
  /** Every subset of the components. */
  forms: number;
  /** forms × trials × scenarios. */
  runs: number;
  /** The tools the chosen scenarios offer — each can be taken away as a component (`withoutTools`). */
  tools: string[];
}

/** A tool a new agent's forms may offer: its definition, and what it returns whatever it is asked. */
export interface LabFormTool { name: string; description: string; parameters: Record<string, unknown>; output: unknown }
export interface LabFormRequest {
  agent: string;
  trials?: number;
  scenarios?: string[];
  /** Tools the scenarios offer, each taken away in half of the forms: component `without <name>`. */
  withoutTools?: string[];
  /** Tools written on the page, each offered in half of the forms: component `with <name>`. */
  addTools?: LabFormTool[];
}

export interface LabBestForm extends BestFormResult {
  agent: string;
  model: string;
  componentsDetail: LabPart[];
  scenarios: string[];
}

/** A tool as the capsule offers it: the agent's, described otherwise, or one the person added. */
export interface LabCapsuleTool {
  name: string;
  description: string;
  /** JSON Schema of its arguments; the agent's own when omitted for one of its tools. */
  parameters?: unknown;
  /**
   * The run called it but the agent's config does not define it (memory's own `updateWorkingMemory`,
   * for one): offered with no description and any arguments, and answered from the recording.
   */
  recordedOnly?: true;
}

/** What a run's capsule starts from: the recorded prompt and the agent's tools, before any change. */
export interface LabCapsuleBase {
  runId: string;
  agent: string;
  /**
   * The system prompt the run was given ('' when it had none) — without the working memory when the
   * layout places one in it (see `workingMemory`); a capsule's `system` replaces this text.
   */
  system: string;
  /** The working memory memory put into the system prompt, told apart from it when the layout places it. */
  workingMemory?: CapsuleSystem['workingMemory'];
  tools: LabCapsuleTool[];
  /** Messages before the run's last one — what `history: false` leaves out. */
  earlierMessages: number;
  /** Messages memory put into the input — what `memory: false` leaves out; null when the layout does not prove which (see `layout`). */
  memoryMessages: number | null;
  /** Where the input came from, by the run's own layout. */
  layout: LabLayout;
  /** The input's parts, each named by where it came from (none merged). */
  parts: LabPart[];
  lastMessage: string;
  recordedCalls: Array<{ toolName: string; args: unknown }>;
  /** The recorded run's tokens — roughly what one play costs. */
  tokensPerPlay: number;
}

export interface LabCapsuleRequest {
  runId: string;
  model: string;
  trials?: number;
  system?: string;
  /** Every tool the capsule offers; the agent's own when omitted. */
  tools?: LabCapsuleTool[];
  history?: boolean;
  memory?: boolean;
  /** What a right answer does; every play is checked against it. */
  expect?: Expectation;
  answers?: ToolAnswer[];
  /** Results put in place of the recorded ones (same tool, same arguments). */
  overrides?: ToolAnswer[];
}

export interface LabCapsule extends CapsuleResult {
  agent: string;
  model: string;
}

/** A thread's turns, read a page at a time — see threadPlan. */
export interface LabThreadPlanRequest {
  threadId: string;
  /** The model a diagnosis would play with — it prices the plan. */
  model: string;
  /** Plays per arm; the planned number when omitted. */
  trials?: number;
  offset?: number;
  limit?: number;
  /** What a right answer does: each turn's own calls are checked against it. */
  expect?: Expectation;
  /** The hypotheses the person will bring, named — each is an arm the plan counts (see threadPlan). */
  hypotheses?: { workingMemory?: boolean; overrides?: string[]; corrections?: string[]; suggest?: boolean; guess?: boolean };
}

export interface LabThreadPlan extends ThreadPlanResult { model: string }

/** A turn's diagnosis, as the Lab tab asks for it — see diagnoseTurn. */
export interface LabThreadRequest {
  runId: string;
  model: string;
  /** What a right answer does — required. */
  expect: Expectation;
  trials?: number;
  eliminationTrials?: number;
  topK?: number;
  /** A corrected working memory to try in place of the recorded one. */
  workingMemory?: string;
  /** Tool results the person thinks were wrong, each tried in place of the recorded one. */
  overrides?: ToolAnswer[];
  /** Results for calls the recording never made. */
  answers?: ToolAnswer[];
  /** What a part should have said, by part id (diagnoseTurn `corrections`). */
  corrections?: Record<string, string>;
  /** The diagnosing model also proposes corrections of the most blamed parts (diagnoseTurn `suggest`). */
  suggest?: boolean;
  /** The diagnosing model first names the parts most likely to blame; only those are played first (diagnoseTurn `guess`). */
  guess?: boolean;
}

export interface LabThreadDiagnosis extends DiagnoseTurnResult { agent: string; model: string }

/** What "would removing this section change what the agent does?" takes, before it is asked. */
export interface LabPrunePlan {
  runId: string;
  agent: string;
  /** The run's system prompt cut at blank lines (none merged): the sections one can remove. */
  sections: LabPart[];
  /** The agent's tools — they RUN in this check, so each is answered from the page. */
  tools: Array<{ name: string; description: string; parameters: unknown }>;
  /** The full prompt twice (the noise), without the section, and without the control when one is named. */
  arms: number;
  runs: number;
  /** One run is taken to cost what the recorded run did. */
  estimatedTokens: number;
  estimatedCostUsd?: number;
}
export interface LabPruneRequest {
  runId: string;
  model: string;
  remove: string;
  control?: string;
  /** New user messages, each in place of the run's last one. */
  prompts: string[];
  /** What each tool returns: for these exact arguments, else its default. A call neither answers gets `{ error }` and is listed. */
  answers?: Array<{ toolName: string; args: unknown; output: unknown }>;
  otherwise?: Record<string, unknown>;
  trials?: number;
  margin?: number;
}
export interface LabPrune extends PruneCheckResult {
  agent: string;
  model: string;
  /** Calls the page did not answer — each got an error back, so what followed it is not the agent's. */
  unanswered: Array<{ toolName: string; args: unknown; count: number }>;
  costUsd: number;
  priced: boolean;
}

/** What "which words decided it?" takes, before it is asked. */
export interface LabWordsPlan {
  runId: string;
  agent: string;
  /** The run's last user message as it is cut by default — at most 6 groups of words when sampled, 8 with logprobs. */
  words: string[];
  /** The tools offered, and the one the run called first (the default to explain). */
  tools: string[];
  tool?: string;
  /** `logprobs`: one call per subset, the provider's probability; `sampled`: `samples` calls per subset, the share of tries. */
  method: 'logprobs' | 'sampled';
  samples: number;
  subsets: number;
  calls: number;
  estimatedTokens: number;
  estimatedCostUsd?: number;
}
export interface LabWordsRequest { runId: string; model: string; tool: string; words: string[]; samples?: number }
export interface LabWords extends WordSharesResult {
  agent: string;
  model: string;
  tool: string;
  method: 'logprobs' | 'sampled';
  /** Tries per subset when sampled. */
  samples?: number;
  inputTokens: number;
  outputTokens: number;
  costUsd: number;
  priced: boolean;
}

/** How a long lab call reports as it goes, and how it is stopped. */
export interface LabRunControl {
  onProgress?: (progress: TrialsProgress) => void;
  signal?: AbortSignal;
}

export interface StudioLabApi {
  catalog(): { agents: string[]; models: string[] };
  plan(journal: JournalReader, request: { runId: string; model: string; trials?: number }): Promise<LabPlan>;
  explain(journal: JournalReader, request: { runId: string; model: string; trials?: number }, control?: LabRunControl): Promise<LabExplanation>;
  /** The scenarios a new agent's forms can be tried on. */
  scenarios(agent: string): LabScenario[];
  /** The components of an agent's prompt and how many runs trying every form takes. Calls no model. */
  formPlan(request: LabFormRequest): LabFormPlan;
  /** Every form of the agent on the chosen scenarios: the cheapest that passes as well as the best. */
  bestForm(request: LabFormRequest & { model: string }, control?: LabRunControl): Promise<LabBestForm>;
  /** The sections of a run's prompt one can try removing, and what checking one takes. Calls no model. */
  prunePlan(journal: JournalReader, request: { runId: string; model: string; prompts: number; trials?: number; control?: boolean }): Promise<LabPrunePlan>;
  /** Would removing the section change what the agent does — on new messages, beside the noise. Its tools run, answered from the page. */
  prune(journal: JournalReader, request: LabPruneRequest, control?: LabRunControl): Promise<LabPrune>;
  /** How the run's last message is cut into words, and what explaining one decision takes. Calls no model. */
  wordsPlan(journal: JournalReader, request: { runId: string; model: string; words?: string[]; samples?: number }): Promise<LabWordsPlan>;
  /** Which words of the run's last message decided whether its next call is `tool`. No tool runs. */
  words(journal: JournalReader, request: LabWordsRequest, control?: LabRunControl): Promise<LabWords>;
  /** The run's capsule before any change. Calls no model. */
  capsuleBase(journal: JournalReader, request: { runId: string }): Promise<LabCapsuleBase>;
  /** The run played again in its capsule, changed as asked; no tool runs and nothing is written. */
  capsule(journal: JournalReader, request: LabCapsuleRequest, control?: LabRunControl): Promise<LabCapsule>;
  /** A thread's turns, a page at a time: how each ended, where its input came from, what diagnosing it takes. Calls no model. */
  threadPlan(journal: JournalReader, request: LabThreadPlanRequest): Promise<LabThreadPlan>;
  /** One turn diagnosed against what a right answer does; no tool runs and nothing is written. */
  thread(journal: JournalReader, request: LabThreadRequest, control?: LabRunControl): Promise<LabThreadDiagnosis>;
  /**
   * A run's turn kept as a scenario of its agent (a copy — see saved-scenarios.ts), in `journal`: under the
   * person whose conversation it copies, so their erasure takes it.
   */
  saveScenario(journal: ScenarioJournal, request: LabSaveScenarioRequest, by: string): Promise<SavedScenario>;
  /** The scenarios kept for an agent in `journal`, newest first. */
  savedScenarios(journal: ScenarioJournal, agent: string): Promise<SavedScenario[]>;
  /** Removes one; false when there is none by that id. */
  deleteScenario(journal: ScenarioJournal, agent: string, id: string): Promise<boolean>;
  /** Changes one in place (title, expectation, tool results, answers); undefined when there is none by that id. */
  updateScenario(journal: ScenarioJournal, agent: string, id: string, edit: ScenarioEdit): Promise<SavedScenario | undefined>;
  /** An agent the lab offers, as the playground starts from it: its prompt (when fixed) and its tools' definitions. Calls no model. */
  playgroundBase(agent: string): Promise<{ agent: string; system: string; systemFixed: boolean; tools: Array<{ name: string; description: string; parameters: unknown }> }>;
  /** One play of a playground agent: every tool call answered from the page; nothing runs or is written. */
  play(request: LabPlayRequest): Promise<PlayAgentResult>;
  /** A playground agent's last turn played `trials` times (and A beside it, with `compareTo`). */
  measure(request: LabMeasureRequest, control?: LabRunControl): Promise<MeasureAgentResult & { model: string }>;
  /** A playground conversation kept as a scenario of the playground agent named, in `journal`. */
  savePlaygroundScenario(journal: ScenarioJournal, request: LabPlaygroundScenarioRequest, by: string): Promise<SavedScenario>;
  /** The scenarios kept under a playground agent's name, played against its definition as it is on the page now. */
  runPlaygroundScenarios(journal: ScenarioJournal, request: LabRunPlaygroundScenariosRequest, control?: LabRunControl): Promise<LabScenarioRuns>;
  /** Plays the agent's kept scenarios (or those named) against the agent as the host defines it now. */
  runScenarios(journal: ScenarioJournal, request: LabRunScenariosRequest, control?: LabRunControl): Promise<LabScenarioRuns>;
}

/** The journal scenarios are kept in: Studio's organization-scoped, writable one. */
export type ScenarioJournal = JournalReader & { put: (k: string, v: unknown) => Promise<void>; deletePrefix?: (p: string) => Promise<number> };
export interface LabSaveScenarioRequest {
  runId: string;
  title: string;
  expect: Expectation;
  overrides?: ToolAnswer[];
  answers?: ToolAnswer[];
  /** The system prompt as it should be kept (an edited one) — the recorded one when omitted. */
  system?: string;
}
export interface LabPlayRequest { agent: PlaygroundAgent; model: string; messages: ModelMessage[] }
export interface LabMeasureRequest extends LabPlayRequest { expect: Expectation; trials?: number; compareTo?: PlaygroundAgent }
export interface LabPlaygroundScenarioRequest { agent: string; title: string; definition: PlaygroundAgent; messages: ModelMessage[]; expect: Expectation }
export interface LabRunPlaygroundScenariosRequest { agent: string; definition: PlaygroundAgent; model: string; trials?: number; ids?: string[] }
export interface LabRunScenariosRequest { agent: string; model: string; trials?: number; ids?: string[] }
export interface LabScenarioRuns extends RunScenariosResult { agent: string; model: string }

const sizeOf = (x: unknown) => (typeof x === 'string' ? x.length : JSON.stringify(x ?? '').length);
/**
 * The share of a run's input an explanation's average replay keeps: each part is out of half the
 * coalitions, so half of the parts' characters (system sections and messages) are gone on average.
 */
function keptShareOf(proposed: Proposed, input: { system?: unknown; messages?: unknown; prompt?: unknown }): number {
  const messages = Array.isArray(input.messages) ? input.messages as Array<{ content?: unknown }> : typeof input.prompt === 'string' ? [{ content: input.prompt }] : [];
  const total = sizeOf(typeof input.system === 'string' ? input.system : '') + messages.reduce((n, m) => n + sizeOf(m.content), 0);
  const parts = Object.values(proposed.systemSections).reduce((n, t) => n + t.length, 0)
    + Object.values(proposed.messages).flat().reduce((n, i) => n + sizeOf(messages[i]?.content), 0);
  return total > 0 ? 1 - 0.5 * Math.min(1, parts / total) : 1;
}

/** A message cut into at most `most` groups of neighbouring words, as even as they come. */
function wordsOf(text: string, most = 8): string[] {
  const all = text.split(/\s+/).filter(Boolean);
  if (all.length <= most) return all;
  const out: string[] = [];
  for (let g = 0; g < most; g++) out.push(all.slice(Math.round((g * all.length) / most), Math.round(((g + 1) * all.length) / most)).join(' '));
  return out;
}

/** Builds the object Studio's Lab tab calls. */
export function studioLab(opts: StudioLabOptions): StudioLabApi {
  refuseUnknownNames('studioLab', opts, STUDIO_LAB_NAMES);
  const { config, models } = opts;
  const maxParts = opts.maxParts ?? 6;
  const toolsOf = (agent: string): ToolSet | undefined => {
    const tools = config.agents?.[agent]?.tools;
    if (tools === undefined) return undefined;
    if (typeof tools !== 'object' || tools === null) throw new TypeError(`@gnldev/lab: agent '${agent}' builds its tools per request; a replay needs them as an object`);
    return tools as ToolSet;
  };
  const modelOf = (name: string) => {
    const m = models[name];
    if (!m) throw new TypeError(`@gnldev/lab: no model named '${name}'`);
    return m;
  };
  /**
   * The agent's tools, and a definition for every tool the run called that the agent's config does not
   * define (memory's own `updateWorkingMemory`, for one). Without it a replay could not make the call
   * the recording made, and every comparison would count it missed. Answered from the recording; never run.
   */
  const recordedOnly = (agent: string, calls: readonly string[]): string[] => {
    const own = toolsOf(agent) ?? {};
    return [...new Set(calls)].filter((name) => !(name in own));
  };
  const stubOf = () => tool({ description: '', inputSchema: jsonSchema({ type: 'object' }) } as never);
  const replayTools = (agent: string, calls: readonly string[]): ToolSet | undefined => {
    const own = toolsOf(agent);
    const extra = recordedOnly(agent, calls);
    if (extra.length === 0) return own;
    return { ...(own ?? {}), ...Object.fromEntries(extra.map((name) => [name, stubOf()])) } as ToolSet;
  };
  const load = async (journal: JournalReader, runId: string, partsCap = maxParts) => {
    const j = readerOf(journal as JournalSource);
    const input = await j.get<{ system?: unknown; messages?: unknown; prompt?: unknown; agent?: string; threadId?: unknown }>(runKeys.input(runId));
    if (!input) throw new RangeError(`@gnldev/lab: run '${runId}' has no recorded input`);
    const agent = input.agent;
    if (!agent || !(agent in (config.agents ?? {}))) throw Object.assign(new RangeError(`@gnldev/lab: run '${runId}' is not a run of an agent the lab offers`), { code: 'agent-not-offered', agent: agent ?? null });
    const usage = await usageOfRun(j, runId);
    const messages = Array.isArray(input.messages) ? input.messages : typeof input.prompt === 'string' ? [{ role: 'user', content: input.prompt }] : [];
    const { sources, layout } = await sourcesOf(j, runId, input);
    return { j, agent, usage, input, sources, layout, proposed: proposeParts({ system: input.system, messages }, usage.calls, partsCap, sources) };
  };
  const suiteOf = (agent: string) => opts.scenarios?.[agent] ?? DEFAULT_SUITE;
  const pickScenarios = (agent: string, ids?: string[]) => {
    const all = suiteOf(agent);
    if (!ids || ids.length === 0) return all;
    const chosen = all.filter((s) => ids.includes(s.id));
    const unknown = ids.filter((id) => !all.some((s) => s.id === id));
    if (unknown.length) throw new RangeError(`@gnldev/lab: no scenario ${unknown.map((u) => `'${u}'`).join(', ')} for agent '${agent}'`);
    return chosen;
  };
  /** The agent's own prompt, cut at blank lines — the components of a new agent. */
  const componentsOf = (agent: string): LabPart[] => {
    if (!(agent in (config.agents ?? {}))) throw new RangeError(`@gnldev/lab: agent '${agent}' is not offered by the lab`);
    const system = config.agents![agent]!.system;
    if (typeof system !== 'string') throw new RangeError(`@gnldev/lab: agent '${agent}' has no fixed system prompt to divide (it is missing or built per request)`);
    const sections = system.split(/\n\s*\n/).map((x) => x.trim()).filter(Boolean);
    if (sections.length > maxParts) throw new RangeError(`@gnldev/lab: agent '${agent}''s prompt has ${sections.length} sections; at most ${maxParts} (join some with a single line break, or raise maxParts)`);
    return sections.map((text, i) => ({ id: `section ${i + 1}`, kind: 'system' as const, source: 'layout' as const, preview: cut(text), text }));
  };
  const pricing = async (j: JournalReader) => opts.pricing ?? (await effectivePricingTable(j as never));
  /** The capsule's tool set: each asked-for tool, the agent's definition with the asked description and schema, or a new one. */
  const capsuleTools = (agent: string, asked: LabCapsuleTool[] | undefined, calls: readonly string[]): ToolSet | undefined => {
    const own = replayTools(agent, calls) ?? {};
    if (!asked) return replayTools(agent, calls);
    return Object.fromEntries(asked.map((t) => {
      const base = own[t.name];
      if (!base && t.parameters === undefined) throw new RangeError(`@gnldev/lab: tool '${t.name}' is not the agent's; a new tool needs its parameters (a JSON Schema)`);
      const inputSchema = t.parameters !== undefined ? jsonSchema(t.parameters as never) : base!.inputSchema;
      // A description built per request was shown empty: left empty, it is kept as the agent builds it.
      const description = base && typeof base.description !== 'string' && t.description === '' ? base.description : t.description;
      return [t.name, base ? { ...base, description, inputSchema } : tool({ description: t.description, inputSchema } as never)];
    })) as ToolSet;
  };

  const priceOf = async (j: JournalReader, name: string) => {
    const model = modelOf(name);
    const id = typeof model === 'string' ? model : (model as { modelId?: string }).modelId ?? name;
    return priceFor(id, await pricing(j));
  };
  const costOf = (price: Awaited<ReturnType<typeof priceOf>>, input: number, output: number) =>
    price ? (input / 1e6) * price.inputPer1M + (output / 1e6) * price.outputPer1M : 0;
  /** The agent's tools as their definitions: name, description, JSON Schema. */
  const definitionsOf = async (agent: string, calls: readonly string[]) => {
    const own = replayTools(agent, calls) ?? {};
    return Promise.all(Object.entries(own).map(async ([name, t]) => ({
      name, description: typeof t.description === 'string' ? t.description : '', parameters: await asSchema(t.inputSchema as never).jsonSchema,
    })));
  };
  /** A run's last user message, the messages before it, and its system prompt as recorded. */
  const lastTurnOf = (input: { system?: unknown; messages?: unknown; prompt?: unknown }) => {
    const messages = (Array.isArray(input.messages) ? input.messages : typeof input.prompt === 'string' ? [{ role: 'user', content: input.prompt }] : []) as ModelMessage[];
    const last = messages.map((m) => m.role).lastIndexOf('user');
    return { before: last >= 0 ? messages.slice(0, last) : messages, text: last >= 0 ? textOf(messages[last]!.content) : '', system: typeof input.system === 'string' ? input.system : undefined };
  };
  const pruneArms = (control: boolean) => 3 + (control ? 1 : 0);
  /** A new agent's components: its prompt's sections, then the tools taken away and the tools added. */
  const formComponents = (req: LabFormRequest, offered: readonly string[]) => {
    const parts = componentsOf(req.agent);
    const components: Record<string, Component> = Object.fromEntries(parts.map((p) => [p.id, promptSection((p as LabPart & { text: string }).text)]));
    const detail: LabPart[] = parts.map(({ id, kind, source, preview }) => ({ id, kind, source, preview }));
    for (const name of req.withoutTools ?? []) {
      if (!offered.includes(name)) throw new RangeError(`@gnldev/lab: the chosen scenarios offer no tool '${name}' to take away`);
      components[`without ${name}`] = withoutTool(name);
      detail.push({ id: `without ${name}`, kind: 'tool', source: 'layout', preview: name });
    }
    for (const t of req.addTools ?? []) {
      if (offered.includes(t.name) || `with ${t.name}` in components) throw new RangeError(`@gnldev/lab: tool '${t.name}' is offered already; an added tool needs a name of its own`);
      if (!t.parameters || t.parameters.type !== 'object') throw new RangeError(`@gnldev/lab: tool '${t.name}' needs its parameters as an object JSON Schema`);
      components[`with ${t.name}`] = withTool(t.name, { description: t.description, parameters: t.parameters, run: () => t.output });
      detail.push({ id: `with ${t.name}`, kind: 'tool', source: 'layout', preview: t.description || t.name });
    }
    const n = Object.keys(components).length;
    if (n > 10) throw new RangeError(`@gnldev/lab: ${n} components make ${2 ** n} forms; at most 10`);
    return { components, detail };
  };
  const offeredBy = (scenarios: readonly Scenario[]) => [...new Set(scenarios.flatMap((x) => Object.keys(x.tools)))];

  return {
    catalog: () => ({ agents: Object.keys(config.agents ?? {}), models: Object.keys(models) }),
    plan: async (journal, req) => {
      const { j, agent, usage, proposed, layout, input } = await load(journal, req.runId);
      const trials = req.trials ?? 3;
      const replays = explainRunSize(proposed.parts.length, trials);
      const model = modelOf(req.model);
      const id = typeof model === 'string' ? model : (model as { modelId?: string }).modelId ?? req.model;
      const price = priceFor(id, await pricing(j));
      const tokensPerReplay = usage.inputTokens + usage.outputTokens;
      const kept = usage.inputTokens * keptShareOf(proposed, input);
      return {
        runId: req.runId, agent, parts: proposed.parts, layout, trials, replays, tokensPerReplay,
        estimatedTokens: Math.round(replays * (kept + usage.outputTokens)),
        ...(price ? { estimatedCostUsd: replays * ((kept / 1e6) * price.inputPer1M + (usage.outputTokens / 1e6) * price.outputPer1M) } : {}),
      };
    },
    explain: async (journal, req, control = {}) => {
      const { j, agent, usage, proposed } = await load(journal, req.runId);
      const tools = replayTools(agent, usage.calls);
      const r = await explainRun({
        journal: j, runId: req.runId, model: modelOf(req.model), trials: req.trials ?? 3,
        ...(tools ? { tools } : {}),
        ...(Object.keys(proposed.systemSections).length ? { systemSections: proposed.systemSections } : {}),
        ...(Object.keys(proposed.messages).length ? { messages: proposed.messages } : {}),
        ...(Object.keys(proposed.toolResults).length ? { toolResults: proposed.toolResults } : {}),
        pricing: await pricing(j),
        ...control,
      });
      return { ...r, agent, model: req.model, partsDetail: proposed.parts };
    },
    scenarios: (agent) => suiteOf(agent).map((s) => ({ id: s.id, category: s.category, prompt: s.prompt })),
    formPlan: (req) => {
      const chosen = pickScenarios(req.agent, req.scenarios);
      const tools = offeredBy(chosen);
      const components = formComponents(req, tools).detail;
      const scenarios = chosen.length;
      const trials = req.trials ?? 2;
      const forms = 2 ** components.length;
      return { agent: req.agent, components, scenarios, trials, forms, runs: forms * trials * scenarios, tools };
    },
    capsuleBase: async (journal, req) => {
      // Every part listed, none merged: the capsule shows the input as it is.
      const { j, agent, usage, input, sources, layout, proposed } = await load(journal, req.runId, Number.POSITIVE_INFINITY);
      const messages = (Array.isArray(input.messages) ? input.messages : []) as ModelMessage[];
      const last = messages.map((m) => m.role).lastIndexOf('user');
      const own = toolsOf(agent) ?? {};
      const tools: LabCapsuleTool[] = await Promise.all(Object.entries(own).map(async ([name, t]) => ({
        // A description built per request has no text to edit; the capsule shows it empty.
        name, description: typeof t.description === 'string' ? t.description : '', parameters: await asSchema(t.inputSchema as never).jsonSchema,
      })));
      for (const name of recordedOnly(agent, usage.calls)) tools.push({ name, description: '', parameters: { type: 'object' }, recordedOnly: true });
      const sys = capsuleSystemOf(typeof input.system === 'string' ? input.system : '', sources.layout ? sources.rows : undefined);
      return {
        runId: req.runId, agent, system: sys.own, ...(sys.workingMemory ? { workingMemory: sys.workingMemory } : {}), tools,
        earlierMessages: Math.max(0, last),
        memoryMessages: layout.status === 'present' ? layout.memoryMessages : null,
        layout, parts: proposed.parts,
        lastMessage: cut(last >= 0 ? textOf(messages[last]!.content) : String(input.prompt ?? '')),
        recordedCalls: await recordedTrace(j, req.runId), tokensPerPlay: usage.inputTokens + usage.outputTokens,
      };
    },
    capsule: async (journal, req, control = {}) => {
      const { j, agent, usage } = await load(journal, req.runId, Number.POSITIVE_INFINITY);
      const tools = capsuleTools(agent, req.tools, usage.calls);
      // A change is played beside the run as it was, as many times: its worth is the difference.
      const changes = req.system !== undefined || req.tools !== undefined || req.history === false || req.memory === false || !!req.overrides?.length;
      const own = replayTools(agent, usage.calls);
      const r = await runCapsule({
        journal: j, runId: req.runId, model: modelOf(req.model), trials: req.trials ?? 3,
        ...(tools ? { tools } : {}),
        ...(changes ? { unchanged: own ? { tools: own } : {} } : {}),
        ...(req.system !== undefined ? { system: req.system } : {}),
        ...(req.history !== undefined ? { history: req.history } : {}),
        ...(req.memory !== undefined ? { memory: req.memory } : {}),
        ...(req.expect !== undefined ? { expect: req.expect } : {}),
        ...(req.answers?.length ? { answers: req.answers } : {}),
        ...(req.overrides?.length ? { overrides: req.overrides } : {}),
        pricing: await pricing(j),
        ...control,
      });
      return { ...r, agent, model: req.model };
    },
    threadPlan: async (journal, req) => {
      const model = modelOf(req.model);
      const j = readerOf(journal as JournalSource);
      const plan = await threadPlan({
        journal: j, threadId: req.threadId, modelId: typeof model === 'string' ? model : (model as { modelId?: string }).modelId ?? req.model, pricing: await pricing(j),
        ...(req.trials !== undefined ? { trials: req.trials } : {}),
        ...(req.offset !== undefined ? { offset: req.offset } : {}),
        ...(req.limit !== undefined ? { limit: req.limit } : {}),
        ...(req.expect !== undefined ? { expect: req.expect } : {}),
        ...(req.hypotheses ? { hypotheses: req.hypotheses } : {}),
      });
      // A turn of an agent the lab does not offer has no tools to play it with.
      const offered = (t: (typeof plan.turns)[number]) => !!t.agent && t.agent in (config.agents ?? {});
      const turns = plan.turns.map(({ experiments, ...t }) => (t.diagnosable && !offered(t)
        ? { ...t, diagnosable: false, whyNot: 'it is not a run of an agent the lab offers' }
        : { ...t, ...(experiments ? { experiments } : {}) }));
      return { ...plan, turns, model: req.model };
    },
    thread: async (journal, req, control = {}) => {
      const { j, agent, usage } = await load(journal, req.runId, Number.POSITIVE_INFINITY);
      const tools = replayTools(agent, usage.calls);
      const r = await diagnoseTurn({
        journal: j, runId: req.runId, model: modelOf(req.model), expect: req.expect,
        ...(tools ? { tools } : {}),
        ...(req.trials !== undefined ? { trials: req.trials } : {}),
        ...(req.eliminationTrials !== undefined ? { eliminationTrials: req.eliminationTrials } : {}),
        ...(req.topK !== undefined ? { topK: req.topK } : {}),
        ...(req.workingMemory !== undefined ? { workingMemory: req.workingMemory } : {}),
        ...(req.overrides?.length ? { overrides: req.overrides } : {}),
        ...(req.answers?.length ? { answers: req.answers } : {}),
        ...(req.corrections && Object.keys(req.corrections).length ? { corrections: req.corrections } : {}),
        ...(req.suggest ? { suggest: modelOf(req.model) } : {}),
        ...(req.guess ? { guess: modelOf(req.model) } : {}),
        pricing: await pricing(j),
        ...control,
      });
      return { ...r, agent, model: req.model };
    },
    playgroundBase: async (agent) => {
      if (!(agent in (config.agents ?? {}))) throw new RangeError(`@gnldev/lab: agent '${agent}' is not offered by the lab`);
      const system = config.agents![agent]!.system;
      const own = toolsOf(agent) ?? {};
      const tools = await Promise.all(Object.entries(own).map(async ([name, t]) => ({
        // A description built per request has no text to start from; the page shows it empty.
        name, description: typeof t.description === 'string' ? t.description : '', parameters: await asSchema(t.inputSchema as never).jsonSchema,
      })));
      return { agent, system: typeof system === 'string' ? system : '', systemFixed: typeof system === 'string', tools };
    },
    play: async (req) => playAgent({ agent: req.agent, model: modelOf(req.model), messages: req.messages, ...(opts.pricing ? { pricing: opts.pricing } : {}) }),
    measure: async (req, control = {}) => ({
      ...(await measureAgent({
        agent: req.agent, model: modelOf(req.model), messages: req.messages, expect: req.expect, trials: req.trials ?? 5,
        ...(req.compareTo ? { compareTo: req.compareTo } : {}), ...(opts.pricing ? { pricing: opts.pricing } : {}), ...control,
      })),
      model: req.model,
    }),
    savePlaygroundScenario: async (journal, req, by) => {
      const answers = req.definition.tools.flatMap((t) => (t.answers ?? []).map((a) => ({ toolName: t.name, args: a.args, output: a.output })));
      return saveScenario(journal as never, scenarioOfPlayground({ agent: req.agent, title: req.title, by, system: req.definition.system, messages: req.messages, expect: req.expect, answers }));
    },
    runPlaygroundScenarios: async (journal, req, control = {}) => {
      const all = await listScenarios(journal as never, req.agent);
      const scenarios = req.ids?.length ? all.filter((s) => req.ids!.includes(s.id)) : all;
      if (scenarios.length === 0) throw new RangeError(`@gnldev/lab: '${req.agent}' has no kept scenario${req.ids?.length ? ' by those ids' : ''} to play`);
      // The definition on the page: its prompt, its tools, and what they return now.
      const tools = Object.fromEntries(req.definition.tools.map((t) => [t.name, tool({ description: t.description, inputSchema: jsonSchema(t.parameters as never) } as never)])) as ToolSet;
      const r = await runScenarios({
        scenarios, model: modelOf(req.model), trials: req.trials ?? 3, system: req.definition.system, tools,
        returns: {
          answers: req.definition.tools.flatMap((t) => (t.answers ?? []).map((a) => ({ toolName: t.name, args: a.args, output: a.output }))),
          otherwise: Object.fromEntries(req.definition.tools.filter((t) => t.otherwise).map((t) => [t.name, t.otherwise!.output])),
        },
        ...(opts.pricing ? { pricing: opts.pricing } : {}), ...control,
      });
      return { ...r, agent: req.agent, model: req.model };
    },
    saveScenario: async (journal, req, by) => {
      const { j, agent } = await load(journal, req.runId);
      return saveScenario(journal as never, await scenarioOfRun({
        journal: j, runId: req.runId, agent, title: req.title, by, expect: req.expect,
        ...(req.overrides?.length ? { overrides: req.overrides } : {}), ...(req.answers?.length ? { answers: req.answers } : {}),
        ...(req.system !== undefined ? { system: req.system } : {}),
      }));
    },
    savedScenarios: (journal, agent) => listScenarios(journal as never, agent),
    updateScenario: async (journal, agent, id, edit) => {
      const s = await findScenario(journal as never, agent, id);
      return s ? updateScenario(journal as never, s, edit) : undefined;
    },
    deleteScenario: async (journal, agent, id) => {
      const s = await findScenario(journal as never, agent, id);
      if (!s) return false;
      await deleteScenario(journal as never, s);
      return true;
    },
    runScenarios: async (journal, req, control = {}) => {
      if (!(req.agent in (config.agents ?? {}))) throw new RangeError(`@gnldev/lab: agent '${req.agent}' is not offered by the lab`);
      const all = await listScenarios(journal as never, req.agent);
      const scenarios = req.ids?.length ? all.filter((s) => req.ids!.includes(s.id)) : all;
      if (scenarios.length === 0) throw new RangeError(`@gnldev/lab: agent '${req.agent}' has no kept scenario${req.ids?.length ? ' by those ids' : ''} to play`);
      // The agent as the host defines it now: its prompt when it is fixed (a scenario's own otherwise) and its tools.
      const system = config.agents![req.agent]!.system;
      const tools = replayTools(req.agent, [...new Set(scenarios.flatMap((s) => [...s.results, ...s.answers].map((r) => r.toolName)))]);
      const r = await runScenarios({
        scenarios, model: modelOf(req.model), trials: req.trials ?? 3,
        ...(typeof system === 'string' ? { system } : {}), ...(tools ? { tools } : {}),
        pricing: await pricing(readerOf(journal as JournalSource)), ...control,
      });
      return { ...r, agent: req.agent, model: req.model };
    },
    bestForm: async (req, control = {}) => {
      const scenarios = pickScenarios(req.agent, req.scenarios);
      const { components, detail } = formComponents(req, offeredBy(scenarios));
      const r = await bestForm({
        model: modelOf(req.model), scenarios, trials: req.trials ?? 2, components,
        ...(opts.pricing ? { pricing: opts.pricing } : {}),
        ...control,
      });
      return { ...r, agent: req.agent, model: req.model, componentsDetail: detail, scenarios: scenarios.map((s) => s.id) };
    },
    prunePlan: async (journal, req) => {
      const { j, agent, usage, proposed } = await load(journal, req.runId, Number.POSITIVE_INFINITY);
      const sections = proposed.parts.filter((p) => p.kind === 'system' || p.kind === 'wm');
      const trials = req.trials ?? 10;
      const runs = pruneArms(!!req.control) * Math.max(0, req.prompts) * trials;
      const price = await priceOf(j, req.model);
      return {
        runId: req.runId, agent, sections, tools: await definitionsOf(agent, usage.calls), arms: pruneArms(!!req.control), runs,
        estimatedTokens: runs * (usage.inputTokens + usage.outputTokens),
        ...(price ? { estimatedCostUsd: runs * costOf(price, usage.inputTokens, usage.outputTokens) } : {}),
      };
    },
    prune: async (journal, req, control = {}) => {
      const { j, agent, usage, proposed, input } = await load(journal, req.runId, Number.POSITIVE_INFINITY);
      if (Object.keys(proposed.systemSections).length < 2) throw new RangeError(`@gnldev/lab: run '${req.runId}''s system prompt has fewer than two sections; there is nothing to remove beside the rest`);
      if (req.prompts.length === 0) throw new RangeError('@gnldev/lab: removing a section is checked on new messages; give at least one');
      for (const id of [req.remove, ...(req.control !== undefined ? [req.control] : [])]) {
        if (!(id in proposed.systemSections)) throw new RangeError(`@gnldev/lab: run '${req.runId}''s prompt has no section '${id}'`);
      }
      // The tools run in this check: each is the agent's definition, answered from the page.
      const answers = new Map((req.answers ?? []).map((a) => [`${a.toolName}\u0000${argsHash(a.args)}`, a.output]));
      const unanswered = new Map<string, { toolName: string; args: unknown; count: number }>();
      const tools = Object.fromEntries((await definitionsOf(agent, usage.calls)).map((d) => [d.name, tool({
        description: d.description, inputSchema: jsonSchema(d.parameters as never),
        execute: async (args: unknown) => {
          const key = `${d.name}\u0000${argsHash(args)}`;
          if (answers.has(key)) return answers.get(key);
          if (req.otherwise && d.name in req.otherwise) return req.otherwise[d.name];
          const u = unanswered.get(key) ?? { toolName: d.name, args, count: 0 };
          u.count++; unanswered.set(key, u);
          return { error: 'nothing answers this call' };
        },
      } as never)])) as ToolSet;
      const { before } = lastTurnOf(input);
      const r = await checkPrune({
        model: modelOf(req.model), tools, systemSections: proposed.systemSections, history: before, prompts: req.prompts,
        remove: req.remove, ...(req.control !== undefined ? { control: req.control } : {}),
        trials: req.trials ?? 10, ...(req.margin !== undefined ? { margin: req.margin } : {}), ...control,
      });
      const price = await priceOf(j, req.model);
      return { ...r, agent, model: req.model, unanswered: [...unanswered.values()].slice(0, 20), costUsd: costOf(price, r.inputTokens, r.outputTokens), priced: !!price };
    },
    wordsPlan: async (journal, req) => {
      const { j, agent, usage, input } = await load(journal, req.runId, Number.POSITIVE_INFINITY);
      const method = opts.logprobs?.[req.model] ? 'logprobs' as const : 'sampled' as const;
      // Sampled, every group doubles the subsets and each is asked `samples` times: six to start, not eight.
      const words = req.words?.length ? req.words : wordsOf(lastTurnOf(input).text, method === 'sampled' ? 6 : 8);
      if (words.length === 0) throw new RangeError(`@gnldev/lab: run '${req.runId}' has no user message to cut into words`);
      const samples = method === 'logprobs' ? 1 : req.samples ?? 5;
      const subsets = 2 ** words.length;
      const calls = subsets * samples;
      const price = await priceOf(j, req.model);
      const tools = Object.keys(replayTools(agent, usage.calls) ?? {});
      const first = usage.calls.find((c) => tools.includes(c));
      return {
        runId: req.runId, agent, words, tools, ...(first ? { tool: first } : {}), method, samples, subsets, calls,
        // Each call is the run's first step asked again, its answer a call's few tokens.
        estimatedTokens: calls * (usage.firstInputTokens + 20),
        ...(price ? { estimatedCostUsd: calls * costOf(price, usage.firstInputTokens, 20) } : {}),
      };
    },
    words: async (journal, req, control = {}) => {
      const { j, agent, usage, input } = await load(journal, req.runId, Number.POSITIVE_INFINITY);
      const offered = replayTools(agent, usage.calls) ?? {};
      if (!(req.tool in offered)) throw new RangeError(`@gnldev/lab: agent '${agent}' offers no tool '${req.tool}'`);
      if (req.words.length === 0 || req.words.length > 10) throw new RangeError('@gnldev/lab: cut the message into 1 to 10 groups of words');
      const { before, system } = lastTurnOf(input);
      const endpoint = opts.logprobs?.[req.model];
      const price = await priceOf(j, req.model);
      let value: (text: string) => Promise<number | { value: number; variance: number }>;
      let spent = () => ({ inputTokens: 0, outputTokens: 0 });
      if (endpoint) {
        const defs = await definitionsOf(agent, usage.calls);
        let calls = 0;
        const read = toolChoiceProbability({
          baseURL: endpoint.baseURL, apiKey: endpoint.apiKey, model: endpoint.model, tool: req.tool,
          tools: defs.map((d) => ({ type: 'function' as const, function: { name: d.name, description: d.description, parameters: d.parameters } })),
          ...(system ? { system } : {}), before: openAIMessagesOf(before),
          ...(endpoint.body ? { body: endpoint.body } : {}), ...(endpoint.fetch ? { fetch: endpoint.fetch } : {}),
        });
        value = async (text) => { calls++; return read(text); };
        // The endpoint's usage is not read back: one call is taken to cost the run's first step's input.
        spent = () => ({ inputTokens: calls * usage.firstInputTokens, outputTokens: calls * 20 });
      } else {
        const sampled = sampledToolChoice({ model: modelOf(req.model), tools: offered, tool: req.tool, ...(system ? { system } : {}), before, samples: req.samples ?? 5 });
        value = sampled;
        spent = () => ({ inputTokens: sampled.spent.inputTokens, outputTokens: sampled.spent.outputTokens });
      }
      const r = await wordShares({ words: req.words, value, ...control });
      const { inputTokens, outputTokens } = spent();
      return {
        ...r, agent, model: req.model, tool: req.tool, method: endpoint ? 'logprobs' : 'sampled',
        ...(endpoint ? {} : { samples: req.samples ?? 5 }), inputTokens, outputTokens,
        costUsd: costOf(price, inputTokens, outputTokens), priced: !!price,
      };
    },
  };
}
