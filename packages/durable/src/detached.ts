// A RUN DETACHED FROM ITS CALLER — started by a request, executed by the process that took the request,
// followed by anyone, continued by any process when that one is gone.
//
// The request used to BE the run: `await run(...)` inside the HTTP handler. A slow side effect held the
// request open, the client timed out and retried, the retry reached another process, and that process
// judged the first one's claim stale by its age and ran the effect beside it (release audit E6).
//
// Here the request starts the run and follows it:
//
//   · ONE EXECUTION PER RUN. An execution record (`__exec__:<scope>/<runId>#`, in the platform journal)
//     names the process executing the run. A retry of the same run — in this process or another —
//     finds it and FOLLOWS the run instead of starting a second execution. The record is taken over only
//     when its process is dead by the operating system or the database session (process-liveness.ts),
//     never by its age: a frozen process keeps its runs.
//   · EVERY STEP IS AN EVENT in the run's own journal (run-events.ts). The caller that started the run
//     streams it live on the same connection; a caller that left reconnects from its last `seq`;
//     a process that is not executing the run serves it from the journal (woken by a signal — Postgres
//     LISTEN/NOTIFY — or by polling). The run does not depend on any caller: it continues when they leave.
//   · A DEAD EXECUTOR IS REPLACED. Any process (every app process runs the sweep; a dedicated one may)
//     takes a run whose process is gone and continues it from the journal: finished steps replay, the
//     call that was in flight goes through the crash ladder (idempotency key → recover() → a human),
//     never blindly again.
//   · GRACEFUL DRAIN. `drain()`: no new run is accepted, the running tool finishes, no new step starts,
//     the runs are released and another process continues them at once.
//
// This module owns no HTTP: a door (REST, chat, AG-UI, MCP) or a plain script hands it a `launch`.
import { refuseUnknownNames } from '@gnldev/options';
import { DETACHED_RUNS_NAMES, FOLLOW_NAMES, EXEC_CANCEL_NAMES } from './option-names.js';
import { randomUUID } from 'node:crypto';
import { claim, runKeys, type Journal } from './journal.js';
import { compareAndSet } from './attempt.js';
import { interruptsFromSteps } from './agent-stream.js';
import { LIMIT_ERROR_CODES, BLOCKED_ERROR_CODES } from './errors.js';
import { limitBreachFromSteps, blockedFromSteps } from './run.js';
import { RUN_EVENT_VERSION, DELTA_KINDS, encodePart, errorData } from './event-codec.js';
import { readRunOutcome } from './outcome.js';
import { agentRunCanceled, cancelAgentRun } from './cancel.js';
import {
  beginDrain, bindLiveness, isDraining, isProcessLocal, livenessFor, inMemoryLiveness, LivenessUnavailableError, judgeAlive,
  within, settledExceptOwn, outsideHeld, type ProcessLiveness,
} from './process-liveness.js';
import { appendRunEvent, endsFollow, lastRunEvent, readRunEvents, runEventPrefix, type RunEvent, type RunState } from './run-events.js';
import { EXEC_PREFIX, execKey } from './exec-record.js';
import { runRecordKey, runRecordPrefix } from './run-id-grammar.js';
import { settleErasedRun, deleteExactKey } from './model.js';
import { runOwnerOf, type RawJournal } from './run-identity.js';
import { erasureBaseline, runErasedSince, assertNotErased, type ErasureBaseline } from './erasure-fence.js';
import { createHash } from 'node:crypto';
import { upgradeFormat } from './format.js';

/** The execution record: which process executes a run, and what another process needs to continue it. */
export interface ExecRecord {
  v: 1;
  runId: string;
  /** The scope the run's journal is in (an organization id), `undefined` for the root. */
  scope?: string;
  /** The process executing it; `status: 'released'` / `'parked'`: none. */
  owner: string;
  status: 'running' | 'parked' | 'released';
  at: number;
  /**
   * What `resume` needs to find how to continue the run elsewhere (an agent's name) — never content and
   * never a person: this record lives in the platform journal, outside every organization's partition.
   * Whom the run is for is the run's own owner record (`:input`), read when it is continued.
   */
  meta?: Record<string, unknown>;
  /** Why a run that nothing will move on its own waits (`parked`): a human's answer, or a launch that failed. */
  reason?: string;
  /** The last event `seq` before this execution's first: where a reader of THIS execution starts. */
  from?: number;
  /**
   * A run parked on a call whose outcome is unknown (`waiting-outcome`): the call's record (`key`, in the
   * run's journal) is what continues it. Any process's sweep continues the run as soon as that record holds
   * a result (a late attempt's, an operator's), and at `nextAt` to ask the tool again (`asks` so far,
   * backing off, at most OUTCOME_ASKS times — then only a result moves it, and `pending` says a person is needed).
   */
  awaits?: { key: string; toolCallId?: string; asks: number; nextAt: number };
}

/**
 * What starts or continues a run: an agent stream (a `streamDurable` / registry `stream` result). It may
 * carry `end` (`LaunchEnd`): work that belongs to the run's ENDING, done by whichever execution ends it.
 */
export type Launch = (signal: AbortSignal) => Promise<unknown>;

/**
 * A run's ending work (a background task's wake, deferred.ts): called when an execution ends the run
 * completed or failed — also an execution that only closes a run whose previous process died after its
 * end — before the execution record goes. Until it returns, the run is not over: a process that dies in
 * it leaves the record to be taken over, and a throw RELEASES the record (the next sweep, here or in
 * another process, ends the run again and calls it again). So it is called at least once per ending, and
 * must be idempotent; what it starts is kept to once by its own ids.
 */
export type LaunchEnd = (state: 'completed' | 'failed', signal: AbortSignal) => Promise<void>;

/** Cross-process wake-up for followers (optional; followers poll without it). */
export interface RunSignal {
  notify(key: string): Promise<void>;
  subscribe(onKey: (key: string) => void): Promise<void>;
}

export interface DetachedRunsOptions {
  /** Where the execution records live: the platform (unscoped) journal every process shares. */
  journal: Journal;
  /** The journal a scope's runs are in (default: `journal` for every scope). */
  journalFor?: (scope: string | undefined) => Journal;
  /** How a process that did not start a run continues it (takeover, approval): its launch. */
  resume: (rec: ExecRecord, journal: Journal) => Launch | Promise<Launch>;
  /** This process's liveness (default: the installed one, else an in-memory one — single process). */
  liveness?: ProcessLiveness;
  signal?: RunSignal;
  /** Poll interval of a follower in a process that is not executing the run. Default 200 ms. */
  pollMs?: number;
  /** Sweep interval (takeover of runs whose process is gone). Default 1 s; 0: no sweeper here. */
  sweepMs?: number;
  /**
   * Deltas within this window are one event in the store (the first of a step is written at once).
   * Default 1 s: measured on Postgres (ADR-0008), 30 ms wrote 337–355 KB of WAL per
   * 30 s answer, 1 s wrote 34–41 KB at the same throughput. A reader in the executing process does not
   * wait for the window: it reads each delta from memory as it is produced.
   */
  coalesceMs?: number;
  /**
   * A run waiting on a call's unknown outcome is continued to ask the tool again after this, doubling each
   * time (at most 5 min apart, OUTCOME_ASKS times). It is never what decides the outcome: a result recorded
   * for the call continues the run whenever it arrives. Default 2 s.
   */
  outcomeAskMs?: number;
  /** Completion notice — at least once per completed/failed run, `id` stable across deliveries. */
  onComplete?: (c: { id: string; runId: string; scope?: string; state: RunState }) => Promise<void>;
  /**
   * Which scopes this process can continue (its sweep takes over only these). Default: every scope.
   * A scope with no registered journal here is somebody else's to continue — `pending()` names it.
   */
  handles?: (scope: string | undefined) => boolean;
}

/**
 * What `start` is given. `admit`: the question "may this caller act on this run?" — asked of the owner of
 * that rule (the engine's admission, `admitAgentRun`) EVERY time, before a run is executed, taken over,
 * resumed or attached to. This module keeps no rule of its own about whose a run is.
 */
export interface StartRequest { runId: string; scope?: string; launch: Launch; admit?: () => Promise<void>; meta?: Record<string, unknown>; resumeIntent?: boolean }

export type StartState = 'started' | 'attached' | 'took-over' | 'resumed' | 'finished' | 'parked';

/**
 * What `start` found and where its caller reads from: `from` is the last event before the execution the
 * caller is joining (or, for a run that is over or waiting, before its last ending) — so a follow from
 * there sees this execution and its ending, never an earlier attempt's ending.
 */
export interface Started { runId: string; state: StartState; from: number }

/** A shared store and no process liveness: refused at construction (see the constructor). */
export class LivenessRequiredError extends Error {
  readonly code = 'liveness_required';
  constructor() {
    super(
      '@gnldev/durable: this journal cannot say whether other processes reach it, and runs need to know whether ' +
      'the process executing one is alive — guessed wrong, a live run is taken over and executed twice. Pass ' +
      '`liveness` to createGnl (or DetachedRuns): `sqliteLiveness(dbPath)` or `await postgresLiveness({ connectionString })` ' +
      'for a shared store, `inMemoryLiveness()` for a store only this process reaches. A SqliteStorage or ' +
      'PostgresStorage passed as `storage` answers for itself.',
    );
    this.name = 'LivenessRequiredError';
  }
}

/** Refused start: the process is draining (a door answers 503). */
export class DrainingError extends Error {
  readonly code = 'draining';
  constructor() { super('@gnldev/durable: this process is shutting down and accepts no new run'); this.name = 'DrainingError'; }
}

interface Local {
  key: string;
  runId: string;
  journal: Journal;
  ctrl: AbortController;
  next: number;
  /** Events this execution appended, for followers in this process (no store read). */
  log: RunEvent[];
  firstSeq: number;
  wake: Set<() => void>;
  done: Promise<void>;
  /** The erasure state at its start, the last fence check, and whether it found the run erased. */
  baseline?: ErasureBaseline;
  fenceAt: number;
  erased: boolean;
  /** When this execution last read its run's cancel record (`obeyCancel`). */
  cancelAt: number;
  /** The delta segment produced and not yet written (event `afterSeq + 1` once it is): what a reader here sees live. */
  live?: { afterSeq: number; kind: string; step: number; data: { id?: string; text: string } };
  /** The launch's ending work (`LaunchEnd`). */
  end?: LaunchEnd;
  /** The call this execution stopped on with its outcome unknown (`waiting-outcome`). */
  awaits?: { key: string; toolCallId?: string };
}

/** How often (at most) an executor reads its run's erasure fence before an append. */
const FENCE_EVERY_MS = 250;


/** Run endings that wait on a human decision rather than end the run (the crash ladder's last rung). */
const ASKS_A_HUMAN = new Set(['side_effect_retry_blocked']);
/** The ending that waits on a call's outcome (OutcomeUnknownError): the call's recorded result continues the run. */
const WAITS_FOR_OUTCOME = 'outcome_unknown';
/** How many times a run waiting on an outcome is continued to ask the tool again, and the longest gap between two. */
const OUTCOME_ASKS = 12;
const OUTCOME_ASK_MAX_MS = 300_000;
/** A call's record that answers it (durable-tool.ts `isDone`, or a question asked since). */
const ANSWERED = new Set(['succeeded', 'denied', 'reflected', 'suspended']);
// The cross-process signal is one channel every process of every organization shares: it carries a
// hash of the run, never its organization or its id (a run id can carry a person's name).
const wakeKey = (scope: string | undefined, runId: string) => createHash('sha256').update(`${scope ?? ''}/${runId}`).digest('hex').slice(0, 32);
/** The nudge a cancel sends on the same channel: "read this run's cancel record now" — never the decision itself. */
const STOP_NUDGE = 'stop:';

export class DetachedRuns {
  readonly liveness: ProcessLiveness;
  private readonly local = new Map<string, Local>();
  private readonly starting = new Map<string, Promise<Started>>();
  private readonly remoteWake = new Map<string, Set<() => void>>();
  private draining = false;
  private sweeper: ReturnType<typeof setInterval> | undefined;
  private sweeping = false;
  private subscribed: Promise<void> | undefined;
  /** Store statements this object issued (measurement). */
  stats = { appends: 0, reads: 0, execWrites: 0, notifies: 0 };

  constructor(private readonly opts: DetachedRunsOptions) {
    refuseUnknownNames('DetachedRuns', opts, DETACHED_RUNS_NAMES);
    // In-memory liveness answers "dead" for every id that is not this process's. That is true only of
    // a journal no other process can reach; on a shared store it made another process's sweep take a
    // LIVE run over and execute it a second time beside its owner (T1). Refused instead.
    const given = opts.liveness ?? livenessFor(opts.journal);
    if (!given && !isProcessLocal(opts.journal)) throw new LivenessRequiredError();
    this.liveness = given ?? inMemoryLiveness();
    // It answers for this store from here on: every stamp written into it carries its id (process-liveness.ts).
    bindLiveness(opts.journal, this.liveness);
    const every = opts.sweepMs ?? 1_000;
    if (every > 0) {
      // Outside any held unit: the sweeper outlives the call that built this executor, and what it starts is nobody's part.
      this.sweeper = outsideHeld(() => setInterval(() => { void this.sweep().catch((e) => console.warn('@gnldev/durable: sweep failed:', e)); }, every));
      this.sweeper.unref?.();
    }
  }

  /** Whether the process holding a record is alive — asked of THIS executor's liveness (the store's). */
  private alive(owner: string): Promise<boolean | undefined> {
    return owner === this.liveness.id ? Promise.resolve(true) : judgeAlive(this.liveness, owner);
  }

  private journalOf(scope: string | undefined): Journal {
    return this.opts.journalFor ? this.opts.journalFor(scope) : this.opts.journal;
  }

  /**
   * Starts the run, or joins it: a run already executing (here or in a live process) is FOLLOWED, never
   * executed twice; a run whose process is gone is taken over; a run waiting on a human is continued
   * only when `resumeIntent` (the request carries the answer). Never waits for the run.
   */
  async start(req: StartRequest): Promise<Started> {
    if (this.draining || isDraining()) throw new DrainingError();
    // WHOSE run: the engine's answer, before anything here is written or joined. For a new run it is
    // also its birth (the owner record, first writer wins), so a second caller racing the first for an
    // unborn id loses there — before an execution record exists to be attached to.
    await req.admit?.();
    const key = execKey(req.scope, req.runId);
    const loc = this.local.get(key);
    if (loc) return { runId: req.runId, state: 'attached', from: loc.firstSeq - 1 };
    const inFlight = this.starting.get(key);
    if (inFlight) return inFlight.then((r) => ({ ...r, state: 'attached' as StartState }));
    const p = this.startOnce(key, req).finally(() => this.starting.delete(key));
    this.starting.set(key, p);
    return p;
  }

  private async startOnce(key: string, req: StartRequest): Promise<Started> {
    // A process that cannot prove it holds its own lock is read as dead by the others: a run it started
    // now would be theirs to take over at once — executed twice. It starts and attaches nothing.
    if (!(await this.liveness.confirm())) throw new LivenessUnavailableError();
    const runJournal = this.journalOf(req.scope);
    const mine = (from: number): ExecRecord => ({ v: 1, runId: req.runId, ...(req.scope !== undefined ? { scope: req.scope } : {}), owner: this.liveness.id, status: 'running', at: Date.now(), from, ...(req.meta ? { meta: req.meta } : {}) });
    const lastSeq = async () => (await lastRunEvent(runJournal, req.runId))?.seq ?? 0;
    // A run that is over (or waits on a human): its reader reads its last execution, whole.
    const before = () => lastExecutionStart(runJournal, req.runId);
    for (let round = 0; round < 8; round++) {
      const cur = await this.opts.journal.get<ExecRecord>(key);
      if (cur === undefined) {
        // A deleted run is never started again, whoever names it (an `admit` says so too; without one
        // this is the only check).
        await assertNotErased(runJournal, req.runId, undefined);
        const outcome = await readRunOutcome(runJournal, req.runId);
        // Over: completed or canceled. A FAILED run is not over — its retry does fresh work (the engine's
        // rule, runResumeGates): a new call starts it again.
        if ((outcome?.status === 'completed' || outcome?.status === 'canceled') && !req.resumeIntent) {
          return { runId: req.runId, state: 'finished', from: await before() };
        }
        const rec = mine(await lastSeq());
        this.stats.execWrites++;
        if (await claim(this.opts.journal, key, rec)) { await this.execute(key, rec, runJournal, req.launch); return { runId: req.runId, state: 'started', from: rec.from! }; }
        continue;
      }
      if (cur.status === 'running') {
        if (cur.owner === this.liveness.id || (await this.alive(cur.owner)) !== false) return { runId: req.runId, state: 'attached', from: cur.from ?? 0 };
      } else if (cur.status === 'parked' && !req.resumeIntent) {
        return { runId: req.runId, state: 'parked', from: await before() };
      }
      // Its process is gone, it was released by a draining process, or a human's answer arrived.
      if (await runErasedSince(runJournal, req.runId, undefined)) { await this.opts.journal.deletePrefix(key); continue; }
      const rec = mine(await lastSeq());
      this.stats.execWrites++;
      if (await compareAndSet(this.opts.journal, key, cur, rec)) {
        await this.execute(key, rec, runJournal, req.launch);
        return { runId: req.runId, state: cur.status === 'parked' ? 'resumed' : 'took-over', from: rec.from! };
      }
    }
    return { runId: req.runId, state: 'attached', from: 0 };
  }

  /** Takes over every run whose executing process is gone (or that a draining process released). */
  async sweep(): Promise<number> {
    if (this.sweeping || this.draining || isDraining()) return 0;
    // Takes nothing over while it cannot prove its own lock (it would stamp an id the others read as dead).
    if (!(await this.liveness.confirm())) return 0;
    this.sweeping = true;
    try {
      const handles = this.opts.handles ?? (() => true);
      const keys = (await this.opts.journal.listKeys(EXEC_PREFIX)).filter((k) => !this.local.has(k) && handles(scopeOfKey(k)));
      const recs = this.opts.journal.getMany ? await this.opts.journal.getMany<ExecRecord>(keys) : await Promise.all(keys.map((k) => this.opts.journal.get<ExecRecord>(k)));
      // One liveness question per process, not per run: a few processes hold every run.
      const alive = new Map<string, Promise<boolean | undefined>>();
      const isAlive = (owner: string) => { let p = alive.get(owner); if (!p) alive.set(owner, (p = this.alive(owner))); return p; };
      let taken = 0;
      for (const [i, key] of keys.entries()) {
        const cur = recs[i];
        if (!cur) continue;
        if (cur.status === 'parked' && !(cur.awaits && (await this.outcomeMoves(cur)))) continue;
        if (cur.status === 'running' && (cur.owner === this.liveness.id || (await isAlive(cur.owner)) !== false)) continue;
        // An erased run is not continued: its record goes (the erasure model deletes it too; this covers
        // a record written back by an executor that died before it read the fence).
        if (await runErasedSince(this.journalOf(cur.scope), cur.runId, undefined)) { await this.opts.journal.deletePrefix(key); continue; }
        const rec: ExecRecord = { ...cur, owner: this.liveness.id, status: 'running', at: Date.now(), from: (await lastRunEvent(this.journalOf(cur.scope), cur.runId))?.seq ?? 0 };
        this.stats.execWrites++;
        if (!(await compareAndSet(this.opts.journal, key, cur, rec))) continue;
        const runJournal = this.journalOf(cur.scope);
        try {
          // Asking HOW to continue it is part of beginning the execution: a resume that throws (an agent this
          // deployment lacks, an unreadable owner) fails the launch, and a failed launch gives the record back
          // through execute's one failure path — parked with its reason, or gone for a run with no past. It
          // used to throw here, after the record was taken: "running" under a live process that ran nothing,
          // which nobody else may take (release audit A6).
          await this.execute(key, rec, runJournal, async (signal) => (await this.opts.resume(rec, runJournal))(signal));
          taken++;
        } catch (e) {
          console.warn(`@gnldev/durable: run '${rec.runId}' could not be continued here:`, e);
        }
      }
      return taken;
    } finally {
      this.sweeping = false;
    }
  }

  /**
   * Whether a run parked on a call's unknown outcome is to be continued now: the call's record holds a
   * result (whoever wrote it — the one path that settles the call), or it is time to ask the tool again.
   */
  /** The wait before asking a call's tool again, after `asks` asks: doubling from `outcomeAskMs`, capped. */
  private askDelay(asks: number): number {
    return Math.min((this.opts.outcomeAskMs ?? 2_000) * 2 ** asks, OUTCOME_ASK_MAX_MS);
  }

  private async outcomeMoves(rec: ExecRecord): Promise<boolean> {
    const awaits = rec.awaits!;
    const raw = await this.journalOf(rec.scope).get(awaits.key).catch(() => undefined);
    const call = upgradeFormat(raw as never, awaits.key) as { status?: string } | undefined;
    if (call?.status !== undefined && ANSWERED.has(call.status)) return true;
    return awaits.asks + 1 < OUTCOME_ASKS && Date.now() >= awaits.nextAt;
  }

  /**
   * Follows a run from `after` (the last `seq` the reader holds): what was written, then live, until
   * the run ends (or, with `untilPause`, waits on a human). Served from memory when this process
   * executes the run, from the journal otherwise. The run does not depend on the follower.
   */
  async *follow(req: { runId: string; scope?: string; after?: number; afterOffset?: number; signal?: AbortSignal; untilPause?: boolean; idleCheckMs?: number }): AsyncGenerator<RunEvent> {
    refuseUnknownNames('DetachedRuns.follow', req, FOLLOW_NAMES);
    const key = execKey(req.scope, req.runId);
    const journal = this.journalOf(req.scope);
    let cursor = req.after ?? 0;
    // How much of the delta segment after `cursor` this reader already holds (a reader here saw it live, or a
    // reconnect said so in its cursor): the event that segment becomes is handed on without it.
    let offset = req.afterOffset ?? 0;
    const rest = (ev: RunEvent): RunEvent | undefined => {
      if (!offset) return ev;
      const d = ev.data as { text?: unknown };
      const held = offset;
      offset = 0;
      if (typeof d?.text !== 'string') return ev;
      const text = d.text.slice(held);
      return text ? { ...ev, data: { ...d, text } } : undefined;
    };
    await this.ensureSubscribed();
    let idleSince = Date.now();
    // The follow's last word is the LOG's: nobody executing the run (its record) is read after the events,
    // so the ending a run writes before its record goes may be newer than the events read. Once the record
    // says nobody executes it, the log is read again, and the follow ends on the first read that brings
    // nothing (release audit A4: a follower a store round trip away ended without the run's last events).
    let settled = false;
    while (!req.signal?.aborted) {
      const loc = this.local.get(key);
      if (loc?.erased) return;
      let batch: RunEvent[];
      if (loc && cursor >= loc.firstSeq - 1) batch = loc.log.filter((e) => e.seq > cursor);
      else { this.stats.reads++; batch = await readRunEvents(journal, req.runId, cursor); }
      for (const ev of batch) {
        const out = ev.seq === cursor + 1 ? rest(ev) : ev;
        cursor = ev.seq;
        if (out) yield out;
        if (endsFollow(ev, req.untilPause)) return;
      }
      // The segment in progress, here: what this reader does not hold yet, as part of event `cursor + 1`.
      const live = loc?.live;
      if (live && live.afterSeq === cursor && live.data.text.length > offset) {
        const text = live.data.text.slice(offset);
        offset = live.data.text.length;
        yield { v: RUN_EVENT_VERSION, seq: cursor, kind: live.kind, data: { ...live.data, text }, step: live.step, at: Date.now(), offset } as RunEvent;
        idleSince = Date.now();
        continue;
      }
      if (batch.length) idleSince = Date.now();
      else if (settled) return;
      // Nothing is executing it and nothing new came: a run that ended without a final event (a run that
      // finished before it was detached, or one whose record is gone) ends the follow — after the log
      // read that follows this answer (`settled`).
      // (At once on the first empty read: a run nobody executes and nothing was written for is over.)
      if (!batch.length && !this.local.has(key) && (cursor === (req.after ?? 0) || Date.now() - idleSince > (req.idleCheckMs ?? 2_000))) {
        idleSince = Date.now();
        const rec = await this.opts.journal.get<ExecRecord>(key);
        if (await runErasedSince(journal, req.runId, undefined)) return;
        if (!rec || (rec.status === 'parked' && req.untilPause)) { settled = true; continue; }
      }
      await this.waitForMore(key, req.scope, req.runId, req.signal);
    }
  }

  /** Stops accepting runs, lets every local run reach its next boundary, releases them. Resolves when none is left. */
  async drain(): Promise<void> {
    this.draining = true;
    beginDrain();
    if (this.sweeper) clearInterval(this.sweeper);
    // Every run here except the one the caller runs inside (a tool body that drains): that one would wait for itself.
    await settledExceptOwn(() => [...this.local.values()].map((l) => l.done));
  }

  /**
   * Whether any of these runs (of `scope`) is executing now, here or in another process — a run whose
   * process died counts too: it is about to be continued. What a background tool's continuation waits
   * on before it writes into a thread (deferred.ts).
   */
  async executing(scope: string | undefined, runIds: string[]): Promise<boolean> {
    if (!runIds.length) return false;
    const keys = runIds.map((id) => execKey(scope, id));
    const recs = this.opts.journal.getMany ? await this.opts.journal.getMany<ExecRecord>(keys) : await Promise.all(keys.map((k) => this.opts.journal.get<ExecRecord>(k)));
    return recs.some((r) => r?.status === 'running');
  }

  /** Runs that cannot move on their own: waiting on a human, or held by a live process that has gone quiet. */
  async pending(quietMs = 60_000): Promise<Array<{ runId: string; scope?: string; status: ExecRecord['status']; owner: string; reason: string }>> {
    const out: Array<{ runId: string; scope?: string; status: ExecRecord['status']; owner: string; reason: string }> = [];
    for (const key of await this.opts.journal.listKeys(EXEC_PREFIX)) {
      const rec = await this.opts.journal.get<ExecRecord>(key);
      if (!rec) continue;
      if (rec.status === 'parked' && rec.awaits) {
        out.push({ ...pick(rec), reason: rec.awaits.asks + 1 >= OUTCOME_ASKS
          ? `a call's outcome is unknown (${rec.awaits.key}) and the tool was asked ${rec.awaits.asks + 1} times — a late result still continues it; otherwise a person decides (gnl pending)`
          : `waiting for a call's outcome (${rec.awaits.key}): continued when it is recorded, the tool asked again ${new Date(rec.awaits.nextAt).toISOString()}` });
        continue;
      }
      if (rec.status === 'parked') { out.push({ ...pick(rec), reason: 'waiting on a human (approval)' }); continue; }
      const last = await lastRunEvent(this.journalOf(rec.scope), rec.runId);
      if (rec.status === 'running' && (await this.alive(rec.owner)) !== false && Date.now() - (last?.at ?? rec.at) > quietMs) {
        out.push({ ...pick(rec), reason: `its process is alive and wrote nothing for ${Math.round((Date.now() - (last?.at ?? rec.at)) / 1000)} s — not taken over (it may be one instruction from its effect); kill it to hand the run over` });
      }
    }
    return out;
  }

  /**
   * Cancels a run wherever it executes. THE RECORD is the cancel (`cancelAgentRun`: durable, first one
   * wins, every later resume refused); every executor obeys it (`obeyCancel`) — read before each event it
   * writes, and while an answer streams, at most every FENCE_EVERY_MS. This only makes the holder read it
   * now: here directly, elsewhere through the signal channel when there is one.
   *
   * `'delivered'`: the run executes in this process and was stopped now. `'recorded'`: it executes
   * elsewhere (that process stops it at its next event, or at once on the signal) or nowhere (no
   * execution of it starts again). A cancel used to reach only this process's own requests' controllers,
   * and a run executing in another one ran on to `completed` with every token billed (release audit D2).
   */
  async cancel(req: { runId: string; scope?: string; reason?: unknown }): Promise<'delivered' | 'recorded'> {
    refuseUnknownNames('DetachedRuns.cancel', req, EXEC_CANCEL_NAMES);
    await cancelAgentRun(this.journalOf(req.scope), req.runId, req.reason !== undefined ? { reason: req.reason } : {});
    const loc = this.local.get(execKey(req.scope, req.runId));
    if (loc) return (await this.obeyCancel(loc, true)) ? 'delivered' : 'recorded';
    if (this.opts.signal) void this.opts.signal.notify(STOP_NUDGE + wakeKey(req.scope, req.runId)).catch(() => undefined);
    return 'recorded';
  }

  /**
   * Whether the run's cancel record is there — and if so this execution is aborted: its stream ends, and
   * the run ends `canceled` through its normal ending (executeBody). Read at most every FENCE_EVERY_MS
   * unless `force`. The one place an executor learns of a cancel.
   */
  private async obeyCancel(loc: Local, force = false): Promise<boolean> {
    if (loc.ctrl.signal.aborted) return true;
    if (!force && Date.now() - loc.cancelAt < FENCE_EVERY_MS) return false;
    loc.cancelAt = Date.now();
    if ((await agentRunCanceled(loc.journal, loc.runId).catch(() => undefined)) === undefined) return false;
    loc.ctrl.abort(new Error(`run '${loc.runId}' was canceled`));
    return true;
  }

  async close(): Promise<void> {
    if (this.sweeper) clearInterval(this.sweeper);
    const stopping = [...this.local.values()];
    for (const l of stopping) l.ctrl.abort();
    // Stopped, then settled, before the store under them closes: a settle reading a closed store was an
    // unhandled rejection, and a settle skipped could leave a write that landed after an erasure
    // (a-store-closed-under-a-finishing-run.test.ts).
    await settledExceptOwn(() => stopping.map((l) => l.done));
  }

  // ── execution ───────────────────────────────────────────────────────────────────────────────────

  /**
   * Launches the run (its admission — owner, thread, limits — happens in the launch, and a refusal is
   * thrown to the caller, nothing written under the run), then executes it apart from the caller.
   */
  private async execute(key: string, rec: ExecRecord, journal: Journal, launch: Launch): Promise<void> {
    const ctrl = new AbortController();
    // Where this execution starts in the log is what its record says (`from`, read before the record was
    // claimed): one place, so a caller attached before the execution reads anything is told the same
    // place as the caller that started it. It used to be read again later (executeBody), and a caller
    // attached in between was told 0 — and read an earlier execution's ending (release audit A5).
    const first = rec.from! + 1;
    const loc: Local = {
      key, runId: rec.runId, journal, ctrl, next: first, log: [], firstSeq: first, wake: new Set(), done: Promise.resolve(),
      baseline: await erasureBaseline(journal, await recordedParent(journal, rec.runId)), fenceAt: 0, erased: false, cancelAt: 0,
    };
    // The execution is one unit from its launch to its settle: its launch and its body run as part of it
    // (`within`), so a wait from inside the run (a tool body that drains or closes) does not wait for it.
    let ended!: (p: Promise<void>) => void;
    loc.done = new Promise<void>((r) => (ended = r));
    this.local.set(key, loc);
    // The holder of a run hears a cancel sent from another process (the signal's stop nudge).
    await this.ensureSubscribed().catch(() => undefined);
    let result: { fullStream: AsyncIterable<any>; steps?: unknown; end?: LaunchEnd };
    try {
      result = (await within(loc.done, () => launch(ctrl.signal))) as typeof result;
      if (typeof result.end === 'function') loc.end = result.end;
    } catch (e) {
      this.local.delete(key);
      ended(Promise.resolve());
      // Refused or failed before it ran: nothing of this execution was written under the run. A run that
      // has a past (taken over, resumed) waits for a person (`pending` names it) instead of being retried
      // by every sweep; a run that never started leaves no record at all, and neither does a deleted one
      // (the engine's refusal says so: nobody is to continue it).
      const cur = await this.opts.journal.get<ExecRecord>(key);
      if (cur && cur.owner === rec.owner && cur.at === rec.at) {
        if ((e as { code?: unknown })?.code === 'run_erased' || (await readRunOutcome(journal, rec.runId)) === undefined) await this.opts.journal.deletePrefix(key);
        else await compareAndSet(this.opts.journal, key, cur, {
          ...cur, status: 'parked', reason: `could not be continued: ${errorData(e).message}`, at: Date.now(),
          // Waiting on a call's outcome: the next ask backs off like any other, not every sweep.
          ...(cur.awaits ? { awaits: { ...cur.awaits, asks: cur.awaits.asks + 1, nextAt: Date.now() + this.askDelay(cur.awaits.asks + 1) } } : {}),
        });
      }
      throw e;
    }
    ended(within(loc.done, () => this.executeBody(loc, rec, result))
      .catch((e) => console.warn(`@gnldev/durable: detached run '${rec.runId}' stopped:`, e))
      // THE SETTLE, after the run's stream has quiesced — never on an early exit before it: a write in
      // flight when the run was stopped (a stream checkpoint) lands after the worker's own settle
      // (erasure-fence.ts "once more after its LAST write").
      .then(async () => {
        await quiesced(result);
        if (loc.erased || (await this.erasedRun(loc, true))) await settleErasedRun(loc.journal, loc.runId, loc.baseline).catch(() => undefined);
      })
      // A settle that fails (a store error) is said, as a stopped body is — never an unhandled rejection.
      .catch((e) => console.warn(`@gnldev/durable: detached run '${rec.runId}' was not settled here:`, e))
      .finally(() => { this.local.delete(key); this.wakeAll(loc); }));
  }

  private async executeBody(loc: Local, rec: ExecRecord, result: { fullStream: AsyncIterable<any>; steps?: unknown }): Promise<void> {
    const { runId, journal } = loc;
    // A launch that began no run (no owner record, no rows) has nothing to log: its events would be the
    // first records of a run nobody began (run-identity.ts). Its execution record goes, as for a run
    // that never began.
    if ((await runOwnerOf(journal as RawJournal, runId)).state === 'missing') { await this.opts.journal.deletePrefix(loc.key); return; }
    // How the run stood: its last event — `rec.from`'s, unless another executor wrote since, and then this
    // execution's first append (`loc.next`) finds its number taken and stops (first writer wins).
    const prior = await lastRunEvent(journal, runId);
    // A run whose log already ends it (its process died after the end and before the record went): close it.
    const outcome = await readRunOutcome(journal, runId);
    // (A failed one is not ended: this execution IS its retry.)
    const priorState = prior?.kind === 'status' ? (prior.data as { state: RunState }).state : undefined;
    if (priorState === 'completed' || priorState === 'canceled') { await this.finish(loc, rec, priorState); return; }
    // A run that ENDED without its log saying so — a late process finished it, its events refused, or a
    // process died between its outcome and its last events — is not closed with a bare status: its
    // reader would never get what it produced. It is executed below like any continued run: the steps
    // the log lacks replay from the journal (no model call, no tool call) through this one writer.
    // A canceled run has nothing more to produce.
    if (outcome?.status === 'canceled') {
      if (!(await this.emit(loc, 'status', { state: outcome.status }, -1))) return;
      await this.finish(loc, rec, outcome.status);
      return;
    }
    // Continuing a run that has events: the steps before the last one replay from the journal and are
    // not written again; the last one is produced again whole, so readers discard what they hold of it.
    let skipBelow = -1;
    if (prior) {
      skipBelow = prior.step < 0 ? -1 : prior.step;
      if (!(await this.emit(loc, 'step-retry', { step: skipBelow }, skipBelow))) return;
    }
    if (!(await this.emit(loc, 'status', { state: 'running' }, Math.max(skipBelow, -1)))) return;

    let chain: Promise<boolean> = Promise.resolve(true);
    let lost = false;
    // Appends run in order; the first that finds its number taken (or its run erased) stops every later one.
    // Writes queued and not yet in the log: a live segment's event comes after all of them.
    let queued = 0;
    const write = (kind: string, data: unknown, s: number) => {
      queued++;
      chain = chain.then(async (ok) => {
        try {
          if (!ok || lost) return false;
          if (await this.emit(loc, kind, data, s)) return true;
          lost = true;
          return false;
        } finally { queued--; }
      });
      return chain;
    };
    // Deltas (text, reasoning, tool input) are written in batches: the first of a step at once, the rest
    // every `coalesceMs`.
    let step = -1;
    let pending: { kind: string; data: { id?: string; text: string } } | undefined;
    let pendingStep = -1;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let stepHadDelta = false;
    const flush = () => {
      if (timer) { clearTimeout(timer); timer = undefined; }
      if (!pending) return chain;
      const p = pending; pending = undefined;
      const written = write(p.kind, p.data, pendingStep);
      // The segment stays readable here until its event is in the log (emit pushes it, then this clears).
      void written.then(() => { if (loc.live?.data === p.data) loc.live = undefined; });
      return written;
    };
    let ended: RunState = 'completed';
    let end: Record<string, unknown> = {};
    try {
      for await (const part of result.fullStream) {
        if (lost) break;
        if (part?.type === 'start-step') { step++; stepHadDelta = false; }
        if (step < skipBelow) continue;
        const ev = encodePart(part);
        if (!ev) continue;
        if (DELTA_KINDS.has(ev.kind)) {
          const d = ev.data as { id?: string; text: string };
          if (pending && (pending.kind !== ev.kind || pending.data.id !== d.id)) void flush();
          if (pending) pending.data.text += d.text;
          else { pending = { kind: ev.kind, data: { ...d } }; pendingStep = step; loc.live = { afterSeq: loc.next - 1 + queued, kind: ev.kind, step, data: pending.data }; }
          // A reader in this process sees the delta now; the store sees the segment at the window's end.
          this.wakeLocal(loc);
          // An answer that streams writes an event only every `coalesceMs`: it reads its cancel meanwhile.
          void this.obeyCancel(loc);
          if (!stepHadDelta) { stepHadDelta = true; void flush(); continue; }
          if (!timer) timer = setTimeout(() => { void flush(); }, this.opts.coalesceMs ?? 1_000);
          continue;
        }
        void flush();
        if (ev.kind === 'tool-error' && isDraining()) continue; // a body the drain did not start — not an error of the run
        if (ev.kind === 'error') {
          ended = isDraining() ? 'released' : 'failed';
          end = { error: ev.data.error };
          if (ended === 'released') continue;
        }
        void write(ev.kind, ev.data, step);
        if (ev.kind === 'tool-call') void write('status', { state: 'tool', tool: ev.data.toolName }, step);
      }
      await flush();
      if (ended === 'completed') {
        // How the run ended is in its steps — the same reading the doors made of the in-request stream:
        // a limit, a refusal, or calls that wait on a human.
        const steps = ((await Promise.resolve(result.steps).catch(() => undefined)) ?? []) as any[];
        const breach = limitBreachFromSteps(steps);
        const blocked = breach ? undefined : blockedFromSteps(steps);
        const interrupts = interruptsFromSteps(steps);
        if (breach) { ended = 'failed'; end = { error: { message: breach.message, name: 'RunLimitExceededError', code: breach.kind === 'loop' ? LIMIT_ERROR_CODES.toolLoopDetected : LIMIT_ERROR_CODES.runLimitExceeded, detail: breach.detail } }; }
        else if (blocked) {
          const code = BLOCKED_ERROR_CODES[blocked.code] ?? 'run_busy';
          ended = ASKS_A_HUMAN.has(code) ? 'waiting-approval' : code === WAITS_FOR_OUTCOME ? 'waiting-outcome' : 'failed';
          end = { error: { message: blocked.message, name: blocked.code, code, detail: blocked.detail } };
          const key = (blocked.detail as { key?: unknown } | undefined)?.key;
          if (ended === 'waiting-outcome' && typeof key === 'string') loc.awaits = { key, toolCallId: blocked.toolCallId };
        } else if (interrupts.length) { ended = 'waiting-approval'; end = { interrupts }; }
      }
    } catch (e) {
      await flush();
      ended = isDraining() ? 'released' : (await agentRunCanceled(journal, runId)) ? 'canceled' : 'failed';
      end = ended === 'failed' ? { error: errorData(e) } : {};
    }
    if (ended === 'completed' && (await agentRunCanceled(journal, runId))) ended = 'canceled';
    if (!(await chain) || lost) return; // another executor owns the run now (or it was erased): write nothing more
    if (ended === 'completed') {
      const o = await readRunOutcome(journal, runId);
      if (o?.status === 'failed') ended = 'failed';
    }
    if (ended !== 'released') await this.emit(loc, 'status', { state: ended, ...end }, step);
    await this.finish(loc, rec, ended);
  }

  /** Appends one event; false when the sequence number was taken (the run is another executor's now). */
  private async emit(loc: Local, kind: string, data: unknown, step: number): Promise<boolean> {
    if (await this.erasedRun(loc)) return false;
    // A canceled run still writes its ending (`canceled`): the cancel aborts the execution, not its log.
    void this.obeyCancel(loc);
    const ev: RunEvent = { v: RUN_EVENT_VERSION, seq: loc.next, kind, data, step, at: Date.now() };
    this.stats.appends++;
    if (!(await appendRunEvent(loc.journal, loc.runId, ev))) { loc.ctrl.abort(); return false; }
    loc.next++;
    loc.log.push(ev);
    this.wakeAll(loc);
    if (this.opts.signal) { this.stats.notifies++; void this.opts.signal.notify(wakeKey(scopeOfKey(loc.key), loc.runId)).catch(() => undefined); }
    return true;
  }

  private async finish(loc: Local, rec: ExecRecord, state: RunState): Promise<void> {
    if (await this.erasedRun(loc, true)) return;
    const cur = await this.opts.journal.get<ExecRecord>(loc.key);
    if (!cur || cur.owner !== this.liveness.id || cur.status !== 'running') return;
    this.stats.execWrites++;
    if (state === 'waiting-approval' || state === 'released') {
      await compareAndSet(this.opts.journal, loc.key, cur, { ...cur, status: state === 'released' ? 'released' : 'parked', at: Date.now() });
      return;
    }
    if (state === 'waiting-outcome') {
      // Parked on the call: its recorded result continues the run (sweep), and the tool is asked again
      // later. The asks carry over from the execution that was continued to ask (its record is `cur`).
      const asks = cur.awaits && loc.awaits && cur.awaits.key === loc.awaits.key ? cur.awaits.asks + 1 : 0;
      const nextAt = Date.now() + this.askDelay(asks);
      const { awaits: _was, ...rest } = cur;
      await compareAndSet(this.opts.journal, loc.key, cur, {
        ...rest, status: 'parked', at: Date.now(),
        ...(loc.awaits ? { awaits: { ...loc.awaits, asks, nextAt } } : {}),
        reason: 'waiting for a call\'s outcome',
      });
      return;
    }
    // The run's ending work: not done (a store error, a drain) — the record is released and the next
    // sweep ends the run again, as an undelivered completion notice is (below). A run erased meanwhile
    // is not ended again: its record goes with it.
    if (loc.end && (state === 'completed' || state === 'failed')) {
      try {
        await loc.end(state, loc.ctrl.signal);
      } catch (e) {
        if (await this.erasedRun(loc, true)) return;
        console.warn(`@gnldev/durable: the ending of '${loc.runId}' was not done (ended again by the next sweep):`, e);
        await compareAndSet(this.opts.journal, loc.key, cur, { ...cur, status: 'released', at: Date.now() });
        return;
      }
    }
    // Not delivered: the record is released, so the next sweep (here or elsewhere) closes the run again
    // and delivers again — at least once, never dropped.
    if (this.opts.onComplete && !(await this.deliverOnce(loc, rec, state))) {
      await compareAndSet(this.opts.journal, loc.key, cur, { ...cur, status: 'released', at: Date.now() });
      return;
    }
    await this.opts.journal.deletePrefix(loc.key);
  }

  /** At least once: delivered, then marked. A process that dies between the two delivers again (same id). */
  private async deliverOnce(loc: Local, rec: ExecRecord, state: RunState): Promise<boolean> {
    const mark = runRecordKey(loc.runId, 'ev-delivered');
    if ((await loc.journal.get(mark)) !== undefined) return true;
    try {
      await this.opts.onComplete!({ id: `${rec.scope ?? ''}/${loc.runId}`, runId: loc.runId, ...(rec.scope !== undefined ? { scope: rec.scope } : {}), state });
      await loc.journal.put(mark, { at: Date.now(), state });
      return true;
    } catch (e) {
      console.warn(`@gnldev/durable: completion notice for '${loc.runId}' failed (delivered again by the next sweep):`, e);
      return false;
    }
  }

  /**
   * Whether the run was erased since this execution started (its fence, or its organization's purge).
   * Read at most every FENCE_EVERY_MS before an append, and always before the end. An erased run is
   * stopped, what this execution wrote since the erasure goes again, its record goes, and its followers
   * here end: nothing of it is written back and no completion is announced.
   */
  private async erasedRun(loc: Local, force = false): Promise<boolean> {
    if (loc.erased) return true;
    if (!force && Date.now() - loc.fenceAt < FENCE_EVERY_MS) return false;
    loc.fenceAt = Date.now();
    if (!(await runErasedSince(loc.journal, loc.runId, loc.baseline))) return false;
    loc.erased = true;
    loc.ctrl.abort();
    loc.log.length = 0;
    // The run's own event families, as run-id-grammar.ts spells them: the event log is a listed family
    // (its prefix is the run's alone — the gate refuses `:ev` in a run id), the delivery mark is ONE key
    // and goes by that key — as a prefix it took a run named `<runId>:ev-delivered…` with it (R2-1).
    await loc.journal.deletePrefix(runRecordPrefix(loc.runId, 'ev'));
    await deleteExactKey(loc.journal, runRecordKey(loc.runId, 'ev-delivered'));
    await this.opts.journal.deletePrefix(loc.key);
    this.wakeAll(loc);
    return true;
  }

  // ── wake-ups ────────────────────────────────────────────────────────────────────────────────────

  /** Wakes this process's readers only (a delta not yet in the store: nothing for another process to read). */
  private wakeLocal(loc: Local): void {
    for (const fn of [...loc.wake]) fn();
  }

  private wakeAll(loc: Local): void {
    for (const fn of [...loc.wake]) fn();
    for (const fn of [...(this.remoteWake.get(wakeKey(scopeOfKey(loc.key), loc.runId)) ?? [])]) fn();
  }

  private ensureSubscribed(): Promise<void> {
    if (!this.opts.signal) return Promise.resolve();
    this.subscribed ??= this.opts.signal.subscribe((k) => {
      if (k.startsWith(STOP_NUDGE)) {
        // A cancel elsewhere: the run's holder reads the record now (the nudge decides nothing itself).
        const wk = k.slice(STOP_NUDGE.length);
        for (const loc of this.local.values()) if (wakeKey(scopeOfKey(loc.key), loc.runId) === wk) void this.obeyCancel(loc, true);
        return;
      }
      for (const fn of [...(this.remoteWake.get(k) ?? [])]) fn();
    });
    return this.subscribed;
  }

  private waitForMore(key: string, scope: string | undefined, runId: string, signal?: AbortSignal): Promise<void> {
    return new Promise((resolve) => {
      const loc = this.local.get(key);
      const wk = wakeKey(scope, runId);
      const set = this.remoteWake.get(wk) ?? new Set();
      this.remoteWake.set(wk, set);
      const done = () => {
        clearTimeout(t);
        loc?.wake.delete(done);
        set.delete(done);
        if (set.size === 0) this.remoteWake.delete(wk);
        signal?.removeEventListener('abort', done);
        resolve();
      };
      // In this process the executor wakes the follower; elsewhere the signal does, or the poll.
      const t = setTimeout(done, loc ? 5_000 : (this.opts.pollMs ?? 200));
      loc?.wake.add(done);
      set.add(done);
      signal?.addEventListener('abort', done, { once: true });
    });
  }
}

const pick = (rec: ExecRecord) => ({ runId: rec.runId, ...(rec.scope !== undefined ? { scope: rec.scope } : {}), status: rec.status, owner: rec.owner });

function scopeOfKey(key: string): string | undefined {
  const s = decodeURIComponent(key.slice(EXEC_PREFIX.length, key.indexOf('/')));
  return s === '' ? undefined : s;
}

/**
 * Where a run's last execution starts in its log (the `seq` before its `running` status) — what a reader
 * of a run that is over, or that waits on a human, reads from: that execution's events and its ending.
 */
async function lastExecutionStart(journal: Journal, runId: string): Promise<number> {
  if (journal.readRange) {
    // Backwards from the end, a page at a time (one index range each).
    for (let after: string | undefined; ;) {
      const page = await journal.readRange<RunEvent>(runEventPrefix(runId), { ...(after !== undefined ? { after } : {}), limit: 64, desc: true });
      for (const [, ev] of page) if (ev?.kind === 'status' && (ev.data as { state?: string }).state === 'running') return ev.seq - 1;
      if (page.length < 64) return 0;
      after = page[page.length - 1]![0];
    }
  }
  const keys = await journal.listKeys(runEventPrefix(runId));
  for (let end = keys.length; end > 0; end -= 64) {
    const chunk = keys.slice(Math.max(0, end - 64), end);
    const evs = journal.getMany ? await journal.getMany<RunEvent>(chunk) : await Promise.all(chunk.map((k) => journal.get<RunEvent>(k)));
    for (let i = evs.length - 1; i >= 0; i--) {
      const ev = evs[i];
      if (ev?.kind === 'status' && (ev.data as { state?: string }).state === 'running') return ev.seq - 1;
    }
  }
  return 0;
}

/**
 * The run that made this one, as its owner record says (erasure-fence.ts `lineage`). An unreadable record
 * gives the executor no lineage of its own; the run's engine still reads its parent's fence (it is given
 * the parent with its arguments), and refuses the run when it is gone.
 */
async function recordedParent(journal: Journal, runId: string): Promise<string | undefined> {
  const input = await journal.get<{ parentRunId?: unknown }>(runKeys.input(runId)).catch(() => undefined);
  return typeof input?.parentRunId === 'string' ? input.parentRunId : undefined;
}

/** Resolves when a run's stream has ended (its steps settle then), bounded: a stuck stream is not waited for forever. */
async function quiesced(result: { steps?: unknown }): Promise<void> {
  await Promise.race([Promise.resolve(result.steps).catch(() => undefined), new Promise((r) => setTimeout(r, 30_000).unref?.())]);
}

/** A `RunSignal` over a Postgres process session's LISTEN/NOTIFY (process-liveness.ts). */
export function pgRunSignal(session: { notify(channel: string, payload: string): Promise<void>; listen(channel: string, fn: (p: string) => void): Promise<void> }): RunSignal {
  return {
    notify: (k) => session.notify('gnl_run_events', k),
    subscribe: (fn) => session.listen('gnl_run_events', fn),
  };
}

/** A fresh run id for a caller that names none. */
export const newRunId = (): string => randomUUID();
