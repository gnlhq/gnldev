// @gnldev/scheduler — durable workflow scheduler on top of @gnldev/durable.
// Keeps triggers in the journal (definition immutable, state mutable). The poll loop (now=Date.now())
// fires due triggers exactly-once (acquireRunLock + per-fireCount runId). The workflow run carries its
// own durable guarantee. Time = DATA (nextRunAt in the journal) → resolve-then-freeze, replay-safe.
import { acquireRunLock, argsHash, toJournal, attemptEndOf, executionGrant, createPollLoop, holdWhile, isDraining, orgPrefix, ownedName, ownedPrefix, ownerOfName, stableStringify, user, staff, UNKNOWN, refuseRunIdThatCannotBeBorn, withOrg, claimRunOwner, composerMark, markUpgradeDue, clearUpgradeDue } from '@gnldev/durable';
import type { Journal, Caller, UpgradeStep, UpgradeStepFactory, UnheededText } from '@gnldev/durable';
import { canonicalTimeZone, cronNeverFires, nextCronTime } from './cron.js';
import { rootJournal } from './root-journal.js';
import { refuseUnknownNames } from '@gnldev/options';
import { SCHEDULE_WORKFLOW_INPUT_NAMES, POLL_SCHEDULER_OPTS_NAMES, CREATE_SCHEDULER_OPTS_NAMES, MOVE_TRIGGER_TO_NAMES, UPGRADE_TRIGGERS_OPTS_NAMES } from './option-names.js';

export { nextCronTime, parseField } from './cron.js';
export { createWorkflowWaker } from './workflow-waker.js';
export type { WorkflowWaker, WorkflowWakerOptions, WorkflowWakerTickResult } from './workflow-waker.js';

/** Structurally compatible with what createGnl returns — no hard dependency. */
export interface WorkflowRunner {
  runWorkflow(
    name: string,
    input: unknown,
    /**
     * `caller` is the trigger's recorded owner (see `ScheduleSpec.caller`), decided by the scheduler.
     * The run `runId` names is already born, for that owner, by the scheduler: the runner continues it.
     * `signal` aborts when this poller's right to the fire ends (an `ExecutionRevokedError`, `why:
     * 'lease-lost'`: another poller took its lock and continues the run) — `createGnl().runWorkflow`
     * stops the workflow at its next step boundary, and does not cancel it.
     */
    opts?: {
      runId?: string;
      caller?: Caller;
      /**
       * The occurrence this fire is for (epoch ms) — the slot on the trigger's schedule, not the time
       * the poll ran: a fire after a day asleep, a retry, a resume all carry the slot they were decided for.
       */
      scheduledFor?: number;
      signal?: AbortSignal;
    },
  ): Promise<{ runId: string; suspended?: boolean; output?: unknown }>;
}

/**
 * Reaches an organization's runner — typically `(orgId) => createGnl(scopeConfigToOrg(config, orgId))`,
 * cached. Needed only for triggers set with an `orgId`.
 */
export type RunnerForOrg = (orgId: string) => WorkflowRunner;

export interface ScheduleSpec {
  /** Trigger id (idempotent record; `name` is used if not given). */
  id?: string;
  /** Workflow name to run (passed to runner.runWorkflow). */
  name: string;
  input?: unknown;
  /** Absolute time (epoch ms) — one-shot. */
  at?: number;
  /** Period (ms) — repeats every interval. */
  every?: number;
  /** 5-field cron (minute resolution) — repeats on every match. Read in UTC, or in `tz` when given. */
  cron?: string;
  /**
   * The IANA time zone `cron` is read in (`'Europe/Berlin'`, `'America/New_York'`). Without it, UTC.
   * Only for `cron` — `every` is a period and `at` an instant, so a zone would mean nothing there and
   * is refused. On a DST day a wall time that does not exist fires once, shifted forward by the gap
   * (02:30 → 03:30); one that happens twice fires once, at the first — unless the hour field is `*`.
   */
  tz?: string;
  /** Max attempts on failure (default 5). */
  maxAttempts?: number;
  /**
   * The end user this trigger works for — shorthand for `caller: user(resourceId, orgId)`. Each fire
   * runs as them, so the run is theirs: they can see it and approve it.
   */
  resourceId?: string;
  /**
   * Whose the trigger is, as an engine `Caller`. Every fire hands it to `runWorkflow` as the run's
   * caller. `staff(org?)` is an explicit operator/system trigger. With neither this nor `resourceId` the
   * fires run as `unknown`: never staff by omission, and never visible to an end user.
   */
  caller?: Caller;
  /**
   * The organization this trigger works in. Each fire runs on `runnerForOrg(orgId)`; without one the
   * fire fails rather than run on the organization-less runner, where the organization cannot see it.
   */
  orgId?: string;
  /**
   * Policy for occurrences missed because no poller ran (the machine slept, every process was down) —
   * only meaningful for every/cron. Read in ONE place (`slotToFire`). An occurrence is MISSED when a
   * later one is due as well; the schedule always goes on from the first occurrence after now (on the
   * planned grid: no drift), except under 'catchup':
   * 'latest'   (default) — the LATEST missed occurrence fires once; the older ones do not run.
   * 'earliest' — the OLDEST missed occurrence fires once; the newer ones do not run.
   * 'none'     — no missed occurrence runs: only an occurrence that is due on its own (no later one due
   *              as well) fires.
   * 'catchup'  — the missed occurrences fire in sequence, one per poll, oldest first — all of them, or at
   *              most the `maxCatchup` latest (a warning names what the limit dropped).
   * Each fire is told which occurrence it is for (`scheduledFor`).
   */
  misfire?: MisfirePolicy;
  /**
   * With `misfire: 'catchup'`: how many missed occurrences are run at most, the latest ones (default:
   * no limit — a day asleep on a minute cron is 1440 fires). When the limit drops some, the trigger logs
   * ONE warning: how many, and the time of the oldest.
   */
  maxCatchup?: number;
  /**
   * What to do when this id is already scheduled with a DIFFERENT spec (the same spec again is always
   * a no-op — that is what makes calling this on every boot safe):
   * 'refuse'  (default) — throw, naming both specs; nothing is changed.
   * 'replace' — the stored trigger takes this spec: next time from it, attempts reset, and a fire
   *             counter that no run has used (so no run id is reused and replayed).
   * 'keep'    — leave the stored trigger as it is (0.9 did this for every re-registration, silently).
   */
  ifExists?: 'refuse' | 'replace' | 'keep';
}

export type Kind = 'at' | 'every' | 'cron';
export type MisfirePolicy = 'latest' | 'earliest' | 'none' | 'catchup';
const MISFIRE_POLICIES: readonly MisfirePolicy[] = ['latest', 'earliest', 'none', 'catchup'];
/** What a trigger does about missed occurrences when its caller named no policy. */
const DEFAULT_MISFIRE: MisfirePolicy = 'latest';
/** What 0.16 stored for a trigger — the policy the caller named or not, it could not tell which (see `misfireOf`). */
const LEGACY_MISFIRE = 'skip';
/**
 * What a fire whose workflow runs on after its lock was taken costs, for the warning `executionGrant` says
 * (@gnldev/durable `UnheededText`). No hold limit here: only `lease-lost`.
 */
const UNHEEDED: UnheededText = {
  body: 'the workflow',
  signal: "the runner's signal (WorkflowRunner opts.signal)",
  lost: "createGnl().runWorkflow stops at its next step boundary on it; work outside the workflow's recorded steps may be repeated by the poller that took the lock.",
};
/** The upgrade step that rewrites 0.16 'skip' records (`schedulerUpgrade`), and the note a poller leaves for it. */
const MISFIRE_STEP = 'scheduler/misfire-default';
/**
 * A poller that reads a 0.16 'skip' record notes it once per journal (@gnldev/durable `markUpgradeDue`):
 * a `storage.upgrade()` where `schedulerUpgrade` is not registered then says so. `upgradeTriggers` clears it.
 * Never fails a poll: the record is read as "none named" either way (`misfireOf`).
 */
const misfireNoted = new WeakSet<object>();
function noteLegacyMisfire(journal: Journal): void {
  if (misfireNoted.has(journal)) return;
  misfireNoted.add(journal);
  markUpgradeDue(journal, MISFIRE_STEP, { by: '@gnldev/scheduler', register: 'registerUpgradeSteps(storage, [schedulerUpgrade])' })
    .catch(() => misfireNoted.delete(journal));
}
interface TriggerDef {
  name: string;
  input: unknown;
  kind: Kind;
  value: number | string;
  maxAttempts: number;
  /**
   * Absent = the caller named none: the record says "default", never a value, so the default can change
   * without every stored trigger looking like a different spec. Read only through `misfireOf`.
   */
  misfire?: MisfirePolicy;
  /** Absent = no limit (and absent on every definition written before it existed). */
  maxCatchup?: number;
  resourceId?: string;
  orgId?: string;
  ownerKind?: 'staff';
  /** Canonical IANA zone for a cron; absent = UTC (and absent on every definition written before it existed). */
  tz?: string;
}

/**
 * THE ONE READING of a trigger's misfire policy: the stored value, or the CURRENT default when none was
 * named. A 0.16 record ('skip', stored whether the caller named a policy or not) is read as "none named":
 * the data is read up, the API has no such alias (`scheduleWorkflow` refuses 'skip'). `upgradeTriggers`
 * rewrites such records for good.
 */
function misfireOf(def: TriggerDef): MisfirePolicy {
  const stored: unknown = def.misfire;
  return stored === undefined || stored === LEGACY_MISFIRE ? DEFAULT_MISFIRE : def.misfire!;
}

/** Why a misfire value is not one a trigger can have, or `undefined`. */
function misfireProblem(value: unknown): string | undefined {
  return MISFIRE_POLICIES.includes(value as MisfirePolicy) ? undefined : `misfire must be 'latest', 'earliest', 'none' or 'catchup', got ${JSON.stringify(value)}`;
}

/** A definition as a spec reads: a 0.16 'skip' is "none named", the same as an absent misfire (see `misfireOf`). */
function asSpecified(def: TriggerDef): TriggerDef {
  if ((def.misfire as unknown) !== LEGACY_MISFIRE) return def;
  const { misfire: _m, ...rest } = def;
  return rest;
}

/** The caller a trigger's recorded owner stands for — the ONE reading every fire uses. */
function callerOfTrigger(def: TriggerDef): Caller {
  if (typeof def.resourceId === 'string' && def.resourceId !== '') return user(def.resourceId, def.orgId);
  if (def.ownerKind === 'staff') return staff(def.orgId);
  return UNKNOWN;
}

/** The owner fields a trigger records, from its spec. One owner per trigger. */
function triggerOwnerOf(spec: Pick<ScheduleSpec, 'caller' | 'resourceId' | 'orgId'>): { resourceId?: string; orgId?: string; ownerKind?: 'staff' } {
  const c = spec.caller;
  const cOrg = c === undefined || c.kind === 'unknown' ? undefined : c.orgId;
  const cRes = c?.kind === 'user' ? c.id : undefined;
  if (c !== undefined && ((spec.resourceId !== undefined && spec.resourceId !== cRes) || (spec.orgId !== undefined && cOrg !== undefined && spec.orgId !== cOrg))) {
    throw new TypeError('@gnldev/scheduler: a trigger was given both `caller` and a different `resourceId`/`orgId` — one owner per trigger.');
  }
  const resourceId = cRes ?? spec.resourceId;
  const orgId = cOrg ?? spec.orgId;
  return {
    ...(resourceId !== undefined ? { resourceId } : {}),
    ...(orgId !== undefined ? { orgId } : {}),
    ...(c?.kind === 'staff' ? { ownerKind: 'staff' as const } : {}),
  };
}
interface TriggerState {
  /** When the poller next tries this trigger — the slot itself, or a retry/deferral time for it. */
  nextRunAt: number;
  /**
   * THE OCCURRENCE the next fire is for (`scheduledFor`), when it is not `nextRunAt`: frozen at the
   * fire's decision (`slotToFire`) and kept across its retries, suspensions and deferrals, which move
   * only `nextRunAt`. The next slot is computed from it, never from a retry time (that drifted the grid).
   * Absent = `nextRunAt` (every state written before it existed).
   */
  slot?: number;
  /**
   * Where the calendar goes on once the fire for `slot` has ended — frozen with `slot` (`slotToFire`),
   * since only the policy knows it: the occurrence after `slot` for 'latest' and 'catchup', the first one
   * after now for 'earliest' (the newer missed ones do not run). Absent = the occurrence after `slot`.
   */
  resumeAt?: number;
  attempts: number;
  fireCount: number;
  /**
   * THE ONE ANSWER to "does this trigger fire": only `'pending'` (and due) does. `'paused'` is kept and
   * waits for `resumeTrigger`; `'removed'` is gone (`unscheduleWorkflow`) and is read as absent by
   * everything but the fire counter.
   */
  status: 'pending' | 'done' | 'failed' | 'paused' | 'removed';
  /** Set by `moveTrigger` on the retired system trigger: the owned id it now lives under. */
  movedTo?: string;
  /**
   * The fingerprint of the definition this state was computed FOR (`definitionFingerprint`). A state
   * whose `of` names another definition is a half-written trigger, and a registration repairs it.
   * Absent on states written before 0.10 — those are trusted (see `stateBelongsTo`).
   */
  of?: string;
}

const DEF = (id: string) => `sched:def:${id}`;
const STATE = (id: string) => `sched:state:${id}`;

/** What a state's `of` names: the stable hash of the definition, the same reading `stableStringify` equality uses. */
function definitionFingerprint(def: TriggerDef): string {
  return argsHash(def);
}

/**
 * Whether a stored state was computed for this definition. A state without `of` was written before
 * the fingerprint existed and is trusted: treating it as foreign would reset every running trigger
 * on the upgrade boot, and re-fire a one-shot that is already `done`.
 */
function stateBelongsTo(state: TriggerState, def: TriggerDef): boolean {
  return state.of === undefined || state.of === definitionFingerprint(def);
}

/**
 * THE ONE WRITER OF A TRIGGER — both halves, `sched:def:<id>` and `sched:state:<id>`, as one unit.
 *
 * A trigger is two records and the poller needs both to agree. Written as two puts, a crash between
 * them left a definition next to a state computed for the PREVIOUS one: a `done` one-shot replaced by
 * `every: 1000` stayed done, a 0.9 `every: 0` trigger marked failed stayed failed, and the identical
 * registration on the next boot read only the definition, found "the same spec", and did nothing —
 * so the trigger never fired again and the advice in `sched:fail:` ("call scheduleWorkflow again")
 * stopped working. Measured: 4/4 crash scenarios, in-memory and SQLite.
 *
 * Two mechanisms, one rule ("after any crash, re-running the same registration converges to a state
 * the poller fires"):
 *   - `applyBatch` (every first-party journal): both puts land in one transaction / Lua call, so there
 *     is no window at all.
 *   - a journal without it: definition first, then the state, and the state carries `of` — the
 *     fingerprint of its definition. A crash in between leaves a state whose `of` names the old
 *     definition, and `scheduleWorkflow`'s same-spec path repairs exactly that (`stateBelongsTo`).
 *     Writing the state FIRST would not do: the poller would fire the OLD definition with the new
 *     state (a `done` one-shot fires again).
 */
async function writeTrigger(journal: Journal, id: string, def: TriggerDef, state: TriggerState): Promise<TriggerState>;
/**
 * The same writer, for a TRANSITION of a trigger whose stored definition stays: a fire's outcome, a
 * pause, a resume, a removal. Only the state changes, so one write is the whole unit — a CAS against
 * the state the caller read (`expected`). Returns `null` when somebody else wrote the state in between
 * (another poller's fire, an operator's pause): the caller re-reads and decides again, it never
 * overwrites a transition it did not see.
 */
async function writeTrigger(journal: Journal, id: string, def: TriggerDef, state: TriggerState, expected: TriggerState): Promise<TriggerState | null>;
async function writeTrigger(journal: Journal, id: string, def: TriggerDef, state: TriggerState, expected?: TriggerState): Promise<TriggerState | null> {
  const stamped: TriggerState = { ...state, of: definitionFingerprint(def) };
  if (expected !== undefined) {
    return (await journal.putIfMatch(STATE(id), expected, stamped)) ? stamped : null;
  }
  await journal.applyBatch({ puts: [{ key: DEF(id), value: def }, { key: STATE(id), value: stamped }] });
  return stamped;
}
const FAIL = (id: string) => `sched:fail:${id}`;
const BUDGET_SKIP = (id: string) => `sched:budget-skip:${id}`;
const BUSY_SKIP = (id: string) => `sched:busy-skip:${id}`;

/**
 * THE FIRE LOCK'S KEY — deliberately NOT the runId.
 *
 * This lock answers "is another POLLER firing this occurrence?". The runId's own lock answers "is
 * this RUN executing anywhere?". Two different questions, and for a long time they were written to
 * the same place: `acquireRunLock(journal, runId, …)` produces `<runId>:lock`, so a poller holding
 * the fire lock was holding the run's lock too.
 *
 * That was invisible until a run started taking its own lock. Measured, in a `preset: 'critical'`
 * app: the poller locked `sched:saglik-5dk:0:lock`, then called `runWorkflow` with that same runId,
 * and the critical preset's run-lock (registry.ts) found the key occupied and refused —
 * `RunBusyError`, "already running, locked by another process". The other process was the caller.
 * Five polls, five refusals, `status: 'failed'`, and not one step ever ran. Nothing raced; it simply
 * could not work.
 *
 * The two locks now live on separate keys and are free to be held at the same time, which is the
 * correct arrangement: they nest rather than compete. Fire exclusivity is unchanged (the key is still
 * per-occurrence and still CAS-claimed).
 *
 * SUFFIXED rather than moved to a `sched:fire:…` namespace of its own, and that is not a style
 * choice. `<runId>:fire:lock` stays UNDER the run's own key prefix, which is the prefix `purgeRun` /
 * `sweepRuns` delete by — a sibling namespace would have left one small orphan record per fire
 * behind forever, and a five-minute trigger fires a hundred thousand times a year. `parseJournalKey`
 * still ignores it (it claims only `:model:`/`:tool:`), so it stays invisible to replay exactly as
 * `<runId>:lock` always has.
 *
 * MIXED-VERSION NOTE, honestly: during a rolling deploy an old poller and a new one hold DIFFERENT
 * keys for the same occurrence, so both can start the fire. That window is covered by what already
 * covers every other lock loss here — the state write is a CAS (`commit`), so only one poller's
 * result is recorded, and under the critical preset the run's own lock refuses the second executor
 * outright. UNDER THE CRITICAL PRESET it degrades to documented takeover behaviour, not to a double
 * side effect; a non-critical preset has no run lock, so two executors in this window CAN each run a
 * side-effecting tool once — drain the pollers over an upgrade if that matters to the workflow.
 */
const FIRE_LOCK = (runId: string) => `${runId}:fire`;
const FIRE_AT = (runId: string) => `${runId}:fire:at`;

/**
 * 1.4: optional budget/quota hook — called BEFORE the trigger starts (before runner.runWorkflow is
 * CALLED). Throws on overage (typically `@gnldev/durable`'s `assertBudget` — `BudgetExceededError`);
 * `pollScheduler` does NOT RUN this trigger (skip + records/logs to `sched:budget-skip:<id>`,
 * `out.skipped` increments), state is DEFERRED to retry after `retryMs` but `attempts` DOES NOT
 * increase (a budget overage isn't the workflow's fault → doesn't count toward maxAttempts, `status`
 * stays 'pending'). IF NOT GIVEN (default) behavior is UNCHANGED — no quota check (backward compat).
 * Typical host usage:
 *   budgetGuard: () => assertBudget(journal, { orgId, fallback })
 * Kept simple: the scheduler does NOT EMBED quota logic itself, the host injects it (same pattern as limits/guard).
 */
export type BudgetGuard = (ctx: {
  triggerId: string;
  workflowName: string;
  input: unknown;
  now: number;
  /** Whose trigger is firing — so one scheduler serving many organizations can charge the right one. */
  orgId?: string;
  resourceId?: string;
}) => Promise<unknown> | unknown;

/**
 * Why a trigger definition cannot fire, or `undefined` when it can — the ONE reading for a new spec
 * (`scheduleWorkflow`, before anything is written) and for a stored definition (the poller, and a
 * re-registration deciding whether the stored one may be replaced). A definition in the journal is
 * always one the poller can fire: 0.9.0 wrote the definition first and validated after, so a refused
 * cron left an orphan behind, and `every: 0` was accepted and fired on every poll.
 */
function definitionProblem(def: TriggerDef): string | undefined {
  if (typeof def.name !== 'string' || def.name === '') return `name must be the workflow's name (a non-empty string), got ${JSON.stringify(def.name)}`;
  if (def.kind === 'at') {
    if (typeof def.value !== 'number' || !Number.isFinite(def.value)) return `at must be a finite epoch-ms number, got ${String(def.value)}`;
  } else if (def.kind === 'every') {
    if (typeof def.value !== 'number' || !Number.isFinite(def.value) || def.value <= 0) {
      return `every must be a finite period in ms greater than 0, got ${String(def.value)} (0 or less fires on every poll)`;
    }
  } else if (def.kind === 'cron') {
    if (typeof def.value !== 'string') return `cron must be a 5-field string, got ${String(def.value)}`;
    // Whether the cron can EVER fire, never "within a year of now": the same spec must get the same
    // answer on every date, here and in the poller (see cronNeverFires).
    let never: string | undefined;
    try {
      never = cronNeverFires(def.value);
    } catch (e) {
      return `cron '${def.value}' is not valid: ${(e as Error).message}`;
    }
    if (never) return `cron '${def.value}' can never fire: ${never}`;
  } else {
    return `unknown kind ${JSON.stringify(def.kind)}`;
  }
  if (!Number.isInteger(def.maxAttempts) || def.maxAttempts < 1) return `maxAttempts must be an integer of at least 1, got ${String(def.maxAttempts)}`;
  const misfire = misfireOf(def);
  const badMisfire = misfireProblem(misfire);
  if (badMisfire !== undefined) return badMisfire;
  if (def.maxCatchup !== undefined) {
    if (misfire !== 'catchup') return `maxCatchup is only for misfire: 'catchup' (the other policies run one missed occurrence at most), got maxCatchup ${String(def.maxCatchup)} with misfire '${misfire}'`;
    if (def.maxCatchup !== Infinity && (!Number.isInteger(def.maxCatchup) || def.maxCatchup < 1)) return `maxCatchup must be an integer of at least 1, or Infinity, got ${String(def.maxCatchup)}`;
  }
  if (def.tz !== undefined) {
    if (def.kind !== 'cron') return `tz is only for cron (a time zone means nothing to ${def.kind === 'at' ? 'an instant' : 'a period'}), got tz ${JSON.stringify(def.tz)} with ${def.kind}`;
    if (canonicalTimeZone(def.tz) === undefined) return `tz ${JSON.stringify(def.tz)} is not a time zone this runtime knows (an IANA name, e.g. 'Europe/Berlin')`;
  }
  return undefined;
}

/** The definition a spec stands for — refused, before any write, when it could not fire. */
function definitionOf(spec: ScheduleSpec, id: string, owner: ReturnType<typeof triggerOwnerOf>): TriggerDef {
  const given = (['at', 'every', 'cron'] as const).filter((k) => spec[k] != null);
  if (given.length !== 1) {
    throw new Error(
      given.length === 0
        ? `@gnldev/scheduler: trigger '${id}' — one of at | every | cron is required.`
        : `@gnldev/scheduler: trigger '${id}' — give only one of at | every | cron (got ${given.join(' and ')}); a second one was silently ignored before.`,
    );
  }
  // A policy the caller names must be one a trigger can have. (Not left to definitionProblem, which
  // reads a stored 0.16 'skip' as "none named" and so would let a caller's 'skip' through.)
  const badMisfire = spec.misfire === undefined ? undefined : misfireProblem(spec.misfire);
  if (badMisfire !== undefined) throw new Error(`@gnldev/scheduler: trigger '${id}' — ${badMisfire}. Nothing was written.`);
  const kind: Kind = given[0]!;
  // The canonical spelling, so two spellings of one zone are one spec; an unknown zone is kept as given
  // and refused by definitionProblem below. Absent when not given, so a definition stored before `tz`
  // existed keeps its fingerprint.
  const tz = spec.tz === undefined ? undefined : (canonicalTimeZone(spec.tz) ?? spec.tz);
  const def: TriggerDef = {
    name: spec.name,
    input: spec.input,
    kind,
    value: spec[kind]!,
    maxAttempts: spec.maxAttempts ?? 5,
    ...(spec.misfire !== undefined ? { misfire: spec.misfire } : {}),
    ...(spec.maxCatchup !== undefined ? { maxCatchup: spec.maxCatchup } : {}),
    ...owner,
    ...(tz !== undefined ? { tz } : {}),
  };
  const problem = definitionProblem(def);
  if (problem) throw new Error(`@gnldev/scheduler: trigger '${id}' — ${problem}. Nothing was written.`);
  return def;
}

/**
 * Which parts of two definitions differ, by NAME. Never the stored values: the id may be a guess by a
 * caller who does not own the trigger (an ownerless id is shared), and the stored input is the owner's
 * data. Measured: printing both specs put another caller's trigger input into the refusal.
 */
function definitionDiff(storedDef: TriggerDef, given: TriggerDef): string {
  const stored = asSpecified(storedDef);
  const fields = (['name', 'input', 'maxAttempts', 'misfire', 'maxCatchup', 'resourceId', 'orgId', 'ownerKind', 'tz'] as const)
    .filter((k) => stableStringify(stored[k] ?? null) !== stableStringify(given[k] ?? null));
  const schedule = stored.kind !== given.kind ? `the schedule (${stored.kind} → ${given.kind})`
    : stableStringify(stored.value) !== stableStringify(given.value) ? `the ${given.kind} value` : undefined;
  return [...(schedule ? [schedule] : []), ...fields].join(', ');
}

/** A definition's first time from `now` — read from the DEFINITION, so a repair under 'keep' uses the stored schedule. */
function firstRunAt(def: TriggerDef, now: number): number {
  if (def.kind === 'at') return def.value as number;
  if (def.kind === 'every') return now + (def.value as number);
  return nextCronTime(def.value as string, now, def.tz);
}
/**
 * The schedule's occurrence right after `slot` — on the planned grid, whatever time it is now: poll
 * delay never accumulates as drift. Missed occurrences are the misfire policy's business (`slotToFire`),
 * never this function's.
 */
function slotAfter(def: TriggerDef, slot: number): number {
  if (def.kind === 'every') return slot + (def.value as number);
  return nextCronTime(def.value as string, slot, def.tz);
}

/**
 * What a due trigger does about the occurrences it missed: which one it fires for (`fire`, absent when
 * none runs), where the calendar goes on afterwards (`resume`), and what `maxCatchup` dropped.
 */
interface MisfirePlan {
  fire: number | undefined;
  resume: number;
  dropped?: { count: number; oldest: number };
}

/**
 * The occurrences due at `now` that are not among the `keep` latest: the first of the `keep` latest
 * (`start`), and how many came before it (`dropped`, counted from `slot`, the oldest not yet fired).
 */
function latestDue(def: TriggerDef, slot: number, now: number, keep: number): { start: number; dropped: number } {
  if (keep === Infinity) return { start: slot, dropped: 0 };
  if (def.kind === 'every') {
    const interval = def.value as number;
    const due = Math.floor((now - slot) / interval) + 1; // occurrences at or before now, from `slot`
    const dropped = Math.max(0, due - keep);
    return { start: slot + interval * dropped, dropped };
  }
  // Any other schedule (cron): no arithmetic for "n occurrences back", so the due ones are walked
  // forward with `slotAfter`, keeping the last `keep` (once per fire: the answer is frozen into the state).
  const window: number[] = [];
  let dropped = 0;
  for (let s = slot; s <= now; s = slotAfter(def, s)) {
    window.push(s);
    if (window.length > keep) { window.shift(); dropped++; }
  }
  return { start: window[0] ?? slot, dropped };
}

/**
 * THE MISFIRE POLICY, the one place it is read: given the oldest occurrence not yet fired (`slot`) and
 * the time now, which occurrence a due trigger fires for and where its calendar goes on. An occurrence
 * is missed when a later one is due too. An `at` trigger has one occurrence. The answer is frozen into
 * the state before the fire (see `dispatchDue`): a second poller with another clock fires the same
 * occurrence, not its own guess.
 */
function slotToFire(def: TriggerDef, slot: number, now: number): MisfirePlan {
  if (def.kind === 'at' || now < slot) return { fire: slot, resume: slot };
  const misfire = misfireOf(def);
  switch (misfire) {
    case 'earliest':
      return { fire: slot, resume: slotAfter(def, latestDue(def, slot, now, 1).start) };
    case 'none': {
      const latest = latestDue(def, slot, now, 1).start;
      return { fire: latest === slot ? slot : undefined, resume: slotAfter(def, latest) };
    }
    default: { // 'latest' keeps the one latest occurrence; 'catchup' all of them, or the `maxCatchup` latest
      const keep = misfire === 'latest' ? 1 : (def.maxCatchup ?? Infinity);
      const { start, dropped } = latestDue(def, slot, now, keep);
      return { fire: start, resume: slotAfter(def, start), ...(misfire === 'catchup' && dropped > 0 ? { dropped: { count: dropped, oldest: slot } } : {}) };
    }
  }
}
function backoff(attempts: number): number {
  return Math.min(1000 * 2 ** (attempts - 1), 60_000);
}

/**
 * Where a REPAIRED trigger's fire counter has to start, and why it is not zero.
 *
 * `fireCount` is not bookkeeping: it is part of the run's id (`sched:<id>:<fireCount>`), and a
 * durable run is exactly-once PER ID. A repair that started the counter at 0 would point the first
 * fire at a run that already completed — the engine would hand back the recorded answer, no step
 * would execute, the counter would tick to 1 and do it again. The trigger would look alive on every
 * dashboard and do nothing, which is the same silence this repair exists to end.
 *
 * So the journal is asked what it already knows: the highest `<n>` that ever appeared under this
 * trigger's own key prefix, plus one. Every fire leaves something there — the run's entries, and the
 * fire lock even when the run itself was swept — so the answer is a floor, not a guess.
 */
async function fireCountAfterLoss(journal: Journal, id: string): Promise<number> {
  const prefix = `sched:${id}:`;
  let highest = -1;
  try {
    for (const key of await journal.listKeys(prefix)) {
      const n = /^(\d+)(?::|$)/.exec(key.slice(prefix.length));
      if (n) highest = Math.max(highest, Number(n[1]));
    }
  } catch {
    return 0; // a reader that cannot answer is not evidence that nothing ever fired — but see the warn
  }
  return highest + 1;
}

/**
 * Schedules a workflow (at | every | cron). Returns the id. Idempotent: the same spec under the same id
 * again is a no-op. A DIFFERENT spec under an id already scheduled is refused unless `ifExists` says
 * otherwise (see `ScheduleSpec.ifExists`).
 */
export async function scheduleWorkflow(journal: Journal, input: ScheduleSpec, now: number = Date.now()): Promise<string> {
  refuseUnknownNames('scheduleWorkflow', input, SCHEDULE_WORKFLOW_INPUT_NAMES);
  journal = rootJournal(journal, 'scheduleWorkflow');
  const owner = triggerOwnerOf(input);
  const spec: ScheduleSpec = { ...input, caller: undefined, resourceId: owner.resourceId, orgId: owner.orgId };
  // Checked when the trigger is set: found at fire time, a bad id is maxAttempts failures and a dead
  // trigger instead of one error to the caller.
  if (spec.orgId !== undefined) orgPrefix(spec.orgId);
  if (spec.resourceId !== undefined && (typeof spec.resourceId !== 'string' || spec.resourceId === '')) {
    throw new Error(`@gnldev/scheduler: invalid resourceId '${String(spec.resourceId)}' — must be a non-empty string, or omitted for a system trigger`);
  }
  // A name within its owner (`ownedName`): triggers of every organization share this journal, and the
  // id defaults to the workflow's name, so the second user to schedule it got the first one's trigger.
  const id = ownedName(spec.id ?? spec.name, { resourceId: owner.resourceId, orgId: owner.orgId });
  // Validated BEFORE any write, so a refused spec leaves nothing behind (0.9.0 wrote the definition
  // first and threw after it, and the orphan then shadowed the corrected registration).
  const def = definitionOf(spec, id, owner);
  const ifExists = spec.ifExists ?? 'refuse';
  if (ifExists !== 'refuse' && ifExists !== 'replace' && ifExists !== 'keep') {
    throw new Error(`@gnldev/scheduler: trigger '${id}' — ifExists must be 'refuse', 'replace' or 'keep', got ${JSON.stringify(ifExists)}. Nothing was written.`);
  }
  const stored = await journal.get<TriggerDef>(DEF(id));
  if (stored !== undefined) {
    // A REMOVED trigger is absent (`unscheduleWorkflow`): registering the id again is a new trigger,
    // whatever its spec and whatever `ifExists` says. Only its fire counter survives, moved past every
    // run id the removed one used — a reused id would replay a finished run instead of firing.
    const prev = await journal.get<TriggerState>(STATE(id));
    if (prev?.status === 'removed') {
      await writeTrigger(journal, id, def, {
        nextRunAt: firstRunAt(def, now), attempts: 0,
        fireCount: Math.max(prev.fireCount, await fireCountAfterLoss(journal, id)), status: 'pending',
      });
      return id;
    }
  }
  const storedProblem = stored === undefined ? undefined : definitionProblem(stored);
  // "Already scheduled" is an answer only for the SAME spec. For a different one it was the silent
  // failure: 0.9 stored `{ at }`, the host now passes `{ every }`, and the one-shot that had already
  // fired stayed done forever while every boot was told all was well.
  const changed = stored !== undefined && storedProblem === undefined && stableStringify(asSpecified(stored)) !== stableStringify(def);
  if (changed && ifExists === 'refuse') {
    throw new Error(
      `@gnldev/scheduler: trigger '${id}' is already scheduled with a different spec (differs in ${definitionDiff(stored, def)}). `
      + `Nothing was changed. Pass ifExists: 'replace' to apply this spec, ifExists: 'keep' to leave the stored one, or use a new id.`,
    );
  }
  if (stored !== undefined && (storedProblem !== undefined || (changed && ifExists === 'replace'))) {
    // Replaced: a stored definition that cannot fire (written by 0.9.0 — an orphan from a refused spec,
    // or an `every: 0`) whatever `ifExists` says, since it has no schedule worth keeping; or a valid
    // one the caller asked to replace. The fire counter moves to one no run has used: it is part of
    // the run id, and a run id that already ran replays its recorded answer instead of firing. (A
    // one-shot that fired is `done` with its counter unmoved, so the stored count alone is not enough.)
    const prev = await journal.get<TriggerState>(STATE(id));
    const state = await writeTrigger(journal, id, def, {
      nextRunAt: firstRunAt(def, now),
      attempts: 0,
      fireCount: Math.max(prev?.fireCount ?? 0, await fireCountAfterLoss(journal, id)),
      // A pause is the operator's, not the spec's: a new spec does not lift it.
      status: prev?.status === 'paused' ? 'paused' : 'pending',
    });
    console.warn(
      storedProblem !== undefined
        ? `[scheduler] invalid trigger definition replaced (trigger ${id}, workflow ${spec.name}) — the stored one could not fire (${storedProblem}); the definition from this scheduleWorkflow call was written in its place, fireCount=${state.fireCount}.`
        : `[scheduler] trigger ${id} replaced (ifExists: 'replace') — it differed in ${definitionDiff(stored, def)}; nextRunAt=${state.nextRunAt}, fireCount=${state.fireCount}.`,
    );
    return id;
  }
  if (stored !== undefined) {
    /**
     * THE DEFINITION EXISTS. That used to end the function — and it was reading only half the record.
     *
     * A trigger is two entries written together, `sched:def:<id>` and `sched:state:<id>`, and only the
     * second one can be lost on its own: the definition is immutable and nothing rewrites it, while
     * the state is written on every fire and is what a too-wide purge or a retention sweep takes. Once
     * it is gone the trigger is not broken loudly, it is INVISIBLE — `pollScheduler` skips it on its
     * `!state` branch, `listTriggers` drops it as a "partial record" so it is absent from Studio, and
     * this function said "already scheduled" to every restart. Nothing fires and nothing complains.
     * Measured in production: the discovery was somebody noticing that work had not happened.
     *
     * The repair belongs HERE because this is the only place that still holds the spec. `firstRunAt`
     * needs `at | every | cron`, and neither the poller nor a listing has them — they have a def, but
     * a def that has already lost its state has no honest "next time" either. Hosts already call this
     * on every boot (that is the idempotency promise), so the trigger for the repair is free.
     *
     * DEF + STATE BOTH PRESENT: nothing is written, not even the definition — this is the same spec
     * again, or a different one with `ifExists: 'keep'`. A running trigger's schedule is never
     * redefined silently: a different spec was refused above unless the caller said which it wanted.
     */
    const current = await journal.get<TriggerState>(STATE(id));
    if (current !== undefined && !stateBelongsTo(current, stored)) {
      // HALF-WRITTEN: the definition was replaced and the process stopped before its state landed
      // (reachable for a trigger an earlier version wrote in two puts — see writeTrigger). The state still
      // describes the previous definition, so it is replaced like a lost one; the counter keeps
      // climbing past every run id either definition used.
      const state = await writeTrigger(journal, id, stored, {
        nextRunAt: firstRunAt(stored, now),
        attempts: 0,
        fireCount: Math.max(current.fireCount, await fireCountAfterLoss(journal, id)),
        status: 'pending',
      });
      console.warn(
        `[scheduler] half-written trigger repaired (trigger ${id}, workflow ${spec.name}) — 'sched:state:${id}' was computed for a different definition than the stored one (a registration stopped between its two writes). A state for the stored definition was written: nextRunAt=${state.nextRunAt}, attempts=0, fireCount=${state.fireCount}.`,
      );
      return id;
    }
    if (current !== undefined && !Number.isFinite(current.nextRunAt) && (current.status === 'pending' || current.status === 'failed' || current.status === 'paused')) {
      // NO VALID TIME: the poller failed it (or would), since it cannot fire from there. Registering the
      // same spec is the way out it names — and a host registers on every boot, so a restart repairs it.
      // The time comes from the definition; a pause stays the operator's.
      const state = await writeTrigger(journal, id, stored, {
        ...current,
        nextRunAt: firstRunAt(stored, now),
        attempts: 0,
        status: current.status === 'paused' ? 'paused' : 'pending',
      });
      console.warn(
        `[scheduler] trigger ${id} had no valid next time (${String(current.nextRunAt)}) — set from its definition by this scheduleWorkflow call: nextRunAt=${state.nextRunAt}, status=${state.status}.`,
      );
      return id;
    }
    if (current === undefined) {
      const state = await writeTrigger(journal, id, stored, {
        nextRunAt: firstRunAt(stored, now),
        attempts: 0,
        fireCount: await fireCountAfterLoss(journal, id),
        status: 'pending',
      });
      // LOUD, and deliberately not a debug line. A system that heals itself in silence never shows
      // the operator the thing that keeps breaking it — and what breaks this is usually a purge or a
      // retention rule that runs again next week. `attempts` is reset because the previous attempt
      // history is genuinely gone; the trigger is honestly starting over.
      console.warn(
        `[scheduler] orphaned trigger state repaired (trigger ${id}, workflow ${spec.name}) — the definition was in the journal but 'sched:state:${id}' was missing, so the trigger was invisible to the poller AND to listTriggers, and could not have fired again. A fresh state was written: nextRunAt=${state.nextRunAt}, attempts=0, fireCount=${state.fireCount}. Find out what deleted it (a too-wide purge or a retention sweep is the usual cause) — this will happen again otherwise.`,
      );
    }
    return id;
  }
  // A trigger nobody has seen before: both halves are written here, and only here. Its first fire's run
  // (`sched:<id>:0`) is born at that fire (`claimRunOwner`); an erasure that took this id's earlier fires
  // fenced it, and a fenced id is never born again — refused here by that same rule, before anything is
  // written, instead of a trigger that fails at every fire (e2e F1, its scheduler sibling).
  // Asked here too: an id whose fires no run could carry (`sched:tool:0` — `:tool` is where a run's tool
  // records start) is refused at scheduling, not deferred at every fire. The scheduler composes the id.
  await refuseRunIdThatCannotBeBorn(def.orgId !== undefined ? withOrg(journal, def.orgId) : journal, `sched:${id}:0`, composerMark(`sched:${id}:0`));
  await writeTrigger(journal, id, def, { nextRunAt: firstRunAt(def, now), attempts: 0, fireCount: 0, status: 'pending' });
  return id;
}

export interface PollResult {
  fired: number;
  rescheduled: number;
  failed: number;
  /**
   * Triggers that were NOT RUN and are NOT a failure — the three deferral reasons, counted together
   * because they mean the same thing to a caller ("nothing happened, come back later"):
   *   - another poller holds the fire lock for this occurrence (no record; the lock IS the record),
   *   - `budgetGuard` was given and threw on overage (`sched:budget-skip:<id>`),
   *   - the run is already in flight elsewhere (`sched:busy-skip:<id>`).
   * None of them consume an attempt. Without a guard and without contention this stays 0.
   */
  skipped: number;
}

export interface PollOptions {
  owner?: string;
  retryMs?: number;
  budgetGuard?: BudgetGuard;
  lockTtlMs?: number;
  runnerForOrg?: RunnerForOrg;
  onInvalidTime?: InvalidTimePolicy;
  /**
   * How many fires run at once in this scheduler (default: no limit). A fire never holds up the decision about
   * another trigger: the poll decides, the fire runs beside it. When every slot is busy, the triggers
   * still due stay due — not skipped, not failed — and fire as soon as a slot frees. Two fires of ONE
   * trigger never overlap: its next occurrence is decided only after its fire ends.
   */
  concurrency?: number;
}

/**
 * THE FIRES IN HAND of one scheduler in this process: at most `limit` at once, and never two of one
 * trigger. The poll is the only writer of `inFlight`; a fire removes itself when it ends.
 */
interface FireSlots {
  limit: number;
  inFlight: Set<string>;
}

function fireSlots(concurrency: number | undefined, fn: string): FireSlots {
  const limit = concurrency ?? Infinity;
  if (limit !== Infinity && (!Number.isInteger(limit) || limit < 1)) {
    throw new TypeError(`@gnldev/scheduler: ${fn} — concurrency must be a positive integer (or Infinity), got ${String(concurrency)}.`);
  }
  return { limit, inFlight: new Set() };
}

/**
 * Fires triggers that are due ('pending' && now≥nextRunAt) and resolves when those fires have ended.
 * Double-firing is prevented via the run-lock; the real exactly-once guarantee comes from the durable
 * workflow run (per-fireCount runId).
 *
 * Y2: the lock is kept alive by a heartbeat while the workflow runs (`lockTtlMs`, default 60s, renewed
 * every ttl/3) — a long workflow no longer lets a second poller take the fire over. And EVERY state
 * write is a CAS (`putIfMatch`) against the state read at the start of the fire, so even if a takeover
 * does happen the late poller cannot write its stale result back.
 */
export async function pollScheduler(
  journal: Journal,
  runner: WorkflowRunner,
  now: number = Date.now(),
  opts: PollOptions = {},
): Promise<PollResult> {
  refuseUnknownNames('pollScheduler', opts, POLL_SCHEDULER_OPTS_NAMES);
  journal = rootJournal(journal, 'pollScheduler');
  const out: PollResult = { fired: 0, rescheduled: 0, failed: 0, skipped: 0 };
  const fires = await dispatchDue(journal, runner, now, opts, fireSlots(opts.concurrency, 'pollScheduler'), out);
  // Every fire ends before the answer; a journal error in one of them is the poll's error, as it was.
  const ended = await Promise.allSettled(fires);
  const failed = ended.find((e): e is PromiseRejectedResult => e.status === 'rejected');
  if (failed) throw failed.reason;
  return out;
}

/**
 * THE DECISION: which due triggers fire now, each under its fire lock and with its occurrence frozen —
 * and nothing else. A fire is started, not awaited: the returned promises are the fires, each held
 * (`holdWhile`) from its lock to its release, so a drain still waits for every one of them. The lock is
 * taken with the time the decision was made at, never a time a previous fire has aged.
 */
async function dispatchDue(
  journal: Journal,
  runner: WorkflowRunner,
  now: number,
  opts: PollOptions,
  slots: FireSlots,
  out: PollResult,
): Promise<Promise<void>[]> {
  const owner = opts.owner ?? `sched-${Math.random().toString(36).slice(2, 8)}`;
  const retryMs = opts.retryMs ?? 30_000;
  const lockTtlMs = opts.lockTtlMs ?? 60_000;
  const onInvalidTime = invalidTimePolicy(opts.onInvalidTime, 'pollScheduler');
  const fires: Promise<void>[] = [];

  const due: Array<{ id: string; def: TriggerDef; state: TriggerState }> = [];
  const defKeys = await journal.listKeys('sched:def:');
  for (const dkey of defKeys) {
    const id = dkey.slice('sched:def:'.length);
    const def = await journal.get<TriggerDef>(DEF(id));
    if ((def?.misfire as unknown) === LEGACY_MISFIRE) noteLegacyMisfire(journal);
    const state = await journal.get<TriggerState>(STATE(id));
    // A definition with NO state is invisible otherwise: skipped here, dropped by listTriggers. 0.9.0
    // wrote one for a cron it then refused (`'99 * * * *'`, `'hello'`): it never fires and nothing says
    // so, forever if the host no longer registers that id. An invalid one is failed here, created only if
    // its state is still absent, so it shows in listTriggers and Studio with the reason. A VALID one is left
    // to the registration that repairs it (the next scheduleWorkflow for the id — a host that registers on
    // boot does it on start); listTriggers shows it meanwhile. Writing a state for it here would stop that
    // repair, which leaves a definition that has a state alone.
    if (def && !state) {
      const orphanProblem = definitionProblem(def);
      if (orphanProblem !== undefined) {
        const failed: TriggerState = { nextRunAt: 0, attempts: 0, fireCount: await fireCountAfterLoss(journal, id), status: 'failed', of: definitionFingerprint(def) };
        const won = await journal.putIfAbsent(STATE(id), failed);
        if (won) {
          await journal.put(FAIL(id), { error: invalidDefinitionError(orphanProblem), at: now });
          console.warn(`[scheduler] trigger ${id} has an invalid definition and no state (${orphanProblem}) — marked failed, not fired.`);
          out.failed++;
        }
      }
      continue;
    }
    if (!def || !state || state.status !== 'pending') continue;

    // Two questions, asked in this order: can this stored trigger fire at all, and is it time. A
    // trigger that cannot fire is answered on the first poll that sees it, whatever its time says.
    //
    // Its DEFINITION cannot fire — only 0.9.0 could store one (`scheduleWorkflow` now refuses it):
    // firing it would run the workflow and then throw in computeNext, or fire on every poll for
    // `every: 0`. Failed, with the reason and the way out.
    const problem = definitionProblem(def);
    if (problem !== undefined) {
      // Stamped with the definition it failed FOR (writeTrigger): the corrected registration then
      // replaces both halves, and if it stops between them the state still names the bad definition —
      // which the same-spec path reads as half-written and repairs.
      if (await failTrigger(journal, id, def, state, now, invalidDefinitionError(problem))) {
        console.warn(`[scheduler] trigger ${id} has an invalid definition (${problem}) — marked failed, not fired.`);
        out.failed++;
      }
      continue;
    }
    // Its definition is valid but its stored next time is not a number — a state no registration
    // writes (a foreign writer, a hand edit). It is never fired from that state: a fire computes the next
    // slot FROM the stored time, so an `every` fired on every poll and an `at` fired before its time
    // (measured, 15 of 15). By default it is failed, visible, with the way out; `onInvalidTime: 'repair'`
    // sets the time from the definition instead and fires at that time.
    if (!Number.isFinite(state.nextRunAt)) {
      if (onInvalidTime === 'repair') {
        const repaired = await writeTrigger(journal, id, def, { ...state, nextRunAt: firstRunAt(def, now) }, state);
        if (repaired) {
          console.warn(`[scheduler] trigger ${id} had no valid next time (${String(state.nextRunAt)}) — set from its definition to ${repaired.nextRunAt} (onInvalidTime: 'repair'), not fired.`);
          out.rescheduled++;
        }
      } else if (await failTrigger(journal, id, def, state, now, `the trigger's stored next time is not a number (${String(state.nextRunAt)}). Call scheduleWorkflow again for this id (a restart that registers it does): its time is set from the definition. Or pass onInvalidTime: 'repair' to the scheduler.`)) {
        console.warn(`[scheduler] trigger ${id} has no valid next time (${String(state.nextRunAt)}) — marked failed, not fired.`);
        out.failed++;
      }
      continue;
    }
    if (!isDue(state, now)) continue;
    // Its fire is in hand here: the state moves when that fire ends, and the next occurrence is decided then.
    if (slots.inFlight.has(id)) continue;
    due.push({ id, def, state });
  }
  // THE OLDEST DUE OCCURRENCE FIRST: when the slots are fewer than the due triggers, the one that has
  // waited longest takes the next free slot — the order of ids in the journal never starves a trigger.
  due.sort((x, y) => x.state.nextRunAt - y.state.nextRunAt);
  for (const { id, def, state: decided } of due) {
    let state = decided;
    // GRACEFUL DRAIN (@gnldev/durable drainProcess): a process shutting down fires nothing new. The
    // trigger stays due; a process that is not leaving fires it.
    if (isDraining()) break;
    // Every slot busy: the triggers still due stay due, untouched, for the next poll.
    if (slots.inFlight.size >= slots.limit) break;

    const runId = `sched:${id}:${state.fireCount}`;
    // The fire lock, on its OWN key — see FIRE_LOCK. `runId` below is the RUN's name and is passed to
    // the runner untouched; the two must not be the same lock.
    // The fire lock names this process: `acquireRunLock` binds the store's liveness itself (run-lock.ts),
    // so a frozen holder keeps it and a dead one loses it at once, whatever component attached first.
    // Dated on the store's clock (run-lock.ts H2), not this poll's `now`: `now` was read at the start of
    // the poll, before every earlier fire of it ran — a lock dated by it was born expired behind a long one.
    const lock = await acquireRunLock(journal, FIRE_LOCK(runId), owner, lockTtlMs);
    if (lock) {
      // THE DECISION, CONFIRMED UNDER THE LOCK — one CAS against the state it was made from, which also
      // freezes the occurrence (`slotToFire`; kept if already frozen): every later attempt of this run id
      // — a retry, a resume, another poller after a takeover — is told the same one. The state was read
      // BEFORE the lock: another poller may have fired this occurrence, committed and released in
      // between, and taking the released lock is not permission to start it again (measured: the same
      // run id started twice, k4 S5b/S5c). A lost CAS means exactly that — decided again on the next poll.
      const plan = state.slot === undefined ? slotToFire(def, state.nextRunAt, now) : undefined;
      const frozen: TriggerState = plan === undefined ? state
        : plan.fire === undefined ? { ...state, nextRunAt: plan.resume } // nothing runs: the calendar goes on
        : { ...state, slot: plan.fire, resumeAt: plan.resume };
      const confirmed = await writeTrigger(journal, id, def, frozen, state);
      if (!confirmed) {
        await lock.release();
        continue;
      }
      if (plan?.dropped) {
        console.warn(`[scheduler] trigger ${id}: ${plan.dropped.count} missed occurrence(s) were not run because of maxCatchup ${def.maxCatchup} — the oldest was ${new Date(plan.dropped.oldest).toISOString()}.`);
      }
      if (plan !== undefined && plan.fire === undefined) {
        await lock.release();
        out.rescheduled++;
        continue;
      }
      state = confirmed;
    }
    const slot = state.slot ?? state.nextRunAt;
    if (!lock) {
      // SESSİZ DEĞİL: bu dal `out.skipped`'a da yazmıyordu, log da basmıyordu — yani zamanlanmış bir
      // tetik atlandığında hiçbir iz kalmıyordu. Atlama DOĞRU (başka bir poller o ateşlemeyi tutuyor),
      // ama görünmez olması "sessiz-VE-görünmez hiçbir şey olamaz" kuralının ihlali: operatör
      // "tetik çalışmadı mı, atlandı mı, çakıştı mı" sorusunu cevaplayamıyordu.
      out.skipped++;
      continue;
    }

    // Y2 (heartbeat): the lock TTL used to be a FIXED 60s that was never renewed — a workflow running
    // longer than that let the lock expire, a second poller took it over and fired the SAME trigger
    // again. The core's `RunLock.renew()` (run-lock.ts) exists exactly for this: "long-running jobs
    // should call this at an interval shorter than the ttl". We renew every ttl/3 for as long as the
    // trigger is in flight — the same pattern as @gnldev/queue's createWorker.
    // The renewal is this poller's RIGHT TO THE FIRE (@gnldev/durable executionGrant): a renew that
    // answers false (a real takeover) or throws three times in a row revokes it as `lease-lost`, and the
    // workflow this poller started is told through the runner's `signal` — it stops at its next step
    // boundary instead of running on beside the poller that took the lock (it used to: the CAS below
    // covered the write, not the execution). The STATE WRITES are still gated by the CAS in `commit`,
    // which decides atomically at write time; the grant decides whether this poller keeps executing.
    const grant = executionGrant(`[scheduler] trigger ${id}, run ${runId}`, { unheededAfterMs: lockTtlMs, unheeded: UNHEEDED });
    grant.keep(() => lock.renew(lockTtlMs), {
      everyMs: lockTtlMs / 3,
      onTransient: (err) => console.warn(`[scheduler] renew transient error (trigger ${id}), the next tick will retry:`, err),
    });

    // Fencing: every state write is a CAS against the state we read AT THE START of this fire
    // (`expected = state`). CAS — not a "do I still hold the lock?" hunch — is the AUTHORITY FOR THE
    // WRITE (and only for the write; execution is not fenced, see the KNOWN LIMIT above): the
    // lock is advisory and any ownership check is inherently a read at a point in time (it can go
    // stale between the check and the write), whereas putIfMatch decides ATOMICALLY at write time,
    // inside the journal. If somebody else advanced the trigger (took the fire over and wrote its
    // own result), our record no longer matches and this write is REJECTED — a late poller can no
    // longer roll fireCount/nextRunAt back or resurrect `attempts`. The write of the poller that
    // genuinely holds the lock always matches, so a correct poller is never blocked.
    // Every state the poller writes names the definition it was computed from (see writeTrigger), so
    // a state the poller has touched once is never mistaken for a half-written one.
    //
    // PAUSED DURING THE FIRE is the one lost CAS that is not a competing poller: `pauseTrigger` changed
    // only the status, so the counter and attempts this fire was computed from are still the stored ones.
    // The outcome is then recorded UNDER the pause (counter advanced, still paused) — discarding it would
    // make resume fire the same run id again, a finished run replayed instead of the next occurrence.
    const commit = async (computed: TriggerState, what: string): Promise<boolean> => {
      if (await writeTrigger(journal, id, def, computed, state)) return true;
      const current = await journal.get<TriggerState>(STATE(id));
      if (current?.status === 'paused' && current.fireCount === state.fireCount && current.attempts === state.attempts) {
        const underPause: TriggerState = { ...computed, status: computed.status === 'pending' ? 'paused' : computed.status };
        if (await writeTrigger(journal, id, def, underPause, current)) return true;
      }
      console.warn(`[scheduler] stale state write rejected (trigger ${id}, ${what}) — another poller advanced this trigger; this poller's result is DISCARDED.`);
      return false;
    };

    // THE FIRE IN HAND, from here to its lock's release (@gnldev/durable `holdWhile`): a drain waits for it,
    // and `gnl pending` lists it — from this process, or from its shadow in another. The unit IS this block:
    // it ends when the block does, on every way out (each `return` below goes on to the next trigger), and
    // the workflow runs as part of it — a drain from inside the fire does not wait for itself (R2-7).
    slots.inFlight.add(id);
    fires.push(holdWhile(async (): Promise<void> => {
      try {
        // 1.4: optional budget/quota hook — checked before runner.runWorkflow is CALLED.
        if (opts.budgetGuard) {
          try {
            await opts.budgetGuard({
              triggerId: id, workflowName: def.name, input: def.input, now,
              ...(def.orgId !== undefined ? { orgId: def.orgId } : {}),
              ...(def.resourceId !== undefined ? { resourceId: def.resourceId } : {}),
            });
          } catch (e) {
            // attempts DOES NOT increase; the diagnostic record is only written if the CAS was won (a
            // stale poller must not leave a budget-skip note on someone else's fire either).
            if (await commit({ ...state, nextRunAt: now + retryMs }, 'budget-skip')) {
              await journal.put(BUDGET_SKIP(id), { error: String((e as any)?.message ?? e), at: now });
              out.skipped++;
            }
            return;
          }
        }
        let result: { suspended?: boolean; output?: unknown };
        try {
          // Inside this try on purpose: a trigger whose organization cannot be reached fails like any other
          // fire — counted, retried, and written to `sched:fail:` — instead of running where it does not belong.
          const target = def.orgId === undefined ? runner : opts.runnerForOrg?.(def.orgId);
          if (!target) {
            throw new Error(
              `@gnldev/scheduler: trigger '${id}' belongs to organization '${def.orgId}', and this scheduler has no runnerForOrg — ` +
              `it was NOT run on the organization-less runner, where that organization could not see it. Pass runnerForOrg to createScheduler/pollScheduler.`,
            );
          }
          // The fire runs AS the trigger's recorded owner (ADR-0002): the caller is decided here, once,
          // from the definition — the runner does not get to pick it, and forgetting it cannot happen.
          // The scheduler composed `sched:<trigger>:<fire>`, so the scheduler begins it, here, for the
          // trigger's owner (run-id-grammar.ts `begin: 'composer'`) — as the queue begins a job's run at
          // its lease. The runner is handed a run that exists and continues it, whatever it is: createGnl,
          // a wrapper, a runDurable of its own. A stranger who named the id first could not have begun it.
          // In the organization's run space, where the runner for that organization keeps its runs.
          const caller = callerOfTrigger(def);
          await claimRunOwner((def.orgId !== undefined ? withOrg(journal, def.orgId) : journal) as never, runId, caller, composerMark(runId));
          await (def.orgId !== undefined ? withOrg(journal, def.orgId) : journal).putIfAbsent(FIRE_AT(runId), slot);
          result = await target.runWorkflow(def.name, def.input, { runId, caller, scheduledFor: slot, signal: grant.signal });
        } catch (e) {
          // DEFERRAL, not attempt: the run is already in flight elsewhere — the engine refused this poller AT
          // LOCK ACQUISITION, before the run did anything. Nothing was tried and nothing went wrong; counting it
          // against `maxAttempts` is how a busy minute became a permanently dead trigger (the live finding:
          // five deferrals spent as five failures). A MID-FLIGHT RunBusyError (this poller got in, ran, and was
          // fenced out) is an ordinary failure: something did happen, and it is worth a retry budget.
          // `attempts` is untouched, `status` stays 'pending', and — this is the half that cost the live
          // investigation its diagnosis — NOTHING is written to `sched:fail:`. That record is where an
          // operator reads WHY a trigger died, and a run-busy message answers a question nobody asked
          // while burying the answer to the one they did (the live record said "already running"; the
          // real reason the workflow could not run was never written down anywhere).
          //
          // Not silent, though: a deferral that repeats forever is a trigger that never fires, so the
          // record carries a RUNNING TOTAL (never reset — a lifetime count is the number an operator can
          // compare against `fireCount`). There is no cap on purpose: "wait for the other holder" has no
          // honest deadline, and the other side is already bounded by its own lock TTL.
          // WHETHER IT COUNTS (@gnldev/durable `attemptEndOf` — the one answer the queue gives too).
          const end = attemptEndOf(e, runId);
          // RELEASED, not failed: this process drains ("another process continues it") or cannot judge other
          // processes right now. Nothing is written — the trigger stays due, its attempts as they were — and a
          // process that is not leaving fires it (the same run id: it continues from its journal). Counted, a
          // drain failed the trigger for good on its last attempt (audit C5).
          if (end === 'released') {
            out.skipped++;
            return;
          }
          // ITS RUN WAS DELETED: no fire can run it again under this id — the trigger fails now, with
          // that error, instead of spending its attempts on a run that no longer runs.
          if (end === 'erased') {
            if (await commit({ ...state, attempts: state.attempts + 1, status: 'failed' }, 'failed')) {
              await journal.put(FAIL(id), { error: String((e as any)?.message ?? e), at: now, erased: true });
              out.failed++;
            }
            return;
          }
          if (end === 'deferred') {
            if (await commit({ ...state, nextRunAt: now + retryMs }, 'run-busy-skip')) {
              const prev = await journal.get<{ deferrals?: number }>(BUSY_SKIP(id));
              await journal.put(BUSY_SKIP(id), {
                error: String((e as any)?.message ?? e),
                at: now,
                runId,
                deferrals: (prev?.deferrals ?? 0) + 1,
              });
              out.skipped++;
            }
            return;
          }
          const attempts = state.attempts + 1;
          if (attempts >= def.maxAttempts) {
            if (await commit({ ...state, attempts, status: 'failed' }, 'failed')) {
              await journal.put(FAIL(id), { error: String((e as any)?.message ?? e), at: now });
              out.failed++;
            }
          } else if (await commit({ ...state, attempts, nextRunAt: now + backoff(attempts) }, 'retry')) {
            out.rescheduled++;
          }
          return;
        }

        if (result.suspended) {
          // workflow suspended → the same runId should be resumed later (fireCount unchanged).
          if (await commit({ ...state, nextRunAt: now + retryMs }, 'suspended')) out.rescheduled++;
        } else if (def.kind === 'at') {
          if (await commit({ ...state, status: 'done' }, 'done')) out.fired++;
        } else {
          const next: TriggerState = {
            nextRunAt: state.resumeAt ?? slotAfter(def, slot),
            attempts: 0,
            fireCount: state.fireCount + 1,
            status: 'pending',
          };
          if (await commit(next, 'reschedule')) out.fired++;
        }
      } finally {
        // MUST run BEFORE release(): release() keeps the SAME fencing token (it only pushes `expires`
        // into the past), so a heartbeat tick that survives this fire would find its own token still in
        // the record and RESURRECT the lock it just released (expires: 0 → now+ttl) — blocking every
        // later poll of the same runId (a suspended trigger's resume, most visibly). Pinned by test.
        await grant.dispose();
        // If the lock was genuinely taken over, release() is a no-op anyway (the fencing token no
        // longer matches — run-lock.ts mkLock.release), so we never free somebody else's lock.
        await lock.release();
      }
    }, { journal, name: runId, what: `trigger '${id}' is firing`, ...(def.orgId !== undefined ? { scope: def.orgId } : {}) })
      .finally(() => slots.inFlight.delete(id)));
  }
  return fires;
}

/** THE ONE ANSWER to "does this trigger fire now" — read by the poller, and by nothing that writes. */
function isDue(state: TriggerState, now: number): boolean {
  // Time only. Whether the stored trigger CAN fire is asked first, of every pending trigger (pollScheduler).
  return now >= state.nextRunAt;
}

/** The reason, with the way out, for a stored definition that cannot fire. */
function invalidDefinitionError(problem: string): string {
  return `the trigger definition cannot fire: ${problem}. Call scheduleWorkflow again with a valid spec for this id; it replaces the stored definition.`;
}

/** What the poller does with a valid trigger whose stored next time is not a number. */
export type InvalidTimePolicy = 'fail' | 'repair';

function invalidTimePolicy(v: unknown, fn: string): InvalidTimePolicy {
  if (v === undefined) return 'fail';
  if (v === 'fail' || v === 'repair') return v;
  throw new TypeError(`@gnldev/scheduler: ${fn} — onInvalidTime must be 'fail' or 'repair', got ${JSON.stringify(v)}.`);
}

/**
 * The ONE way the poller fails a stored trigger it cannot fire: the state goes `failed` (through
 * writeTrigger, a CAS against the state read) and the reason, with the way out, is the trigger's
 * `lastError` in listTriggers and Studio. `false` when another poller changed the state first.
 */
async function failTrigger(journal: Journal, id: string, def: TriggerDef, state: TriggerState, now: number, error: string): Promise<boolean> {
  if (!(await writeTrigger(journal, id, def, { ...state, status: 'failed' }, state))) return false;
  await journal.put(FAIL(id), { error, at: now });
  return true;
}

/** Introspection view of a single trigger (for the Studio Scheduler view). */
export interface TriggerInfo {
  id: string;
  name: string;
  kind: Kind;
  /** kind='at' → absolute time (epoch ms); kind='every' → period (ms); kind='cron' → 5-field cron expression. */
  value: number | string;
  input?: unknown;
  /** Next (planned) fire time, epoch ms — if in the past, the trigger is due/overdue. */
  nextRunAt: number;
  attempts: number;
  maxAttempts: number;
  fireCount: number;
  /** `'paused'`: kept, not fired, until `resumeTrigger`. A removed trigger is not listed at all. */
  status: 'pending' | 'done' | 'failed' | 'paused';
  misfire: MisfirePolicy;
  /** The IANA zone a cron is read in; absent = UTC. */
  tz?: string;
  /** The end user this trigger works for (absent: the system's). */
  resourceId?: string;
  /** The organization this trigger works in. */
  orgId?: string;
  /** Set when `moveTrigger` retired this trigger: the owned id that replaced it. */
  movedTo?: string;
  /** Last error if status='failed' (if any, from `sched:fail:<id>`). */
  lastError?: string;
  lastErrorAt?: number;
  /**
   * How many times this trigger was DEFERRED because the run was already in flight elsewhere
   * (`sched:busy-skip:<id>`, lifetime total). Absent when it has never happened.
   *
   * On this list a deferred trigger is otherwise indistinguishable from a healthy one — 'pending',
   * with a nextRunAt in the near future, forever. That is the shape of a trigger that has not run in
   * a week and looks fine, so the count is here rather than only in the journal. Compare it against
   * `fireCount`: a number that keeps climbing while fireCount does not is a trigger that is being
   * refused, not one that is waiting.
   */
  deferrals?: number;
  lastDeferralAt?: number;
}

/**
 * READ-ONLY trigger listing from the journal, WITHOUT needing a scheduler INSTANCE or a runner (for
 * Studio introspection). Reads the SAME `sched:def:`/`sched:state:` keys (+ `sched:fail:` for 'failed')
 * as `pollScheduler`; does NOT change any state, does not take a lock, does not run a workflow. Returns
 * results sorted alphabetically by id (stable list order).
 */
export async function listTriggers(journal: Journal): Promise<TriggerInfo[]> {
  journal = rootJournal(journal, 'listTriggers');
  const defKeys = await journal.listKeys('sched:def:');
  const out: TriggerInfo[] = [];
  for (const dkey of defKeys) {
    const id = dkey.slice('sched:def:'.length);
    const def = await journal.get<TriggerDef>(DEF(id));
    const state = await journal.get<TriggerState>(STATE(id));
    if (!def) continue;
    if (!state) {
      // A definition whose state is gone (a too-wide purge or a retention sweep) does not fire, and was
      // dropped here as a "partial record" — invisible in Studio too. Shown as failed, with the way out;
      // nothing is written (see pollScheduler). An invalid one gets its own state from the poller.
      const problem = definitionProblem(def);
      out.push({
        id, name: def.name, kind: def.kind, value: def.value, input: def.input,
        nextRunAt: 0, attempts: 0, maxAttempts: def.maxAttempts, fireCount: 0, status: 'failed', misfire: misfireOf(def),
        ...(def.tz !== undefined ? { tz: def.tz } : {}),
        ...(def.resourceId !== undefined ? { resourceId: def.resourceId } : {}),
        ...(def.orgId !== undefined ? { orgId: def.orgId } : {}),
        lastError: problem !== undefined
          ? invalidDefinitionError(problem)
          : 'its state is missing (a too-wide purge or a retention sweep is the usual cause), so it does not fire. scheduleWorkflow for this id repairs it — a host that registers its triggers on boot does it on the next start.',
      });
      continue;
    }
    if (state.status === 'removed') continue; // unscheduled: gone, whatever records it left behind
    const info: TriggerInfo = {
      id,
      name: def.name,
      kind: def.kind,
      value: def.value,
      input: def.input,
      nextRunAt: state.nextRunAt,
      attempts: state.attempts,
      maxAttempts: def.maxAttempts,
      fireCount: state.fireCount,
      status: state.status,
      misfire: misfireOf(def),
      ...(def.tz !== undefined ? { tz: def.tz } : {}),
      ...(def.resourceId !== undefined ? { resourceId: def.resourceId } : {}),
      ...(def.orgId !== undefined ? { orgId: def.orgId } : {}),
      ...(state.movedTo !== undefined ? { movedTo: state.movedTo } : {}),
    };
    if (state.status === 'failed') {
      const fail = await journal.get<{ error: string; at: number }>(FAIL(id));
      if (fail) {
        info.lastError = fail.error;
        info.lastErrorAt = fail.at;
      }
    }
    // Read on EVERY status, not just 'failed': a deferred trigger is 'pending' by definition, so
    // gating this the way `lastError` is gated would hide it on exactly the rows that carry it.
    const busy = await journal.get<{ at: number; deferrals?: number }>(BUSY_SKIP(id));
    if (busy?.deferrals) {
      info.deferrals = busy.deferrals;
      info.lastDeferralAt = busy.at;
    }
    out.push(info);
  }
  return out.sort((a, b) => a.id.localeCompare(b.id));
}

/** What `upgradeTriggers` did (or, with `dryRun`, would do). */
export interface UpgradeTriggersResult {
  dryRun: boolean;
  /** The ids of the triggers whose stored `misfire: 'skip'` was (would be) rewritten to "the default". */
  migrated: string[];
}

/**
 * THE MIGRATION for triggers stored by 0.16, which wrote `misfire: 'skip'` whether the caller named a
 * policy or not (it could not tell the two apart). Each becomes "none named": the record says "default"
 * and the trigger follows the default, `'latest'` — after an outage it fires the LATEST missed
 * occurrence, not the oldest as 'skip' did (`misfire: 'earliest'` is that policy now). The definition
 * and its state (which names the definition it was computed for) are rewritten as one unit. Idempotent:
 * a second run finds nothing. Run it once every 0.16 poller is gone: that poller reads a record without
 * a policy as one that cannot fire and fails the trigger. (This version's poller reads a stored 'skip'
 * as "none named" itself, so a trigger not yet migrated keeps firing.)
 */
export async function upgradeTriggers(journal: Journal, opts: { dryRun?: boolean } = {}): Promise<UpgradeTriggersResult> {
  refuseUnknownNames('upgradeTriggers', opts, UPGRADE_TRIGGERS_OPTS_NAMES);
  journal = rootJournal(journal, 'upgradeTriggers');
  const dryRun = opts.dryRun === true;
  const migrated: string[] = [];
  for (const dkey of await journal.listKeys('sched:def:')) {
    const id = dkey.slice('sched:def:'.length);
    const stored = await journal.get<TriggerDef>(DEF(id));
    if (stored === undefined || (stored.misfire as unknown) !== LEGACY_MISFIRE) continue;
    migrated.push(id);
    if (dryRun) continue;
    const def = asSpecified(stored);
    const state = await journal.get<TriggerState>(STATE(id));
    if (state !== undefined) await writeTrigger(journal, id, def, state);
    else await journal.put(DEF(id), def);
  }
  // Last: no 0.16 record is left, so the note a poller left for this (`noteLegacyMisfire`) goes.
  if (!dryRun) await clearUpgradeDue(journal, MISFIRE_STEP);
  return { dryRun, migrated: migrated.sort() };
}


/**
 * `upgradeTriggers` as an upgrade step: `registerUpgradeSteps(storage, [schedulerUpgrade])`. The step
 * is that function — pending/plan/run only report and run it, nothing is decided here.
 * `afterOlderGone`: a 0.16 poller treats the rewritten records as ones that cannot fire.
 */
export const schedulerUpgrade: UpgradeStepFactory = (storage) => {
  const journal = toJournal(storage);
  const triggers = async (dryRun: boolean) => ({ triggers: (await upgradeTriggers(journal, { dryRun })).migrated });
  const step: UpgradeStep = {
    name: MISFIRE_STEP,
    description: "rewrites the misfire 0.16 stored as 'skip' to \"the default\" (the latest missed occurrence fires, not the oldest)",
    // It reads the triggers: asked only once the store is in this version's format (an earlier one's
    // refuses the read), as the queue's step is.
    requires: ['schema'],
    afterOlderGone: true,
    pending: async () => (await triggers(true)).triggers.length > 0,
    plan: () => triggers(true),
    run: () => triggers(false),
  };
  return step;
};

// ─── Remove, pause, resume ─────────────────────────────────────────────────────────────────────

/**
 * Names a scheduled trigger the way `scheduleWorkflow` named it: the `id` you gave (or the workflow
 * name, if you gave none), within its owner — pass the same `caller` / `resourceId` / `orgId`.
 */
export interface TriggerRef {
  id: string;
  caller?: Caller;
  resourceId?: string;
  orgId?: string;
}

/** What a transition does to a trigger: a new state, or an answer without a write. */
type Decision = TriggerState | boolean;

/**
 * Every operator transition, one way: read both halves, decide, write the state through `writeTrigger`
 * as a CAS against what was read. A lost CAS (a poller recorded a fire in between) re-reads and decides
 * again on the new state, so a transition never overwrites a fire it did not see — the fire counter in
 * particular never moves backwards, which would point a later fire at a finished run.
 */
async function transitionTrigger(
  journal: Journal,
  fn: string,
  ref: TriggerRef,
  decide: (def: TriggerDef, state: TriggerState) => Decision,
): Promise<{ id: string; def?: TriggerDef; state?: TriggerState; done: boolean }> {
  journal = rootJournal(journal, fn);
  if (typeof ref?.id !== 'string' || ref.id === '') {
    throw new TypeError(`@gnldev/scheduler: ${fn} needs the trigger's id (a non-empty string) — the one scheduleWorkflow was given, or the workflow name.`);
  }
  const owner = triggerOwnerOf(ref);
  if (owner.orgId !== undefined) orgPrefix(owner.orgId);
  const id = ownedName(ref.id, { resourceId: owner.resourceId, orgId: owner.orgId });
  for (let tries = 0; tries < 8; tries++) {
    const def = await journal.get<TriggerDef>(DEF(id));
    const state = await journal.get<TriggerState>(STATE(id));
    if (!def || !state) return { id, ...(def ? { def } : {}), done: false };
    const next = decide(def, state);
    if (typeof next === 'boolean') return { id, def, state, done: next };
    if (await writeTrigger(journal, id, def, next, state)) return { id, def, state: next, done: true };
  }
  throw new Error(`@gnldev/scheduler: ${fn}('${id}') — the trigger's state changed on every one of 8 reads (a poller firing it in a tight loop?). Nothing was changed; call it again.`);
}

/**
 * Removes a trigger: it never fires again and `listTriggers` no longer shows it. Returns `true` when it
 * was removed by this call, `false` when there was nothing to remove (no such trigger, or already removed).
 *
 * A fire already in flight finishes — the run is not aborted — and its result is not recorded: the
 * removal wins the state's CAS, so a late fire cannot bring the trigger back.
 *
 * The record stays as a tombstone (`status: 'removed'`) rather than being deleted: deleting the two
 * halves is two writes, and a definition left without its state is what the next boot's
 * `scheduleWorkflow` repairs — the trigger would come back. Calling `scheduleWorkflow` for the id again
 * is a new trigger (any spec), with run ids the removed one never used. If your boot code registers the
 * trigger, remove that registration too, or the next boot schedules it again — which is what it says.
 * `triggerEraser` deletes a person's tombstones with the rest of their triggers.
 */
export async function unscheduleWorkflow(journal: Journal, ref: TriggerRef): Promise<boolean> {
  const r = await transitionTrigger(journal, 'unscheduleWorkflow', ref, (_def, state) =>
    state.status === 'removed' ? false : { ...state, status: 'removed' });
  if (!r.done && r.def !== undefined && r.state === undefined) {
    // A definition whose state was lost (a too-wide purge): invisible now, re-created by the next boot.
    // Write the tombstone so it stays removed.
    await writeTrigger(journal, r.id, r.def, { nextRunAt: 0, attempts: 0, fireCount: await fireCountAfterLoss(journal, r.id), status: 'removed' });
    return true;
  }
  return r.done;
}

/**
 * Stops a trigger from firing until `resumeTrigger`, keeping its schedule, counter and attempts.
 * Returns `true` when the trigger is paused (also when it already was), `false` when there is nothing
 * to pause: no such trigger, or one that is removed, `done` or `failed`.
 *
 * Re-registering the same spec on boot does not lift a pause, and neither does `ifExists: 'replace'`.
 * A fire already in flight finishes and is recorded under the pause (its counter advances, the
 * trigger stays paused), so resuming never runs that occurrence a second time.
 */
export async function pauseTrigger(journal: Journal, ref: TriggerRef): Promise<boolean> {
  return (await transitionTrigger(journal, 'pauseTrigger', ref, (_def, state) =>
    state.status === 'paused' ? true : state.status !== 'pending' ? false : { ...state, status: 'paused' })).done;
}

/**
 * Lets a paused trigger fire again. Returns `true` when it is pending (also when it was not paused),
 * `false` when there is nothing to resume: no such trigger, or one that is removed, `done` or `failed`.
 *
 * NO CATCH-UP. The occurrences that fell inside the pause are not run, whatever `misfire` says: the
 * pause was the decision not to run them, and `misfire` is for occurrences missed because no poller
 * ran. The next fire is the schedule's first slot after `now` — on the same grid for `every`, the next
 * match for `cron`. A one-shot (`at`) whose time passed during the pause fires once, right away:
 * skipping its only occurrence would be deleting it.
 */
export async function resumeTrigger(journal: Journal, ref: TriggerRef, now: number = Date.now()): Promise<boolean> {
  return (await transitionTrigger(journal, 'resumeTrigger', ref, (def, state) => {
    if (state.status === 'pending') return true;
    if (state.status !== 'paused') return false;
    return { ...state, status: 'pending', nextRunAt: resumedRunAt(def, state, now) };
  })).done;
}

/** The first slot after `now` (see `resumeTrigger`) — the schedule's grid, never the missed slots. */
function resumedRunAt(def: TriggerDef, state: TriggerState, now: number): number {
  if (def.kind === 'at' || state.nextRunAt > now) return state.nextRunAt;
  if (def.kind === 'every') {
    const interval = def.value as number;
    return state.nextRunAt + interval * (Math.floor((now - state.nextRunAt) / interval) + 1);
  }
  return nextCronTime(def.value as string, now, def.tz);
}

export interface Scheduler {
  poll(now?: number): Promise<PollResult>;
  start(): void;
  stop(): void;
}

/**
 * Scheduler that manages the poll loop (a self-rescheduling setTimeout chain) — the same pattern as
 * @gnldev/queue's createWorker. `backoff` (default OFF — timing is the scheduler's core contract, see the
 * trade-off below): IF ENABLED, when a poll fires NO triggers at all (`fired === 0`) the next poll
 * interval grows ×2 (cap: `maxPollMs ?? pollMs*32`) → prevents tens of thousands of empty queries per
 * second (poll storm) on an empty schedule table; the interval resets to `pollMs` once a trigger fires.
 * Trade-off: `backoff: true` cuts idle poll load by ~32x but can delay a trigger that becomes due after
 * a quiet period by up to `maxPollMs` — for timing-critical use (e.g. minute-level cron) the default
 * should stay OFF; only enable it for deployments with many idle-poller instances that can tolerate delay.
 */
export function createScheduler(
  journal: Journal,
  runner: WorkflowRunner,
  opts: { pollMs?: number; owner?: string; retryMs?: number; backoff?: boolean; maxPollMs?: number; budgetGuard?: BudgetGuard; lockTtlMs?: number; runnerForOrg?: RunnerForOrg; onInvalidTime?: InvalidTimePolicy; concurrency?: number } = {},
): Scheduler {
  refuseUnknownNames('createScheduler', opts, CREATE_SCHEDULER_OPTS_NAMES);
  journal = rootJournal(journal, 'createScheduler');
  const onInvalidTime = invalidTimePolicy(opts.onInvalidTime, 'createScheduler');
  const pollMs = opts.pollMs ?? 1000;
  const backoffOn = opts.backoff ?? false;
  const maxPollMs = opts.maxPollMs ?? pollMs * 32;
  const pollOpts: PollOptions = { owner: opts.owner, retryMs: opts.retryMs, budgetGuard: opts.budgetGuard, lockTtlMs: opts.lockTtlMs, runnerForOrg: opts.runnerForOrg, onInvalidTime };
  // ONE set of slots for this scheduler, across its ticks and its manual polls: the limit is per scheduler.
  const slots = fireSlots(opts.concurrency, 'createScheduler');
  const poll = async (now: number = Date.now()): Promise<PollResult> => {
    const out: PollResult = { fired: 0, rescheduled: 0, failed: 0, skipped: 0 };
    const ended = await Promise.allSettled(await dispatchDue(journal, runner, now, pollOpts, slots, out));
    const failed = ended.find((e): e is PromiseRejectedResult => e.status === 'rejected');
    if (failed) throw failed.reason;
    return out;
  };
  // A TICK DECIDES AND RETURNS: the fires it started run beside the loop (held — a drain waits for them),
  // so the next tick comes on time and a long fire does not hold up any other trigger. A fire's own
  // journal error is logged as a tick's was; it never stops the loop.
  const tick = async (): Promise<boolean> => {
    const fires = await dispatchDue(journal, runner, Date.now(), pollOpts, slots, { fired: 0, rescheduled: 0, failed: 0, skipped: 0 });
    for (const f of fires) f.catch((err) => console.warn('[scheduler] a fire failed outside the workflow (the trigger stays due):', err));
    return fires.length > 0;
  };

  // Phase 8.1: the tick/backoff/"polling" flag loop now lives in @gnldev/durable's shared createPollLoop
  // (it used to be triplicated across queue/events/scheduler) — behavior is identical: pollScheduler only
  // catches runWorkflow errors internally; the rest (journal I/O etc.) are logged and swallowed by
  // createPollLoop (the chain doesn't die). While `fired === 0` and backoffOn, the interval grows ×2
  // (cap maxPollMs); it resets to pollMs once something fires. Default backoff is OFF (see the comment
  // above — timing-critical).
  const loop = createPollLoop(tick, { pollMs, backoff: backoffOn, maxPollMs });

  return {
    poll,
    start: loop.start,
    stop: loop.stop,
  };
}

// ─── Upgrades and erasure ──────────────────────────────────────────────────────────────────────

/**
 * Give an existing SYSTEM trigger (an id written before triggers had owners) to an owner, without
 * doubling it.
 *
 * `scheduleWorkflow` stores an owned trigger under `ownedName(id, owner)`. A host that adds `orgId` (or
 * a user) to a spec it already scheduled gets a SECOND trigger on its next boot, and both fire. Call
 * this once per id during the upgrade, BEFORE the first boot with the new spec: the owned trigger gets
 * the old definition (plus the owner) and the old state — its next time, attempts and fire count — and
 * the old one is retired (`status: 'done'`, `movedTo`). The post-upgrade `scheduleWorkflow` then finds
 * the owned trigger and is a no-op.
 *
 * Returns the owned id, or `null` when there is no such trigger. Refuses an id that already has an owner.
 */
export async function moveTrigger(
  journal: Journal,
  fromId: string,
  to: Pick<ScheduleSpec, 'caller' | 'resourceId' | 'orgId'>,
): Promise<string | null> {
  refuseUnknownNames('moveTrigger', to, MOVE_TRIGGER_TO_NAMES);
  journal = rootJournal(journal, 'moveTrigger');
  const from = ownerOfName(fromId);
  if (from.resourceId !== undefined || from.orgId !== undefined) {
    throw new TypeError(`@gnldev/scheduler: moveTrigger('${fromId}') — that trigger already has an owner; only a system trigger is moved.`);
  }
  const owner = triggerOwnerOf(to);
  if (owner.resourceId === undefined && owner.orgId === undefined) {
    throw new TypeError('@gnldev/scheduler: moveTrigger needs an owner to move the trigger to (`caller`, `resourceId` or `orgId`).');
  }
  if (owner.orgId !== undefined) orgPrefix(owner.orgId);
  const def = await journal.get<TriggerDef>(DEF(fromId));
  const state = await journal.get<TriggerState>(STATE(fromId));
  if (!def || !state) return null;
  const toId = ownedName(fromId, { resourceId: owner.resourceId, orgId: owner.orgId });
  // Both halves of the owned trigger, or neither: a move that stopped between them is finished by
  // calling it again (a definition already there without its state is completed, not skipped).
  const toDef = await journal.get<TriggerDef>(DEF(toId));
  if (toDef === undefined || (await journal.get(STATE(toId))) === undefined) {
    const { resourceId: _r, orgId: _o, ownerKind: _k, ...rest } = def;
    // The run ids start over under the new id (`sched:<toId>:<n>`), so the count carries on without
    // pointing a fire at a run the old id already completed.
    const { movedTo: _m, of: _f, ...carried } = state;
    await writeTrigger(journal, toId, toDef ?? ({ ...rest, ...owner } satisfies TriggerDef), carried);
  }
  if (state.status === 'pending') {
    if (!(await writeTrigger(journal, fromId, def, { ...state, status: 'done', movedTo: toId }, state))) {
      throw new Error(`@gnldev/scheduler: moveTrigger('${fromId}') — the trigger fired while it was being moved; stop the pollers and run it again.`);
    }
  }
  return toId;
}

/** What `eraseSubject` and `purgeOrganization` (in `@gnldev/durable`) call to erase a person's, or a whole organization's, share of a package. */
export interface SubjectEraser {
  name: string;
  erase(owner: { resourceId: string; orgId?: string }): Promise<number>;
  eraseOrganization?(orgId: string): Promise<number>;
}

/**
 * Erase one person's triggers: definition (with its `input`), state, failure and skip records, and the
 * fire locks (`sched:<id>:<n>:fire:lock`, plus the fires' runs when the trigger has no organization).
 * Found by the id prefix the engine wrote (`ownedPrefix`), never by payload. The fires' runs in an
 * organization's journal carry the owner record, so `purgeResource` (called by `eraseSubject`) takes them.
 *
 * Refuses a journal that cannot `deletePrefix` rather than report a partial erasure as done. Handed an
 * organization (`{ orgId }`, by `purgeOrganization`), it erases every trigger owned under it, its members' too.
 */
export function triggerEraser(journal: Journal): SubjectEraser {
  journal = rootJournal(journal, 'triggerEraser');
  // One body for a person and an organization: what differs is the owner's prefix (`ownedPrefix`).
  const eraseOwned = async (owner: { resourceId?: string; orgId?: string }): Promise<number> => {
    const del = journal.deletePrefix.bind(journal);
    const prefix = ownedPrefix(owner);
    let n = 0;
    for (const fam of ['sched:def:', 'sched:state:', 'sched:fail:', 'sched:budget-skip:', 'sched:busy-skip:', 'sched:']) {
      n += await del.call(journal, `${fam}${prefix}`);
    }
    return n;
  };
  return {
    name: 'triggers',
    erase: (owner) => eraseOwned(owner),
    eraseOrganization: (orgId) => eraseOwned({ orgId }),
  };
}

export async function scheduledForOf(ctx: { journal: Pick<Journal, 'get'>; runId: string }): Promise<number | undefined> {
  return ctx.journal.get<number>(FIRE_AT(ctx.runId));
}
