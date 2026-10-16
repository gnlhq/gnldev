// @gnldev/queue — durable background-task queue + worker on top of WorkStore.
// Each job runs as a DURABLE run (the handler typically calls runDurable(runId:'job:'+id)) →
// if the worker crashes mid-job the lock goes stale → reclaim → handler runs again → runDurable
// resumes from the RunJournal → SIDE EFFECT HAPPENS ONCE. acquireRunLock (M4) prevents two workers
// from running the same job concurrently.
// Job log + markers live in WorkStore (own namespace); the lock + handler's durability live in RunJournal.
import { randomUUID } from 'node:crypto';
import {
  acquireRunLock, requireCapability, createPollLoop, orgPrefix, withOrgStorage, orgStorageScopeOf, ownedName, ownedPrefix,
  claimRunOwner, runDurable, user, staff, UNKNOWN, toJournal, ownerOfName, assertRootWorkForErasure, portOf, storageOf,
  processLiveness, storeLiveness, isProcessLocal, isDraining, LivenessRequiredError, attemptEndOf, holdWhile, settledExceptOwn, handNamePrefix,
  refuseErasedRunId, storageOfWork, isStorage } from '@gnldev/durable';
import type { Storage, WorkStore, RunJournal, LogRecord, Caller, RunDurableArgs, DurableResult, ProcessLiveness } from '@gnldev/durable';
import { refuseUnknownNames } from '@gnldev/options';
import { ENQUEUE_OPTIONS_NAMES, RETRY_JOB_OPTS_NAMES, CREATE_WORKER_OPTS_NAMES, CREATE_QUEUE_OPTS_NAMES, MOVE_JOB_TO_NAMES } from './option-names.js';

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
   * Aborted when the job is cancelled (`cancelJob`) while this handler runs. The worker notices on its
   * heartbeat tick (every `ttlMs/3`), so with `heartbeat: false` it is never aborted. `ctx.run` already
   * passes it on to the run; a handler doing other long work checks it itself.
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
  const t = await work.get<TryRecord>(`qtry:${jobId}`);
  const old = await work.get<unknown>(`qatt:${jobId}`);
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
   * holding a job is alive is asked of it, not of the lease's age. Default: the one installed in this
   * process, else the one the storage makes for itself (a SqliteStorage or PostgresStorage answers for
   * itself), installed for the process. A store only this process reaches (in memory) needs none; any
   * other store without one is refused (`LivenessRequiredError`) — guessed by age, a frozen worker's job
   * is taken and its side effect runs twice.
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
   * persistent — e.g. journal/network is consistently unreachable), `lockLost=true` is assumed: a
   * persistent transient error is treated as the best available signal that the lock may have REALLY
   * expired via TTL — the worker can't know for certain, so this is the best approximation (until
   * WorkStore CAS/fencing lands — a tracked backlog item). Default 3. The consecutive counter is
   * reset by any SUCCESSFUL renew (a single hiccup never PRODUCES a lockLost — current behavior, see tests).
   */
  maxRenewFailures?: number;
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
  if (opts.maxDepth != null) {
    // Counted per organization: one organization filling the queue refused every other one's work.
    // Read from the organization's own depth index, so an organization with 5 jobs pays for 5 records,
    // not for every other organization's backlog (R22).
    const depth = await countUpTo(work, depthNs(opts.orgId), opts.maxDepth);
    if (depth >= opts.maxDepth) {
      throw new QueueDepthExceededError(
        `@gnldev/queue: queue depth limit exceeded (${depth} >= ${opts.maxDepth}) — job rejected (type='${type}').`,
        { type, depth, maxDepth: opts.maxDepth },
      );
    }
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
  // here by that same rule, before anything is written — not accepted, then failed on every attempt
  // (e2e F1). A fresh random id was never anybody's run; only a caller-chosen one is asked.
  const runOfJob = runId ?? (opts.id !== undefined && stored !== undefined ? `job:${stored}` : undefined);
  const runs = runOfJob === undefined ? undefined : jobRunsOf(work, given, opts.orgId);
  if (runOfJob !== undefined && runs !== undefined) await refuseErasedRunId(runs, runOfJob);
  const id = await work.append('qjob', rec, stored);
  // The depth index, under the SAME id (idempotent with the job). A crash between the two appends
  // under-counts this one job by one; never over-counts.
  await work.append(depthNs(opts.orgId), { type }, id);
  noticeIfUnconsumed(work, type, id);
  return id;
}

/**
 * Exhausts WorkStore.list pagination (default limit, e.g. 50) to return ALL records in a namespace.
 * Intended for management/listing (listJobs, drain's cap calculation) — NOT USED in the poll loop
 * (runOnce); that path reads only the necessary pages via a cursor (5.1: reduce O(n)-per-poll).
 */
async function listAll<T>(work: WorkStore, ns: string): Promise<LogRecord<T>[]> {
  const out: LogRecord<T>[] = [];
  let cursor: string | undefined;
  for (;;) {
    const page = await work.list<T>(ns, { cursor });
    out.push(...page.items);
    if (!page.nextCursor) return out;
    cursor = page.nextCursor;
  }
}

/** Summary of all jobs (pending/done/failed + attempt count). */
export async function listJobs(workArg: WorkStore): Promise<JobStatus[]> {
  const work = portOf(workArg, 'work', 'listJobs');
  const jobs = await listAll<JobRecord>(work, 'qjob');
  const out: JobStatus[] = [];
  for (const j of jobs) {
    const done = await work.get(`qdone:${j.id}`);
    const fail = await work.get(`qfail:${j.id}`);
    const cancelled = await work.get(`qcancel:${j.id}`);
    const { attempts } = await attemptsOf(work, j.id);
    // A job cancelled while it ran, and which then finished, ran: `done` wins over `cancelled`.
    // `in-doubt`: dead-lettered with its outcome unknown (its last attempt never reported) — a late
    // report makes it `done`.
    const status = done ? 'done' : fail ? ((fail as { inDoubt?: unknown }).inDoubt === true ? 'in-doubt' : 'failed') : cancelled !== undefined ? 'cancelled' : 'pending';
    const notBefore = status === 'pending' ? await notBeforeOf(work, j) : 0;
    out.push({
      id: j.id,
      type: j.payload.type,
      status,
      attempts,
      ...(notBefore > 0 ? { notBefore } : {}),
      ...(j.payload.resourceId !== undefined ? { resourceId: j.payload.resourceId } : {}),
      ...(j.payload.orgId !== undefined ? { orgId: j.payload.orgId } : {}),
    });
  }
  return out;
}

/**
 * Finds the job record with `id` (if any) in the `qjob` log. Unlike `listAll` it does NOT READ the
 * entire log — it scans page by page and stops as soon as the id is found (cost O(pages read until found)).
 */
async function findJob(
  work: WorkStore,
  id: string,
): Promise<LogRecord<JobRecord> | undefined> {
  let cursor: string | undefined;
  for (;;) {
    const page = await work.list<JobRecord>('qjob', { cursor });
    const hit = page.items.find((j) => j.id === id);
    if (hit) return hit;
    if (!page.nextCursor) return undefined;
    cursor = page.nextCursor;
  }
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
 * Every polling worker on a store announces itself in `__qworkers__`, every ttlMs/3: `owner → { at, ttlMs }`. It
 * answers "is anyone polling now", so it is judged by its age alone — a process that is alive and no
 * longer polls (a worker stopped, a one-off `drain()` long done) consumes nothing. Advisory: it decides
 * no job, only whether "nobody consumes this" is said. One key per store: a worker takes every job it
 * sees (a type it has no handler for is dead-lettered), so the question is whether a worker polls, not
 * which types it handles.
 */
// `__`: a platform key (organization.ts `isPlatformKey`) — process state, never moved into an organization.
const PRESENCE = '__qworkers__';
interface Presence { at: number; ttlMs: number }

function livePresence(map: Record<string, Presence> | undefined, now: number): Record<string, Presence> {
  return Object.fromEntries(Object.entries(map ?? {}).filter(([, p]) => p.at + p.ttlMs >= now));
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
      await setPresence(work, owner, { at: Date.now(), ttlMs });
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
  // Queue-wide scan cursor (WorkStore KV): persistently tracks the position "all jobs before this
  // point are terminal (done/fail)" → subsequent polls never re-scan earlier pages (5.1: starvation +
  // O(n)-per-poll fix). If a job is still pending (awaiting retry / locked) the cursor does NOT PASS
  // it → exactly-once/retry semantics are preserved. Old (cursor-less) queues also flow from the
  // start (cursor=undefined), and so does a cursor 0.9 persisted (a row offset — see WorkStore.list:
  // the cursor is a record's position now, so an erasure or a slow producer clock cannot move it).
  const QCURSOR = 'qcursor';

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
  async function runOnceHeld(): Promise<boolean> {
    const live = await liveness();
    await announce();
    let cursor = await work.get<string>(QCURSOR);
    for (;;) {
      const page = await work.list<JobRecord>('qjob', { cursor });
      let allTerminal = true;
      for (const job of page.items) {
        // A cheap pre-filter only. It decides nothing: see the re-check under the lease below.
        const before = await mayStart(job);
        if (before === 'finished') continue;
        allTerminal = false; // a waiting job is not finished: the cursor must not pass it
        if (before === 'waiting') continue;
        // GRACEFUL DRAIN (@gnldev/durable drainProcess): a process shutting down takes no new job — the
        // same boundary rule as a run's next step. A scan under way when the drain began stops here; the
        // job is left for a process that is not leaving.
        if (isDraining()) return false;
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
        const stampedBy = live?.id;
        const lock = await acquireRunLock(runs, `${runId}:lease`, owner, ttlMs);
        if (!lock) continue; // held by another worker / fresh lease
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
          continue;
        }
        // A process that cannot prove it still holds its own liveness (its session is gone — a partition)
        // may already be judged dead elsewhere, its job taken: it starts nothing. Nor when the lease names
        // an id it no longer holds (its session came back under a new one).
        if (live && !live.processOnly && (live.id !== stampedBy || !(await live.confirm()))) {
          await lock.release();
          return false;
        }
        // The fleet-wide per-type limit: taken after the job's lease (so a slot is never held for a
        // job this worker lost), given back with it.
        const slot = await acquireSlot(job.payload.type);
        if (!slot) {
          await lock.release();
          continue;
        }
        // 8.2 (closes a correctness debt): terminal writes (qdone/qfail/qatt) get their OWN fencing
        // chain inside WorkStore. `qown:<jobId>` answers "who currently holds this" for the ENTIRE
        // DURATION of this run via WorkStore's own in-engine CAS (putIfMatch) — INDEPENDENT of the
        // lock record in RunJournal, within WorkStore's own consistency boundary. The first write is
        // an UNCONDITIONAL put: the claim itself was already deduplicated via RunJournal CAS
        // (acquireRunLock) → overwriting here is safe (a new claim = a new token = a new "ownership
        // epoch"). If WorkStore doesn't support putIfMatch this key is never written (stillOwns()
        // below then falls back to lockLost only — old behavior preserved EXACTLY).
        const fencingKey = `qown:${job.id}`;
        if (work.putIfMatch) await work.put(fencingKey, lock.token);
        // Y2 (heartbeat): if the handler runs longer than ttlMs, the lock TTL expires → a second
        // worker could take over the SAME job and DOUBLE-RUN it (the actual bug). We keep the lock
        // alive until the handler finishes by renewing it every ttlMs/3. If renew returns FALSE
        // (fencing token mismatch — the lock was genuinely taken over), `lockLost` is marked: this
        // worker can no longer WRITE THE JOB RESULT — the worker that took over will write its own
        // run; a stale worker's qdone/qfail/qatt write could overwrite it and make an
        // INCONSISTENT/wrong result permanent. `lockLost` is a DELAYED approximation, up to one
        // heartbeat tick (ttlMs/3) — if the handler finishes mid-tick, `lockLost` may not be true yet
        // even though a real takeover happened. If WorkStore supports it, `stillOwns()` (below) closes
        // this narrow window AT WRITE TIME via the `qown` CAS; if not, we rely on `lockLost` alone
        // (WorkStore.put is NOT CAS-backed — see storage.ts WorkStore).
        // renew THROWING (a TRANSIENT error like a network/journal hiccup) is a separate case: a
        // SINGLE throw does NOT PROVE a token mismatch — we don't know a real takeover happened —
        // so a single hiccup does NOT TOUCH `lockLost` (flipping it to true by mistake would mean
        // qdone/qfail/qatt never get written even if the handler finishes successfully, AND
        // release() would genuinely free the lock since the token still matches → another worker
        // would RE-RUN the job, exactly the double-run Y2 is meant to prevent). It's just logged; the
        // lock's TTL already tolerates a few renew ticks (ttlMs/3 interval), and the next tick
        // retries. BUT (Phase 8 review leftover) if the throw repeats `maxRenewFailures` times IN A
        // ROW, the transient error has become PERSISTENT — this is the best approximation of the
        // lock having GENUINELY expired via TTL (the worker can't be certain since WorkStore lacks
        // CAS/fencing here — "WorkStore fencing" is a tracked backlog item) → at
        // that point `lockLost=true` is assumed. Any SUCCESSFUL renew (non-throwing) resets the
        // consecutive counter — a single hiccup never produces lockLost.
        const heartbeatOn = opts.heartbeat ?? true;
        let lockLost = false;
        let consecutiveRenewFailures = 0;
        let heartbeat: ReturnType<typeof setInterval> | undefined;
        const cancel = new AbortController();
        if (heartbeatOn) {
          heartbeat = setInterval(() => {
            // A cancel requested while the handler runs reaches it here, as `ctx.signal`.
            if (!cancel.signal.aborted) {
              work.get(`qcancel:${job.id}`).then((c) => { if (c !== undefined) cancel.abort(new Error(`@gnldev/queue: job ${job.id} was cancelled`)); }, () => {});
            }
            slot.renew().catch(() => {}); // a lost slot only loosens the limit until this job ends; never fails it
            lock
              .renew(ttlMs)
              .then((ok) => {
                if (!ok) { lockLost = true; return; } // false = a real takeover (token mismatch)
                consecutiveRenewFailures = 0; // successful renew → consecutive failure counter resets
              })
              .catch((err) => {
                consecutiveRenewFailures++;
                console.warn(`[queue] renew transient error (job ${job.id}, ${consecutiveRenewFailures}x in a row), next tick will retry:`, err);
                if (consecutiveRenewFailures >= maxRenewFailures) {
                  lockLost = true;
                  console.warn(`[queue] renew threw ${consecutiveRenewFailures} times in a row (job ${job.id}) — the lock has likely expired via TTL, assuming lockLost=true (best approximation until WorkStore fencing).`);
                }
              });
          }, Math.max(1, Math.floor(ttlMs / 3)));
        }
        // 8.2: the terminal-write GATE. `lockLost` (precautionary — also becomes true on consecutive
        // renew failures, a real takeover is NOT REQUIRED) is STILL the first condition and is the
        // behavior the existing tests rely on. ON TOP OF THAT: if WorkStore supports putIfMatch, a
        // second, stricter check is added via an INSTANT in-engine CAS on `qown` — this catches a
        // real takeover even if it happened mid-heartbeat-tick (not yet reflected in lockLost). If
        // putIfMatch isn't available, we fall back to `lockLost` alone (old behavior preserved
        // EXACTLY).
        const stillOwns = async (): Promise<boolean> => {
          if (lockLost) return false;
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
            await claimRunOwner(toJournal(scoped.runs), runId, caller);
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
                abortSignal: args.abortSignal ? AbortSignal.any([args.abortSignal, cancel.signal]) : cancel.signal,
                journal: toJournal(scoped.runs), runId, caller,
              }),
              enqueue: (type, payload, o) => enqueue(work, type, payload, followUp(o)),
              signal: cancel.signal,
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
            await slot.release();
            // While lockLost=true (a real takeover), release() is naturally a no-op because this
            // worker's token no longer matches the current record (see run-lock.ts mkLock.release) —
            // it never overwrites the lock of the worker that took over. On a transient renew error
            // (lockLost stays false) the token is STILL OURS, so release() here deliberately, genuinely
            // frees the lock (the job was already written as terminal).
            await lock.release();
          }
          return true; // one job was processed (success or retry)
        }, {
          journal: toJournal((job.payload.orgId !== undefined ? withOrgStorage(storage, job.payload.orgId) : storage).runs),
          name: runId, what: `job '${job.payload.type}' is running`,
        });
      }
      if (allTerminal) {
        if (!page.nextCursor) return false; // end of log, all terminal — nothing to process
        // ALL jobs on this page are terminal → advance the cursor permanently (never re-scan it), move to the next page.
        cursor = page.nextCursor;
        await work.put(QCURSOR, cursor);
        continue;
      }
      if (!page.nextCursor) return false; // remaining job(s) exist but are all locked (another worker) — retried on the next poll
      // Page is only partially terminal (has a pending/locked job) → the cursor is NOT advanced permanently (retry preserved), check the next page.
      cursor = page.nextCursor;
    }
  }

  async function drain(): Promise<number> {
    let n = 0;
    // upper bound of TOTAL job count to prevent infinite retries (each turn either advances or approaches dead-letter).
    // listAll (5.1): counted correctly even if the job count exceeds the store's default page size (e.g. 50).
    const total = (await listAll(work, 'qjob')).length;
    const cap = total * (maxAttempts + 1) + 1;
    for (let i = 0; i < cap; i++) {
      if (await runOnce()) n++;
      else break;
    }
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
    ...(worker ? { worker } : {}),
    close: async () => { await worker?.close(); },
  };
}

// ─── Upgrades and erasure ──────────────────────────────────────────────────────────────────────

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
