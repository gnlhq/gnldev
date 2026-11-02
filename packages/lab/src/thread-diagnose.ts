// "Why did this turn of the conversation go wrong?" — a thread's turns read, and one of them diagnosed.
//
// threadPlan calls no model. It reads the thread's runs in order and says, per turn: how it ended, and
// whether it ended before the model could be asked (an `infrastructure` turn — a provider refusal, a
// 5xx, a network error, or no model step at all — says nothing about the agent and is never diagnosed);
// where its input came from, by the run's own memory layout, as CHARACTERS (the layout's spans measured
// as JSON text, the working memory's length — not tokens: a tokenizer would be one model's); and the
// experiments a diagnosis of it would run, with what they cost, before anything is spent.
//
// diagnoseTurn is the diagnosis. With `guess`, a GUESS comes first: a model reads the turn — what a right
// answer does, what the turn did, each part's text — and names the one or two parts most likely to blame,
// with what each should have said. Only those are played, beside the turn unchanged; a guess the plays
// bear out is the verdict, and elimination is not run. A guess is never the verdict by itself: it names
// where to look, the plays decide. One the plays do not bear out is said so, and the two stages below
// run as without it, the 5% level shared between the guess and them (2.5% each). Measured (40 planted
// faults, gpt-6-luna, through Studio's routes): elimination named 15 and could not test 18; the same
// model asked to name the part named all 40 — but a reader's guess is not evidence, so it is tested.
//
// Then, in two stages that never share a play:
// 1. ELIMINATION — explainRun over the turn's parts, each named by where it came from, valued by how
//    often a play does what a right answer does (`match: 'expect'`): the recorded calls of a failed turn
//    are the wrong ones, so "how often they came out again" would explain the mistake, not its cause.
//    A part whose presence pulls the plays away from the right answer has a positive `blame`. Past 8
//    parts they are taken four groups at a time (system / memory / history / tool results).
// 2. VERIFICATION — the k most blamed parts, plus every candidate that is an ABSENCE (rows memory
//    returned and an input processor removed; earlier turns of the thread that fell out of the recent
//    window) and every hypothesis the person brought (a corrected working memory, a tool result they
//    think was wrong, the corrected text of any part), each changed in the capsule — left out, replaced,
//    corrected, put back — and played n times,
//    beside the turn played n times unchanged. Fresh plays: an elimination play is never counted again.
//    Each arm's rate of right answers is compared with the unchanged turn's (Newcombe's interval of the
//    difference), at a Bonferroni level over every comparison planned — one of them kept for the joint
//    arm (the two leading candidates together), played only when no single change helps.
//
//    Leaving a part out tests whether it was in the way; a part that said something WRONG (an old address
//    in the working memory, a tool result that lied) is not fixed by its absence — the model then knows
//    nothing — but by its corrected text. With `suggest`, a model proposes that text for the most blamed
//    parts (only those: a correction of a part elimination did not blame could put the right answer
//    anywhere), and each proposal is played as an arm of its own, marked suggested; `corrections` are the
//    person's own.
//
// The verdict follows rules written before any play (verdictOf). No tool runs and nothing is written:
// every call is answered from the recording, an override or an answer the person gave.
import { generateText, type LanguageModel, type ModelMessage, type ToolSet } from 'ai';
import { argsHash, priceFor, runKeys, settleModelContent, usageAndCostFromModelValue, type JournalReader, type ModelPricing, type RunOutcomeRecord, type RunStatus, type RunSummary } from '@gnldev/durable';
import { refuseUnknownNames } from '@gnldev/options';
import {
  replayCounterfactual, maskConversation, runTrials, wilson, newcombe, normalQuantile, readerOf, recordedTrace, recordedResults, checkExpectation,
  type Expectation, type Interval, type JournalSource, type ToolAnswer, type TracedCall, type TrialsProgress,
} from '@gnldev/experiment';
import { explainRun, explainRunSize } from './explain-run.js';
import { capsuleSystemOf } from './capsule.js';
import { judgePlay } from './judge.js';
import { proposeParts, sourcesOf, cut, textOf, type LabLayout, type LabPart, type PartSources, type Proposed } from './parts.js';
import { usageOfRun } from './journal.js';
import { THREAD_PLAN_NAMES, DIAGNOSE_TURN_NAMES, PLAN_DIAGNOSIS_NAMES } from './option-names.js';

// ── How a turn ended ────────────────────────────────────────────────────────────────────────────────

/**
 * `infrastructure`: the turn ended before the model could be asked, or the provider refused or broke —
 * nothing in it says how the agent behaves. `failed`: it ended badly after the model answered (a tool
 * that threw, a limit). The rest are the run's own status.
 */
export type TurnClass = 'infrastructure' | 'failed' | 'suspended' | 'completed' | 'running' | 'canceled';

/** Connection failures a provider client reports by code (Node's and undici's). */
const NETWORK_CODES = new Set([
  'ECONNRESET', 'ECONNREFUSED', 'ECONNABORTED', 'ETIMEDOUT', 'ENOTFOUND', 'EAI_AGAIN', 'EPIPE', 'EHOSTUNREACH', 'ENETUNREACH',
  'UND_ERR_SOCKET', 'UND_ERR_CONNECT_TIMEOUT', 'UND_ERR_HEADERS_TIMEOUT', 'UND_ERR_BODY_TIMEOUT',
]);

/**
 * The lab's policy for a failed turn, in this order: a 429 or a 5xx (the provider's answer), a network
 * code, a `TimeoutError`, and no model step at all are `infrastructure` — the model did not get to
 * decide anything. Every other failure is `failed`: the model answered and something after it broke.
 * Read from the run's outcome record (errorStatus/errorCode/errorName), never from its message text.
 * @internal — its arguments are a run's summary and outcome record, not an options bag.
 */
export function classifyTurn(run: Pick<RunSummary, 'status' | 'modelSteps'>, outcome: Partial<RunOutcomeRecord> | undefined): { class: TurnClass; reason?: string } {
  if (run.status !== 'failed') return { class: run.status };
  const s = outcome?.errorStatus, code = outcome?.errorCode, name = outcome?.errorName;
  if (s === 429) return { class: 'infrastructure', reason: 'the provider refused the request (429)' };
  if (typeof s === 'number' && s >= 500) return { class: 'infrastructure', reason: `the provider failed (${s})` };
  if (code && NETWORK_CODES.has(code)) return { class: 'infrastructure', reason: `the connection failed (${code})` };
  if (name === 'TimeoutError') return { class: 'infrastructure', reason: 'the request timed out' };
  if (run.modelSteps === 0) return { class: 'infrastructure', reason: 'it failed before any model step answered' };
  return { class: 'failed', ...(name ? { reason: name } : {}) };
}

// ── Where a turn's input came from, in characters ───────────────────────────────────────────────────

export type CompositionSource = 'system' | 'wm' | 'om' | 'recall' | 'recent' | 'turn' | 'unlabelled';

/**
 * A turn's input by source, in characters: each row's JSON text, the system prompt's and the working
 * memory's length. Characters, not tokens — a share of characters is close to a share of tokens and
 * is what the record can prove. `labelled` false: a memory run without a layout — only the total is known.
 */
export interface TurnComposition {
  unit: 'characters';
  total: number;
  labelled: boolean;
  bySource: Partial<Record<CompositionSource, number>>;
}

function compositionOf(input: { system?: unknown; messages?: unknown; prompt?: unknown }, layout: LabLayout, src: PartSources): TurnComposition {
  const messages = (Array.isArray(input.messages) ? input.messages : typeof input.prompt === 'string' ? [{ role: 'user', content: input.prompt }] : []) as unknown[];
  const system = typeof input.system === 'string' ? input.system : '';
  const len = (m: unknown) => JSON.stringify(m ?? null).length;
  const by: Partial<Record<CompositionSource, number>> = {};
  const add = (k: CompositionSource, n: number) => { if (n > 0) by[k] = (by[k] ?? 0) + n; };
  const total = system.length + messages.reduce<number>((a, m) => a + len(m), 0);
  if (layout.status === 'absent') return { unit: 'characters', total, labelled: false, bySource: {} };
  const sys = capsuleSystemOf(system, src.layout ? src.rows : undefined);
  const wmText = sys.workingMemory && 'text' in sys.workingMemory ? sys.workingMemory.text : '';
  add('system', system.length - wmText.length);
  add('wm', wmText.length);
  const L = src.layout;
  const off = new Set([...(L?.foreign ?? []), ...(L?.ambiguous ?? [])]);
  const inSpan = (sp: [number, number] | undefined, i: number) => !!sp && i >= sp[0] && i < sp[1];
  messages.forEach((m, i) => {
    const k: CompositionSource = !L ? 'turn' : off.has(i) ? 'unlabelled' : inSpan(L.observations, i) ? 'om' : inSpan(L.recall, i) ? 'recall'
      : inSpan(L.recent, i) ? 'recent' : inSpan(L.incoming, i) ? 'turn' : 'unlabelled';
    add(k, len(m));
  });
  return { unit: 'characters', total, labelled: true, bySource: by };
}

// ── Planning: how many plays, what they cost ────────────────────────────────────────────────────────

export interface PlanDiagnosisOptions {
  /** Changes compared with the unchanged turn (suspects, absences, the person's hypotheses). */
  arms: number;
  /** Plays of the elimination stage (explainRunSize). */
  eliminationPlays: number;
  /** What one play costs in tokens, roughly (the recorded run's). */
  tokensPerPlay: number;
  /** Plays per arm; the planned number when omitted. */
  trials?: number;
  /** The smallest difference in the rate of right answers the plan should see (default 0.4). */
  targetDifference?: number;
  /** The chance of seeing it when it is there (default 0.8). */
  power?: number;
  /**
   * The share of plays expected to stop at a call nobody answered, in every arm (default 0.1 —
   * EXPECTED_UNDETERMINED). The verdict reads each comparison at its worst, which takes that share off
   * the difference twice over neither side's favour: an arm's undetermined plays count wrong, the
   * unchanged turn's right. A plan blind to it promised a power it did not have (measured: at 10% on
   * both sides, 0.575 where 0.8 was planned).
   */
  undetermined?: number;
  /** Price of one play's tokens, to say the cost in money. */
  price?: { inputPer1M: number; outputPer1M: number; inputTokens: number; outputTokens: number };
  /** Arms the guess may play first (0: no guess). With a guess the 5% level is shared: 2.5% for it, 2.5% for the rest. */
  guessArms?: number;
}

export interface DiagnosisPlan {
  /**
   * Arms compared with the unchanged turn — at most: elimination may blame fewer than `topK` parts, and
   * then fewer are played (and the level is shared by fewer comparisons).
   */
  arms: number;
  /** Comparisons the level is shared by: the arms and the joint arm, kept for whether it is played or not. */
  comparisons: number;
  /** The level of each comparison: 0.05 / comparisons (Bonferroni). */
  alpha: number;
  targetDifference: number;
  power: number;
  /** Plays per arm — the person's, or the planned. */
  trials: number;
  /** The share of undetermined plays the plan assumes in every arm. */
  undetermined: number;
  /**
   * Plays per arm the target difference needs at this power and level, compared at its worst (the
   * planned undetermined share counted against the change). Capped at MAX_ARM_TRIALS.
   */
  plannedTrials: number;
  /** With `trials` plays per arm and no undetermined play, the smallest difference seen at this power and level. */
  detectableDifference: number;
  /**
   * With `trials` plays per arm and the planned undetermined share, compared at its worst: the smallest
   * TRUE difference in right answers seen at this power and level (above 1: none can be).
   */
  worstCaseDetectableDifference: number;
  eliminationPlays: number;
  /** The unchanged turn and every arm, `trials` times each. */
  verificationPlays: number;
  /** Plays of the joint arm, if it is needed. */
  jointPlays: number;
  /** The guess's arms, `trials` times each, played first (the unchanged turn's plays are shared with verification). */
  guessPlays: number;
  /** Elimination + verification + the joint arm: the most this diagnosis plays. */
  totalPlays: number;
  tokens: number;
  estimatedCostUsd?: number;
  /** `trials` below the planned number: only a difference of about `worstCaseDetectableDifference` can be seen. */
  underpowered: boolean;
}

/** Most plays per arm the planner proposes. */
export const MAX_ARM_TRIALS = 100;

/**
 * The undetermined share a plan assumes when it is not told one: half of MAX_UNDETERMINED_SHARE. An arm
 * past that share is not tested, so a tested arm's share lies between 0 and it; its middle is the guess
 * that neither promises power the worst case cannot deliver at moderate stopping nor doubles every bill.
 * Not a measurement: a capsule play of the turn says what share stops (`expected.undetermined`).
 */
export const EXPECTED_UNDETERMINED = 0.1;

// Two rates, one of them unknown: the sample size is planned at the worst case, rates either side of
// one half, where a difference is hardest to see.
function trialsFor(d: number, alpha: number, power: number): number {
  const za = normalQuantile(1 - alpha / 2), zb = normalQuantile(power);
  const p0 = 0.5 - d / 2, p1 = 0.5 + d / 2;
  const n = (za * Math.sqrt(2 * 0.25) + zb * Math.sqrt(p0 * (1 - p0) + p1 * (1 - p1))) ** 2 / (d * d);
  return Math.ceil(n);
}
function detectable(n: number, alpha: number, power: number): number {
  if (trialsFor(0.999, alpha, power) > n) return 1;
  let lo = 0.001, hi = 0.999;
  for (let i = 0; i < 40; i++) { const mid = (lo + hi) / 2; if (trialsFor(mid, alpha, power) <= n) hi = mid; else lo = mid; }
  return Math.round(hi * 100) / 100;
}

/** How many plays a diagnosis takes and what it costs — before anything is spent. Calls no model. */
export function planDiagnosis(opts: PlanDiagnosisOptions): DiagnosisPlan {
  refuseUnknownNames('planDiagnosis', opts, PLAN_DIAGNOSIS_NAMES);
  const targetDifference = opts.targetDifference ?? 0.4, power = opts.power ?? 0.8;
  if (!(targetDifference > 0 && targetDifference < 1)) throw new RangeError('@gnldev/lab: planDiagnosis: targetDifference must lie between 0 and 1');
  if (!(power > 0 && power < 1)) throw new RangeError('@gnldev/lab: planDiagnosis: power must lie between 0 and 1');
  const undetermined = opts.undetermined ?? EXPECTED_UNDETERMINED;
  if (!(undetermined >= 0 && undetermined < 1)) throw new RangeError('@gnldev/lab: planDiagnosis: undetermined must lie from 0 to below 1');
  const comparisons = Math.max(1, opts.arms) + 1;
  const guessArms = opts.guessArms ?? 0;
  if (!Number.isInteger(guessArms) || guessArms < 0) throw new RangeError('@gnldev/lab: planDiagnosis: guessArms must be a whole number ≥ 0');
  const alpha = (guessArms ? 0.025 : 0.05) / comparisons;
  // At its worst the comparison sees the true difference less the undetermined share (the arm's counted
  // wrong, the unchanged turn's right): that smaller difference is what n must find.
  const seen = targetDifference - undetermined;
  const plannedTrials = seen > 0 ? Math.min(MAX_ARM_TRIALS, trialsFor(seen, alpha, power)) : MAX_ARM_TRIALS;
  const trials = opts.trials ?? plannedTrials;
  if (!Number.isInteger(trials) || trials < 1) throw new RangeError('@gnldev/lab: planDiagnosis: trials must be a whole number ≥ 1');
  const verificationPlays = (opts.arms + 1) * trials;
  const jointPlays = opts.arms >= 2 ? trials : 0;
  const guessPlays = guessArms * trials;
  const totalPlays = opts.eliminationPlays + verificationPlays + jointPlays + guessPlays;
  const pr = opts.price;
  const perPlayUsd = pr ? (pr.inputTokens / 1e6) * pr.inputPer1M + (pr.outputTokens / 1e6) * pr.outputPer1M : undefined;
  return {
    arms: opts.arms, comparisons, alpha, targetDifference, power, undetermined, trials, plannedTrials,
    detectableDifference: detectable(trials, alpha, power),
    worstCaseDetectableDifference: Math.round((detectable(trials, alpha, power) + undetermined) * 100) / 100,
    eliminationPlays: opts.eliminationPlays, verificationPlays, jointPlays, guessPlays, totalPlays,
    tokens: totalPlays * opts.tokensPerPlay,
    ...(perPlayUsd !== undefined ? { estimatedCostUsd: totalPlays * perPlayUsd } : {}),
    underpowered: trials < plannedTrials || seen <= 0,
  };
}

// ── The candidates of one turn ──────────────────────────────────────────────────────────────────────

/** How a candidate is changed in the capsule. */
export type Intervention = 'remove' | 'wm-replace' | 'wm-remove' | 'hide-result' | 'override' | 'restore' | 'correct';

export interface Suspect extends LabPart {
  /** What the verification arm does to it, should elimination blame it. */
  intervention: Intervention;
}

/**
 * Something the turn's input LACKED that may have been the cause: rows memory returned and an input
 * processor removed (`trimmed`), or earlier turns of the thread that were not in the recent window
 * (`window`). Put back from the thread's own earlier runs — their frozen input and their answer, read
 * only — before the recent window.
 */
export interface AbsenceCandidate {
  id: string;
  kind: 'window' | 'trimmed';
  /** The earlier turns put back (1-based, in thread order). */
  turns: number[];
  /** Where they go, as a position of the turn's input. */
  at: number;
  preview: string;
}

/** A candidate that cannot be tried on this turn, and why. */
/**
 * A candidate that cannot be tested, and why — in words (`candidate`, `reason`) and as a code a page says
 * in its reader's language: `kind` names the candidate; `layoutReason` (the layout's absent reason),
 * `wmStatus` or `rows` the why.
 */
export interface Untestable {
  candidate: string;
  reason: string;
  kind: 'memory' | 'earlier-turns' | 'working-memory' | 'processor-rows';
  layoutReason?: string;
  wmStatus?: string;
  rows?: number;
}

export interface TurnCandidates {
  suspects: Suspect[];
  absences: AbsenceCandidate[];
  untestable: Untestable[];
  /** Past 8 parts, elimination takes them four groups at a time. */
  grouped: boolean;
}

/** Most earlier turns put back by one absence candidate (the latest of those missing). */
const MAX_RESTORED_TURNS = 3;
/** How far back a turn's missing earlier turns are looked for. */
const ABSENCE_LOOKBACK = 50;
/** Past this many parts, elimination is done over four groups. */
const MAX_ELIMINATION_PARTS = 8;

const norm = (m: unknown) => {
  const r = m as { role?: unknown; content?: unknown } | null;
  return `${String(r?.role ?? '')}:${textOf(r?.content).replace(/\s+/g, ' ').trim()}`;
};

interface Loaded {
  runId: string;
  input: { system?: unknown; messages?: unknown; prompt?: unknown; threadId?: unknown; agent?: unknown };
  messages: ModelMessage[];
  sources: PartSources;
  layout: LabLayout;
}

async function loadRun(j: { get: <T>(key: string) => Promise<T | undefined> }, runId: string): Promise<Loaded | undefined> {
  const input = await j.get<Loaded['input']>(runKeys.input(runId));
  if (!input) return undefined;
  const messages = (Array.isArray(input.messages) ? input.messages : typeof input.prompt === 'string' ? [{ role: 'user', content: input.prompt }] : []) as ModelMessage[];
  const { sources, layout } = await sourcesOf(j, runId, input);
  return { runId, input, messages, sources, layout };
}

/** A turn's own messages (its incoming span, or its last user message) and the answer it gave. */
async function ownTurnOf(j: JournalReader, run: Loaded): Promise<ModelMessage[]> {
  const L = run.sources.layout;
  const rows = L?.incoming ? run.messages.slice(L.incoming[0], L.incoming[1]) : (() => {
    const last = run.messages.map((m) => m.role).lastIndexOf('user');
    return last >= 0 ? run.messages.slice(last) : [];
  })();
  const entries = await j.readRun(run.runId);
  const lastModel = entries.filter((e) => e.kind === 'model').at(-1);
  const answer = lastModel ? textOf(settleModelContent(lastModel.value)) : '';
  return [...rows, ...(answer ? [{ role: 'assistant', content: answer } as ModelMessage] : [])];
}

/**
 * The turn's candidates: every part of its input named by where it came from (proposeParts, none
 * merged), with the change a verification arm makes to it; the absences; what cannot be tried. The
 * thread's earlier turns are passed in thread order, the turn itself not among them.
 */
async function candidatesOf(j: JournalReader, run: Loaded, calledTools: readonly string[], earlier: ReadonlyArray<{ turn: number; run: Loaded | undefined }>, opts: { workingMemory?: string; overrides?: readonly ToolAnswer[] }): Promise<TurnCandidates & { proposed: Proposed }> {
  const proposed = proposeParts({ system: run.input.system, messages: run.messages }, calledTools, Number.POSITIVE_INFINITY, run.sources);
  const overridden = new Set((opts.overrides ?? []).map((o) => o.toolName));
  const suspects: Suspect[] = proposed.parts.map((p) => ({
    ...p,
    intervention: p.kind === 'wm' ? (opts.workingMemory !== undefined ? 'wm-replace' : 'wm-remove')
      : p.kind === 'tool' ? (overridden.has(proposed.toolResults[p.id]!) ? 'override' : 'hide-result')
      : 'remove',
  }));
  const untestable: Untestable[] = [];
  const absences: AbsenceCandidate[] = [];
  if (run.layout.status === 'absent') {
    untestable.push({ candidate: 'memory (working memory, observations, recall, recent window)', reason: run.layout.detail, kind: 'memory', layoutReason: run.layout.reason });
    untestable.push({ candidate: 'earlier turns missing from the input', reason: run.layout.detail, kind: 'earlier-turns', layoutReason: run.layout.reason });
  } else if (run.layout.status === 'present') {
    const wm = run.sources.rows?.workingMemory;
    if (wm && !('span' in wm)) untestable.push({ candidate: 'working memory', reason: `its place in the system prompt is not known ('${wm.status}')`, kind: 'working-memory', wmStatus: wm.status });
    const L = run.sources.layout!;
    const present = new Set(run.messages.map(norm));
    const missing: Array<{ turn: number; messages: ModelMessage[] }> = [];
    for (const e of earlier.slice(-ABSENCE_LOOKBACK)) {
      if (!e.run) continue;
      const own = await ownTurnOf(j, e.run);
      const asked = own.filter((m) => m.role === 'user');
      if (asked.length === 0 || asked.some((m) => present.has(norm(m)))) continue;
      missing.push({ turn: e.turn, messages: own });
    }
    if (missing.length) {
      const back = missing.slice(-MAX_RESTORED_TURNS);
      const at = L.recent?.[0] ?? L.incoming?.[0] ?? Math.max(0, run.messages.map((m) => m.role).lastIndexOf('user'));
      const kind = (L.droppedByChain ?? 0) > 0 ? 'trimmed' : 'window';
      absences.push({
        id: `restore:${kind}`, kind, turns: back.map((x) => x.turn), at,
        preview: cut(back.flatMap((x) => x.messages).map((m) => textOf(m.content)).filter(Boolean).join(' · ')),
      });
    } else if ((L.droppedByChain ?? 0) > 0) {
      untestable.push({ candidate: 'rows an input processor removed', reason: `${L.droppedByChain} row(s) were removed, and no earlier turn of this thread within reach holds them`, kind: 'processor-rows', rows: L.droppedByChain! });
    }
  }
  return { suspects, absences, untestable, grouped: proposed.parts.length > MAX_ELIMINATION_PARTS, proposed };
}

// ── threadPlan ──────────────────────────────────────────────────────────────────────────────────────

export interface ThreadPlanOptions {
  /** Where the thread's runs are. Only read. */
  journal: JournalSource;
  threadId: string;
  /** The first turn of the page, 0-based in thread order (default 0). */
  offset?: number;
  /** Turns per page (default and most 50). */
  limit?: number;
  /** What a right answer does: each turn's recorded calls and answer are checked against it. */
  expect?: Expectation;
  /** Plays per arm for the costs; the planned number when omitted. */
  trials?: number;
  /** Plays per subset in elimination (default 2). */
  eliminationTrials?: number;
  targetDifference?: number;
  power?: number;
  /** The share of plays the plan expects to stop at a call nobody answered (planDiagnosis; default EXPECTED_UNDETERMINED). */
  undetermined?: number;
  /** The model a diagnosis would play with, to price it. */
  modelId?: string;
  pricing?: Record<string, ModelPricing>;
  /**
   * The hypotheses the person will bring (named, not written): a corrected working memory, the tools
   * whose recorded result they will replace, the parts they will correct, and whether a model will
   * suggest corrections (one arm per verified part) — each is an arm, so the plan counts it.
   */
  hypotheses?: { workingMemory?: boolean; overrides?: readonly string[]; corrections?: readonly string[]; suggest?: boolean; guess?: boolean };
}

export interface ThreadTurn {
  /** 1-based, in thread order. */
  turn: number;
  runId: string;
  agent?: string;
  status: RunStatus;
  class: TurnClass;
  classReason?: string;
  error?: { name?: string; code?: string; status?: number; message?: string };
  modelSteps: number;
  /** The first model step's input tokens, as the provider counted them. */
  firstStepInputTokens?: number;
  layout: LabLayout;
  composition?: TurnComposition;
  /** With `expect`: whether the turn's own calls and answer did what it asks. */
  expected?: { pass: boolean; failures: string[] };
  /** The turn can be diagnosed; `whyNot` says why when it cannot. */
  diagnosable: boolean;
  whyNot?: string;
  /** For a diagnosable turn: its candidates and what diagnosing it would take. */
  experiments?: TurnCandidates & { tokensPerPlay: number; plan: DiagnosisPlan };
}

export interface ThreadPlanResult {
  threadId: string;
  /** Turns in the thread (sub-agent runs are not turns). */
  total: number;
  offset: number;
  turns: ThreadTurn[];
  /** The offset of the next page; absent on the last. */
  nextOffset?: number;
}

/** Most turns one page of a thread plan reads. */
export const MAX_THREAD_PAGE = 50;

async function threadRuns(j: JournalReader, threadId: string): Promise<RunSummary[]> {
  if (typeof j.listRunsPaged !== 'function') return (await j.listRuns()).filter((r) => r.threadId === threadId && !r.parentRunId);
  const out: RunSummary[] = [];
  let cursor: string | undefined;
  do {
    const page = await j.listRunsPaged({ threadId, topLevel: true, order: 'asc', limit: 200, ...(cursor ? { cursor } : {}) });
    out.push(...page.items);
    cursor = page.items.length ? page.nextCursor : undefined;
  } while (cursor);
  return out;
}

/** The plays and arms a turn's diagnosis takes (the plan the person sees before spending). */
function planOf(c: TurnCandidates, opts: { trials?: number; eliminationTrials?: number; targetDifference?: number; power?: number; undetermined?: number; topK?: number; workingMemory?: string; overrides?: readonly ToolAnswer[]; corrections?: Readonly<Record<string, string>>; suggest?: unknown; guess?: unknown }, tokens: { input: number; output: number }, price: ModelPricing | undefined): DiagnosisPlan {
  const players = c.grouped ? 4 : c.suspects.length;
  const topK = Math.min(opts.topK ?? 3, c.suspects.length);
  // Each correction is an arm; suggestions are at most one per verified part.
  const corrected = Object.keys(opts.corrections ?? {}).filter((id) => c.suspects.some((s) => s.id === id)).length;
  const hypotheses = hypothesesOf(c, opts).length + corrected + (opts.suggest && !c.grouped ? topK : 0);
  return planDiagnosis({
    arms: topK + c.absences.length + hypotheses,
    eliminationPlays: players ? explainRunSize(players, opts.eliminationTrials ?? 2) : 0,
    tokensPerPlay: tokens.input + tokens.output,
    ...(opts.guess ? { guessArms: Math.min(MAX_GUESSES, c.suspects.length + c.absences.length) } : {}),
    ...(opts.trials !== undefined ? { trials: opts.trials } : {}),
    ...(opts.targetDifference !== undefined ? { targetDifference: opts.targetDifference } : {}),
    ...(opts.power !== undefined ? { power: opts.power } : {}),
    ...(opts.undetermined !== undefined ? { undetermined: opts.undetermined } : {}),
    ...(price ? { price: { inputPer1M: price.inputPer1M, outputPer1M: price.outputPer1M, inputTokens: tokens.input, outputTokens: tokens.output } } : {}),
  });
}

/** The person's own hypotheses, always tried: a corrected working memory, and each tool whose result they replaced. */
function hypothesesOf(c: TurnCandidates, opts: { workingMemory?: string; overrides?: readonly ToolAnswer[] }): Array<{ id: string; intervention: Intervention; tool?: string }> {
  const out: Array<{ id: string; intervention: Intervention; tool?: string }> = [];
  if (opts.workingMemory !== undefined && c.suspects.some((s) => s.kind === 'wm')) out.push({ id: 'working memory', intervention: 'wm-replace' });
  for (const t of new Set((opts.overrides ?? []).map((o) => o.toolName))) out.push({ id: `${t} result`, intervention: 'override', tool: t });
  return out;
}

/**
 * A thread's turns, in order, a page at a time: how each ended, where its input came from, and — for
 * every turn that can be diagnosed — its candidates and what diagnosing it takes. Calls no model.
 */
export async function threadPlan(opts: ThreadPlanOptions): Promise<ThreadPlanResult> {
  refuseUnknownNames('threadPlan', opts, THREAD_PLAN_NAMES);
  const j = readerOf(opts.journal);
  const offset = opts.offset ?? 0;
  const limit = Math.min(opts.limit ?? MAX_THREAD_PAGE, MAX_THREAD_PAGE);
  if (!Number.isInteger(offset) || offset < 0) throw new RangeError('@gnldev/lab: threadPlan: offset must be a whole number ≥ 0');
  if (!Number.isInteger(limit) || limit < 1) throw new RangeError(`@gnldev/lab: threadPlan: limit must be a whole number from 1 to ${MAX_THREAD_PAGE}`);
  const runs = await threadRuns(j, opts.threadId);
  const page = runs.slice(offset, offset + limit);
  const price = opts.modelId ? priceFor(opts.modelId, opts.pricing) : undefined;
  // Named hypotheses, as the arms they will be (their text is the diagnosis request's, not the plan's).
  const hyp = {
    ...(opts.hypotheses?.workingMemory ? { workingMemory: '' } : {}),
    ...(opts.hypotheses?.overrides?.length ? { overrides: opts.hypotheses.overrides.map((toolName) => ({ toolName, args: undefined, output: undefined })) } : {}),
    ...(opts.hypotheses?.corrections?.length ? { corrections: Object.fromEntries(opts.hypotheses.corrections.map((id) => [id, ''])) } : {}),
    ...(opts.hypotheses?.suggest ? { suggest: true } : {}),
    ...(opts.hypotheses?.guess ? { guess: true } : {}),
  };
  // The earlier turns an absence is looked for in reach back before the page.
  const loaded = new Map<string, Promise<Loaded | undefined>>();
  const load = (id: string) => { let p = loaded.get(id); if (!p) { p = loadRun(j, id); loaded.set(id, p); } return p; };
  const turns: ThreadTurn[] = [];
  for (let k = 0; k < page.length; k++) {
    const summary = page[k]!, index = offset + k;
    const outcome = await j.get<RunOutcomeRecord>(runKeys.outcome(summary.runId));
    const cls = classifyTurn(summary, outcome);
    const run = await load(summary.runId);
    const entries = await j.readRun(summary.runId);
    const first = entries.find((e) => e.kind === 'model');
    const firstUsage = first ? usageAndCostFromModelValue(first.value) : undefined;
    const turn: ThreadTurn = {
      turn: index + 1, runId: summary.runId, ...(summary.agent ? { agent: summary.agent } : {}), status: summary.status,
      class: cls.class, ...(cls.reason ? { classReason: cls.reason } : {}),
      ...(summary.status === 'failed' && outcome ? { error: {
        ...(outcome.errorName ? { name: outcome.errorName } : {}), ...(outcome.errorCode ? { code: outcome.errorCode } : {}),
        ...(outcome.errorStatus !== undefined ? { status: outcome.errorStatus } : {}), ...(outcome.error ? { message: cut(outcome.error) } : {}),
      } } : {}),
      modelSteps: summary.modelSteps,
      ...(firstUsage ? { firstStepInputTokens: firstUsage.inputTokens } : {}),
      layout: run?.layout ?? { status: 'absent', reason: 'no-record', detail: 'the run has no recorded input' },
      diagnosable: false,
    };
    if (run) turn.composition = compositionOf(run.input, run.layout, run.sources);
    if (opts.expect && run && cls.class !== 'infrastructure' && cls.class !== 'running') {
      const trace = await recordedTrace(j, summary.runId);
      const last = entries.filter((e) => e.kind === 'model').at(-1);
      const failures = checkExpectation(opts.expect, trace, last ? textOf(settleModelContent(last.value)) : '');
      turn.expected = { pass: failures.length === 0, failures };
    }
    if (!run) turn.whyNot = 'the run has no recorded input';
    else if (cls.class === 'infrastructure') turn.whyNot = `nothing in it says how the agent behaves: ${cls.reason}`;
    else if (cls.class === 'running') turn.whyNot = 'it is still running';
    else if (summary.modelSteps === 0) turn.whyNot = 'it has no model step to play again';
    else {
      const earlier = await Promise.all(runs.slice(Math.max(0, index - ABSENCE_LOOKBACK), index).map(async (r, i) => ({ turn: Math.max(0, index - ABSENCE_LOOKBACK) + i + 1, run: await load(r.runId) })));
      const usage = await usageOfRun(j, summary.runId);
      const { proposed: _p, ...cands } = await candidatesOf(j, run, usage.calls, earlier, hyp);
      turn.diagnosable = true;
      turn.experiments = { ...cands, tokensPerPlay: usage.inputTokens + usage.outputTokens, plan: planOf(cands, { ...opts, ...hyp }, { input: usage.inputTokens, output: usage.outputTokens }, price) };
    }
    turns.push(turn);
  }
  return { threadId: opts.threadId, total: runs.length, offset, turns, ...(offset + page.length < runs.length ? { nextOffset: offset + page.length } : {}) };
}

// ── diagnoseTurn ────────────────────────────────────────────────────────────────────────────────────

export interface DiagnoseTurnOptions {
  /** Where the run is. Only read. */
  journal: JournalSource;
  runId: string;
  /** The model the turn is played again with. */
  model: LanguageModel;
  /** The agent's tool definitions; `execute` never runs. */
  tools?: ToolSet;
  /** What a right answer does — required: without it there is nothing to diagnose against. */
  expect: Expectation;
  /** Plays per arm in verification (default: the planned number for `targetDifference`). */
  trials?: number;
  /** Plays per subset in elimination (default 2). */
  eliminationTrials?: number;
  /** How many of the most blamed parts are verified (default 3). */
  topK?: number;
  /** A corrected working memory to try in place of the recorded one; without it the arm leaves it out. */
  workingMemory?: string;
  /** Tool results the person thinks were wrong, each put in place of the recorded one — an arm per tool. */
  overrides?: readonly ToolAnswer[];
  /** Results for calls the recording never made (the right call the turn should have made, for one). */
  answers?: readonly ToolAnswer[];
  /**
   * What a part should have said, by part id: a system section's text, a message part's text (its first
   * message's content; the rest of the part is left out), the working memory, or a tool result (JSON,
   * else the text) put in place of each of that tool's recorded results. Each is an arm, always played.
   */
  corrections?: Readonly<Record<string, string>>;
  /**
   * A model that proposes the corrected text of the most blamed parts after elimination; each proposal
   * is played as an arm marked suggested (a part the person corrected is not proposed). Its tokens are
   * in the totals. See the header for why only blamed parts.
   */
  suggest?: LanguageModel;
  /**
   * A model that first names the one or two parts most likely to blame and what each should have said;
   * only those are played, and a guess the plays bear out is the verdict (elimination is not run). See
   * the header. Its tokens are in the totals.
   */
  guess?: LanguageModel;
  targetDifference?: number;
  power?: number;
  /** The share of plays the plan expects to stop at a call nobody answered (planDiagnosis; default EXPECTED_UNDETERMINED). */
  undetermined?: number;
  concurrency?: number;
  maxSteps?: number;
  timeoutMs?: number;
  pricing?: Record<string, ModelPricing>;
  /** Called after every play, over both stages: `done` of the most the diagnosis plays. */
  onProgress?: (progress: TrialsProgress) => void;
  signal?: AbortSignal;
  throttle?: { waitMs?: number; maxWaits?: number };
}

/** One way the plays of an arm went: the calls, how often, how many of those plays were right. */
export interface ArmPath { calls: TracedCall[]; count: number; passed: number }

export interface ArmResult {
  /** 'baseline' for the unchanged turn. */
  id: string;
  intervention: Intervention | 'baseline' | 'joint';
  /** What was changed, in words. */
  label: string;
  /** The suspects or candidates it changes (the joint arm: two). */
  targets: string[];
  /** Plays judged right. */
  passed: number;
  /** Plays judged (right or wrong). */
  judged: number;
  /** Plays that stopped where they could not be judged (judgePlay). */
  undetermined: number;
  /** Plays that could not run — in no denominator. */
  failed: number;
  /** Rate of right answers among the judged plays, 95% Wilson — the OBSERVED rate, blind to what stopped. */
  rate: Interval;
  /**
   * The rate's two bounds over every play that ran (95% Wilson each): `low` counts an undetermined play
   * as wrong, `high` as right. The truth lies between them; the observed rate does not have to (a change
   * that turns wrong answers into calls nobody answered lifts it with no right answer more).
   */
  bounds: { low: Interval; high: Interval };
  /**
   * The difference the verdict reads, taken at its WORST for the arm: this arm with every undetermined
   * play wrong, minus the unchanged turn with every undetermined play right (Newcombe, Bonferroni z).
   * Absent on the baseline, and on an arm too undetermined to be tested (`untested`).
   */
  difference?: Interval;
  /** The same difference over the judged plays only — shown beside the worst case, never decided on. */
  observedDifference?: Interval;
  /** Calls the plays stopped at that no recording, answer or override covered — answer them to test further. */
  pending: Array<{ toolName: string; args: unknown }>;
  /** Its plays' undetermined share is past MAX_UNDETERMINED_SHARE even at its 95% lower bound: the arm decides nothing. */
  untested?: { share: number };
  paths: ArmPath[];
}

export type Verdict =
  /** Unchanged, the turn is mostly right: the recorded failure was a draw of chance — no cause is named. */
  | { kind: 'chance'; sentence: string; baseline: Interval }
  /** One change made right answers more frequent, beyond the level; the largest is the cause. */
  | { kind: 'cause'; sentence: string; arm: string; also: string[] }
  /** The two leading changes both helped, and by amounts the plays cannot tell apart. */
  | { kind: 'indistinct'; sentence: string; arms: [string, string]; also: string[] }
  /** No single change helped; the two leading candidates together did. */
  | { kind: 'joint'; sentence: string; arms: [string, string] }
  /**
   * Changes were tested and none helped: the cause is not among the candidates tried. `uncorrected`: parts
   * elimination blamed that were only left out, never corrected — leaving out a wrong fact does not put
   * the right one in, so their content may still be the cause.
   */
  | { kind: 'not-found'; sentence: string; uncorrected?: string[] }
  /**
   * No change was tested: elimination did not finish and nothing else was played, or every change played
   * stopped too often at calls nobody answered. Nothing is said about the cause — "not found" would
   * claim changes were tried and failed.
   */
  | { kind: 'untested'; sentence: string; untested: string[] }
  /** The unchanged turn could not be judged at all (every play stopped or failed). */
  | { kind: 'undecided'; sentence: string };

/** Unchanged, a turn whose rate's 95% lower bound reaches this is "mostly right": its failure was chance. */
export const CHANCE_AT = 0.66;

/**
 * Past this share of undetermined plays (its 95% lower bound, see `testable`) an arm (or the unchanged turn) is not tested. Why 0.2: the two
 * bounds of an arm's rate lie that share apart, and the planned difference is 0.4 — with half of it
 * unknown on one side alone, the worst-case comparison can no longer reach the planned power, and a
 * verdict would rest on how the unanswered calls would have gone. The person is told which calls to answer.
 */
export const MAX_UNDETERMINED_SHARE = 0.2;

/** Plays that ran and were judged or stopped — the denominator of both bounds. */
const ran = (a: Pick<ArmResult, 'judged' | 'undetermined'>) => a.judged + a.undetermined;
const asWrong = (a: Pick<ArmResult, 'passed' | 'judged' | 'undetermined'>) => ({ successes: a.passed, n: ran(a) });
const asRight = (a: Pick<ArmResult, 'passed' | 'judged' | 'undetermined'>) => ({ successes: a.passed + a.undetermined, n: ran(a) });
/** The share of an arm's plays that could not be judged (0 when none ran). */
export function undeterminedShare(a: Pick<ArmResult, 'judged' | 'undetermined'>): number {
  return ran(a) ? a.undetermined / ran(a) : 0;
}
// Not tested only when the share is PROVEN past the limit (its 95% Wilson lower bound): a sample share
// over it at a true share under it is a draw (measured: at a true 10%, the unchanged turn was refused in
// 12.5% of diagnoses on its sample share). It decides only whether an arm is tested; the verdict's
// worst-case comparison already charges every undetermined play against the change.
const testable = (a: Pick<ArmResult, 'judged' | 'undetermined'>) => ran(a) > 0 && wilson(a.undetermined, ran(a)).low <= MAX_UNDETERMINED_SHARE;
/** An arm's difference from the unchanged turn at its worst (see ArmResult.difference). */
export function worstDifference(arm: Pick<ArmResult, 'passed' | 'judged' | 'undetermined'>, baseline: Pick<ArmResult, 'passed' | 'judged' | 'undetermined'>, z: number): Interval {
  return newcombe(asWrong(arm), asRight(baseline), z);
}

/**
 * The verdict, by the rules written before any play — in this order:
 * 1. the unchanged turn's rate of right answers has a 95% lower bound ≥ CHANCE_AT: chance, no cause;
 * 2. arms whose difference from the unchanged turn has its lower bound above 0 at the Bonferroni level
 *    (`z`): the largest is the cause and the rest are "also" — unless the two largest cannot be told
 *    apart (the interval of their own difference holds 0), then neither is named over the other. Arms of
 *    the same part (left out, and corrected) count once, by the larger;
 * 3. none: the joint arm, if it was played and passes the same test;
 * 4. none, and nothing was tested — every arm played too undetermined, or no arm played and elimination
 *    (`screened`: leaving each part out, beside the rest) did not finish: untested, nothing is said;
 * 5. none: the cause is not among the candidates.
 * @internal — its argument is the arms' counts, not an options bag.
 */
export function verdictOf(baseline: ArmResult, arms: readonly ArmResult[], joint: ArmResult | undefined, z: number, screened = true): Verdict {
  if (ran(baseline) === 0) return { kind: 'undecided', sentence: 'The unchanged turn could not be judged: every play of it failed.' };
  if (!testable(baseline)) {
    return { kind: 'undecided', sentence: `The unchanged turn could not be tested: ${baseline.undetermined} of ${ran(baseline)} plays stopped at a call the recording never made — write those calls' answers and diagnose again.` };
  }
  // "Mostly right" at its worst: every undetermined play of the unchanged turn counted wrong.
  const base95 = wilson(asWrong(baseline).successes, ran(baseline));
  if (base95.low >= CHANCE_AT) {
    return { kind: 'chance', baseline: base95, sentence: `Unchanged, the turn did the right thing in ${baseline.passed} of ${ran(baseline)} plays: the recorded failure is not representative — it was chance, and no cause is named.` };
  }
  // Every comparison at its worst for the change: the arm's undetermined plays wrong, the unchanged turn's right.
  const diff = (a: ArmResult) => worstDifference(a, baseline, z);
  const helped = (a: ArmResult) => testable(a) && diff(a).low > 0;
  // Two arms that change the same part (left out, and corrected) are one candidate: the best of them stands for it.
  const partOf = (a: ArmResult) => a.targets.join('+');
  const sig = arms.filter(helped).sort((a, b) => diff(b).value - diff(a).value).filter((a, i, all) => all.findIndex((x) => partOf(x) === partOf(a)) === i);
  const k = (a: ArmResult) => `${a.passed}/${ran(a)}`;
  if (sig.length >= 2) {
    const [a, b] = sig as [ArmResult, ArmResult];
    const apart = newcombe(asWrong(a), asRight(b), z);
    if (!(apart.low > 0)) {
      return { kind: 'indistinct', arms: [a.id, b.id], also: sig.slice(2).map((x) => x.id), sentence: `Both "${a.label}" and "${b.label}" made the right answer more frequent, and the plays cannot tell the two apart.` };
    }
  }
  if (sig.length >= 1) {
    const top = sig[0]!;
    const also = sig.slice(1).map((x) => x.id);
    return { kind: 'cause', arm: top.id, also, sentence: `Cause: ${top.label} — the right answer went from ${k(baseline)} unchanged to ${k(top)}.${also.length ? ` Also helped: ${sig.slice(1).map((x) => x.label).join('; ')}.` : ''}` };
  }
  if (joint && helped(joint)) {
    return { kind: 'joint', arms: [joint.targets[0]!, joint.targets[1]!], sentence: `No single change helped; ${joint.label} together did — the right answer went from ${k(baseline)} to ${k(joint)}.` };
  }
  const untested = arms.filter((a) => !testable(a));
  if (arms.length > 0 && untested.length === arms.length) {
    return { kind: 'untested', untested: untested.map((a) => a.id), sentence: `No change could be tested — most plays of each stopped at a call the recording never made (${untested.map((a) => a.label).join('; ')}): write those calls' answers and diagnose again. Nothing is said about the cause.` };
  }
  if (arms.length === 0 && !screened) {
    return { kind: 'untested', untested: [], sentence: 'No change was tested: elimination could not finish, and there was no absence or hypothesis to play. Nothing is said about the cause.' };
  }
  return { kind: 'not-found', sentence: `No change tried made the right answer more frequent: the cause is not among the candidates.${untested.length ? ` Not tested (most plays stopped at a call the recording never made): ${untested.map((a) => a.label).join('; ')}.` : ''}` };
}

export interface DiagnoseTurnResult {
  runId: string;
  /** The thread the turn is of, and its place in it (1-based) — absent for a run of no thread. */
  threadId?: string;
  turn?: number;
  expect: Expectation;
  layout: LabLayout;
  composition: TurnComposition;
  elimination: {
    grouped: boolean;
    /** The players: the turn's parts, or the four groups. */
    parts: LabPart[];
    /** Most blamed first. `blame` = −share: how far the part's presence pulls a play from the right answer. */
    shares: Array<{ part: string; share: number; blame: number; noise: number }>;
    plays: number;
    failed: number;
    undetermined: number;
    /** Elimination could not finish (every play of a subset could not be judged); verification ran on the absences and hypotheses only. */
    error?: string;
    /** Not run: the guess was borne out (or the turn unchanged was mostly right, or could not be judged). */
    skipped?: true;
  };
  /** The unchanged turn first, then every arm. */
  arms: ArmResult[];
  /** The two leading candidates together — played only when no single arm helped. */
  joint?: ArmResult;
  /** Comparisons the 5% level is shared by (arms + the joint arm). */
  comparisons: number;
  /** The interval width every difference is taken at: the Bonferroni z. */
  z: number;
  verdict: Verdict;
  /**
   * With `guess`: the parts the model named first and what it said each should have said, the plays of
   * them beside the turn unchanged (at their own level, `z`), and whether they bore it out. Borne out,
   * its arms and verdict are the result's; not, the verdict is the stages' after it.
   */
  guess?: { parts: Array<{ part: string; correction?: string }>; verified: boolean; z: number; arms: ArmResult[]; verdict: Verdict };
  /** With `suggest`: the corrections the model proposed and that were played (each is an arm `correct:<part>`). */
  suggestions?: Array<{ part: string; text: string }>;
  untestable: Untestable[];
  plan: DiagnosisPlan;
  plays: number;
  failed: number;
  inputTokens: number;
  outputTokens: number;
  costUsd: number;
  priced: boolean;
  /** What could not be done exactly as asked, in words. */
  notes: string[];
}

/** What a capsule arm changes; two of them are merged into the joint arm. */
interface Change {
  dropInput: number[];
  insertInput: Array<{ at: number; message: ModelMessage }>;
  hideToolResults: string[];
  /** System sections of the caller's prompt left out (their text). */
  dropSections: string[];
  /** The working memory replaced, or left out. */
  wm?: { text: string } | 'remove';
  overrides: ToolAnswer[];
  /** Input messages put in place of others, by position. */
  replaceInput: Record<number, ModelMessage>;
  /** System sections given other text (their recorded text → the new). */
  replaceSections: Record<string, string>;
}
const none = (): Change => ({ dropInput: [], insertInput: [], hideToolResults: [], dropSections: [], overrides: [], replaceInput: {}, replaceSections: {} });
const merge = (a: Change, b: Change): Change => ({
  // A position replaced by one side is not also dropped by the other: the correction wins.
  dropInput: [...new Set([...a.dropInput, ...b.dropInput])].filter((i) => !(i in a.replaceInput) && !(i in b.replaceInput)),
  replaceInput: { ...a.replaceInput, ...b.replaceInput },
  replaceSections: { ...a.replaceSections, ...b.replaceSections },
  insertInput: [...a.insertInput, ...b.insertInput],
  hideToolResults: [...new Set([...a.hideToolResults, ...b.hideToolResults])],
  dropSections: [...new Set([...a.dropSections, ...b.dropSections])],
  ...(a.wm !== undefined || b.wm !== undefined ? { wm: a.wm ?? b.wm! } : {}),
  overrides: [...a.overrides, ...b.overrides],
});

const GROUPS = ['system', 'memory', 'history', 'tool results'] as const;

// ── Suggested corrections ───────────────────────────────────────────────────────────────────────────

const SUGGEST_SYSTEM = [
  'An AI agent answered a turn of a conversation wrongly. Some parts of what it was given may have said something wrong or misleading:',
  'an outdated fact in its memory, a tool result that was wrong, an earlier message that misled it, a rule that said the wrong thing.',
  'For each part listed that you think is wrong, write what it should have said: the same part, in the same form and language, changed as little as',
  'possible — correct the wrong fact, do not add instructions, do not tell the agent what to do. Leave out a part that is not wrong.',
  'Reply with JSON only: {"corrections":[{"part":"<the part id>","text":"<what the part should have said>"}]}',
].join(' ');

/** What the suggesting model is shown: what a right answer does, the turn's last message, and the blamed parts as the model saw them. */
function suggestPrompt(expect: Expectation, run: Loaded, parts: ReadonlyArray<{ id: string; text: string }>): string {
  const last = [...run.messages].reverse().find((m) => m.role === 'user');
  return [
    `What a right answer does: ${JSON.stringify(expect)}`,
    `The turn's last message: ${last ? textOf(last.content) : String(run.input.prompt ?? '')}`,
    'The parts:',
    ...parts.map((p) => `[${p.id}]\n${p.text}`),
  ].join('\n\n');
}

/** The proposals in a model's reply — its first JSON object, read leniently; nothing usable reads as none. */
/** @internal */
export function parseSuggestions(text: string): Array<{ part: string; text: string }> {
  const start = text.indexOf('{'), end = text.lastIndexOf('}');
  if (start < 0 || end <= start) return [];
  try {
    const j = JSON.parse(text.slice(start, end + 1)) as { corrections?: unknown };
    return Array.isArray(j.corrections)
      ? j.corrections.filter((x): x is { part: string; text: string } => !!x && typeof (x as any).part === 'string' && typeof (x as any).text === 'string').map((x) => ({ part: x.part, text: x.text }))
      : [];
  } catch { return []; }
}

// ── The guess ───────────────────────────────────────────────────────────────────────────────────────

/** At most this many parts are guessed — each an arm played before anything else. */
export const MAX_GUESSES = 2;

const GUESS_SYSTEM = [
  'An AI agent answered the last turn of a conversation wrongly. You are shown what a right answer does, what the agent did,',
  'and the parts of what it was given, each with an id. Name the part or parts most likely to have caused the wrong behaviour —',
  'at most two, most likely first. For a part that said something wrong (an outdated fact, a misleading message, a tool result that',
  'was wrong, a rule that said the wrong thing), also write what it should have said: the same part, in the same form and language,',
  'changed as little as possible — for a tool result, the JSON the tool should have returned. A correction is used only for the working',
  'memory and tool results; leave it out for a rule, a message, or a turn missing from the input.',
  'Reply with JSON only: {"guesses":[{"part":"<the part id>","correction":"<what it should have said>"}]}',
].join(' ');

/** What the guessing model is shown: what a right answer does, the turn's last message, what the agent did, and every part. */
/** @internal */
export function guessPrompt(expect: Expectation, run: Loaded, calls: ReadonlyArray<{ toolName: string; args: unknown; output: unknown }>, parts: ReadonlyArray<{ id: string; kind: string; text: string }>): string {
  const convo = run.messages.map((m) => `${m.role.toUpperCase()}: ${typeof m.content === 'string' ? m.content : JSON.stringify(m.content)}`).join('\n');
  return [
    `SYSTEM PROMPT THE AGENT WAS GIVEN:\n${typeof run.input.system === 'string' ? run.input.system : ''}`,
    `CONVERSATION IT WAS GIVEN (oldest first; the last USER message is the turn that went wrong):\n${convo || String(run.input.prompt ?? '')}`,
    `WHAT A RIGHT ANSWER DOES: ${JSON.stringify(expect)}`,
    `WHAT IT DID: ${calls.length ? calls.map((x) => `${x.toolName}(${JSON.stringify(x.args)})`).join(', ') : 'no tool call'}`,
    'THE PARTS (use these ids exactly):',
    ...parts.map((p) => `[${p.id}] (${p.kind})\n${p.text}`),
  ].join('\n\n');
}

/** The guesses in a model's reply — its first JSON object, read leniently; nothing usable reads as none. */
/** @internal */
export function parseGuesses(text: string): Array<{ part: string; correction?: string }> {
  const start = text.indexOf('{'), end = text.lastIndexOf('}');
  if (start < 0 || end <= start) return [];
  try {
    const j = JSON.parse(text.slice(start, end + 1)) as { guesses?: unknown };
    if (!Array.isArray(j.guesses)) return [];
    const out: Array<{ part: string; correction?: string }> = [];
    for (const x of j.guesses as Array<Record<string, unknown>>) {
      if (!x || typeof x.part !== 'string' || out.some((o) => o.part === x.part)) continue;
      const c = typeof x.correction === 'string' ? x.correction : x.correction !== undefined && x.correction !== null ? JSON.stringify(x.correction) : undefined;
      out.push({ part: x.part, ...(c !== undefined ? { correction: c } : {}) });
    }
    return out;
  } catch { return []; }
}

/**
 * Diagnoses one turn against what a right answer does (see the header). Refused before any play when
 * there is no `expect`, when the run has no recorded input, or when its turn ended before the model
 * could be asked.
 */
export async function diagnoseTurn(opts: DiagnoseTurnOptions): Promise<DiagnoseTurnResult> {
  refuseUnknownNames('diagnoseTurn', opts, DIAGNOSE_TURN_NAMES);
  const expect = opts.expect as Expectation | undefined;
  if (!expect || !((expect.calls?.length ?? 0) + (expect.forbidden?.length ?? 0) + (expect.answerIncludes?.length ?? 0))) {
    throw new RangeError('@gnldev/lab: diagnoseTurn needs `expect` — what a right answer does; without it a play can be neither right nor wrong');
  }
  const j = readerOf(opts.journal);
  const run = await loadRun(j, opts.runId);
  if (!run) throw new RangeError(`@gnldev/lab: run '${opts.runId}' has no recorded input`);
  const summaries = typeof run.input.threadId === 'string' ? await threadRuns(j, run.input.threadId) : [];
  const at = summaries.findIndex((r) => r.runId === opts.runId);
  const summary = summaries[at];
  if (summary) {
    const cls = classifyTurn(summary, await j.get<RunOutcomeRecord>(runKeys.outcome(opts.runId)));
    if (cls.class === 'infrastructure') throw new RangeError(`@gnldev/lab: run '${opts.runId}' ended before the model could be asked (${cls.reason}) — nothing in it says how the agent behaves`);
  }
  const earlier = await Promise.all(summaries.slice(Math.max(0, at - ABSENCE_LOOKBACK), Math.max(0, at)).map(async (r, i) => ({ turn: Math.max(0, at - ABSENCE_LOOKBACK) + i + 1, run: await loadRun(j, r.runId) })));
  const usage = await usageOfRun(j, opts.runId);
  const c = await candidatesOf(j, run, usage.calls, earlier, opts);
  const pricing = opts.pricing;
  const modelId = typeof opts.model === 'string' ? opts.model : (opts.model as { modelId?: string }).modelId;
  const price = modelId && pricing ? priceFor(modelId, pricing) : undefined;
  const t0 = opts.eliminationTrials ?? 2;
  const topK = opts.topK ?? 3;
  const plan = planOf(c, { ...opts, topK }, { input: usage.inputTokens, output: usage.outputTokens }, price);
  const n = plan.trials;
  const notes: string[] = [];

  // Progress over both stages: `done` of the most the diagnosis plays.
  let doneBefore = 0, failedBefore = 0;
  const progress = (p: TrialsProgress) => opts.onProgress?.({ ...p, done: doneBefore + p.done, failed: failedBefore + p.failed, total: plan.totalPlays });
  const control = {
    ...(opts.concurrency !== undefined ? { concurrency: opts.concurrency } : {}),
    ...(opts.onProgress ? { onProgress: progress } : {}),
    ...(opts.signal ? { signal: opts.signal } : {}),
    ...(opts.throttle ? { throttle: opts.throttle } : {}),
  };
  const playOpts = {
    ...(opts.tools ? { tools: opts.tools } : {}),
    ...(opts.maxSteps !== undefined ? { maxSteps: opts.maxSteps } : {}),
    ...(opts.timeoutMs !== undefined ? { timeoutMs: opts.timeoutMs } : {}),
    ...(pricing ? { pricing } : {}),
  };
  let inputTokens = 0, outputTokens = 0, costUsd = 0, priced = true, plays = 0, failed = 0;

  const P = c.proposed;
  const sys = capsuleSystemOf(typeof run.input.system === 'string' ? run.input.system : '', run.sources.layout ? run.sources.rows : undefined);
  const wmText = sys.workingMemory && 'text' in sys.workingMemory ? sys.workingMemory.text : undefined;
  const ownSections = sys.own.split(/\n\s*\n/).map((s) => s.trim()).filter(Boolean);
  const groupOf = (p: LabPart): (typeof GROUPS)[number] => p.kind === 'system' ? 'system' : p.kind === 'wm' || p.kind === 'om' || p.kind === 'recall' || p.kind === 'recent' ? 'memory' : p.kind === 'tool' ? 'tool results' : 'history';
  type Arm = { id: string; intervention: Intervention; label: string; targets: string[]; change: Change };
  // What each part said, as the model saw it — what a correction replaces, and what a suggestion is asked about.
  const outputs = await recordedResults(j, opts.runId).catch(() => [] as Array<{ toolName: string; args: unknown; output: unknown }>);
  const textOfPart = (id: string): string | undefined => {
    const sp = c.suspects.find((x) => x.id === id);
    if (!sp) return undefined;
    if (sp.kind === 'wm') return wmText;
    if (P.systemSections[id] !== undefined) return P.systemSections[id];
    if (P.toolResults[id]) return JSON.stringify(outputs.filter((r) => r.toolName === P.toolResults[id]).map((r) => r.output));
    if (P.messages[id]) return P.messages[id]!.map((i) => `${run.messages[i]!.role}: ${textOf(run.messages[i]!.content)}`).join('\n');
    return undefined;
  };
  // A message part is corrected by its first message's text; one holding a tool call or result cannot be
  // (a provider refuses a call without its result), and is said so.
  const textOnly = (id: string) => (P.messages[id] ?? []).every((i) => { const m = run.messages[i]!; return (m.role === 'user' || m.role === 'assistant') && (typeof m.content === 'string' || (Array.isArray(m.content) && (m.content as any[]).every((x) => x?.type === 'text'))); });
  const corrections = new Map<string, { text: string; by: 'person' | 'suggested' | 'guessed' }>();
  for (const [id, text] of Object.entries(opts.corrections ?? {})) {
    if (!c.suspects.some((x) => x.id === id)) { notes.push(`a correction of '${id}' was given, but the turn has no such part — it was not tried`); continue; }
    if (P.messages[id] && !textOnly(id)) { notes.push(`'${id}' holds a tool call or its result and cannot be corrected as text — it was not tried`); continue; }
    if (c.suspects.find((x) => x.id === id)!.kind === 'wm' && !wmText) { notes.push('the working memory has no known place in the system prompt — its correction was not tried'); continue; }
    corrections.set(id, { text, by: 'person' });
  }
  /** The change a correction makes, by the kind of part it corrects. */
  const correctionOf = (id: string, text: string): Change => {
    const ch = none();
    const sp = c.suspects.find((x) => x.id === id)!;
    if (sp.kind === 'wm') ch.wm = { text };
    else if (P.systemSections[id] !== undefined) ch.replaceSections = { [P.systemSections[id]!]: text };
    else if (P.toolResults[id]) {
      let output: unknown = text;
      try { output = JSON.parse(text); } catch { /* the person wrote text, and text is what the tool returns */ }
      const own = outputs.filter((r) => r.toolName === P.toolResults[id]);
      // A JSON list of as many results as the tool returned: one each, in order; anything else: the same for every call.
      ch.overrides = own.map((r, i) => ({ toolName: r.toolName, args: r.args, output: Array.isArray(output) && output.length === own.length ? output[i] : output }));
    } else if (P.messages[id]) {
      const [first, ...rest] = P.messages[id]!;
      ch.replaceInput = { [first!]: { role: run.messages[first!]!.role, content: text } as ModelMessage };
      ch.dropInput = rest;
    }
    return ch;
  };
  const changeOf = (partId: string, intervention: Intervention, tool?: string): Change => {
    const ch = none();
    if (c.grouped && (GROUPS as readonly string[]).includes(partId)) {
      for (const p of P.parts.filter((x) => groupOf(x) === partId)) {
        const sub = changeOf(p.id, p.kind === 'wm' ? 'wm-remove' : p.kind === 'tool' ? 'hide-result' : 'remove');
        Object.assign(ch, merge(ch, sub));
      }
      return ch;
    }
    if (intervention === 'correct') return correctionOf(partId, corrections.get(partId)!.text);
    if (intervention === 'wm-replace') ch.wm = { text: opts.workingMemory! };
    else if (intervention === 'wm-remove') ch.wm = 'remove';
    else if (intervention === 'override') ch.overrides = (opts.overrides ?? []).filter((o) => o.toolName === (tool ?? P.toolResults[partId]));
    else if (intervention === 'hide-result') ch.hideToolResults = [P.toolResults[partId]!];
    else if (P.systemSections[partId] !== undefined) ch.dropSections = [P.systemSections[partId]!];
    else if (P.messages[partId]) ch.dropInput = [...P.messages[partId]!];
    return ch;
  };
  const labelOf = (partId: string, iv: Intervention) =>
    iv === 'correct' ? `${partId} corrected${corrections.get(partId)?.by === 'suggested' ? ' (suggested)' : corrections.get(partId)?.by === 'guessed' ? ' (guessed)' : ''}`
    : iv === 'wm-replace' ? 'the working memory replaced with the corrected text' : iv === 'wm-remove' ? 'the working memory left out'
    : iv === 'override' ? `${partId.replace(/ result$/, '')}'s recorded result replaced` : iv === 'hide-result' ? `${partId} hidden`
    : `${partId} left out`;
  const systemFor = (ch: Change): string | undefined => {
    const replaced = Object.keys(ch.replaceSections).length > 0;
    if (!ch.dropSections.length && ch.wm === undefined && !replaced) return undefined;
    const own = ch.dropSections.length || replaced ? ownSections.filter((s) => !ch.dropSections.includes(s)).map((s) => ch.replaceSections[s] ?? s).join('\n\n') : sys.own;
    const wm = ch.wm === 'remove' ? '' : ch.wm ? ch.wm.text : (wmText ?? '');
    return [own, wm].filter(Boolean).join('\n\n');
  };
  const playOf = (ch: Change) => () => {
    const replaced = Object.keys(ch.replaceInput).length > 0;
    const masked = ch.dropInput.length || ch.insertInput.length || ch.hideToolResults.length || replaced
      ? maskConversation({ dropInput: ch.dropInput, insertInput: ch.insertInput, hideToolResults: ch.hideToolResults, ...(replaced ? { replaceInput: ch.replaceInput } : {}) }) : undefined;
    const system = systemFor(ch);
    const answers = opts.answers ?? [];
    return replayCounterfactual({
      journal: j, runId: opts.runId, model: opts.model, ...playOpts,
      ...(system !== undefined ? { system } : {}),
      ...(masked ? { prepareStep: masked as never } : {}),
      ...(answers.length ? { answers } : {}),
      ...(ch.overrides.length ? { overrides: ch.overrides } : {}),
    });
  };
  const tally = (id: string, intervention: ArmResult['intervention'], label: string, targets: string[], outcomes: ReadonlyArray<{ ok: true; value: Awaited<ReturnType<ReturnType<typeof playOf>>> } | { ok: false; error: string }>): ArmResult => {
    let passed = 0, judged = 0, undetermined = 0, bad = 0;
    const paths = new Map<string, ArmPath>();
    const pending = new Map<string, { toolName: string; args: unknown }>();
    for (const o of outcomes) {
      if (!o.ok) { bad++; continue; }
      const r = o.value;
      inputTokens += r.candidate.inputTokens; outputTokens += r.candidate.outputTokens; costUsd += r.candidate.costUsd; priced &&= r.candidate.priced;
      const v = judgePlay(expect, r.trace, r.candidate.text);
      if (v.verdict === 'undetermined') undetermined++; else { judged++; if (v.verdict === 'pass') passed++; }
      if (r.divergence) pending.set(`${r.divergence.call.toolName}:${r.divergence.call.argsHash}`, { toolName: r.divergence.call.toolName, args: r.divergence.args });
      const key = r.trace.map((x) => `${x.toolName}:${argsHash(x.args)}:${x.source}`).join('|');
      const p = paths.get(key) ?? { calls: r.trace, count: 0, passed: 0 };
      p.count++; if (v.verdict === 'pass') p.passed++;
      paths.set(key, p);
    }
    plays += outcomes.length; failed += bad;
    const counts = { passed, judged, undetermined };
    return {
      id, intervention, label, targets, passed, judged, undetermined, failed: bad, rate: wilson(passed, judged),
      bounds: { low: wilson(asWrong(counts).successes, ran(counts)), high: wilson(asRight(counts).successes, ran(counts)) },
      pending: [...pending.values()],
      ...(!testable(counts) && ran(counts) > 0 ? { untested: { share: undeterminedShare(counts) } } : {}),
      paths: [...paths.values()].sort((a, b) => b.count - a.count),
    };
  };
  const compare = (a: ArmResult, base: ArmResult, z: number): ArmResult => ({
    ...a,
    ...(a.untested ? {} : { difference: worstDifference(a, base, z) }),
    observedDifference: newcombe({ successes: a.passed, n: a.judged }, { successes: base.passed, n: base.judged }, z),
  });

  /** The arm that puts an absence back. */
  const absenceArm = async (a: AbsenceCandidate): Promise<Arm> => {
    const back: ModelMessage[] = [];
    for (const t of a.turns) { const e = earlier.find((x) => x.turn === t); if (e?.run) back.push(...(await ownTurnOf(j, e.run))); }
    const ch = none();
    ch.insertInput = back.map((message) => ({ at: a.at, message }));
    return { id: a.id, intervention: 'restore', label: `turn${a.turns.length > 1 ? 's' : ''} ${a.turns.join(', ')} put back (${a.kind === 'trimmed' ? 'removed by an input processor' : 'fell out of the recent window'})`, targets: [a.id], change: ch };
  };

  // 0. The guess: a model names the parts most likely to blame and what each should have said; only those
  // are played. Borne out, it is the verdict and elimination is not run; else it is said so, and the rest
  // runs at the other half of the level.
  const alphaShare = opts.guess ? 0.025 : 0.05;
  let guessed: DiagnoseTurnResult['guess'];
  // The unchanged turn as the guess played it: verification reuses it, counted once.
  let guessBaseline: ArmResult | undefined;
  if (opts.guess) {
    const ids = [...c.suspects.map((x) => x.id), ...c.absences.map((a) => a.id)];
    const shown = [
      ...c.suspects.map((x) => ({ id: x.id, kind: x.kind === 'wm' ? 'working memory' : x.kind === 'tool' ? 'tool result' : x.kind === 'system' ? 'system prompt section' : `${x.kind} message`, text: textOfPart(x.id) ?? x.preview })),
      ...c.absences.map((a) => ({ id: a.id, kind: 'turn missing from the input', text: `earlier turn${a.turns.length > 1 ? 's' : ''} ${a.turns.join(', ')}, which the agent did not see: ${a.preview}` })),
    ];
    let picks: Array<{ part: string; correction?: string }> = [];
    try {
      const r = await generateText({ model: opts.guess, system: GUESS_SYSTEM, prompt: guessPrompt(expect, run, outputs, shown) });
      inputTokens += r.usage.inputTokens ?? 0; outputTokens += r.usage.outputTokens ?? 0;
      const gm = typeof opts.guess === 'string' ? opts.guess : (opts.guess as { modelId?: string }).modelId;
      const gp = gm && pricing ? priceFor(gm, pricing) : undefined;
      if (gp) costUsd += ((r.usage.inputTokens ?? 0) / 1e6) * gp.inputPer1M + ((r.usage.outputTokens ?? 0) / 1e6) * gp.outputPer1M; else priced = false;
      const norm = (x: string) => x.toLowerCase().replace(/[\[\]"'`]/g, '').replace(/\s+/g, ' ').trim();
      const byNorm = new Map(ids.map((id) => [norm(id), id]));
      const said = parseGuesses(r.text);
      picks = said.map((x) => ({ ...x, part: byNorm.get(norm(x.part)) ?? x.part })).filter((x) => ids.includes(x.part)).slice(0, MAX_GUESSES);
      if (!picks.length) notes.push(`the guess named no part of this turn (it said: ${cut(r.text.replace(/\s+/g, ' '))})`);
    } catch (err) {
      if (opts.signal?.aborted) throw err;
      notes.push(`no guess could be made: ${err instanceof Error ? err.message : String(err)}`);
    }
    const guessArms: Arm[] = [];
    for (const g of picks) {
      const absence = c.absences.find((a) => a.id === g.part);
      if (absence) { const a = await absenceArm(absence); guessArms.push({ ...a, label: `${a.label} (guessed)` }); continue; }
      const sp = c.suspects.find((x) => x.id === g.part)!;
      // Only data is corrected from a guess — the working memory, a tool result: there the fault is a wrong
      // fact, and the right one is its correction. A rule or a message "corrected" by a guess could carry
      // the right answer itself (measured: a guessed system prompt that changed "Izmir → Aegean" to
      // "Izmir → Central" was borne out), so a guessed rule or message is only left out.
      // Nor the result of a tool the expectation names: what the action being judged returned could tell
      // the model which call to make.
      const judged = new Set([...(expect.calls ?? []).map((x) => x.toolName), ...(expect.forbidden ?? [])]);
      const data = (sp.kind === 'wm' && !!wmText) || (!!P.toolResults[g.part] && !judged.has(P.toolResults[g.part] as string));
      const correctable = data && g.correction !== undefined && g.correction.trim() !== '' && g.correction !== textOfPart(g.part);
      if (correctable && !corrections.has(g.part)) corrections.set(g.part, { text: g.correction!, by: 'guessed' });
      const iv: Intervention = correctable && corrections.get(g.part)!.by === 'guessed' ? 'correct' : sp.intervention;
      guessArms.push({ id: `${iv}:${g.part}`, intervention: iv, label: iv === 'correct' ? labelOf(g.part, iv) : `${labelOf(g.part, iv)} (guessed)`, targets: [g.part], change: changeOf(g.part, iv) });
    }
    if (guessArms.length) {
      const zg = normalQuantile(1 - alphaShare / (2 * (guessArms.length + 1)));
      const gall = [{ change: none() }, ...guessArms];
      const gd = await runTrials(gall.flatMap((a) => Array.from({ length: n }, () => playOf(a.change))), control);
      const gBase = tally('baseline', 'baseline', 'the turn unchanged', [], gd.outcomes.slice(0, n));
      guessBaseline = gBase;
      const gResults = guessArms.map((a, i) => compare(tally(a.id, a.intervention, a.label, a.targets, gd.outcomes.slice((i + 1) * n, (i + 2) * n)), gBase, zg));
      doneBefore += gd.outcomes.length; failedBefore += gd.failed;
      const gv = verdictOf(gBase, gResults, undefined, zg, true);
      const borne = gv.kind === 'cause' || gv.kind === 'indistinct' || gv.kind === 'chance' || gv.kind === 'undecided';
      guessed = { parts: picks, verified: gv.kind === 'cause' || gv.kind === 'indistinct', z: zg, arms: [gBase, ...gResults], verdict: gv };
      if (borne) {
        if (gv.kind === 'cause' || gv.kind === 'indistinct') notes.push('the guess was borne out by the plays; elimination was not run');
        else notes.push(gv.kind === 'chance' ? 'the turn unchanged was mostly right: its failure was chance, and elimination was not run' : 'the turn unchanged could not be judged; elimination was not run');
        const skipped: DiagnoseTurnResult['elimination'] = { grouped: c.grouped, parts: [], shares: [], plays: 0, failed: 0, undetermined: 0, skipped: true };
        for (const a of [gBase, ...gResults]) {
          if (a.untested || (a === gBase && !testable(gBase))) notes.push(`${a.label}: not tested — ${a.undetermined} of ${ran(a)} plays stopped at a call the recording never made${a.pending.length ? ` (${a.pending.map((x) => `${x.toolName}(${JSON.stringify(x.args)})`).join(', ')})` : ''}; write their answers (answers) and diagnose again`);
        }
        return {
          runId: opts.runId, ...(summary ? { threadId: run.input.threadId as string, turn: at + 1 } : {}), expect, layout: run.layout, composition: compositionOf(run.input, run.layout, run.sources),
          elimination: skipped, arms: [gBase, ...gResults], comparisons: guessArms.length + 1, z: zg, verdict: gv, guess: guessed,
          untestable: c.untestable, plan, plays, failed, inputTokens, outputTokens, costUsd, priced, notes,
        };
      }
      notes.push(`the guess (${picks.map((x) => x.part).join(', ')}) was not borne out by the plays; elimination and verification ran`);
      // A correction guessed and not borne out is not played again as if it were the person's.
      for (const g of picks) if (corrections.get(g.part)?.by === 'guessed') corrections.delete(g.part);
    } else if (!notes.some((x) => x.startsWith('no guess') || x.startsWith('the guess named no part'))) notes.push('the guess named no part of this turn; elimination and verification ran');
  }

  // 1. Elimination.
  let players: LabPart[] = P.parts;
  let explainIn: { systemSections?: Record<string, string>; messages?: Record<string, number[]>; toolResults?: Record<string, string | string[]> };
  if (c.grouped) {
    const by = (g: string) => P.parts.filter((p) => groupOf(p) === g);
    players = GROUPS.filter((g) => by(g).length).map((g) => ({ id: g, kind: g === 'system' ? 'system' : g === 'memory' ? 'recall' : g === 'tool results' ? 'tool' : 'turn', source: by(g).every((p) => p.source === 'layout') ? 'layout' : 'unknown', preview: cut(by(g).map((p) => p.id).join(', ')) }));
    const sections: Record<string, string> = {}, messages: Record<string, number[]> = {}, toolResults: Record<string, string[]> = {};
    for (const p of P.parts) {
      const g = groupOf(p);
      if (P.systemSections[p.id] !== undefined) sections[g] = [sections[g], P.systemSections[p.id]].filter(Boolean).join('\n\n');
      if (P.messages[p.id]) (messages[g] ??= []).push(...P.messages[p.id]!);
      if (P.toolResults[p.id]) (toolResults[g] ??= []).push(P.toolResults[p.id]!);
    }
    explainIn = { systemSections: sections, messages, toolResults };
    notes.push(`the turn has ${P.parts.length} parts; elimination took them in ${players.length} groups — a group blamed is verified whole`);
  } else {
    explainIn = { systemSections: P.systemSections, messages: P.messages, toolResults: P.toolResults };
  }
  const elimination: DiagnoseTurnResult['elimination'] = { grouped: c.grouped, parts: players, shares: [], plays: 0, failed: 0, undetermined: 0 };
  if (players.length) {
    try {
      const e = await explainRun({
        journal: j, runId: opts.runId, model: opts.model, trials: t0, match: 'expect', expect,
        ...(Object.keys(explainIn.systemSections ?? {}).length ? { systemSections: explainIn.systemSections } : {}),
        ...(Object.keys(explainIn.messages ?? {}).length ? { messages: explainIn.messages } : {}),
        ...(Object.keys(explainIn.toolResults ?? {}).length ? { toolResults: explainIn.toolResults } : {}),
        ...(opts.answers?.length ? { answers: opts.answers } : {}),
        ...playOpts, ...control,
      });
      elimination.shares = e.shares.map((s) => ({ part: s.part, share: s.share, blame: -s.share, noise: s.noise })).sort((a, b) => b.blame - a.blame);
      elimination.plays = e.replays; elimination.failed = e.failed; elimination.undetermined = e.undetermined ?? 0;
      inputTokens += e.inputTokens; outputTokens += e.outputTokens; costUsd += e.costUsd; priced &&= e.priced;
      plays += e.replays; failed += e.failed;
    } catch (err) {
      if (opts.signal?.aborted || (err as { name?: string })?.name === 'ProviderStoppedError') throw err;
      elimination.error = err instanceof Error ? err.message : String(err);
      elimination.plays = plan.eliminationPlays;
      plays += plan.eliminationPlays;
      notes.push('elimination could not finish; only the absences and the hypotheses brought were verified');
    }
  }
  doneBefore += plan.eliminationPlays;
  failedBefore = elimination.failed;

  // 2. Verification arms.
  const blamed = c.grouped ? [] : elimination.shares.filter((x) => x.blame > 0).slice(0, topK).map((x) => x.part);
  let suggestions: Array<{ part: string; text: string }> | undefined;
  if (opts.suggest) {
    const ask = blamed.filter((id) => !corrections.has(id) && textOfPart(id) !== undefined && !(P.messages[id] && !textOnly(id)) && !(c.suspects.find((x) => x.id === id)!.kind === 'wm' && !wmText));
    if (!c.grouped && ask.length) {
      try {
        const r = await generateText({ model: opts.suggest, system: SUGGEST_SYSTEM, prompt: suggestPrompt(expect, run, ask.map((id) => ({ id, text: textOfPart(id)! }))) });
        inputTokens += r.usage.inputTokens ?? 0; outputTokens += r.usage.outputTokens ?? 0;
        const sm = typeof opts.suggest === 'string' ? opts.suggest : (opts.suggest as { modelId?: string }).modelId;
        const sp = sm && pricing ? priceFor(sm, pricing) : undefined;
        if (sp) costUsd += ((r.usage.inputTokens ?? 0) / 1e6) * sp.inputPer1M + ((r.usage.outputTokens ?? 0) / 1e6) * sp.outputPer1M; else priced = false;
        suggestions = parseSuggestions(r.text).filter((x) => ask.includes(x.part) && x.text.trim() !== '' && x.text !== textOfPart(x.part));
        for (const x of suggestions) corrections.set(x.part, { text: x.text, by: 'suggested' });
      } catch (err) {
        if (opts.signal?.aborted) throw err;
        notes.push(`no correction could be suggested: ${err instanceof Error ? err.message : String(err)}`);
        suggestions = [];
      }
    } else suggestions = [];
  }
  const arms: Arm[] = [];
  const suspectsById = new Map([...c.suspects.map((s) => [s.id, s] as const), ...players.map((p) => [p.id, { ...p, intervention: 'remove' as Intervention }] as const)]);
  for (const s of elimination.shares.filter((x) => x.blame > 0).slice(0, topK)) {
    const sp = suspectsById.get(s.part)!;
    const iv = c.grouped ? 'remove' : sp.intervention;
    arms.push({ id: `${iv}:${s.part}`, intervention: iv, label: c.grouped ? `the ${s.part} group left out` : labelOf(s.part, iv), targets: [s.part], change: changeOf(s.part, iv) });
  }
  for (const a of c.absences) arms.push(await absenceArm(a));
  for (const h of hypothesesOf(c, opts)) {
    const id = `${h.intervention}:${h.id}`;
    if (arms.some((a) => a.id === id)) continue;
    arms.push({ id, intervention: h.intervention, label: labelOf(h.id, h.intervention), targets: [h.id], change: changeOf(h.id, h.intervention, h.tool) });
  }
  for (const id of corrections.keys()) arms.push({ id: `correct:${id}`, intervention: 'correct', label: labelOf(id, 'correct'), targets: [id], change: changeOf(id, 'correct') });
  if (opts.workingMemory !== undefined && !c.suspects.some((s) => s.kind === 'wm')) notes.push('a corrected working memory was given, but this turn has no working memory whose place is known — it was not tried');
  const comparisons = Math.max(1, arms.length) + 1;
  const z = normalQuantile(1 - alphaShare / (2 * comparisons));
  // The unchanged turn is played once: the guess's plays of it, when there were any, are its plays here too.
  const all = [...(guessBaseline ? [] : [{ id: 'baseline', change: none() }]), ...arms];
  const jobs = all.flatMap((a) => Array.from({ length: n }, () => playOf(a.change)));
  const done = await runTrials(jobs, control);
  const offset = guessBaseline ? 0 : 1;
  const outcomesOf = (i: number) => done.outcomes.slice(i * n, (i + 1) * n);
  const baseline = guessBaseline ?? tally('baseline', 'baseline', 'the turn unchanged', [], outcomesOf(0));
  const results = arms.map((a, i) => compare(tally(a.id, a.intervention, a.label, a.targets, outcomesOf(i + offset)), baseline, z));
  doneBefore += jobs.length; failedBefore += done.failed;

  // 3. The joint arm: only when no single change helped, the two most promising together.
  let joint: ArmResult | undefined;
  const helped = results.some((r) => r.difference && r.difference.low > 0);
  const base95 = testable(baseline) ? wilson(asWrong(baseline).successes, ran(baseline)) : undefined;
  const candidates = results.map((r, i) => ({ r, i })).filter((x) => !x.r.untested);
  if (!helped && candidates.length >= 2 && base95 && base95.low < CHANCE_AT) {
    const order = candidates.sort((x, y) => (y.r.difference?.value ?? -1) - (x.r.difference?.value ?? -1) || x.i - y.i);
    const [a, b] = [arms[order[0]!.i]!, arms[order[1]!.i]!];
    const ch = merge(a.change, b.change);
    const jd = await runTrials(Array.from({ length: n }, () => playOf(ch)), control);
    joint = compare(tally(`joint:${a.id}+${b.id}`, 'joint', `${a.label} and ${b.label}`, [a.id, b.id], jd.outcomes), baseline, z);
  }

  let verdict = verdictOf(baseline, results, joint, z, elimination.error === undefined);
  if (verdict.kind === 'not-found') {
    const uncorrected = blamed.filter((id) => !corrections.has(id) && !(P.messages[id] && !textOnly(id)));
    if (uncorrected.length) {
      verdict = { ...verdict, uncorrected, sentence: `No change tried made the right answer more frequent. ${uncorrected.join('; ')} ${uncorrected.length > 1 ? 'were' : 'was'} blamed but only left out: leaving a wrong fact out does not put the right one in — write what ${uncorrected.length > 1 ? 'they' : 'it'} should have said (corrections) and diagnose again.` };
    }
  }
  for (const a of [baseline, ...results, ...(joint ? [joint] : [])]) {
    if (a.untested || (a === baseline && !testable(baseline))) {
      notes.push(`${a.label}: not tested — ${a.undetermined} of ${ran(a)} plays stopped at a call the recording never made${a.pending.length ? ` (${a.pending.map((c) => `${c.toolName}(${JSON.stringify(c.args)})`).join(', ')})` : ''}; write their answers (answers) and diagnose again`);
    }
  }
  return {
    runId: opts.runId, ...(summary ? { threadId: run.input.threadId as string, turn: at + 1 } : {}), expect, layout: run.layout, composition: compositionOf(run.input, run.layout, run.sources),
    elimination, arms: [baseline, ...results], ...(joint ? { joint } : {}), comparisons, z, verdict, ...(suggestions ? { suggestions } : {}), ...(guessed ? { guess: guessed } : {}),
    untestable: c.untestable, plan, plays, failed, inputTokens, outputTokens, costUsd, priced, notes,
  };
}
