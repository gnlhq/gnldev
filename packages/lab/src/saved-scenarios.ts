// A turn kept as a scenario, and played again later against the agent as it is then — a regression set
// made of real conversations.
//
// A scenario is a COPY: the turn's input as the model saw it (system prompt, messages), what a right
// answer does, and what each tool returned (the recording's results, the person's replacements and
// answers). It does not point back at the run: the run may be swept, and the scenario stays.
//
// A copy of someone's conversation is about them, so it is kept where their erasure reaches it with
// nothing wired (@gnldev/durable personRecordKey): erasing the person — eraseSubject, purgeResource —
// erases every scenario made from their conversations. A turn whose input names no person (a scheduled
// run, say) is kept under the agent. Nothing here runs a tool: every call is answered from the copy, and
// a call it does not hold stops the play, which is then judged only where what it did already settles it.
import { generateText, stepCountIs, type LanguageModel, type ModelMessage, type ToolSet } from 'ai';
import { argsHash, personRecordKey, runKeys, threadOwnerKey, priceFor, type ModelPricing } from '@gnldev/durable';
import { refuseUnknownNames } from '@gnldev/options';
import { recordedResults, runTrials, wilson, readerOf, type Expectation, type Interval, type JournalSource, type ToolAnswer, type TracedCall, type TrialsProgress } from '@gnldev/experiment';
import { judgePlay } from './judge.js';
import { SAVE_SCENARIO_NAMES, RUN_SCENARIOS_NAMES } from './option-names.js';

export interface SavedScenario {
  v: 1;
  id: string;
  agent: string;
  title: string;
  /** When and by whom it was kept. */
  at: number;
  by: string;
  /** The person whose conversation it copies — erasing them erases it. Absent for a turn that names no one. */
  owner?: string;
  /** Where it was copied from, for reading only: a run (which may no longer exist), or the playground. */
  from: { runId: string; threadId?: string } | { playground: true };
  system: string;
  messages: ModelMessage[];
  expect: Expectation;
  /** What each tool returned, by tool and arguments: the recording's, with the person's replacements. */
  results: ToolAnswer[];
  /** Results for calls the recording never made, the person's. */
  answers: ToolAnswer[];
}

/** The journal's view the scenarios are kept in: Studio's organization-scoped one. */
type Store = { get: <T>(k: string) => Promise<T | undefined>; put: (k: string, v: unknown) => Promise<void>; listKeys: (p: string) => Promise<string[]>; deletePrefix?: (p: string) => Promise<number> };

const OWNERLESS = '__lab__:scenario:';
/** A playground agent's name: what its scenarios are kept under. */
export const AGENT_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const tail = (agent: string, id: string) => `lab:scenario:${encodeURIComponent(agent)}:${id}`;
/** Where a scenario is kept: under its person when it has one, else under the agent. */
export function scenarioKey(s: Pick<SavedScenario, 'owner' | 'agent' | 'id'>): string {
  return s.owner ? personRecordKey(s.owner, tail(s.agent, s.id)) : `${OWNERLESS}${encodeURIComponent(s.agent)}:${s.id}`;
}

export interface SaveScenarioOptions {
  journal: JournalSource;
  runId: string;
  agent: string;
  title: string;
  by: string;
  expect: Expectation;
  /** Results put in place of the recorded ones (same tool, same arguments). */
  overrides?: readonly ToolAnswer[];
  answers?: readonly ToolAnswer[];
  /** The system prompt as it should be kept — the recorded one when omitted. */
  system?: string;
}

/** Copies a run's turn into a scenario: its input, what a right answer does, and every tool's result. Writes nothing. */
export async function scenarioOfRun(opts: SaveScenarioOptions): Promise<SavedScenario> {
  refuseUnknownNames('scenarioOfRun', opts, SAVE_SCENARIO_NAMES);
  if (!opts.title.trim()) throw new RangeError('@gnldev/lab: a scenario needs a title');
  if (!((opts.expect.calls?.length ?? 0) + (opts.expect.forbidden?.length ?? 0) + (opts.expect.answerIncludes?.length ?? 0))) {
    throw new RangeError('@gnldev/lab: a scenario needs `expect` — what a right answer does; without it a play can be neither right nor wrong');
  }
  const j = readerOf(opts.journal);
  const input = await j.get<{ system?: unknown; messages?: unknown; prompt?: unknown; resourceId?: unknown; threadId?: unknown }>(runKeys.input(opts.runId));
  if (!input) throw new RangeError(`@gnldev/lab: run '${opts.runId}' has no recorded input`);
  const threadId = typeof input.threadId === 'string' ? input.threadId : undefined;
  // The person: the run's own record names them; a thread's owner record when it does not.
  const owner = typeof input.resourceId === 'string' && input.resourceId ? input.resourceId
    : threadId ? (await j.get<{ resourceId?: string }>(threadOwnerKey(threadId)))?.resourceId : undefined;
  const replaced = new Map((opts.overrides ?? []).map((o) => [`${o.toolName}:${argsHash(o.args)}`, o.output]));
  const results = (await recordedResults(j, opts.runId)).map((r) => {
    const k = `${r.toolName}:${argsHash(r.args)}`;
    return { toolName: r.toolName, args: r.args, output: replaced.has(k) ? replaced.get(k) : r.output };
  });
  return {
    v: 1, id: crypto.randomUUID(), agent: opts.agent, title: opts.title.trim(), at: Date.now(), by: opts.by,
    ...(owner ? { owner } : {}),
    from: { runId: opts.runId, ...(threadId ? { threadId } : {}) },
    system: opts.system ?? (typeof input.system === 'string' ? input.system : ''),
    messages: Array.isArray(input.messages) ? (input.messages as ModelMessage[]) : [{ role: 'user', content: String(input.prompt ?? '') }],
    expect: opts.expect, results, answers: [...(opts.answers ?? [])],
  };
}

/**
 * A playground conversation kept as a scenario of the playground agent named: typed on the page, so it is
 * no person's — kept under that name. Its tools' answers become the scenario's answers. Writes nothing.
 */
export function scenarioOfPlayground(opts: { agent: string; title: string; by: string; system: string; messages: ModelMessage[]; expect: Expectation; answers: ToolAnswer[] }): SavedScenario {
  if (!AGENT_NAME.test(opts.agent)) throw new RangeError("@gnldev/lab: a playground agent needs a name — letters, digits, '.', '_' or '-', at most 64");
  if (!opts.title.trim()) throw new RangeError('@gnldev/lab: a scenario needs a title');
  if (!((opts.expect.calls?.length ?? 0) + (opts.expect.forbidden?.length ?? 0) + (opts.expect.answerIncludes?.length ?? 0))) {
    throw new RangeError('@gnldev/lab: a scenario needs `expect` — what a right answer does; without it a play can be neither right nor wrong');
  }
  if (opts.messages.at(-1)?.role !== 'user') throw new RangeError("@gnldev/lab: a scenario's conversation must end with the user's message");
  return {
    v: 1, id: crypto.randomUUID(), agent: opts.agent, title: opts.title.trim(), at: Date.now(), by: opts.by,
    from: { playground: true }, system: opts.system, messages: opts.messages, expect: opts.expect, results: [], answers: [...opts.answers],
  };
}

export async function saveScenario(store: Store, s: SavedScenario): Promise<SavedScenario> {
  await store.put(scenarioKey(s), s);
  return s;
}

/** Every scenario of an agent in this store, newest first: those kept under a person and those under the agent. */
export async function listScenarios(store: Store, agent: string): Promise<SavedScenario[]> {
  const mine = `:${tail(agent, '')}`;
  const keys = [...(await store.listKeys('kept:res:')).filter((k) => k.includes(mine)), ...(await store.listKeys(`${OWNERLESS}${encodeURIComponent(agent)}:`))];
  const out: SavedScenario[] = [];
  for (const k of keys) {
    const s = await store.get<SavedScenario>(k);
    if (s?.v === 1 && s.agent === agent) out.push(s);
  }
  return out.sort((a, b) => b.at - a.at);
}

export async function findScenario(store: Store, agent: string, id: string): Promise<SavedScenario | undefined> {
  return (await listScenarios(store, agent)).find((s) => s.id === id);
}

/** What may be changed in a kept scenario: never whose conversation it copies, nor the conversation itself. */
export interface ScenarioEdit {
  title?: string;
  expect?: Expectation;
  /** What each tool returns: the whole list, replacing the kept one. */
  results?: ToolAnswer[];
  answers?: ToolAnswer[];
}

/**
 * A kept scenario changed in place: its title, what a right answer does, what its tools return. It stays
 * where it was kept — under its person — so their erasure still takes it.
 */
export async function updateScenario(store: Store, s: SavedScenario, edit: ScenarioEdit): Promise<SavedScenario> {
  if (edit.title !== undefined && !edit.title.trim()) throw new RangeError('@gnldev/lab: a scenario needs a title');
  if (edit.expect !== undefined && !((edit.expect.calls?.length ?? 0) + (edit.expect.forbidden?.length ?? 0) + (edit.expect.answerIncludes?.length ?? 0))) {
    throw new RangeError('@gnldev/lab: a scenario needs `expect` — what a right answer does');
  }
  const next: SavedScenario = {
    ...s,
    ...(edit.title !== undefined ? { title: edit.title.trim() } : {}),
    ...(edit.expect !== undefined ? { expect: edit.expect } : {}),
    ...(edit.results !== undefined ? { results: [...edit.results] } : {}),
    ...(edit.answers !== undefined ? { answers: [...edit.answers] } : {}),
  };
  await store.put(scenarioKey(next), next);
  return next;
}

export async function deleteScenario(store: Store, s: SavedScenario): Promise<void> {
  if (typeof store.deletePrefix !== 'function') throw new Error('@gnldev/lab: this journal cannot delete, so a scenario cannot be removed');
  // The key ends in the scenario's own uuid: no other key starts with it.
  await store.deletePrefix(scenarioKey(s));
}

export interface RunScenariosOptions {
  scenarios: readonly SavedScenario[];
  model: LanguageModel;
  /** The agent as it is now: its system prompt (a scenario's own when omitted) and its tools (`execute` never runs). */
  system?: string;
  tools?: ToolSet;
  /** Plays per scenario (default 3). */
  trials?: number;
  /**
   * What the tools return now, in place of each scenario's own: answers for given arguments, and a default
   * per tool for any other — the playground's definition, played against its kept conversations.
   */
  returns?: { answers?: readonly ToolAnswer[]; otherwise?: Readonly<Record<string, unknown>> };
  maxSteps?: number;
  concurrency?: number;
  pricing?: Record<string, ModelPricing>;
  onProgress?: (progress: TrialsProgress) => void;
  signal?: AbortSignal;
  throttle?: { waitMs?: number; maxWaits?: number };
}

export interface ScenarioRun {
  id: string;
  title: string;
  passed: number;
  failed: number;
  /** Plays stopped at a call the scenario holds no result for, and not settled by what they did. */
  undetermined: number;
  /** Plays the model could not be asked for — in no count above. */
  errored: number;
  /** Right answers among the plays that ran, an undetermined one counted wrong (95% Wilson). */
  passRate: Interval;
  /** How the first play that fell short did, and the calls it stopped at. */
  failures: string[];
  pending: Array<{ toolName: string; args: unknown }>;
}

export interface RunScenariosResult {
  scenarios: ScenarioRun[];
  /** Scenarios whose every play that ran did what a right answer does. */
  allPassed: number;
  inputTokens: number;
  outputTokens: number;
  costUsd: number;
  priced: boolean;
}

/** Plays every scenario `trials` times against the agent as it is now; each call is answered from the scenario. */
export async function runScenarios(opts: RunScenariosOptions): Promise<RunScenariosResult> {
  refuseUnknownNames('runScenarios', opts, RUN_SCENARIOS_NAMES);
  const trials = opts.trials ?? 3;
  if (!Number.isInteger(trials) || trials < 1) throw new RangeError('@gnldev/lab: runScenarios: trials must be a whole number ≥ 1');
  const modelId = typeof opts.model === 'string' ? opts.model : (opts.model as { modelId?: string }).modelId;
  const price = modelId && opts.pricing ? priceFor(modelId, opts.pricing) : undefined;
  let inputTokens = 0, outputTokens = 0;
  const play = (s: SavedScenario) => async () => {
    // The scenario's own results; what the tools return now (`returns`) in their place.
    const known = new Map([...s.results, ...s.answers, ...(opts.returns?.answers ?? [])].map((r) => [`${r.toolName}:${argsHash(r.args)}`, { output: r.output, source: s.results.includes(r) ? 'recorded' as const : 'answer' as const }]));
    const otherwise = opts.returns?.otherwise ?? {};
    const trace: TracedCall[] = [];
    let stopped: { toolName: string; args: unknown } | undefined;
    const tools: Record<string, unknown> = {};
    for (const [name, def] of Object.entries(opts.tools ?? {})) {
      tools[name] = {
        ...def,
        execute: async (args: unknown) => {
          const hit = known.get(`${name}:${argsHash(args)}`);
          if (hit) { trace.push({ toolName: name, args, source: hit.source }); return hit.output; }
          if (name in otherwise) { trace.push({ toolName: name, args, source: 'answer' }); return otherwise[name]; }
          trace.push({ toolName: name, args, source: 'none' });
          stopped ??= { toolName: name, args };
          return { error: 'no result recorded for this call' };
        },
      };
    }
    const systemInMessages = s.messages.some((m) => m.role === 'system');
    const r = await generateText({
      model: opts.model, system: opts.system ?? s.system, messages: s.messages, tools: tools as ToolSet,
      ...(systemInMessages ? { allowSystemInMessages: true } : {}),
      stopWhen: [stepCountIs(opts.maxSteps ?? 10), () => stopped !== undefined],
    } as never) as Awaited<ReturnType<typeof generateText>>;
    inputTokens += r.totalUsage?.inputTokens ?? 0; outputTokens += r.totalUsage?.outputTokens ?? 0;
    return { verdict: judgePlay(s.expect, trace, stopped ? '' : r.text), stopped };
  };
  const jobs = opts.scenarios.flatMap((s) => Array.from({ length: trials }, () => play(s)));
  const done = await runTrials(jobs, {
    ...(opts.concurrency !== undefined ? { concurrency: opts.concurrency } : {}),
    ...(opts.onProgress ? { onProgress: opts.onProgress } : {}),
    ...(opts.signal ? { signal: opts.signal } : {}),
    ...(opts.throttle ? { throttle: opts.throttle } : {}),
  });
  const scenarios = opts.scenarios.map((s, i): ScenarioRun => {
    let passed = 0, failed = 0, undetermined = 0, errored = 0;
    let failures: string[] = [];
    const pending = new Map<string, { toolName: string; args: unknown }>();
    for (const o of done.outcomes.slice(i * trials, (i + 1) * trials)) {
      if (!o.ok) { errored++; continue; }
      const v = o.value.verdict;
      if (v.verdict === 'pass') passed++;
      else if (v.verdict === 'fail') { failed++; if (!failures.length) failures = v.failures; }
      else undetermined++;
      if (o.value.stopped) pending.set(`${o.value.stopped.toolName}:${argsHash(o.value.stopped.args)}`, o.value.stopped);
    }
    return { id: s.id, title: s.title, passed, failed, undetermined, errored, passRate: wilson(passed, passed + failed + undetermined), failures, pending: [...pending.values()] };
  });
  const costUsd = price ? (inputTokens / 1e6) * price.inputPer1M + (outputTokens / 1e6) * price.outputPer1M : 0;
  return {
    scenarios, allPassed: scenarios.filter((x) => x.passed > 0 && x.failed === 0 && x.undetermined === 0).length,
    inputTokens, outputTokens, costUsd, priced: !!price,
  };
}
