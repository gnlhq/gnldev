// @gnldev/queue — durable background-task queue + worker on top of WorkStore.
// Each job runs as a DURABLE run (the handler typically calls runDurable(runId:'job:'+id)) →
// if the worker crashes mid-job the lock goes stale → reclaim → handler runs again → runDurable
// resumes from the RunJournal → SIDE EFFECT HAPPENS ONCE. acquireRunLock (M4) prevents two workers
// from running the same job concurrently.
// Job log + markers live in WorkStore (own namespace); the lock + handler's durability live in RunJournal.
import { randomUUID } from 'node:crypto';
import {
  acquireRunLock, requireCapability, createPollLoop, orgPrefix, withOrgStorage, orgStorageScopeOf, ownedName, ownedPrefix,
  claimRunOwner, composerMark, runDurable, user, staff, UNKNOWN, toJournal, ownerOfName, assertRootWorkForErasure, portOf, storageOf,
  processLiveness, storeLiveness, isProcessLocal, isDraining, LivenessRequiredError, attemptEndOf, holdWhile, settledExceptOwn, handNamePrefix, executionGrant,
  refuseRunIdThatCannotBeBorn, storageOfWork, isStorage, takeReadyHeld, letGoReady, reclaimReady, markUpgradeDue, clearUpgradeDue } from '@gnldev/durable';
import type { Storage, WorkStore, RunJournal, LogRecord, Caller, RunDurableArgs, DurableResult, ProcessLiveness, Page, ReadyTaken, WorkRecord, ReadyEntry, UpgradeStep, UpgradeStepFactory, UnheededText } from '@gnldev/durable';
import { refuseUnknownNames } from '@gnldev/options';
import { ENQUEUE_OPTIONS_NAMES, ENQUEUE_MANY_JOB_NAMES, RETRY_JOB_OPTS_NAMES, CREATE_WORKER_OPTS_NAMES, CREATE_QUEUE_OPTS_NAMES, MOVE_JOB_TO_NAMES, LIST_JOBS_OPTS_NAMES, LIST_ALL_JOBS_OPTS_NAMES } from './option-names.js';

/** What `ctx.run` takes: `runDurable`'s arguments without the four the job already decides. */
export type JobRunArgs = RunDurableArgs extends infer A ? (A extends unknown ? Omit<A, 'journal' | 'runId' | 'caller' | 'resourceId'> : never) : never;

export interface JobCtx {
  /**
   * RunJournal for the job's own durable runId ('job:<id>'). Scoped to `orgId` when the job has one,
   * so the run lands in that organization.
   */
  journal: RunJournal;
  jobId: string;
  /**
   * The job's durable run: `job:<jobId>`, or — for a job made by `retryJob` — the run of the dead letter
   * it retries, so the journal replays what that run already did.
   */
  runId: string;
  /**
   * WHO the job runs for, read once from the owner recorded when the job was enqueued: the user
   * (`user(resourceId, orgId)`), staff when it was enqueued with `caller: staff()`, else `unknown`.
   * The worker records it as the owner of `runId` BEFORE the handler runs, so a run started on `runId`
   * as anyone else is refused instead of being born ownerless.
   */
  caller: Caller;
  /**
   * Start (or resume) the job's durable run as its owner: `runDurable` on `journal` + `runId` with
   * `caller` bound. Nothing to pass on by hand.
   */
  run(args: JobRunArgs): Promise<DurableResult>;
  /** The organization this job was enqueued for. */
  orgId?: string;
  /**
   * The worker's storage, scoped to `orgId` when the job has one — build the organization's instance
   * from it. Not for follow-up jobs: its work store is the organization's, which no worker polls.
   */
  storage: Storage;
  /**
   * Enqueue a follow-up job into the worker's own queue, for the same owner in the same organization
   * (both overridable). What `enqueue(ctx.storage.work, …)` looks like it does, and did not.
   */
  enqueue(type: string, payload: unknown, opts?: EnqueueOptions): Promise<string>;
  /**
   * Aborted when this worker's right to run the job ends, with an `ExecutionRevokedError` saying why
   * (`reason.why`): `canceled` (`cancelJob`), `lease-lost` (another worker holds the job now: stop, it
   * continues there), `timeout` (`maxHoldMs`). Noticed on the heartbeat tick (every `ttlMs/3`; with
   * `heartbeat: false` only the time limit). `ctx.run` already passes it on to the run; a handler doing
   * other long work checks it itself. The framework cannot stop code that ignores the signal; keep side
   * effects inside `ctx.run` so a takeover does not repeat them. A handler still running `ttlMs` after
   * a `lease-lost` or `timeout` is warned about once (`console.warn`).
   */
  signal: AbortSignal;
}

/** Whose a job is. Kept beside the payload, never inside it: a payload is the handler's, this is the queue's. */
export interface JobOwner {
  resourceId?: string;
  orgId?: string;
}

export interface EnqueueOptions extends JobOwner {
  id?: string;
  maxDepth?: number;
  /**
   * Whose the job is, as an engine `Caller` (the value a door hands `runDurable`). `user(id, org)` is
   * the same as `{ resourceId, orgId }`; `staff(org?)` is an explicit operator/system job. With neither
   * this nor `resourceId`, the job's run is `unknown`: never staff by omission.
   */
  caller?: Caller;
  /**
   * Not before this time (epoch ms or a `Date`). Stored in the job record itself, so it is written in
   * the same append as the job: no crash can leave the job without it. Compared with the run journal's
   * clock when it has one (`now()`), else the worker's. An idempotent re-enqueue of the same id keeps
   * the first record's `runAt`.
   */
  runAt?: number | Date;
}

/**
 * A `qjob` log entry. The owner fields are written by `enqueue` only, beside the payload. `runId` is
 * written by `retryJob` only: the durable run the retried dead letter was using, which the retry
 * continues (absent → the job's own `job:<id>`).
 */
type JobRecord = { type: string; payload: unknown; ownerKind?: 'staff'; runId?: string; runAt?: number } & JobOwner;

/**
 * The per-job KV markers that make up a job's state. `qdone`/`qfail`/`qcancel` are terminal; `qtry` is
 * the attempt record (`TryRecord`); `qatt` is the attempt count a worker before 0.10 wrote; `qlate` is a
 * handler that finished after its worker lost the job (`recordLateSuccess`).
 * One list, read by `moveJob` (copies them) and `jobEraser` (deletes them, with the lease's `qown`).
 */
const STATE_MARKERS = ['qdone', 'qfail', 'qcancel', 'qatt', 'qtry', 'qlate'] as const;

/**
 * A job's attempts, in ONE record under its own key (`qtry`): how many STARTED, and after a failure the
 * earliest time of the next one. An attempt is counted when it starts, so one the process died in counts
 * too: counted when it failed, a job that killed its worker every time ran forever (measured: started 8
 * times with maxAttempts 3, attempts 0, still pending). One write, because WorkStore has no batch and two
 * keys (a count and a time) left a crash between them. `qatt`, the bare count a worker before 0.10
 * writes, is read and never written, so such a worker's attempts still count during a rolling deploy.
 */
type TryRecord = { attempts: number; notBefore: number };
async function attemptsOf(work: WorkStore, jobId: string): Promise<TryRecord> {
  return triesFrom(await work.get<TryRecord>(`qtry:${jobId}`), await work.get<unknown>(`qatt:${jobId}`));
}
/** The attempt record from its two keys as read (`qtry`, and 0.10's bare `qatt`): the one rule `attemptsOf` and `statusesOf` share. */
function triesFrom(t: TryRecord | undefined, old: unknown): TryRecord {
  return { attempts: Math.max(t?.attempts ?? 0, typeof old === 'number' ? old : 0), notBefore: t?.notBefore ?? 0 };
}

/**
 * Done, dead-lettered or cancelled — the ONE reading of "this job is finished", used by the worker
 * (before the lease and under it), `cancelJob`, and nowhere else.
 */
async function isTerminal(work: WorkStore, jobId: string): Promise<boolean> {
  return (
    (await work.get(`qdone:${jobId}`)) !== undefined ||
    (await work.get(`qfail:${jobId}`)) !== undefined ||
    (await work.get(`qcancel:${jobId}`)) !== undefined
  );
}

/**
 * The earliest time a job may run: the later of its `runAt` (in the record, set by `enqueue`) and the
 * retry delay in its attempt record (set by the worker after a failed attempt). The ONE reading of "when is this job
 * eligible" — a delayed job and a job in retry backoff are the same thing to the worker.
 */
async function notBeforeOf(work: WorkStore, job: LogRecord<JobRecord>): Promise<number> {
  const runAt = typeof job.payload.runAt === 'number' ? job.payload.runAt : 0;
  return Math.max(runAt, (await attemptsOf(work, job.id)).notBefore);
}

/** The durable run a job record executes as — the ONE reading (worker, `retryJob`). */
function runIdOfJob(job: LogRecord<JobRecord>): string {
  return typeof job.payload.runId === 'string' ? job.payload.runId : `job:${job.id}`;
}

/** The caller a job's recorded owner stands for — the ONE reading (worker, `ctx.enqueue`, `retryJob`). */
function callerOfJob(rec: JobRecord): Caller {
  if (typeof rec.resourceId === 'string' && rec.resourceId !== '') return user(rec.resourceId, rec.orgId);
  if (rec.ownerKind === 'staff') return staff(rec.orgId);
  return UNKNOWN;
}

/** The enqueue options that recreate a job's owner (a retry, or a follow-up's defaults). */
function ownerOptionsOf(rec: JobRecord): EnqueueOptions {
  return {
    ...(rec.resourceId !== undefined ? { resourceId: rec.resourceId } : {}),
    ...(rec.orgId !== undefined ? { orgId: rec.orgId } : {}),
    ...(rec.ownerKind === 'staff' ? { caller: staff(rec.orgId) } : {}),
  };
}

/** The owner fields a job record carries, from `enqueue`'s options. One owner per job. */
function jobOwnerOf(opts: EnqueueOptions): JobOwner & { ownerKind?: 'staff' } {
  const c = opts.caller;
  const cOrg = c === undefined || c.kind === 'unknown' ? undefined : c.orgId;
  const cRes = c?.kind === 'user' ? c.id : undefined;
  if (c !== undefined && ((opts.resourceId !== undefined && opts.resourceId !== cRes) || (opts.orgId !== undefined && cOrg !== undefined && opts.orgId !== cOrg))) {
    throw new TypeError('@gnldev/queue: a job was given both `caller` and a different `resourceId`/`orgId` — one owner per job.');
  }
  const resourceId = cRes ?? opts.resourceId;
  const orgId = cOrg ?? opts.orgId;
  return {
    ...(resourceId !== undefined ? { resourceId } : {}),
    ...(orgId !== undefined ? { orgId } : {}),
    ...(c?.kind === 'staff' ? { ownerKind: 'staff' as const } : {}),
  };
}

/**
 * The per-organization depth index: one small log per owner group, holding one record per job under
 * the job's own id. `maxDepth` counts this log, so the cost is O(min(depth, maxDepth)) pages of the
 * caller's OWN organization, never the whole shared queue. Under `org:<id>:` so that
 * `purgeOrganization` takes it with the organization; an owned record's id is the job's owned id,
 * so a person's erasure takes it too.
 */
const depthNs = (orgId: string | undefined) => (orgId === undefined ? 'qdepth' : `${orgPrefix(orgId)}qdepth`);

/**
 * THE ONE MAP FROM AN ORGANIZATION TO ITS LANE: the log its jobs are kept in, one per organization, and
 * `qlane` for jobs with none. Reading or listing an organization's jobs touches its own lane only, at a
 * cost that does not grow with any other organization's (N3). A lane is named by its organization's owned
 * prefix, which every job id of that organization starts with: a job's id names its lane (`laneOfJob`).
 */
const SYSTEM_LANE = 'qlane';
const laneOf = (orgId: string | undefined): string => (orgId === undefined ? SYSTEM_LANE : `${SYSTEM_LANE}:${ownedPrefix({ orgId })}`);
const laneOfJob = (id: string): string => laneOf(ownerOfName(id).orgId);
/**
 * WHERE A WORKER TAKES ITS NEXT JOB FROM: the store's ready set (`WorkStore.appendReady`), one entry per job
 * that is not finished, across every lane. One question per take — "the next job, fairly, and nobody
 * else's" — answered by the store in one write: the lowest rank, and every lane with work is served once
 * per round (the rank rule, `WorkStore.appendReady`). The worker used to read each lane from its cursor,
 * so an idle poll cost a query per organization, and before lanes one organization's 200 jobs stood in
 * front of another's one (N2). The entry is a turn, not ownership: the job's lease still decides who runs it.
 */
const READY = 'qready';
/** The one log every job was appended to before lanes (0.16 and earlier); `queue/lanes` moves it into the lanes. */
const LEGACY_LOG = 'qjob';
/** The read position 0.16's workers keep in that log ("every record before here is finished"). */
const LEGACY_CURSOR = 'qcursor';
/**
 * How far THIS version has moved that log into the lanes: every record before it is in its lane. A key of
 * its own — 0.16's workers read the log from `qcursor` while this version moves it, and neither moves the other's.
 */
const MOVE_CURSOR = 'qmovecursor';
/**
 * Records one read of the old log takes. The move cursor advances only past a full page (a store hands
 * out no cursor after its last record), so the records after it — fewer than this — are read again by the
 * next move and found in their lanes by a point read each.
 */
const MOVE_PAGE = 50;
/**
 * THE QUEUE'S DATA VERSION — the shape its jobs are stored in:
 *   1 = the one log (`qjob`, 0.16 and earlier): its jobs are in no lane, and this version's worker does not start;
 *   2 = lanes and a ready set, the old log still there — still written by a process of the earlier version
 *       in a deploy window, and moved by this version's workers as they find it (`queue/lanes` ran);
 *   3 = lanes only: the old log and its cursors are gone (`queue/lanes-cleanup` ran, once every earlier
 *       process was gone) and no worker of this version looks at it again.
 * Read from the data itself, with one record (`qversion`) for the one thing the data cannot say — that
 * the old log's jobs were moved, as opposed to never moved: `queueDataVersion`, the one reading.
 */
const QUEUE_DATA_VERSION = 3;
/** The first data version this version's worker takes jobs at: lanes. */
const LANES_DATA_VERSION = 2;
const DATA_VERSION_KEY = 'qversion';
/** Whether the earlier version's log holds a job: one record of it is enough. */
const legacyLogHolds = async (work: WorkStore): Promise<boolean> => (await work.list(LEGACY_LOG, { limit: 1 })).items.length > 0;
/**
 * The one reading of the store's queue data version. Nothing of the old log left (no record, no cursor
 * of either version): 3, whatever was recorded — a store this version wrote, or one cleaned up. Something
 * left: 2 once `queue/lanes` recorded that it moved the log, else 1 — and an old cursor with an empty log
 * is 2 as well (there is nothing to move, only to delete).
 */
async function queueDataVersion(work: WorkStore): Promise<number> {
  const oldLog = await legacyLogHolds(work);
  if (!oldLog && (await work.get(LEGACY_CURSOR)) === undefined && (await work.get(MOVE_CURSOR)) === undefined) return QUEUE_DATA_VERSION;
  const recorded = (await work.get<{ version: number }>(DATA_VERSION_KEY))?.version ?? 1;
  return oldLog && recorded < LANES_DATA_VERSION ? 1 : LANES_DATA_VERSION;
}
/** What this version's worker says on a store whose queue data is at v1 (it does not start). */
const DATA_VERSION_REFUSAL =
  `@gnldev/queue: this store's job data is at v1 (the one 'qjob' log of 0.16 and earlier); this version's worker needs v${LANES_DATA_VERSION} (lanes) ` +
  'and takes no job from that log. Run `gnl upgrade` once — it moves those jobs into lanes and is safe while workers and producers ' +
  "of the earlier version still run (in code: registerUpgradeSteps(storage, [queueUpgrade]) and storage.upgrade()) — then start this version's. " +
  'Once every process of the earlier version is gone, `gnl upgrade --only queue/lanes-cleanup` retires the old log.';
/**
 * The step a store's queue data at `version` waits for — `queue/lanes` at v1, `queue/lanes-cleanup` at v2 —
 * and the note a worker leaves for it (@gnldev/durable `markUpgradeDue`), so a `storage.upgrade()` on a
 * store where `queueUpgrade` is not registered says so instead of finding nothing to do. Each step clears
 * its own note as its last act (`moveLanes`, `cleanUpLanes`).
 */
/** What a job handler that ignores `ctx.signal` costs, for the warning `executionGrant` says (@gnldev/durable `UnheededText`). */
const UNHEEDED: UnheededText = {
  body: 'the handler',
  signal: 'ctx.signal',
  lost: 'Side effects outside ctx.run may be repeated by the worker that took it over.',
  timeout: 'The lease is kept until it returns, so nothing runs beside it; keep side effects inside ctx.run so a retry does not repeat them.',
};
const LANES_STEP = 'queue/lanes';
const CLEANUP_STEP = 'queue/lanes-cleanup';
const dueStepOf = (version: number): string => (version < LANES_DATA_VERSION ? LANES_STEP : CLEANUP_STEP);
const QUEUE_DUE = { by: '@gnldev/queue', register: 'registerUpgradeSteps(storage, [queueUpgrade])' } as const;
/** The storage whose run journal keeps the notes, from what a step was given. */
const dueHostOf = (arg: unknown, work: WorkStore): Storage | undefined => (isStorage(arg) ? arg : storageOfWork(work));


export type JobHandler = (payload: any, ctx: JobCtx) => Promise<any>;

export interface QueueWorkerOptions {
  owner?: string;
  /**
   * The lease's TTL — consulted only when the holder's process cannot be asked. With a process
   * liveness (below) a job held by a live process stays with it however long it is frozen, and a dead
   * process's job is taken at once; without one, a lease older than this reads as crashed and is taken.
   */
  ttlMs?: number;
  /**
   * This process's liveness (@gnldev/durable `sqliteLiveness`/`postgresLiveness`): whether the worker
   * holding a job is alive is asked of it, not of the lease's age. Only for a store that cannot answer for
   * itself (a custom `Storage`): the built-in stores answer for themselves — their own liveness, or the one
   * given to them (`new PostgresStorage({ liveness })`) — and one passed here beside it is refused
   * (`LivenessConflictError`). Default: the one installed in this process. A store only this process
   * reaches (in memory) needs none; any other store without one is refused (`LivenessRequiredError`) —
   * guessed by age, a frozen worker's job is taken and its side effect runs twice.
   */
  liveness?: ProcessLiveness;
  /** start() poll interval (also the base for backoff growth on an empty queue). */
  pollMs?: number;
  /** How many failed attempts before a job becomes dead-letter (qfail). */
  maxAttempts?: number;
  /**
   * Empty-poll exponential backoff (default ON): if runOnce() CLAIMS NO job (returns false), the next
   * poll interval grows ×2 (cap: `maxPollMs ?? pollMs*32`) → prevents tens of thousands of empty
   * queries per second (poll storm, an audit finding) on an empty queue with 1000 consumers. The
   * interval resets to `pollMs` as soon as a job is claimed. `false` → old behavior (constant `pollMs` interval).
   */
  backoff?: boolean;
  /** Backoff cap (default `pollMs*32`). Only meaningful while `backoff !== false`. */
  maxPollMs?: number;
  /**
   * Y2 (heartbeat, default ON): `renew`s the lock every `ttlMs/3` while the handler runs → prevents a
   * long-running handler (> ttlMs) from letting the lock expire mid-run and a second worker TAKING OVER
   * AND DOUBLE-RUNNING the job. If disabled, old behavior returns (the lock can expire early on a
   * handler longer than TTL, reintroducing reclaim risk) — recommended only for test/debug.
   */
  heartbeat?: boolean;
  /**
   * Phase 8 (review leftover): if renew THROWS THIS MANY TIMES IN A ROW (the transient error has become
   * persistent — e.g. journal/network is consistently unreachable), the job's grant is revoked as `lease-lost` (`ctx.signal` aborts): a
   * persistent transient error is treated as the best available signal that the lock may have REALLY
   * expired via TTL — the worker can't know for certain, so this is the best approximation (until
   * WorkStore CAS/fencing lands — a tracked backlog item). Default 3. The consecutive counter is
   * reset by any SUCCESSFUL renew (a single hiccup never PRODUCES a lost lease — current behavior, see tests).
   */
  maxRenewFailures?: number;
  /**
   * How long one attempt may hold its job (default: no limit). When it is up the handler's `ctx.signal`
   * aborts (`timeout`); a handler that stops on it has failed this attempt — retried, dead-lettered at
   * `maxAttempts`. The lease is kept until the handler returns: a handler that ignores its signal still
   * holds the job (nothing runs it beside itself).
   */
  maxHoldMs?: number;
  /**
   * Called with a handler's error that counts as a failed attempt — not for a job this process released
   * (a drain, a lost liveness session), one whose run was executing elsewhere, or one cancelled while it ran.
   */
  onError?: (err: unknown, jobId: string) => void;
  /**
   * The wait before the next attempt of a failed job, in ms: a number, or `(attempt, err) => ms` where
   * `attempt` is the number of attempts so far (1 after the first failure). Default 0 (the next
   * poll). The worker records the resulting time in the job's attempt record (`qtry`), so every worker in the
   * fleet honours it, across restarts. `retryDelayMs: (n) => 1000 * 2 ** (n - 1)` is exponential backoff.
   */
  retryDelayMs?: number | ((attempt: number, err: unknown) => number);
  /**
   * How many jobs this worker runs at once after `start()` (default 1). Each slot is its own poll loop,
   * so a slot takes the next job as soon as its own finishes. Two slots never run one job: each job is
   * taken under its lease. `runOnce`/`drain` are unaffected (one job per call).
   */
  concurrency?: number;
  /**
   * At most this many jobs of a type run at once, across EVERY worker on this storage — e.g.
   * `{ 'send-email': 2 }`. Enforced with that many leases in the run journal (`qslot:<type>:<k>`), kept
   * alive by the heartbeat and reclaimed after `ttlMs` if a worker dies, so a crash never leaks a slot.
   * A job that finds no free slot is skipped until one frees. Give every worker the same number: a
   * worker with a smaller one uses only the first slots, a worker with a larger one uses more.
   */
  typeConcurrency?: Record<string, number>;
}

export interface JobStatus extends JobOwner {
  id: string;
  type: string;
  /**
   * `in-doubt`: the job reached `maxAttempts` with its last attempt never reporting (its process stopped
   * or was cut off while the handler ran) — whether it ran is unknown, so it is not called failed. Like a
   * dead letter it is not started again (`retryJob` retries it); a late report of its handler makes it `done`.
   */
  status: 'pending' | 'done' | 'failed' | 'cancelled' | 'in-doubt';
  /**
   * Attempts STARTED, counted as each begins: a job done on its first try shows 1, and an attempt the
   * process died in counts. A dead letter shows `maxAttempts`.
   */
  attempts: number;
  /** A pending job that may not run yet (its `runAt`, or its retry delay): the earliest time it may. */
  notBefore?: number;
}

/**
 * Phase 8 (audit finding: unbounded accumulation): if `maxDepth` is given — if the queue depth before
 * insertion (the count of ALL records in the `qjob` namespace: pending+done+failed, since an unpruned
 * append-only log can't distinguish between them) has reached/exceeded `maxDepth`, throws.
 */
export class QueueDepthExceededError extends Error {
  constructor(
    message: string,
    public readonly detail: { type: string; depth: number; maxDepth: number },
  ) {
    super(message);
    this.name = 'QueueDepthExceededError';
  }
}

/**
 * Counts records in the `ns` namespace UP TO AT MOST `limit` (early exit). WorkStore.list is paginated
 * (default page size e.g. 50) — a full count would read O(depth/pageSize) pages; since we only need to
 * know "was the limit exceeded", this stops once it reaches `limit` → cost is O(min(actual depth,
 * maxDepth)) pages, NOT the entire log. Unless `maxDepth` is given (the default behavior), this function
 * is NEVER called → the existing unbounded-queue behavior is preserved.
 */
async function countUpTo(work: WorkStore, ns: string, limit: number): Promise<number> {
  let count = 0;
  let cursor: string | undefined;
  for (;;) {
    const page = await work.list(ns, { cursor });
    count += page.items.length;
    if (count >= limit || !page.nextCursor) return count;
    cursor = page.nextCursor;
  }
}

/**
 * Adds a job to the queue (idempotent: repeating with the same id = a single job).
 *
 * `caller` (or the `resourceId`/`orgId` shorthand) says whose the job is. The worker runs the job as
 * that owner (see `JobCtx.caller`); a job with no owner runs as `unknown`. The owner is checked here,
 * at the door — a bad organization id found by the worker would be five failed attempts and a dead
 * letter instead of one error to the caller.
 */
export async function enqueue(
  workArg: WorkStore,
  type: string,
  payload: unknown,
  options: EnqueueOptions = {},
): Promise<string> {
  refuseUnknownNames('enqueue', options, ENQUEUE_OPTIONS_NAMES);
  const work = portOf(workArg, 'work', 'enqueue');
  return appendJob(work, type, payload, options, undefined, workArg);
}

/**
 * The run journal a job's run is born in (the worker's `scoped.runs`), when the door can reach it: the
 * storage that marked the work port as its own (`storageOfWork`), or the storage handed in. `undefined`
 * for a host's own work store — its worker answers instead (`attemptEndOf` → 'erased').
 */
function jobRunsOf(work: WorkStore, given: unknown, orgId: string | undefined) {
  const storage = storageOfWork(work) ?? (isStorage(given) ? given : undefined);
  if (storage === undefined) return undefined;
  return toJournal((orgId !== undefined ? withOrgStorage(storage, orgId) : storage).runs);
}

/** `enqueue`, plus the one field only `retryJob` writes (the run a retry continues). */
async function appendJob(
  work: WorkStore,
  type: string,
  payload: unknown,
  options: EnqueueOptions,
  runId?: string,
  given?: unknown,
): Promise<string> {
  const job = jobOf(work, type, payload, options, runId);
  await refuseOverDepth(work, [job]);
  await refuseUnbornRun(work, job, given);
  // The record and its ready entry in ONE write (`appendReady`): a job is never in its lane without a
  // turn, nor a turn without the job.
  const [rec, depth] = jobWrites(job, Date.now());
  await work.appendReady(rec.ns, rec.payload, rec.id, rec.entry);
  // The depth index, under the SAME id (idempotent with the job). A crash between the two appends
  // under-counts this one job by one; never over-counts.
  await work.append(depth.ns, depth.payload, depth.id);
  noticeIfUnconsumed(work, type, job.id);
  return job.id;
}

/** One job of `enqueueMany`: `enqueue`'s arguments after the store. */
export interface EnqueueManyJob {
  type: string;
  payload: unknown;
  options?: EnqueueOptions;
}

/**
 * Adds many jobs in ONE write: all of them, or — when one is refused, or the write fails — none. Each job
 * is what `enqueue(work, type, payload, options)` adds, checked the same way, idempotent the same way (an
 * id already enqueued, or repeated in the call, is one job); the ids come back in call order.
 *
 * Fair the same way: an organization's jobs are taken in call order, one turn apart, exactly as one
 * `enqueue` after another ranks them — and another organization's job still starts within its round. What
 * differs is the cost: the call takes each organization's turn ONCE (`WorkStore.appendMany`), where
 * `enqueue` takes it once per job — the way to put a large batch (a CSV import) on one organization's queue.
 * Jobs of several organizations may share a call. `maxDepth` counts the call's own jobs before each one.
 */
export async function enqueueMany(workArg: WorkStore, jobs: readonly EnqueueManyJob[]): Promise<string[]> {
  if (!Array.isArray(jobs)) throw new TypeError('@gnldev/queue: enqueueMany takes an array of jobs ({ type, payload, options? })');
  const work = portOf(workArg, 'work', 'enqueueMany');
  const all = jobs.map((j) => {
    if (j === null || typeof j !== 'object') throw new TypeError(`@gnldev/queue: enqueueMany takes jobs ({ type, payload, options? }), got ${String(j)}`);
    refuseUnknownNames('enqueueMany', j, ENQUEUE_MANY_JOB_NAMES);
    refuseUnknownNames('enqueue', j.options ?? {}, ENQUEUE_OPTIONS_NAMES);
    return jobOf(work, j.type, j.payload, j.options ?? {});
  });
  if (!all.length) return [];
  await refuseOverDepth(work, all);
  for (const job of all) await refuseUnbornRun(work, job, workArg);
  const now = Date.now();
  await work.appendMany(all.flatMap((job) => jobWrites(job, now)));
  for (const job of all) noticeIfUnconsumed(work, job.rec.type, job.id);
  return all.map((job) => job.id);
}

/** A job checked and named, not written yet (`jobOf`). */
interface JobToAppend {
  rec: JobRecord;
  /** The stored id: what `retryJob` and `listJobs` speak. */
  id: string;
  orgId?: string;
  maxDepth?: number;
  /** The run a caller-chosen id (or a retry) names, asked before the write (`refuseUnbornRun`). */
  runOfJob?: string;
  /** The entry's time (`ReadyEntry.notBefore`). */
  notBefore: number;
}

/** Everything `enqueue` checks and decides about one job that needs no read: its owner, its time, its record and its id. */
function jobOf(work: WorkStore, type: string, payload: unknown, options: EnqueueOptions, runId?: string): JobToAppend {
  const opts: EnqueueOptions = { ...options, ...jobOwnerOf(options), caller: undefined };
  const ownerKind = options.caller?.kind === 'staff' ? ('staff' as const) : undefined;
  // The queue is ONE log that the worker polls at the root. An organization-scoped work store (a
  // handler's `ctx.storage.work`) takes the append and files it under `org:<id>:qjob`, where nothing
  // ever reads it: the job is lost without a word. Refused instead.
  const scopedTo = orgStorageScopeOf(work);
  if (scopedTo !== undefined) {
    throw new Error(
      `@gnldev/queue: enqueue was handed organization '${scopedTo}''s work store — the worker polls the root queue, so the job ` +
        "would never run. In a handler use ctx.enqueue(type, payload); elsewhere pass the root storage's work with { orgId }.",
    );
  }
  if (opts.orgId !== undefined) orgPrefix(opts.orgId);
  if (opts.resourceId !== undefined && (typeof opts.resourceId !== 'string' || opts.resourceId === '')) {
    throw new Error(`@gnldev/queue: invalid resourceId '${String(opts.resourceId)}' — must be a non-empty string, or omitted for a system job`);
  }
  const runAt = opts.runAt instanceof Date ? opts.runAt.getTime() : opts.runAt;
  if (runAt !== undefined && !Number.isFinite(runAt)) {
    throw new TypeError(`@gnldev/queue: invalid runAt '${String(opts.runAt)}' — an epoch-ms number or a valid Date`);
  }
  const rec: JobRecord = {
    type,
    payload,
    ...(opts.resourceId !== undefined ? { resourceId: opts.resourceId } : {}),
    ...(opts.orgId !== undefined ? { orgId: opts.orgId } : {}),
    ...(ownerKind ? { ownerKind } : {}),
    ...(runId !== undefined ? { runId } : {}),
    ...(runAt !== undefined ? { runAt } : {}),
  };
  // A caller's id is a name within its owner (`ownedName`): the log is one for every organization. The
  // id returned is the stored one — what `retryJob` and `listJobs` speak.
  // An owned job always has an engine-written owned id: that is where erasure finds it.
  const owned = opts.resourceId !== undefined || opts.orgId !== undefined;
  const name = opts.id ?? (owned ? randomUUID() : undefined);
  const stored = name === undefined ? undefined : ownedName(name, { resourceId: opts.resourceId, orgId: opts.orgId });
  // The job's run is born at its first lease (`claimRunOwner`), under `job:<id>` or the run a retry
  // continues. An id a deletion fenced is never born again, so a job under it could never run: refused
  // before anything is written (`refuseUnbornRun`) — not accepted, then failed on every attempt (e2e F1).
  // A fresh random id was never anybody's run; only a caller-chosen one is asked.
  const runOfJob = runId ?? (opts.id !== undefined && stored !== undefined ? `job:${stored}` : undefined);
  // The entry's time may be EARLIER than the job's, never later: an id the caller chose may already hold
  // a record whose `runAt` the store keeps, and a worker that takes the entry early reads the record and waits.
  return {
    rec,
    id: stored ?? randomUUID(),
    ...(opts.orgId !== undefined ? { orgId: opts.orgId } : {}),
    ...(opts.maxDepth != null ? { maxDepth: opts.maxDepth } : {}),
    ...(runOfJob !== undefined ? { runOfJob } : {}),
    notBefore: opts.id === undefined ? (runAt ?? 0) : 0,
  };
}

/**
 * Phase 8 `maxDepth`, before anything is written. Counted per organization: one organization filling the
 * queue refused every other one's work. Read from the organization's own depth index, so an organization
 * with 5 jobs pays for 5 records, not for every other organization's backlog (R22). A job of
 * `enqueueMany` counts the call's jobs of its organization before it too (each id once).
 */
async function refuseOverDepth(work: WorkStore, jobs: readonly JobToAppend[]): Promise<void> {
  const limits = new Map<string | undefined, number>();
  for (const j of jobs) if (j.maxDepth != null) limits.set(j.orgId, Math.max(limits.get(j.orgId) ?? 0, j.maxDepth));
  if (!limits.size) return;
  const depths = new Map<string | undefined, number>();
  for (const [orgId, limit] of limits) depths.set(orgId, await countUpTo(work, depthNs(orgId), limit));
  const before = new Map<string | undefined, Set<string>>();
  for (const j of jobs) {
    const earlier = before.get(j.orgId) ?? new Set<string>();
    before.set(j.orgId, earlier);
    if (j.maxDepth != null) {
      const depth = depths.get(j.orgId)! + earlier.size - (earlier.has(j.id) ? 1 : 0);
      if (depth >= j.maxDepth) {
        throw new QueueDepthExceededError(
          `@gnldev/queue: queue depth limit exceeded (${depth} >= ${j.maxDepth}) — job rejected (type='${j.rec.type}').`,
          { type: j.rec.type, depth, maxDepth: j.maxDepth },
        );
      }
    }
    earlier.add(j.id);
  }
}

/** A spelling no run can carry (`job:…:tool`), or an id a deletion fenced, refused before the write (`jobOf`). */
async function refuseUnbornRun(work: WorkStore, job: JobToAppend, given: unknown): Promise<void> {
  if (job.runOfJob === undefined) return;
  const runs = jobRunsOf(work, given, job.orgId);
  // The queue composes the job's run id (a retry's is the run the queue composed before).
  if (runs !== undefined) await refuseRunIdThatCannotBeBorn(runs, job.runOfJob, composerMark(job.runOfJob));
}

/** What a job writes: its record with its ready entry in its lane, and its depth-index record under the SAME id. */
function jobWrites(job: JobToAppend, now: number): [WorkRecord & { entry: ReadyEntry }, WorkRecord] {
  return [
    { ns: laneOf(job.orgId), payload: job.rec, id: job.id, entry: { set: READY, kind: job.rec.type, notBefore: job.notBefore, now } },
    { ns: depthNs(job.orgId), payload: { type: job.rec.type }, id: job.id },
  ];
}

/** What `listJobs` takes: whose jobs (an organization's, or with no `orgId` the jobs that have none), and a page of them. */
export interface ListJobsOptions {
  orgId?: string;
  cursor?: string;
  limit?: number;
}

/**
 * A page of one organization's jobs (pending/done/failed + attempt count), in the order they were
 * enqueued — or, with no `orgId`, of the jobs that have no organization. Reads that organization's lane
 * only: never another organization's job, and at a cost that does not grow with any other's.
 */
export async function listJobs(workArg: WorkStore, opts: ListJobsOptions = {}): Promise<Page<JobStatus>> {
  refuseUnknownNames('listJobs', opts, LIST_JOBS_OPTS_NAMES);
  const work = portOf(workArg, 'work', 'listJobs');
  if (opts.orgId !== undefined) orgPrefix(opts.orgId);
  const page = await work.list<JobRecord>(laneOf(opts.orgId), { ...(opts.cursor !== undefined ? { cursor: opts.cursor } : {}), ...(opts.limit !== undefined ? { limit: opts.limit } : {}) });
  return { items: await statusesOf(work, page.items), ...(page.nextCursor ? { nextCursor: page.nextCursor } : {}) };
}

/** What `listAllJobs` takes: a page of every organization's jobs. */
export interface ListAllJobsOptions {
  cursor?: string;
  limit?: number;
}

/**
 * A page of EVERY job on the store — the jobs with no organization first, then each organization's, lane
 * by lane in the lanes' name order, each lane in enqueue order: the operator's view (5b). `listJobs` with no
 * `orgId` is the jobs with no organization only; seeing every organization's is this call, named for it.
 *
 * FIXED AT ITS START (5h-1): the first page takes the moment it was asked, and the cursor carries it — every
 * job enqueued before it is listed, exactly once; one enqueued after it (its record's `ts`, its producer's
 * clock) is not, whatever lane it went to, a new organization's included: it is the next listing's. So a
 * listing ends under producers that never stop. A lane is read up to its first record after that moment.
 * The cursor is a position — a lane, a place in it (`WorkStore.list`'s own cursor) and that moment — so a
 * job enqueued while the pages are read is never listed twice and never makes the reader skip a job that
 * was there. A page reads the lanes it covers (`WorkStore.list`), one probe for each next lane
 * (`WorkStore.listNamespaces`), and the markers of its jobs in one read (`statusesOf`): never a query per job.
 * Refuses an organization's view of the store, which holds no lane: pass the root storage.
 */
export async function listAllJobs(workArg: WorkStore, opts: ListAllJobsOptions = {}): Promise<Page<JobStatus>> {
  refuseUnknownNames('listAllJobs', opts, LIST_ALL_JOBS_OPTS_NAMES);
  const work = portOf(workArg, 'work', 'listAllJobs');
  const org = orgStorageScopeOf(work);
  if (org !== undefined) {
    throw new Error(`@gnldev/queue: listAllJobs was handed organization '${org}''s work store, which holds no lane: every job is in the root store's lanes. Pass the root storage (its \`work\`); for one organization's jobs, listJobs(work, { orgId }).`);
  }
  if (typeof work.listNamespaces !== 'function') {
    throw new Error('@gnldev/queue: listAllJobs needs a work store that lists its namespaces (`listNamespaces`); every bundled store does. One organization at a time: listJobs(work, { orgId }).');
  }
  const limit = opts.limit ?? 50;
  if (!Number.isInteger(limit) || limit < 1) throw new TypeError(`@gnldev/queue: listAllJobs limit must be a positive integer, got ${String(opts.limit)}`);
  let at: AllJobsCursor | undefined = opts.cursor === undefined ? { lane: SYSTEM_LANE, until: Date.now() } : decodeAllJobsCursor(opts.cursor);
  const until = at.until;
  const jobs: LogRecord<JobRecord>[] = [];
  while (at) {
    const page = await work.list<JobRecord>(at.lane, { limit: limit - jobs.length, ...(at.at !== undefined ? { cursor: at.at } : {}) });
    // The lane as it was at the start: up to its first record enqueued after it — the rest is the next listing's.
    const after = page.items.findIndex((j) => j.ts > until);
    jobs.push(...(after === -1 ? page.items : page.items.slice(0, after)));
    if (after === -1 && page.nextCursor) { at = { lane: at.lane, at: page.nextCursor, until }; break; } // the page is full, the lane is not
    const next = await laneAfter(work, at.lane);
    at = next === undefined ? undefined : { lane: next, until };
    if (jobs.length >= limit) break;
  }
  return { items: await statusesOf(work, jobs), ...(at ? { nextCursor: encodeAllJobsCursor(at) } : {}) };
}
/**
 * Where `listAllJobs` stands: a lane, the place in it (`WorkStore.list`'s cursor; none = its head), and the
 * moment the listing started (`until`, epoch ms): the one bound every page of it reads to.
 */
interface AllJobsCursor { lane: string; at?: string; until: number }
const encodeAllJobsCursor = (c: AllJobsCursor): string => Buffer.from(JSON.stringify([c.lane, c.at ?? null, c.until])).toString('base64url');
function decodeAllJobsCursor(s: string): AllJobsCursor {
  try {
    const v = JSON.parse(Buffer.from(s, 'base64url').toString('utf8')) as unknown;
    if (Array.isArray(v) && v.length === 3 && typeof v[0] === 'string' && (v[0] === SYSTEM_LANE || v[0].startsWith(`${SYSTEM_LANE}:`))
      && (v[1] === null || typeof v[1] === 'string') && typeof v[2] === 'number' && Number.isFinite(v[2])) {
      return { lane: v[0], ...(v[1] !== null ? { at: v[1] as string } : {}), until: v[2] };
    }
  } catch { /* said below */ }
  throw new TypeError('@gnldev/queue: listAllJobs was given a cursor it did not hand out — pass the `nextCursor` of its previous page, or none for the first.');
}
/** The lane after `lane` in name order (the jobs with no organization come first): one probe. */
async function laneAfter(work: WorkStore, lane: string): Promise<string | undefined> {
  const page = await work.listNamespaces!(`${SYSTEM_LANE}:`, { limit: 1, ...(lane === SYSTEM_LANE ? {} : { cursor: lane }) });
  return page.items[0];
}

/** One job's status, read by its id; `undefined` when there is no such job. */
export async function getJob(workArg: WorkStore, id: string): Promise<JobStatus | undefined> {
  const work = portOf(workArg, 'work', 'getJob');
  const job = await findJob(work, id);
  return job === undefined ? undefined : (await statusesOf(work, [job]))[0];
}

/** The markers a job's status is read from (`statusesOf`), in the order it reads them. */
const STATUS_KEYS = (id: string): string[] => [`qdone:${id}`, `qfail:${id}`, `qcancel:${id}`, `qtry:${id}`, `qatt:${id}`];
/**
 * THE ONE READING of jobs' statuses from their markers (`listJobs`, `listAllJobs`, `getJob`): every
 * job's markers in one read (`WorkStore.getMany`), or key by key on a store without it.
 */
async function statusesOf(work: WorkStore, jobs: readonly LogRecord<JobRecord>[]): Promise<JobStatus[]> {
  const keys = jobs.flatMap((j) => STATUS_KEYS(j.id));
  let values: unknown[];
  if (work.getMany) values = keys.length ? await work.getMany(keys) : [];
  else { values = []; for (const k of keys) values.push(await work.get(k)); }
  const n = STATUS_KEYS('').length;
  return jobs.map((j, i) => statusFrom(j, values.slice(i * n, i * n + n)));
}
function statusFrom(j: LogRecord<JobRecord>, [done, fail, cancelled, tryRec, oldAttempts]: unknown[]): JobStatus {
  const tries = triesFrom(tryRec as TryRecord | undefined, oldAttempts);
  // A job cancelled while it ran, and which then finished, ran: `done` wins over `cancelled`.
  // `in-doubt`: dead-lettered with its outcome unknown (its last attempt never reported) — a late
  // report makes it `done`.
  const status = done ? 'done' : fail ? ((fail as { inDoubt?: unknown }).inDoubt === true ? 'in-doubt' : 'failed') : cancelled !== undefined ? 'cancelled' : 'pending';
  const runAt = typeof j.payload.runAt === 'number' ? j.payload.runAt : 0;
  const notBefore = status === 'pending' ? Math.max(runAt, tries.notBefore) : 0;
  return {
    id: j.id,
    type: j.payload.type,
    status,
    attempts: tries.attempts,
    ...(notBefore > 0 ? { notBefore } : {}),
    ...(j.payload.resourceId !== undefined ? { resourceId: j.payload.resourceId } : {}),
    ...(j.payload.orgId !== undefined ? { orgId: j.payload.orgId } : {}),
  };
}

/** The job record with `id`, if any: a point read in the lane its id names (`WorkStore.read`), whatever else the queue holds. */
async function findJob(
  work: WorkStore,
  id: string,
): Promise<LogRecord<JobRecord> | undefined> {
  return work.read<JobRecord>(laneOfJob(id), id);
}

/**
 * A handler that finished after its worker lost the job (a takeover after a partition, a stall): the job
 * ran, and that is a fact about the job, not this worker's account of itself — the same rule as a late
 * tool success in @gnldev/durable (attempt.ts). It is kept (`qlate`); `settleFromLateReport` is its one
 * reader. Never into a job that is gone (its attempt record goes with an erasure).
 */
async function recordLateSuccess(work: WorkStore, jobId: string): Promise<void> {
  // A worker back from a partition finds its connections gone: the first statements fail while the pool
  // reconnects. Tried a few times, a beat apart.
  for (let round = 0; round < 5; round++) {
    try {
      if ((await work.get(`qtry:${jobId}`)) === undefined) return;
      // Written through the erasure fence like every write of a job's state (`putJobMarker`): this worker
      // no longer holds the job, and its owner's erasure ran between the read above and this write —
      // `qlate` stayed under the erased person's id for good (audit Q2).
      if (!(await putJobMarker(work, jobId, 'qlate', { at: Date.now() }))) return;
      await settleFromLateReport(work, jobId);
      console.warn(`[queue] job ${jobId} finished after its worker lost it — kept (qlate)`);
      return;
    } catch (err) {
      if (round === 4) console.warn(`[queue] job ${jobId} finished after its worker lost it, and that could not be recorded:`, err);
      else await new Promise((r) => setTimeout(r, 200 * (round + 1)));
    }
  }
}

/**
 * EVERY WRITE OF A JOB'S STATE BY A WORKER — the attempt record, a result, a dead letter, a late report —
 * and the job's ERASURE FENCE read after it (@gnldev/durable erasure-fence.ts: written first, read last).
 * A worker cannot keep its job's owner from being erased between its own check and its write (the holder
 * past `stillOwns`, a worker that lost the job reporting late); the write then stayed under the erased
 * person's id for good (audit Q2). The fence is `qown`: written at the job's first lease and the FIRST
 * record `jobEraser` deletes — so a write lands either before the erasure reaches it (and goes with it),
 * or before this read sees the fence gone, and is taken back here. False when it was.
 *
 * A store without `putIfMatch` writes no `qown`: the attempt record stands in (a late report's fence;
 * the holder there has no fencing at all — the documented fallback of such a store).
 */
async function putJobMarker(work: WorkStore, jobId: string, marker: (typeof STATE_MARKERS)[number], value: unknown): Promise<boolean> {
  await work.put(`${marker}:${jobId}`, value);
  if ((await work.get(`${work.putIfMatch ? 'qown' : 'qtry'}:${jobId}`)) !== undefined) return true;
  // Erased meanwhile. A work store deletes by prefix, so this reaches `<marker>:<id>…` too: ids that
  // extend this one carry the same owner prefix (`ownedName`) and were erased with it.
  await work.deletePrefix?.(`${marker}:${jobId}`);
  return false;
}

/**
 * THE ONE READER OF A LATE REPORT. A job whose handler is known to have finished (`qlate`) RAN; it is
 * `done` (`late: true`) once no other worker can still report for it — the engine's rule for a late tool
 * success (attempt.ts): never over a live holder. That is so when the job is in doubt (its last attempt
 * never reported), or when the caller is the worker that holds the job now and is about to decide it: to
 * start the handler again, or to write off its own failed attempt, which only met the effect the first
 * one made. Before, only the in-doubt case was read, so an attempt started after the report re-ran the
 * handler and the job ended failed although it had run (audit Q1). True when the job is done.
 */
async function settleFromLateReport(work: WorkStore, jobId: string, holder = false): Promise<boolean> {
  if ((await work.get(`qdone:${jobId}`)) !== undefined) return true;
  if ((await work.get(`qlate:${jobId}`)) === undefined) return false;
  if (!holder && (await work.get<{ inDoubt?: unknown }>(`qfail:${jobId}`))?.inDoubt !== true) return false;
  return putJobMarker(work, jobId, 'qdone', { at: Date.now(), ok: true, late: true });
}

/**
 * Retries a dead-letter (qfail — has reached `maxAttempts`) job: appends a NEW job record with its
 * original type/payload/owner (append-only log — the old record AND its qfail/qtry markers are NOT
 * MODIFIED/DELETED, the dead-letter history stays permanent for audit). Returns the new job's id.
 *
 * THE RETRY CONTINUES THE DEAD LETTER'S RUN. The new record carries the dead letter's durable run id
 * (`job:<original id>`, followed through earlier retries), so `ctx.runId` — and `ctx.run`, which is
 * `runDurable` on it — resumes that run: a side effect the journal already records as done is replayed,
 * not fired again. This is the promise the worker keeps for its own retries (same job, same run), kept
 * across an operator's retry too; @gnldev/events' `retryDeadEvent` keeps the event id for the same
 * reason. Two retries of one dead letter share the run as well, and the run's lease keeps them from
 * executing at once. `ctx.jobId` is the new record's id.
 *
 * `{ newRun: true }` is the way through when a fresh start IS what you want (the recorded effects were
 * rolled back by hand, say): the retry then runs as `job:<new id>` with an empty journal, as 0.9.0 did.
 *
 * DOUBLE-RUN PROTECTION: only TERMINAL-FAILED (qfail-marked) jobs can be retried. If the job doesn't
 * exist at all OR hasn't reached qfail yet (status 'pending': still waiting in the queue, a worker is
 * currently processing it, or an automatic retry — createWorker already retries on its own up to
 * `maxAttempts` — it will continue on its own on the next poll; 'done': already finished) returns
 * `null` (no-op). Adding a second copy for these jobs would create a DOUBLE-RUN of work the worker
 * is ALREADY going to process/has already processed — exactly the situation this function is meant
 * to prevent.
 */
export async function retryJob(
  workArg: WorkStore,
  id: string,
  opts: { maxDepth?: number; newRun?: boolean } = {},
): Promise<string | null> {
  refuseUnknownNames('retryJob', opts, RETRY_JOB_OPTS_NAMES);
  const work = portOf(workArg, 'work', 'retryJob');
  const rec = await findJob(work, id);
  if (!rec) return null;
  const fail = await work.get(`qfail:${id}`);
  if (!fail) return null; // only dead-letter jobs are retried — pending/done is a no-op
  if ((await work.get(`qdone:${id}`)) !== undefined) return null; // a late report settled it: it ran
  const { newRun, ...enqueueOpts } = opts;
  // The copy is the same user's, in the same organization: a retry must not turn their job into the system's.
  // A run that was deleted cannot be continued: refused (`RunErasedError`) — `{ newRun: true }` starts over.
  return appendJob(
    work,
    rec.payload.type,
    rec.payload.payload,
    { ...enqueueOpts, ...ownerOptionsOf(rec.payload) },
    newRun ? undefined : runIdOfJob(rec),
    workArg,
  );
}

/**
 * Cancels a job that has not finished: no worker starts it after this returns `true`. A job running at
 * that moment is not killed — its handler's `ctx.signal` is aborted on the worker's next heartbeat tick,
 * and if the handler completes anyway the job is reported `done` (it ran), else `cancelled`.
 *
 * The cancel is the `qcancel:<id>` marker, written with `ackOnce` (one writer wins), and it is terminal:
 * the same `isTerminal` reading the worker re-checks under its lease. Returns `false` (no-op) for an
 * unknown id or a job already done, dead-lettered or cancelled. A cancelled job is not a dead letter, so
 * `retryJob` does not take it; enqueue it again under a new id to run it after all.
 *
 * During a rolling deploy a worker older than this marker does not read it and may still run the job.
 */
export async function cancelJob(workArg: WorkStore, id: string): Promise<boolean> {
  const work = portOf(workArg, 'work', 'cancelJob');
  if (!(await findJob(work, id))) return false;
  if (await isTerminal(work, id)) return false;
  return work.ackOnce(`qcancel:${id}`);
}

// ─── Who consumes the queue ────────────────────────────────────────────────────────────────────

/**
 * How long a job may wait with no live worker on its store before it is reported (`console.warn`, once
 * per type in this process). A job enqueued where nothing consumes it otherwise waits without a word.
 */
export const NO_WORKER_NOTICE_MS = 10_000;

/**
 * Every polling worker on a store announces itself in `__qworkers__`, every ttlMs/3: `owner → { at, ttlMs,
 * packageVersion }`. It answers "is anyone polling now", so it is judged by its age alone — a process that
 * is alive and no longer polls (a worker stopped, a one-off `drain()` long done) consumes nothing. It
 * decides no job: it says whether "nobody consumes this" is said, and whether a worker of an earlier
 * version still polls (`olderWorkersLive`, what `queue/lanes-cleanup` asks). One key per store: a worker
 * takes every job it sees (a type it has no handler for is dead-lettered), so the question is whether a
 * worker polls, not which types it handles.
 *
 * `packageVersion`: the queue data version the worker's package speaks (QUEUE_DATA_VERSION). 0.16 and
 * earlier wrote `{ at, ttlMs }` only, so an entry without it is a worker of an earlier version. 0.16's
 * workers rewrite the record keeping every live entry as they found it, so this field survives them.
 */
// `__`: a platform key (organization.ts `isPlatformKey`) — process state, never moved into an organization.
const PRESENCE = '__qworkers__';
interface Presence { at: number; ttlMs: number; packageVersion?: number }

/**
 * THE ONE READING of "this entry's worker polls now": announced within its own ttl. An entry from further
 * in the future than its ttl (a clock far ahead, a hand-written one) or with no numeric time is not live:
 * it would otherwise hold back `queue/lanes-cleanup` for as long as it says, and nothing renews it.
 */
function presenceIsLive(p: unknown, now: number): p is Presence {
  const { at, ttlMs } = (p ?? {}) as Partial<Presence>;
  return typeof at === 'number' && typeof ttlMs === 'number' && Number.isFinite(at) && Number.isFinite(ttlMs) && at + ttlMs >= now && at <= now + ttlMs;
}
function livePresence(map: Record<string, Presence> | undefined, now: number): Record<string, Presence> {
  return Object.fromEntries(Object.entries(map ?? {}).filter(([, p]) => presenceIsLive(p, now)));
}
/** The live entries of workers of an earlier version: no `packageVersion` (0.16 and earlier), or a lower one. */
async function olderWorkersLive(work: WorkStore): Promise<Array<[string, Presence]>> {
  const now = Date.now();
  return Object.entries(livePresence(await work.get(PRESENCE), now)).filter(([, p]) => !(typeof p.packageVersion === 'number' && p.packageVersion >= QUEUE_DATA_VERSION));
}

/** Writes (`entry`) or removes (`undefined`) one worker's presence; entries no longer live are dropped. */
async function setPresence(work: WorkStore, owner: string, entry: Presence | undefined): Promise<void> {
  // A lost race is redone at the next announcement: the record says who runs, it guards nothing.
  for (let i = 0; i < 3; i++) {
    const cur = await work.get<Record<string, Presence>>(PRESENCE);
    const next = livePresence(cur, Date.now());
    if (entry) next[owner] = entry;
    else delete next[owner];
    if (cur === undefined || !work.putIfMatch) { await work.put(PRESENCE, next); return; }
    if (await work.putIfMatch(PRESENCE, cur, next)) return;
  }
}

/** Types already reported (or being checked) per store, in this process. */
const noticed = new WeakMap<WorkStore, Set<string>>();

/**
 * After NO_WORKER_NOTICE_MS: job `id` still waiting and no live worker on the store → said, once per type.
 * A finished job, or a live worker, re-arms the check for the type's next job.
 */
function noticeIfUnconsumed(work: WorkStore, type: string, id: string): void {
  let types = noticed.get(work);
  if (!types) noticed.set(work, (types = new Set()));
  if (types.has(type)) return;
  types.add(type);
  const timer = setTimeout(() => {
    void (async () => {
      if ((await isTerminal(work, id)) || Object.keys(livePresence(await work.get(PRESENCE), Date.now())).length > 0) {
        types.delete(type);
        return;
      }
      console.warn(
        `[queue] job '${id}' (type '${type}') is waiting and no worker is consuming this queue — it runs once one starts: ` +
          'createQueue(storage, handlers) runs one in this process; createWorker(storage, handlers).start() runs one anywhere.',
      );
    })().catch(() => types.delete(type));
  }, NO_WORKER_NOTICE_MS);
  (timer as { unref?: () => void }).unref?.();
}

export interface Worker {
  /** Claims and runs one pending job. Returns true if a job was processed. */
  runOnce(): Promise<boolean>;
  /** Calls runOnce until no pending jobs remain. Returns the number of jobs processed. */
  drain(): Promise<number>;
  start(): void;
  /** Takes nothing new. The job a call holds finishes on its own; `close()` waits for it. */
  stop(): void;
  /**
   * Stops, then resolves once every job this worker holds has settled (`runOnce` from its loops or from
   * a caller). Before this, closing returned at once: the application closed the store, the process lock
   * went with it, and another worker took the job and ran the handler a second time (audit C2).
   */
  close(): Promise<void>;
}

export function createWorker(
  storageArg: Storage,
  handlers: Record<string, JobHandler>,
  opts: QueueWorkerOptions = {},
): Worker {
  refuseUnknownNames('createWorker', opts, CREATE_WORKER_OPTS_NAMES);
  const storage = storageOf(storageArg, 'createWorker');
  requireCapability(storage, 'work');
  const work = storage.work!;
  const runs: RunJournal = storage.runs;
  const owner = opts.owner ?? `w-${Math.random().toString(36).slice(2, 8)}`;
  const ttlMs = opts.ttlMs ?? 30_000;
  const maxAttempts = opts.maxAttempts ?? 5;
  const pollMs = opts.pollMs ?? 200;
  const backoffOn = opts.backoff ?? true;
  const maxPollMs = opts.maxPollMs ?? pollMs * 32;
  const maxRenewFailures = opts.maxRenewFailures ?? 3;
  const concurrency = opts.concurrency ?? 1;
  if (!Number.isInteger(concurrency) || concurrency < 1) {
    throw new TypeError(`@gnldev/queue: concurrency must be a positive integer, got ${String(opts.concurrency)}`);
  }
  for (const [type, n] of Object.entries(opts.typeConcurrency ?? {})) {
    if (!Number.isInteger(n) || n < 1) {
      throw new TypeError(`@gnldev/queue: typeConcurrency['${type}'] must be a positive integer, got ${String(n)}`);
    }
  }
  // Who answers "is the worker holding this job alive?" — the same answer every holder stamp in this
  // process gets (process-liveness.ts). Refused up front when nothing can give it.
  if (!opts.liveness && !processLiveness() && typeof storage.processLiveness !== 'function' && !isProcessLocal(runs)) {
    throw new LivenessRequiredError();
  }
  let livenessReady: Promise<ProcessLiveness | undefined> | undefined;
  const liveness = (): Promise<ProcessLiveness | undefined> => {
    // The store's liveness in this process — the same one its run executor stamps the store with
    // (@gnldev/durable storeLiveness: one per store, so a process on two databases is alive in each).
    livenessReady ??= storeLiveness(journal, {
      ...(opts.liveness ? { given: opts.liveness } : {}),
      own: () => storage.processLiveness?.(),
    });
    // A failed construction (a pool that does not say where it connects) is not kept: the next call says it again.
    livenessReady.catch(() => { livenessReady = undefined; });
    return livenessReady;
  };
  const journal = toJournal(runs);
  // This worker's presence (PRESENCE above): announced while it polls, at most every ttlMs/3.
  let announcedAt = -Infinity;
  let announcing = false;
  let stopped = false;
  async function announce(): Promise<void> {
    if (stopped || announcing || performance.now() - announcedAt < ttlMs / 3) return;
    announcing = true;
    try {
      await setPresence(work, owner, { at: Date.now(), ttlMs, packageVersion: QUEUE_DATA_VERSION });
      announcedAt = performance.now();
      // Stopped while this was written (a poll already under way when stop() ran): taken back.
      if (stopped) await setPresence(work, owner, undefined);
    } catch {
      // Advisory: a failed announcement only risks a "no worker" warning, never a job.
    } finally {
      announcing = false;
    }
  }
  /** The clock eligibility is judged by: the journal's own (`now()`), else this process's. */
  const now = async (): Promise<number> => (journal.now ? journal.now() : Date.now());
  const retryDelay = (attempt: number, err: unknown): number => {
    let ms: number;
    try {
      ms = typeof opts.retryDelayMs === 'function' ? opts.retryDelayMs(attempt, err) : (opts.retryDelayMs ?? 0);
    } catch (e) {
      // A throwing delay function must not keep the attempt from being counted (that would retry forever).
      console.warn('[queue] retryDelayMs threw; retrying without a delay:', e);
      return 0;
    }
    return Number.isFinite(ms) && ms > 0 ? ms : 0;
  };
  /** A free fleet-wide slot for `type`, or `null` when all are held. No limit → a no-op slot. */
  async function acquireSlot(type: string): Promise<{ renew(): Promise<boolean>; release(): Promise<void> } | null> {
    const limit = opts.typeConcurrency?.[type];
    if (limit === undefined) return { renew: async () => true, release: async () => {} };
    for (let k = 0; k < limit; k++) {
      const slot = await acquireRunLock(runs, `qslot:${type}:${k}`, owner, ttlMs);
      if (slot) return { renew: () => slot.renew(ttlMs), release: () => slot.release() };
    }
    return null;
  }
  /**
   * May this job start now? Finished (`isTerminal`) or not yet eligible (`notBeforeOf`) → no. Asked
   * before the lease as a cheap filter and AGAIN under it, where the answer is the one that counts.
   */
  async function mayStart(job: LogRecord<JobRecord>): Promise<'finished' | 'waiting' | 'ready'> {
    if (await isTerminal(work, job.id)) return 'finished';
    return (await notBeforeOf(work, job)) > (await now()) ? 'waiting' : 'ready';
  }

  // The jobs this worker holds — every `runOnce`, whoever called it. One set: `close()` waits for it.
  // Each is a held unit of its own (`holdWhile`): what it runs — a handler — runs as part of it, so a
  // close from inside a handler waits for every other one, not for itself (R2-7).
  const held = new Set<Promise<boolean>>();
  function runOnce(): Promise<boolean> {
    const p = holdWhile(runOnceHeld);
    held.add(p);
    void p.finally(() => held.delete(p)).catch(() => {});
    return p;
  }
  /**
   * Where a job's ready entry stands once this worker lets go of it: gone when the job is finished, else
   * ready again at the job's own time — its retry delay, its `runAt`, or now. THE ONE place an entry
   * follows its job. Not written → the entry stays held as its stamp says (@gnldev/durable `letGoReady`):
   * by the one ownership rule, like a lease whose release did not land.
   */
  async function settleReady(job: LogRecord<JobRecord>, taken: ReadyTaken): Promise<void> {
    await letGoReady(taken, journal, async () => {
      if (await isTerminal(work, job.id)) await work.dropReady(READY, job.id);
      else await work.deferReady(READY, job.id, await notBeforeOf(work, job), taken.hold);
    });
  }
  /**
   * Lets go of the entries whose holders no longer hold them (@gnldev/durable `reclaimReady`: the one
   * ownership rule) — a worker that died with its job, between its take and its lease or while it ran.
   * One at a time per worker: a poll that finds one under way does not start another.
   */
  let reclaiming: Promise<number> | undefined;
  function reclaim(): Promise<number> {
    reclaiming ??= (async () => reclaimReady(work, READY, journal, await now()))()
      .catch(() => 0)
      .finally(() => { reclaiming = undefined; });
    return reclaiming;
  }
  // THE OLD LOG, by the store's queue data version (`queueDataVersion`), asked by every drain and by a
  // polling worker as often as it announces itself (ttlMs/3):
  //   · v1 — `queue/lanes` never moved it, its jobs are in no lane: refused out loud, not left waiting unseen;
  //   · v2 — moved, but a process of the earlier version may still write to it (a rolling deploy, pm2
  //     reload): what it added is moved into its lane (`moveLegacyLog`, the one move), not refused. A worker
  //     of that version may be running the same job from the old log: both take the job's one lease
  //     (`<runId>:lease`) and ask its one set of markers (`qdone`, …) under it, so it runs once;
  //   · v3 — `queue/lanes-cleanup` retired it (and recorded so): never asked again by this worker.
  let legacyAskedAt = -Infinity;
  let legacyRetired = false;
  // A worker's share of the old log per call: the rest waits for its next call (or another worker's).
  const LEGACY_PAGES_PER_CALL = 8;
  const legacySeen = { at: undefined as string | undefined, ids: new Set<string>() };
  let followingLegacy: Promise<void> | undefined;
  // The steps this worker has left a note for (once each: the note is a putIfAbsent, not asked every poll).
  const noted = new Set<string>();
  function followLegacyLog(now: boolean): Promise<void> {
    if (legacyRetired || (!now && performance.now() - legacyAskedAt < ttlMs / 3)) return Promise.resolve();
    followingLegacy ??= (async () => {
      const v = await queueDataVersion(work);
      // Data a step has not moved (v1) or retired (v2): noted for `storage.upgrade()`. Never fails the worker —
      // the refusal below says the same thing out loud.
      if (v < QUEUE_DATA_VERSION && !noted.has(dueStepOf(v))) {
        const step = dueStepOf(v);
        await markUpgradeDue(storage, step, { ...QUEUE_DUE, dataVersion: v, packageVersion: QUEUE_DATA_VERSION })
          .then(() => noted.add(step), () => undefined);
      }
      if (v < LANES_DATA_VERSION) throw new Error(DATA_VERSION_REFUSAL);
      // Retired only by what the cleanup recorded: a store that merely holds nothing old (a new one) is
      // asked again — an earlier producer appearing there is v1, and refused out loud.
      if (v >= QUEUE_DATA_VERSION) legacyRetired = ((await work.get<{ version: number }>(DATA_VERSION_KEY))?.version ?? 0) >= QUEUE_DATA_VERSION;
      else await moveLegacyLog(work, false, legacySeen, { pages: LEGACY_PAGES_PER_CALL });
      legacyAskedAt = performance.now();
    })().finally(() => { followingLegacy = undefined; });
    return followingLegacy;
  }
  async function runOnceHeld(): Promise<boolean> {
    await followLegacyLog(false);
    const live = await liveness();
    await announce();
    // Kinds this poll found no free fleet-wide slot for (`typeConcurrency`): not taken again in it.
    const skipKinds: string[] = [];
    // Entries whose job's lease another worker holds: held by this poll until it ends (so it does not take
    // them again), then let go — their turn comes again on the next poll.
    const busy: Array<{ job: LogRecord<JobRecord>; taken: ReadyTaken }> = [];
    // Asked alongside the take, not before it: a holder being judged (a process gone, its grace running)
    // does not keep this poll from the next job. Awaited when nothing is ready, so what it let go is taken.
    const reclaimed = reclaim();
    try {
      for (let asked = false; ;) {
        // GRACEFUL DRAIN (@gnldev/durable drainProcess): a process shutting down takes no new job — the
        // same boundary rule as a run's next step. Asked before the take, so a leaving process holds no turn.
        if (isDraining()) return false;
        const got = await takeReadyHeld(work, READY, journal, { now: await now(), ttlMs, skipKinds });
        if (!got) {
          if (asked || (await reclaimed) === 0) return false;
          asked = true;
          continue;
        }
        const job = await work.read<JobRecord>(got.ns, got.id);
        // Erased since it was taken (its record and its entry go together; the entry went second).
        if (!job) { await letGoReady(got, journal, () => work.dropReady(READY, got.id)); continue; }
        const r = await tryJob(job, got, live, skipKinds, busy);
        if (r !== undefined) return r;
      }
    } finally {
      for (const b of busy) await letGoReady(b.taken, journal, () => work.deferReady(READY, b.job.id, 0, b.taken.hold));
    }
  }
  /** One job, taken from the ready set: the claim's outcome, or `undefined` when it may not start now. */
  async function tryJob(
    job: LogRecord<JobRecord>, taken: ReadyTaken, live: ProcessLiveness | undefined, skipKinds: string[],
    busy: Array<{ job: LogRecord<JobRecord>; taken: ReadyTaken }>,
  ): Promise<boolean | undefined> {
    // A cheap pre-filter only. It decides nothing: see the re-check under the lease below.
    if ((await mayStart(job)) !== 'ready') {
      await settleReady(job, taken);
      return undefined;
    }
    const runId = runIdOfJob(job); // `job:<id>`, or the run a retried dead letter continues
    // THE LEASE'S KEY — deliberately NOT the runId.
    //
    // This lock answers "which WORKER owns this job". The runId's own lock answers "is this RUN
    // executing anywhere". Two questions, and they used to be written to one place:
    // `acquireRunLock(runs, runId, …)` produces `<runId>:lock`, and `runId` is then handed to the
    // handler as `ctx.runId` — the value this package's own README tells handlers to pass to
    // `runDurable({ runId: ctx.runId, … })`. So the moment that inner call took a lock of its own
    // (a `lock` option, or a critical-preset `runWorkflow`), the worker refused the handler it had
    // just invoked. RunBusyError on every attempt, the job dead-lettering at maxAttempts having
    // never run once. Not a race — it could not work at all.
    //
    // Found in @gnldev/scheduler first, where the same construction killed a production health
    // trigger; this package had it in the same shape and is fixed the same way. The two locks now
    // nest instead of competing.
    //
    // SUFFIXED rather than moved to a namespace of its own, for the reason the scheduler's
    // FIRE_LOCK gives at length: `<runId>:lease:lock` stays under the run's key prefix, which is
    // what purgeRun/sweepRuns delete by. A sibling namespace would leak one small record per job,
    // forever. `parseJournalKey` ignores it either way (it claims only `:model:`/`:tool:`).
    //
    // The WorkStore fencing chain below is unaffected: `qown:<jobId>` stores `lock.token`, and a
    // token is a token whichever key it was minted on.
    const lock = await acquireRunLock(runs, `${runId}:lease`, owner, ttlMs);
    // Held by another worker (a live one: its liveness answered), or a fresh lease: its holder lets the
    // entry go when it ends. This poll keeps it until it ends, then lets it go (`busy`).
    if (!lock) { busy.push({ job, taken }); return undefined; }
    // "Is it finished?" is answered AGAIN, now that this worker holds the lease. The check above
    // ran before it, and between the two another worker could take the lease, run the job, write
    // `qdone` and release — after which this lease is simply free, and the handler ran a second
    // time. Measured on Postgres with 3 workers: 3-5% of jobs ran twice (0.9.0 too), side effects
    // outside `ctx.run` included. A finisher writes `qdone`/`qfail` BEFORE it releases (or its
    // lease expires), so under the lease the answer cannot change any more.
    // The same holds for "not yet": a failed attempt writes its retry delay before it releases, so a
    // worker that read the job as ready just before that failure sees the retry delay here.
    if ((await mayStart(job)) !== 'ready') {
      await lock.release();
      await settleReady(job, taken);
      return undefined;
    }
    // A process that cannot prove it still holds its own liveness (its session is gone — a partition)
    // may already be judged dead elsewhere, its job taken: it starts nothing. (The lease names `live`:
    // a store has one liveness in a process, never rebound — process-liveness.ts bindLiveness.)
    if (live && !live.processOnly && !(await live.confirm())) {
      await lock.release();
      await settleReady(job, taken);
      return false;
    }
    // The fleet-wide per-type limit: taken after the job's lease (so a slot is never held for a
    // job this worker lost), given back with it.
    const slot = await acquireSlot(job.payload.type);
    if (!slot) {
      await lock.release();
      await settleReady(job, taken);
      skipKinds.push(job.payload.type);
      return undefined;
    }
    // 8.2 (closes a correctness debt): terminal writes (qdone/qfail/qatt) get their OWN fencing
    // chain inside WorkStore. `qown:<jobId>` answers "who currently holds this" for the ENTIRE
    // DURATION of this run via WorkStore's own in-engine CAS (putIfMatch) — INDEPENDENT of the
    // lock record in RunJournal, within WorkStore's own consistency boundary. The first write is
    // an UNCONDITIONAL put: the claim itself was already deduplicated via RunJournal CAS
    // (acquireRunLock) → overwriting here is safe (a new claim = a new token = a new "ownership
    // epoch"). If WorkStore doesn't support putIfMatch this key is never written (stillOwns()
    // below then falls back to `lease-lost` only — old behavior preserved EXACTLY).
    const fencingKey = `qown:${job.id}`;
    if (work.putIfMatch) await work.put(fencingKey, lock.token);
    // Y2 (heartbeat): if the handler runs longer than ttlMs, the lock TTL expires → a second
    // worker could take over the SAME job and DOUBLE-RUN it (the actual bug). We keep the lock
    // alive until the handler finishes by renewing it every ttlMs/3. If renew returns FALSE
    // (fencing token mismatch — the lock was genuinely taken over), `lease-lost` is marked: this
    // worker can no longer WRITE THE JOB RESULT — the worker that took over will write its own
    // run; a stale worker's qdone/qfail/qatt write could overwrite it and make an
    // INCONSISTENT/wrong result permanent. `lease-lost` is a DELAYED approximation, up to one
    // heartbeat tick (ttlMs/3) — if the handler finishes mid-tick, `lease-lost` may not be true yet
    // even though a real takeover happened. If WorkStore supports it, `stillOwns()` (below) closes
    // this narrow window AT WRITE TIME via the `qown` CAS; if not, we rely on `lease-lost` alone
    // (WorkStore.put is NOT CAS-backed — see storage.ts WorkStore).
    // renew THROWING (a TRANSIENT error like a network/journal hiccup) is a separate case: a
    // SINGLE throw does NOT PROVE a token mismatch — we don't know a real takeover happened —
    // so a single hiccup does NOT TOUCH `lease-lost` (flipping it to true by mistake would mean
    // qdone/qfail/qatt never get written even if the handler finishes successfully, AND
    // release() would genuinely free the lock since the token still matches → another worker
    // would RE-RUN the job, exactly the double-run Y2 is meant to prevent). It's just logged; the
    // lock's TTL already tolerates a few renew ticks (ttlMs/3 interval), and the next tick
    // retries. BUT (Phase 8 review leftover) if the throw repeats `maxRenewFailures` times IN A
    // ROW, the transient error has become PERSISTENT — this is the best approximation of the
    // lock having GENUINELY expired via TTL (the worker can't be certain since WorkStore lacks
    // CAS/fencing here — "WorkStore fencing" is a tracked backlog item) → at
    // that point the grant revoked as `lease-lost` is assumed. Any SUCCESSFUL renew (non-throwing) resets the
    // consecutive counter — a single hiccup never produces `lease-lost`.
    const heartbeatOn = opts.heartbeat ?? true;
    let heartbeat: ReturnType<typeof setInterval> | undefined;
    // THE RIGHT TO RUN THE JOB (@gnldev/durable executionGrant): the handler's `ctx.signal`. A lease
    // renewal that answers false (a real takeover, token mismatch) or throws maxRenewFailures times in
    // a row revokes it as `lease-lost`; a cancel as `canceled`; maxHoldMs as `timeout`. One signal,
    // its reason saying which — a lost lease used to only mark the job's outcome unwritable while the
    // handler ran on, its side effect beside the new holder's (audit N4).
    const grant = executionGrant(`@gnldev/queue: job ${job.id}`, { unheededAfterMs: ttlMs, unheeded: UNHEEDED, ...(opts.maxHoldMs !== undefined ? { maxHoldMs: opts.maxHoldMs } : {}) });
    if (heartbeatOn) {
      grant.keep(() => lock.renew(ttlMs), {
        everyMs: ttlMs / 3,
        maxFailures: maxRenewFailures,
        onTransient: (err, n) => console.warn(`[queue] renew transient error (job ${job.id}, ${n}x in a row), next tick will retry:`, err),
      });
      heartbeat = setInterval(() => {
        // A cancel requested while the handler runs reaches it here, as `ctx.signal`.
        if (!grant.signal.aborted) {
          work.get(`qcancel:${job.id}`).then((c) => { if (c !== undefined) grant.revoke('canceled', `@gnldev/queue: job ${job.id} was cancelled`); }, () => {});
        }
        slot.renew().catch(() => {}); // a lost slot only loosens the limit until this job ends; never fails it
      }, Math.max(1, Math.floor(ttlMs / 3)));
    }
    // 8.2: the terminal-write GATE. `lease-lost` (precautionary — also becomes true on consecutive
    // renew failures, a real takeover is NOT REQUIRED) is STILL the first condition and is the
    // behavior the existing tests rely on. ON TOP OF THAT: if WorkStore supports putIfMatch, a
    // second, stricter check is added via an INSTANT in-engine CAS on `qown` — this catches a
    // real takeover even if it happened mid-heartbeat-tick (not yet reflected in the grant). If
    // putIfMatch isn't available, we fall back to `lease-lost` alone (old behavior preserved
    // EXACTLY).
    const stillOwns = async (): Promise<boolean> => {
      if (grant.revoked === 'lease-lost') return false;
      if (!work.putIfMatch) return true;
      return work.putIfMatch(fencingKey, lock.token, lock.token);
    };
    // THE JOB IN HAND, from here to its lease's release (@gnldev/durable `holdWhile`): a drain waits for
    // it whoever called runOnce, and `gnl pending` lists it — from this process, or from its shadow in
    // another (audit C7). The unit IS this block: it ends when the block does, on every way out, and the
    // handler runs as part of it — a handler that closes its worker or drains the process does not wait
    // for itself (R2-7).
    return await holdWhile(async (): Promise<boolean> => {
      // The attempt record as it was before this attempt counted itself: what a release gives back.
      let started: TryRecord | undefined;
      try {
        // The attempt is counted when it STARTS: a process that dies while the handler runs (a crash,
        // an OOM, a kill) has used an attempt too. Counted at the end, such a job never reached maxAttempts.
        started = await attemptsOf(work, job.id);
        if (started.attempts >= maxAttempts) {
          // Its last attempt started and never reported: its OUTCOME IS UNKNOWN, not failed — a worker
          // judged gone because it was cut off from the store (a partition) can still be in the handler
          // and finish it after this (measured, ADR-0008: 5 partitions in a row,
          // the job dead-lettered while the handler then finished). No attempt starts again (the
          // ceiling holds); the job reads `in-doubt` until a report settles it — that worker's own
          // late `qdone` (below), or an operator's `retryJob`.
          if (await stillOwns()) {
            await putJobMarker(work, job.id, 'qfail', { error: `the job's last attempt did not report in ${started.attempts} attempts (its process stopped or was cut off while it ran) — its outcome is unknown`, attempts: started.attempts, inDoubt: true });
            // Written first, read second (recordLateSuccess does the reverse): a handler that finished
            // late is seen by one side or the other.
            await settleFromLateReport(work, job.id);
          }
          return true;
        }
        if (!(await stillOwns())) return false;
        if (await settleFromLateReport(work, job.id, true)) return true;
        if (!(await putJobMarker(work, job.id, 'qtry', { attempts: started.attempts + 1, notBefore: started.notBefore }))) return true;
        const handler = handlers[job.payload.type];
        if (!handler) {
          if (await stillOwns()) await putJobMarker(work, job.id, 'qfail', { error: `no handler: ${job.payload.type}` });
          return true;
        }
        const rec = job.payload;
        const orgId = rec.orgId;
        const scoped = orgId !== undefined ? withOrgStorage(storage, orgId) : storage;
        const caller = callerOfJob(rec);
        // ADR-0002 5a: the job's run belongs to the job's recorded owner WITHOUT the handler passing
        // it. Recorded here, before the handler runs (first write wins, so a retry or a resumed run
        // keeps the owner it was born with). A handler that starts `runId` as anyone else — the old
        // `runDurable({ runId: ctx.runId, … })` with the user forgotten — is now refused by the
        // engine's own admission instead of producing a run nobody but staff can see.
        // The queue composed `job:<id>`, so the queue begins it (run-id-grammar.ts `begin: 'composer'`);
        // a run a retry continues was born already, and the mark changes nothing for it.
        await claimRunOwner(toJournal(scoped.runs), runId, caller, composerMark(runId));
        const followUp = (o: EnqueueOptions = {}): EnqueueOptions => {
          if (o.caller !== undefined) return o;
          const base = ownerOptionsOf(rec);
          if (o.resourceId !== undefined) delete base.caller;
          else if (base.caller && o.orgId !== undefined) base.caller = staff(o.orgId);
          return { ...base, ...o };
        };
        await handler(rec.payload, {
          journal: scoped.runs, jobId: job.id, runId, storage: scoped, caller,
          ...(orgId !== undefined ? { orgId } : {}),
          run: (args) => runDurable({
            ...args,
            abortSignal: args.abortSignal ? AbortSignal.any([args.abortSignal, grant.signal]) : grant.signal,
            journal: toJournal(scoped.runs), runId, caller,
          }),
          enqueue: (type, payload, o) => enqueue(work, type, payload, followUp(o)),
          signal: grant.signal,
        });
        // The handler returned: it ran. Whether this worker still holds the job decides only where that
        // goes — a worker cut off from the store cannot even ask (its session was terminated), and that
        // is not the handler failing.
        const owns = await stillOwns().catch(() => false);
        if (owns) { if (!(await settleFromLateReport(work, job.id, true))) await putJobMarker(work, job.id, 'qdone', { at: Date.now(), ok: true }); }
        else await recordLateSuccess(work, job.id);
      } catch (err) {
        // NOT AN ATTEMPT (@gnldev/durable `attemptEndOf`, the one answer the scheduler gives too): this
        // process released the job — it drains, or cannot judge other processes right now — or the job's
        // run is executing elsewhere. The attempt counted at its start is given back and nothing else is
        // written; the lease goes below and the job stays due for another process (or this one, later).
        // Not reported to onError: the job did not fail.
        const end = attemptEndOf(err, runId);
        if (end === 'released' || end === 'deferred') {
          if (started && (await stillOwns().catch(() => false))) await putJobMarker(work, job.id, 'qtry', started).catch(() => undefined);
          return false;
        }
        // ITS RUN WAS DELETED: refused at its birth, or stopped while it ran. No attempt can run it
        // again, so none is left to spend — the job ends here, failed with that error, reported once.
        if (end === 'erased') {
          if (await stillOwns().catch(() => false)) {
            const n = (await attemptsOf(work, job.id)).attempts;
            await putJobMarker(work, job.id, 'qfail', { error: String((err as any)?.message ?? err), attempts: n, erased: true });
          }
          opts.onError?.(err, job.id);
          return true;
        }
        // Ended while it ran — cancelled (cancelJob: "else `cancelled`"), or settled by a late report:
        // not a failed attempt. A handler that stopped on ctx.signal used to dead-letter the job as
        // `failed` on its last attempt (audit C9).
        if (await isTerminal(work, job.id).catch(() => false)) return true;
        if (await stillOwns() && !(await settleFromLateReport(work, job.id, true))) {
          const n = (await attemptsOf(work, job.id)).attempts; // this attempt was counted when it started
          const delay = n < maxAttempts ? retryDelay(n, err) : 0;
          await putJobMarker(work, job.id, 'qtry', { attempts: n, notBefore: delay > 0 ? (await now()) + delay : 0 });
          if (n >= maxAttempts) {
            await putJobMarker(work, job.id, 'qfail', { error: String((err as any)?.message ?? err), attempts: n });
          }
        }
        opts.onError?.(err, job.id);
        // swallowed: the worker loop continues; the job (unless qfail) retries on the next turn → crash-resume.
      } finally {
        if (heartbeat) clearInterval(heartbeat);
        await grant.dispose();
        await slot.release();
        // While the lease is lost (a real takeover), release() is naturally a no-op because this
        // worker's token no longer matches the current record (see run-lock.ts mkLock.release) —
        // it never overwrites the lock of the worker that took over. On a transient renew error
        // (the lease is not lost) the token is STILL OURS, so release() here deliberately, genuinely
        // frees the lock (the job was already written as terminal).
        await lock.release();
        // After the release: a turn handed out while this worker still held the lease would be spent on a refusal.
        await settleReady(job, taken);
      }
      return true; // one job was processed (success or retry)
    }, {
      journal: toJournal((job.payload.orgId !== undefined ? withOrgStorage(storage, job.payload.orgId) : storage).runs),
      name: runId, what: `job '${job.payload.type}' is running`,
    });
  }

  async function drain(): Promise<number> {
    await followLegacyLog(true);
    let n = 0;
    // Until a take finds nothing ready: every job ends within `maxAttempts` attempts, and one waiting for
    // its retry delay is not ready. A cap counted the queue's jobs first — every lane, read in full.
    while (await runOnce()) n++;
    return n;
  }

  // Phase 8.1: the tick/backoff/"polling" flag loop now lives in @gnldev/durable's shared
  // createPollLoop (it was triplicated across queue/events/scheduler) — behavior is identical: if
  // runOnce() does NOT CLAIM a job (false) the interval grows ×2 while backoffOn (cap maxPollMs);
  // resets to pollMs once a job is claimed.
  // `concurrency` = that many independent loops over the same `runOnce`. Rejected alternative: one
  // loop running `concurrency` jobs per tick with Promise.all — a tick then lasts as long as its
  // slowest job, and the other slots sit idle behind it.
  const loops = Array.from({ length: concurrency }, () => createPollLoop(runOnce, { pollMs, backoff: backoffOn, maxPollMs }));

  let presenceTimer: ReturnType<typeof setInterval> | undefined;
  return {
    runOnce,
    drain,
    start: () => {
      stopped = false;
      for (const l of loops) l.start();
      if (presenceTimer) return;
      // Announced on its own clock too: a backed-off poll loop may tick less often than ttlMs/3.
      void announce();
      presenceTimer = setInterval(() => { void announce(); }, Math.max(1, Math.floor(ttlMs / 3)));
      (presenceTimer as { unref?: () => void }).unref?.();
    },
    stop: () => {
      stopped = true;
      for (const l of loops) l.stop();
      if (presenceTimer) clearInterval(presenceTimer);
      presenceTimer = undefined;
      announcedAt = -Infinity;
      void setPresence(work, owner, undefined).catch(() => {});
    },
    close: async () => {
      stopped = true;
      for (const l of loops) l.stop();
      if (presenceTimer) clearInterval(presenceTimer);
      presenceTimer = undefined;
      // Every job this worker holds except the one the caller runs inside: a job closing its own worker
      // would otherwise wait for itself, and neither would ever settle (R2-7).
      await settledExceptOwn(() => held);
      // A reclaim a poll started runs on its own (see `runOnceHeld`): done before the store may be closed.
      await reclaiming;
      announcedAt = -Infinity;
      await setPresence(work, owner, undefined).catch(() => {});
    },
  };
}

// ─── A queue: enqueue, and the worker that runs it here ─────────────────────────────────────────

export interface QueueOptions extends QueueWorkerOptions {
  /**
   * Run the jobs in this process (default `true`): a worker over `handlers` starts with the queue. `false`
   * for an application whose workers run elsewhere (`createWorker(storage, handlers).start()`); its jobs
   * wait for them, and a job still waiting with no live worker on the store is reported.
   */
  worker?: boolean;
}

export interface Queue {
  /** `enqueue(storage.work, type, payload, options)`. */
  enqueue(type: string, payload: unknown, options?: EnqueueOptions): Promise<string>;
  /** `enqueueMany(storage.work, jobs)`. */
  enqueueMany(jobs: readonly EnqueueManyJob[]): Promise<string[]>;
  /** The worker running here; absent with `worker: false`. */
  readonly worker?: Worker;
  /** Stops the worker running here (the job it holds finishes; nothing new is taken). */
  close(): Promise<void>;
}

/**
 * The queue of an application: where it enqueues, and — unless `worker: false` — the worker that runs
 * the jobs, started in this process. One call instead of two that had to be remembered together: an
 * application that enqueued and started no worker anywhere had its jobs wait forever without a word.
 */
export function createQueue(storageArg: Storage, handlers: Record<string, JobHandler>, opts: QueueOptions = {}): Queue {
  refuseUnknownNames('createQueue', opts, CREATE_QUEUE_OPTS_NAMES);
  const { worker: runHere = true, ...rest } = opts;
  const workerOpts: QueueWorkerOptions = { ...rest, owner: rest.owner ?? `w-${Math.random().toString(36).slice(2, 8)}` };
  const storage = storageOf(storageArg, 'createQueue');
  requireCapability(storage, 'work');
  const work = storage.work!;
  const worker = runHere ? createWorker(storage, handlers, workerOpts) : undefined;
  worker?.start();
  return {
    enqueue: (type, payload, options) => enqueue(work, type, payload, options),
    enqueueMany: (jobs) => enqueueMany(work, jobs),
    ...(worker ? { worker } : {}),
    close: async () => { await worker?.close(); },
  };
}

// ─── Upgrades and erasure ──────────────────────────────────────────────────────────────────────

/** What a step moved, or under `dryRun` would move. */
interface LanesMoved {
  /** Records of the earlier version's log appended to their lanes (found there already: not counted). */
  jobs: number;
  /** Of those, the jobs not finished: each given a ready entry. */
  ready: number;
}

/**
 * THE MOVE of the old log: every record of it this version has not moved yet (from `qmovecursor`), each
 * into its lane (`moveOne`); a record already in its lane is passed by. What `queue/lanes`, its cleanup's
 * last look, and a worker in a deploy window run. Concurrent calls (two workers) move a record twice at
 * worst, which finds it in place. `seen` (a worker's, across its calls): ids it found moved after the
 * cursor, not read again while the cursor stands. Leaves the old log as it is.
 *
 * BOUNDED, because an earlier producer may append faster than this moves (measured: MongoDB under three
 * 0.16 producers — `queue/lanes` chased the log and never ended). `until`: stop after the first page
 * that reaches a record appended after it (its `ts`) — what comes later is a deploy window's, which this
 * version's workers move. `pages`: stop after that many pages (a worker's share per call). Neither bound
 * decides correctness: a record not moved now is after the cursor, and the next call moves it.
 */
async function moveLegacyLog(
  work: WorkStore,
  dryRun: boolean,
  seen?: { at: string | undefined; ids: Set<string> },
  bound: { until?: number; pages?: number } = {},
): Promise<LanesMoved> {
  const report: LanesMoved = { jobs: 0, ready: 0 };
  let cursor = await work.get<string>(MOVE_CURSOR);
  if (seen && seen.at !== cursor) { seen.ids.clear(); seen.at = cursor; }
  for (let pages = 1; ; pages++) {
    const page = await work.list<JobRecord>(LEGACY_LOG, { limit: MOVE_PAGE, ...(cursor !== undefined ? { cursor } : {}) });
    for (const j of page.items) {
      if (seen?.ids.has(j.id)) continue;
      if ((await work.read(laneOfJob(j.id), j.id)) === undefined) {
        report.jobs++;
        if ((dryRun ? ((await isTerminal(work, j.id)) ? 'finished' : 'ready') : await moveOne(work, j)) === 'ready') report.ready++;
      }
      if (!dryRun) seen?.ids.add(j.id);
    }
    if (!page.nextCursor) return report;
    cursor = page.nextCursor;
    if (!dryRun) {
      // Every record before it is in its lane now.
      await work.put(MOVE_CURSOR, cursor);
      if (seen) { seen.ids.clear(); seen.at = cursor; }
    }
    if ((bound.until !== undefined && (page.items.at(-1)?.ts ?? 0) > bound.until) || (bound.pages !== undefined && pages >= bound.pages)) return report;
  }
}

/** `queue/lanes`: the old log moved, and that recorded — from then the store is at v2 and this version's worker starts. */
async function moveLanes(work: WorkStore, dryRun: boolean, host?: Storage): Promise<LanesMoved> {
  if ((await queueDataVersion(work)) >= QUEUE_DATA_VERSION) {
    if (!dryRun && host) await clearUpgradeDue(host, LANES_STEP);
    return { jobs: 0, ready: 0 };
  }
  // Up to what was there when it started: what an earlier producer adds after, the workers move (v2).
  const report = await moveLegacyLog(work, dryRun, undefined, { until: Date.now() });
  // Last: recorded only once every record found is in its lane.
  if (!dryRun && ((await work.get<{ version: number }>(DATA_VERSION_KEY))?.version ?? 1) < LANES_DATA_VERSION) {
    await work.put(DATA_VERSION_KEY, { version: LANES_DATA_VERSION });
  }
  if (!dryRun && host) await clearUpgradeDue(host, LANES_STEP);
  return report;
}

/**
 * What `queue/lanes-cleanup` says while workers of an earlier version poll the store (`olderWorkersLive`):
 * how many, when each was last seen and when its entry expires unless renewed, and what to do. 0.16's
 * entry records its last announcement only, not when the worker started.
 */
function olderWorkersRefusal(older: Array<[string, Presence]>, now: number): string {
  const n = older.length;
  const seen = older.map(([owner, p]) => `'${owner}' last seen ${new Date(p.at).toISOString()} (${Math.max(0, Math.round((now - p.at) / 1000))} s ago), gone from the record by ${new Date(p.at + p.ttlMs).toISOString()} unless it announces again`).join('; ');
  return (
    `@gnldev/queue: queue/lanes-cleanup refused: ${n} worker${n === 1 ? '' : 's'} of an earlier version (0.16 or before) ` +
    `still poll${n === 1 ? 's' : ''} this store — ${seen}. The cleanup deletes the old log and the cursor ${n === 1 ? 'it reads' : 'they read'}: ` +
    'a worker of 0.16 still running would read that log from its head again, and a producer of 0.16 would write jobs no worker of this version looks for. ' +
    'Stop them (finish the deploy), then run it again: `gnl upgrade --only queue/lanes-cleanup`. ' +
    "An entry that is never renewed (a killed process) goes by itself when its time above passes. " +
    'This sees workers only: a 0.16 process that enqueues without running a worker leaves no entry — make sure none is left.'
  );
}

/**
 * `queue/lanes-cleanup`: one last move, then the old log, 0.16's cursor and this version's move cursor go,
 * and v3 is recorded. Only once every process of the earlier version is gone: a worker of it still running
 * would read the log from its head again (its cursor gone), and a producer of it would write a job after the
 * last move — which this version's workers, at v3, no longer look for. A live worker of it (its presence) is
 * refused here — the dry run reports it (`olderWorkers`, `refusal`); a producer without a worker cannot be seen.
 */
async function cleanUpLanes(work: WorkStore, dryRun: boolean, host?: Storage): Promise<LanesMoved & { removed: number; olderWorkers?: number; refusal?: string }> {
  if ((await queueDataVersion(work)) >= QUEUE_DATA_VERSION) {
    if (!dryRun && host) await clearUpgradeDue(host, CLEANUP_STEP);
    return { jobs: 0, ready: 0, removed: 0 };
  }
  if (!dryRun && typeof work.deletePrefix !== 'function') {
    throw new Error('@gnldev/queue: queue/lanes-cleanup needs a work store that can delete by prefix (`deletePrefix`) to retire the old log');
  }
  const older = await olderWorkersLive(work);
  const refused = older.length > 0 ? { olderWorkers: older.length, refusal: olderWorkersRefusal(older, Date.now()) } : undefined;
  if (refused && !dryRun) throw new Error(refused.refusal);
  const report = await moveLegacyLog(work, dryRun);
  let removed = 0;
  if (dryRun) {
    let cursor: string | undefined;
    do {
      const page = await work.list(LEGACY_LOG, cursor !== undefined ? { cursor } : undefined);
      removed += page.items.length;
      cursor = page.nextCursor;
    } while (cursor);
    for (const k of [LEGACY_CURSOR, MOVE_CURSOR]) if ((await work.get(k)) !== undefined) removed++;
  } else {
    for (const k of [LEGACY_LOG, LEGACY_CURSOR, MOVE_CURSOR]) removed += await work.deletePrefix!(k);
    // Last: recorded only once the old log and both cursors are gone.
    await work.put(DATA_VERSION_KEY, { version: QUEUE_DATA_VERSION });
    if (host) await clearUpgradeDue(host, CLEANUP_STEP);
  }
  return { ...report, removed, ...refused };
}

/**
 * Moves ONE job of the earlier version's log (`qjob`, a record as `work.list('qjob')` returns it) into this
 * version's lanes — THE move, which `queue/lanes` makes for every record and a worker meeting a job an
 * earlier producer appended during a deploy makes for that one. Appended to its organization's lane under
 * its own id; a job not finished (`qdone` / `qfail` / `qcancel`) also gets its ready entry, ranked as a new
 * job is. Idempotent: moved again, the record and its entry are found in place (`WorkStore.appendReady`)
 * and the job still runs once. It leaves the old record where it is.
 * Answers `'ready'` (it has a turn) or `'finished'` (moved without one).
 */
export async function moveLegacyJob(workArg: WorkStore, job: LogRecord<JobRecord>): Promise<'ready' | 'finished'> {
  return moveOne(portOf(workArg, 'work', 'moveLegacyJob'), job);
}
async function moveOne(work: WorkStore, j: LogRecord<JobRecord>): Promise<'ready' | 'finished'> {
  if (await isTerminal(work, j.id)) {
    await work.append(laneOfJob(j.id), j.payload, j.id);
    return 'finished';
  }
  await work.appendReady(laneOfJob(j.id), j.payload, j.id, { set: READY, kind: j.payload.type, notBefore: 0, now: Date.now() });
  return 'ready';
}


/**
 * The queue's upgrade steps, for the store they are registered on: `registerUpgradeSteps(storage, [queueUpgrade])`.
 * Two, by when they may run (the data versions, `queueDataVersion`):
 *   · `queue/lanes` — pending at v1: moves the old log's jobs into lanes and records v2. It leaves the log
 *     and 0.16's cursor alone, so it runs while workers and producers of the earlier version still do
 *     (a plain `gnl upgrade`); what they add after it, this version's workers move.
 *   · `queue/lanes-cleanup` — pending below v3, `afterOlderGone`: deletes the old log and both cursors and
 *     records v3, after which no worker of this version looks at the old log again.
 * Each answers the data version before it ("data v1 → package v3"); nothing is decided here.
 */
export const queueUpgrade: UpgradeStepFactory = (storageArg) => {
  const work = (): WorkStore => portOf(storageArg, 'work', 'queueUpgrade');
  const answer = async (f: (w: WorkStore) => Promise<LanesMoved>): Promise<Record<string, unknown>> => {
    const dataVersion = await queueDataVersion(work());
    return { dataVersion, packageVersion: QUEUE_DATA_VERSION, ...(await f(work())) };
  };
  const host = (): Storage | undefined => dueHostOf(storageArg, work());
  const steps: UpgradeStep[] = [
    {
      name: LANES_STEP,
      description: "moves the jobs 0.16 and earlier enqueued (the one 'qjob' log) into their organizations' lanes and the ready set; leaves the old log",
      requires: ['schema'],
      pending: async () => (await queueDataVersion(work())) < LANES_DATA_VERSION,
      plan: () => answer((w) => moveLanes(w, true)),
      run: () => answer((w) => moveLanes(w, false, host())),
    },
    {
      name: CLEANUP_STEP,
      description: "deletes the old 'qjob' log and its cursors, after a last move",
      requires: [LANES_STEP],
      afterOlderGone: true,
      pending: async () => (await queueDataVersion(work())) < QUEUE_DATA_VERSION,
      plan: () => answer((w) => cleanUpLanes(w, true)),
      run: () => answer((w) => cleanUpLanes(w, false, host())),
    },
  ];
  return steps;
};

/**
 * Give an existing SYSTEM job (an id written before jobs had owners) to an owner, without doubling it.
 *
 * `enqueue` stores an owned job under `ownedName(id, owner)`, so after an upgrade the same caller
 * re-enqueuing `weekly-report` with `{ orgId }` adds a SECOND job next to the old one, and both run.
 * This moves it instead: the owned job gets the old one's markers (a finished job stays finished, a
 * dead letter stays dead), then the old one is marked done with `movedTo`. Run it once per id during
 * the upgrade, with the workers stopped; afterwards the post-upgrade `enqueue` is idempotent with it.
 * A job that had started keeps no progress: its run was `job:<old id>`, the moved job's is new.
 *
 * Returns the owned id, or `null` when there is no such job. Refuses an id that already has an owner.
 */
export async function moveJob(workArg: WorkStore, fromId: string, to: Omit<EnqueueOptions, 'id' | 'maxDepth'>): Promise<string | null> {
  refuseUnknownNames('moveJob', to, MOVE_JOB_TO_NAMES);
  const work = portOf(workArg, 'work', 'moveJob');
  const from = ownerOfName(fromId);
  if (from.resourceId !== undefined || from.orgId !== undefined) {
    throw new TypeError(`@gnldev/queue: moveJob('${fromId}') — that job already has an owner; only a system job is moved.`);
  }
  const owner = jobOwnerOf(to);
  if (owner.resourceId === undefined && owner.orgId === undefined) {
    throw new TypeError('@gnldev/queue: moveJob needs an owner to move the job to (`caller`, `resourceId` or `orgId`).');
  }
  const old = await findJob(work, fromId);
  if (!old) return null;
  const toId = ownedName(fromId, { resourceId: owner.resourceId, orgId: owner.orgId });
  // Markers FIRST: a worker that saw the owned job before its markers would run a finished job again.
  for (const m of STATE_MARKERS) {
    const v = await work.get(`${m}:${fromId}`);
    if (v !== undefined && (await work.get(`${m}:${toId}`)) === undefined) await work.put(`${m}:${toId}`, v);
  }
  await enqueue(work, old.payload.type, old.payload.payload, { ...to, id: fromId });
  if (!(await isTerminal(work, fromId))) {
    await work.put(`qdone:${fromId}`, { at: Date.now(), movedTo: toId });
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
 * Erase one person's jobs: the job records and their depth-index records, the state markers
 * (`STATE_MARKERS`) and `qown` (a `qfail` holds the handler's error text), the worker's lease locks in the root
 * journal, and the job runs themselves (`job:<owned id>` in the organization's journal).
 *
 * Found by the id prefix the engine wrote (`ownedPrefix`), never by payload. Refuses, rather than
 * reporting a partial erasure as done, when a store cannot delete: the work store needs
 * `deleteIdPrefix` and `deletePrefix`, the run journal `deletePrefix`.
 *
 * Pass it to `eraseSubject({ …, erasers: [jobEraser(storage)] }, id)`, or call `.erase(owner)`. Handed an
 * organization (`{ orgId }`, by `purgeOrganization`), it erases every job owned under it, its members' too.
 */
export function jobEraser(storageArg: Storage): SubjectEraser {
  const storage = storageOf(storageArg, 'jobEraser');
  // One body for a person and an organization: what differs is the owner's prefix (`ownedPrefix`).
  const eraseOwned = async (owner: { resourceId?: string; orgId?: string }): Promise<number> => {
    requireCapability(storage, 'work');
    const work = storage.work!;
    assertRootWorkForErasure(work, '@gnldev/queue: jobEraser');
    if (typeof work.deleteIdPrefix !== 'function' || typeof work.deletePrefix !== 'function') {
      throw new Error("@gnldev/queue: this work store cannot delete by id prefix (`deleteIdPrefix`) and key prefix (`deletePrefix`), so this person's jobs cannot be erased through it");
    }
    const root = toJournal(storage.runs);
    const scoped = owner.orgId !== undefined ? toJournal(withOrgStorage(storage, owner.orgId).runs) : root;
    if (typeof root.deletePrefix !== 'function' || typeof scoped.deletePrefix !== 'function') {
      throw new Error("@gnldev/queue: the run journal cannot deletePrefix, so this person's job runs and locks cannot be erased");
    }
    const prefix = ownedPrefix(owner);
    let n = await work.deleteIdPrefix(prefix);
    // The fence FIRST (`qown`, then the attempt record that stands in for it — `putJobMarker`): a worker
    // reads it after every write of a job's state, so a write lands either before this erasure reaches
    // it or before that worker's read sees the fence gone, and the worker takes it back.
    for (const m of ['qown', 'qtry', ...STATE_MARKERS.filter((x) => x !== 'qtry')]) n += await work.deletePrefix(`${m}:${prefix}`);
    // An organization's lane, with its ready entries and its ranking lock (a person's prefix names no lane).
    n += await work.deletePrefix(`${SYSTEM_LANE}:${prefix}`);
    // The lease lock lives in the ROOT journal (`job:<id>:lease:lock`); the run in the job's organization.
    n += await root.deletePrefix(`job:${prefix}`);
    if (owner.orgId !== undefined) n += await scoped.deletePrefix(`job:${prefix}`);
    // The shadows of the processes holding these jobs (@gnldev/durable `holdWhile`): they name the jobs' runs.
    n += await root.deletePrefix(handNamePrefix(owner.orgId, `job:${prefix}`));
    return n;
  };
  return {
    name: 'jobs',
    erase: (owner) => eraseOwned(owner),
    eraseOrganization: (orgId) => eraseOwned({ orgId }),
  };
}
