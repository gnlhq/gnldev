// "What would this run have done, changed?" — a recorded run copied into a capsule and played again there.
//
// The capsule is the run's own conversation with what the person changed: the system prompt, the tools
// offered (taken away, added, described otherwise), and whether the conversation before the last message
// is kept. Nothing leaves it: no tool runs, and the run, its thread and its owner are only read. Every
// call is answered from the recording; a call the recording never made is answered by `answers` — the
// person who knows what the tool returns writes it — or the trial stops there and the call is listed in
// `pending`, to be answered and played again. A recorded result can be put aside too (`overrides`): the
// call gets the person's result instead — "what if the tool had said this?". Answers and overrides are
// the caller's: they are sent with every request and kept nowhere.
//
// Each trial is one draw of a model that does not answer the same way twice, so the result is the trials
// side by side: how many made the recorded calls again, and every way they went — and, given what a right
// answer does (`expect`), how many did that. A change is only worth its difference from the run left as it
// was, drawn the same number of times: with `unchanged`, the run is also played unchanged and the two
// are compared ("3 of 10 unchanged → 8 of 10 changed"), with an interval that says whether the
// difference is more than chance.
//
// What memory put into the run is read from the run's own layout (@gnldev/durable memoryRowsOf), never
// from its counts: a run without a layout cannot have its memory left out, and says so.
import type { LanguageModel, ModelMessage, ToolSet } from 'ai';
import { argsHash, runKeys, readRunMemoryLayout, memoryRowsOf, cutWorkingMemory, type MemoryRows, type ModelPricing } from '@gnldev/durable';
import { refuseUnknownNames } from '@gnldev/options';
import {
  replayCounterfactual, maskConversation, runTrials, wilson, newcombe, readerOf,
  type Expectation, type Interval, type JournalSource, type ToolAnswer, type TracedCall, type TrialsProgress,
} from '@gnldev/experiment';
import { CAPSULE_NAMES } from './option-names.js';
import { judgePlay } from './judge.js';

export interface CapsuleOptions {
  /** Where the run is. Only read. */
  journal: JournalSource;
  runId: string;
  model: LanguageModel;
  /** The tools offered in the capsule — the agent's, changed as the person wants. `execute` never runs. */
  tools?: ToolSet;
  /**
   * The system prompt in the capsule; the recorded one when omitted. When the run's layout places a
   * working memory in the recorded system, this is the prompt WITHOUT it (what capsuleSystemOf calls
   * `own`), and the working memory is put back behind it unless `memory` is false.
   */
  system?: string;
  /** Keep the conversation before the run's last message (default true). Off, the model sees that message alone. */
  history?: boolean;
  /**
   * Keep what memory put into the conversation (default true). Off, exactly the rows the run's memory
   * layout proves are memory's are left out — observations, recall, the recent window — and the working
   * memory is cut out of the system text; the turn's own messages, and rows an input processor put in,
   * stay. "Would it have answered so without what it remembered?" A run whose layout does not prove it
   * (none recorded, unaligned, a working memory whose place is not known) is refused with the reason.
   */
  memory?: boolean;
  /** What a right answer does; each trial is checked against it (see CapsuleResult.expected). */
  expect?: Expectation;
  /** Results for calls the recording never made. */
  answers?: readonly ToolAnswer[];
  /** Results put in place of the recorded ones (same tool, same arguments) — "what if the tool had said this?". */
  overrides?: readonly ToolAnswer[];
  /** Plays of the capsule (default 3) — and as many of the run unchanged, with `unchanged`. */
  trials?: number;
  /**
   * Also play the run as it was, `trials` times, beside the change: its own system prompt, history and
   * memory, no override — with these tools (the agent's own; `execute` never runs) and the same
   * `answers`. The result's `unchanged` and `difference` compare the two. Omitted: the change is played alone.
   */
  unchanged?: { tools?: ToolSet };
  concurrency?: number;
  maxSteps?: number;
  timeoutMs?: number;
  pricing?: Record<string, ModelPricing>;
  onProgress?: (progress: TrialsProgress) => void;
  signal?: AbortSignal;
  throttle?: { waitMs?: number; maxWaits?: number };
}

/** One way the trials went: the calls in order, with where each result came from, and how often. */
export interface CapsulePath {
  calls: TracedCall[];
  /** The final answer of the first trial that went this way ('' when it stopped at a call no one answered). */
  text: string;
  count: number;
  /** The same calls with the same arguments as the recording, and none of them answered by the caller. */
  sameAsRecorded: boolean;
  /** With `expect`: the trials of this path that did what it asks. */
  passed?: number;
  /** With `expect`: how the first trial of this path fell short ([] when it passed); absent when it could not be judged (judgePlay). */
  failures?: string[];
}

export interface CapsuleResult {
  runId: string;
  recorded: { calls: Array<{ toolName: string; args: unknown }>; text: string };
  /** Most frequent first. */
  paths: CapsulePath[];
  /** How many trials made the recorded calls again. */
  sameAsRecorded: Interval;
  /** Calls no answer covered — each stopped a trial. Answer them and play again to see past them. */
  pending: Array<{ toolName: string; args: unknown }>;
  trials: number;
  failed: number;
  inputTokens: number;
  outputTokens: number;
  costUsd: number;
  priced: boolean;
  /**
   * With `expect`: how many trials did what it asks. A trial that stopped at a call no one answered did
   * not finish: unless what it already did settles it (judgePlay — a forbidden call made, or every
   * expected call made when nothing else is asked), it is neither a pass nor a failure and is counted in
   * `undetermined`, not in the rate.
   */
  expected?: {
    passRate: Interval;
    undetermined: number;
    /**
     * The rate's two bounds over every trial that ran: `low` counts an undetermined trial as a failure,
     * `high` as a pass. `passRate` is over the judged trials only and can lie outside them — a change
     * that turns failures into calls nobody answered raises it with no pass more — so read the three together.
     */
    bounds: { low: Interval; high: Interval };
  };
  /** What the capsule could not do exactly as asked, in words (a working memory cut at a rewritten span, memory rows left in). */
  notes: string[];
  /** With `unchanged`: the run played as it was, as many times — counted the same way. Its tokens are in the totals above. */
  unchanged?: CapsuleArm;
  /**
   * With `unchanged`: the change's rate minus the unchanged run's (Newcombe, 95%). With `expect`, the rate
   * of right answers at its worst for the change — the change's undetermined plays counted wrong, the
   * unchanged run's right; without it, the rate of plays that made the recorded calls again. An interval
   * that holds 0 does not tell the change from chance.
   */
  difference?: { of: 'expected' | 'sameAsRecorded'; interval: Interval };
}

/** The run played as it was, beside the change (CapsuleResult.unchanged). */
export interface CapsuleArm {
  paths: CapsulePath[];
  sameAsRecorded: Interval;
  trials: number;
  failed: number;
  expected?: NonNullable<CapsuleResult['expected']>;
}

const keyOf = (c: { toolName: string; args: unknown }) => `${c.toolName}:${argsHash(c.args)}`;

/** Memory's part of a run's input, as the run's layout proves it. */
export type CapsuleMemory = Extract<MemoryRows, { known: true }>;

const undiagnosable = (runId: string, why: string) =>
  new RangeError(`@gnldev/lab: run '${runId}' cannot be diagnosed by where its input came from — ${why}`);

/**
 * Which rows of the run's input memory put there, by the run's own layout. Refused (RangeError, with the
 * reason) when the layout does not prove it — never derived from the counts.
 */
export async function memoryOfRun(journal: { get: <T>(key: string) => Promise<T | undefined> }, runId: string): Promise<CapsuleMemory> {
  const rows = memoryRowsOf(await readRunMemoryLayout(journal as never, runId));
  if (!rows.known) throw undiagnosable(runId, rows.detail);
  return rows;
}

/**
 * How many of the run's input messages memory put there — rows of the layout's memory spans, without
 * the rows an input processor added among them or whose part cannot be told. Refused like memoryOfRun.
 */
export async function memoryInjected(journal: { get: <T>(key: string) => Promise<T | undefined> }, runId: string, inputLength: number): Promise<number> {
  const rows = await memoryOfRun(journal, runId);
  if (rows.positions.some((i) => i >= inputLength)) throw undiagnosable(runId, `its layout names rows past the ${inputLength} input messages`);
  return rows.positions.length;
}

/** The recorded system prompt, with the working memory memory put in it told apart when the layout places it. */
export interface CapsuleSystem {
  /** The prompt without the working memory (the whole prompt when it cannot be told apart). */
  own: string;
  /**
   * The working memory. `text` only when its place is proven (`exact`, `moved`, or `rewritten` — a
   * processor changed it in place, its ends still anchored); `unbounded`/`lost` say it is in the system
   * text somewhere this run cannot point at, so `own` is the whole prompt.
   */
  workingMemory?: { status: 'exact' | 'moved' | 'rewritten'; text: string } | { status: 'unbounded' | 'lost' };
}

/** @internal — shared by the capsule and studioLab's capsule base; `rows` is memoryOfRun's answer, not an options bag. */
export function capsuleSystemOf(recorded: string, rows: CapsuleMemory | undefined): CapsuleSystem {
  const wm = rows?.workingMemory;
  if (!wm) return { own: recorded };
  if (!('span' in wm)) return { own: recorded, workingMemory: { status: wm.status } };
  return { own: cutWorkingMemory(recorded, wm.span), workingMemory: { status: wm.status, text: recorded.slice(wm.span[0], wm.span[1]) } };
}

export async function runCapsule(opts: CapsuleOptions): Promise<CapsuleResult> {
  refuseUnknownNames('runCapsule', opts, CAPSULE_NAMES);
  const trials = opts.trials ?? 3;
  let prepareStep: ReturnType<typeof maskConversation> | undefined;
  const notes: string[] = [];
  const j = readerOf(opts.journal);
  const input = await j.get<{ messages?: unknown; system?: unknown }>(runKeys.input(opts.runId));
  const messages = Array.isArray(input?.messages) ? (input!.messages as ModelMessage[]) : [];
  const recordedSystem = typeof input?.system === 'string' ? input.system : '';
  // Memory's rows and working memory: needed to leave memory out, and to put an edited prompt together
  // with the working memory the base showed apart from it. A run without a layout has neither.
  let rows: CapsuleMemory | undefined;
  if (opts.memory === false) rows = await memoryOfRun(j, opts.runId);
  else if (opts.system !== undefined) rows = await memoryOfRun(j, opts.runId).catch(() => undefined);
  let system = opts.system;
  const sys = capsuleSystemOf(recordedSystem, rows);
  const wm = sys.workingMemory;
  if (opts.memory === false) {
    if (wm && !('text' in wm)) throw undiagnosable(opts.runId, `the working memory's place in the system text is not known ('${wm.status}'), so it cannot be left out`);
    if (wm?.status === 'rewritten') notes.push('the working memory was rewritten by an input processor; it was cut out where its ends are anchored');
    if (wm) system ??= sys.own;
    if (rows!.ambiguous.length) notes.push(`${rows!.ambiguous.length} row(s) of memory content whose part cannot be told stayed in`);
  } else if (system !== undefined && wm && 'text' in wm) {
    system = [system, wm.text].filter(Boolean).join('\n\n');
  }
  if (opts.history === false || opts.memory === false) {
    const drop = new Set<number>();
    if (opts.history === false) {
      const last = messages.map((m) => m.role).lastIndexOf('user');
      for (let i = 0; i < last; i++) drop.add(i);
    }
    if (opts.memory === false) for (const i of rows!.positions) if (i < messages.length) drop.add(i);
    if (drop.size) prepareStep = maskConversation({ dropInput: [...drop] });
  }
  const playWith = (changed: boolean) => () => replayCounterfactual({
    journal: opts.journal, runId: opts.runId, model: opts.model,
    ...(changed ? {
      ...(opts.tools ? { tools: opts.tools } : {}),
      ...(system !== undefined ? { system } : {}),
      ...(prepareStep ? { prepareStep: prepareStep as never } : {}),
      ...(opts.overrides?.length ? { overrides: opts.overrides } : {}),
    } : opts.unchanged?.tools ? { tools: opts.unchanged.tools } : {}),
    ...(opts.answers?.length ? { answers: opts.answers } : {}),
    ...(opts.maxSteps !== undefined ? { maxSteps: opts.maxSteps } : {}),
    ...(opts.timeoutMs !== undefined ? { timeoutMs: opts.timeoutMs } : {}),
    ...(opts.pricing ? { pricing: opts.pricing } : {}),
  });
  const jobs = [...Array.from({ length: trials }, () => playWith(true)), ...(opts.unchanged ? Array.from({ length: trials }, () => playWith(false)) : [])];
  const done = await runTrials(jobs, {
    ...(opts.concurrency !== undefined ? { concurrency: opts.concurrency } : {}),
    ...(opts.onProgress ? { onProgress: opts.onProgress } : {}),
    ...(opts.signal ? { signal: opts.signal } : {}),
    ...(opts.throttle ? { throttle: opts.throttle } : {}),
  });
  type Play = Awaited<ReturnType<ReturnType<typeof playWith>>>;
  const valuesOf = (outcomes: typeof done.outcomes) => outcomes.flatMap((o) => (o.ok ? [o.value as Play] : []));
  const changedOutcomes = done.outcomes.slice(0, trials), unchangedOutcomes = done.outcomes.slice(trials);
  const values = valuesOf(changedOutcomes);
  if (values.length === 0) {
    throw new Error(`@gnldev/lab: runCapsule: none of ${trials} plays of '${opts.runId}' could run — ${(changedOutcomes.find((o) => !o.ok) as { error: string }).error}`);
  }

  const first = values[0]!;
  const recordedKey = first.recordedTrace.map(keyOf).join('|');
  const pending = new Map<string, { toolName: string; args: unknown }>();
  let inputTokens = 0, outputTokens = 0, costUsd = 0, priced = true;
  // Both arms counted the same way: paths, plays that made the recorded calls again, and — with `expect` — right answers.
  const tally = (plays: readonly Play[], outcomes: number): CapsuleArm & { passes: number; undetermined: number } => {
    const paths = new Map<string, CapsulePath>();
    let same = 0, passes = 0, undetermined = 0;
    for (const r of plays) {
      const key = r.trace.map((c) => `${keyOf(c)}:${c.source}`).join('|');
      const isSame = r.trace.every((c) => c.source === 'recorded') && r.trace.map(keyOf).join('|') === recordedKey;
      if (isSame) same++;
      // A trial that stopped at a call no one answered is judged only where the rest cannot change it (judgePlay).
      const judged = opts.expect ? judgePlay(opts.expect, r.trace, r.candidate.text) : undefined;
      const failures = !judged || judged.verdict === 'undetermined' ? undefined : judged.verdict === 'fail' ? judged.failures : [];
      if (opts.expect) { if (!failures) undetermined++; else if (failures.length === 0) passes++; }
      const p = paths.get(key);
      if (p) { p.count++; if (failures?.length === 0) p.passed = (p.passed ?? 0) + 1; }
      else paths.set(key, { calls: r.trace, text: r.candidate.text, count: 1, sameAsRecorded: isSame, ...(opts.expect ? { passed: failures?.length === 0 ? 1 : 0 } : {}), ...(failures ? { failures } : {}) });
      if (r.divergence) pending.set(keyOf({ toolName: r.divergence.call.toolName, args: r.divergence.args }), { toolName: r.divergence.call.toolName, args: r.divergence.args });
      inputTokens += r.candidate.inputTokens; outputTokens += r.candidate.outputTokens;
      costUsd += r.candidate.costUsd; priced &&= r.candidate.priced;
    }
    return {
      paths: [...paths.values()].sort((a, b) => b.count - a.count), sameAsRecorded: wilson(same, plays.length), trials: outcomes, failed: outcomes - plays.length, passes, undetermined,
      ...(opts.expect ? { expected: {
        passRate: wilson(passes, plays.length - undetermined), undetermined,
        bounds: { low: wilson(passes, plays.length), high: wilson(passes + undetermined, plays.length) },
      } } : {}),
    };
  };
  const changed = tally(values, trials);
  const base = opts.unchanged ? tally(valuesOf(unchangedOutcomes), trials) : undefined;
  const ranOf = (a: { paths: CapsulePath[] }) => a.paths.reduce((n, p) => n + p.count, 0);
  const difference: CapsuleResult['difference'] = !base || ranOf(base) === 0 ? undefined
    : opts.expect ? { of: 'expected', interval: newcombe({ successes: changed.passes, n: ranOf(changed) }, { successes: base.passes + base.undetermined, n: ranOf(base) }) }
    : { of: 'sameAsRecorded', interval: newcombe({ successes: Math.round(changed.sameAsRecorded.value * ranOf(changed)), n: ranOf(changed) }, { successes: Math.round(base.sameAsRecorded.value * ranOf(base)), n: ranOf(base) }) };
  if (base && ranOf(base) === 0) notes.push(`none of the ${trials} unchanged plays could run, so the change is not compared with the run as it was`);
  const { passes: _p, undetermined: _u, ...unchanged } = base ?? ({} as never);
  return {
    runId: opts.runId,
    recorded: { calls: first.recordedTrace, text: first.recorded.text },
    paths: changed.paths,
    sameAsRecorded: changed.sameAsRecorded,
    pending: [...pending.values()],
    trials,
    failed: changed.failed,
    inputTokens, outputTokens, costUsd, priced,
    ...(changed.expected ? { expected: changed.expected } : {}),
    notes,
    ...(base ? { unchanged: unchanged as CapsuleArm } : {}),
    ...(difference ? { difference } : {}),
  };
}
