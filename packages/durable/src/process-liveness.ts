// WHETHER THE PROCESS THAT HOLDS SOMETHING IS ALIVE — asked of the operating system or the database
// session, never of a clock.
//
// A claim used to be judged live by its age: a 'running' stamp older than its TTL read as a crashed
// attempt and was taken over. Age cannot tell a dead process from a frozen one. A process stopped by
// the scheduler, a GC pause, a VM migration, a laptop lid (or a real `SIGSTOP`) stops renewing, its
// stamp ages past the TTL, and another process takes the call over while the first still holds the
// effect in its hands (release audit E6: the lease's residual). The process comes back and finishes
// the effect: two executions.
//
// The fix is to ask something that does not age: a lock the process holds for as long as it EXISTS.
// The lock goes away when the process does — the kernel closes its file descriptors, the database
// closes its session — and not one moment earlier, however long the process is frozen:
//
//   · Postgres: one session-level advisory lock per process, on a dedicated connection (not the pool).
//     Another process asks `pg_locks` whether it is granted. A frozen process's kernel still answers
//     TCP keepalives, so its session — and its lock — stay. NOT through a transaction-mode pooler
//     (pgbouncer `pool_mode=transaction`): a session lock there belongs to whichever client the server
//     connection is lent to next. Such a connection is refused at open (`refuseSharedBackend`); give
//     this connection a direct (or session-mode) URL.
//   · Sqlite: one exclusive transaction per process on its own lock file (POSIX advisory lock).
//     Another process tries `BEGIN EXCLUSIVE` with no busy wait: SQLITE_BUSY means alive. The lock is
//     released by the kernel when the process exits, however it exits. One host by nature.
//   · In memory: a single process by nature; ids registered here are alive until closed.
//
// Every holder stamp written while a liveness is installed carries the process id (`proc`). A reader
// whose store can answer for that id judges the stamp by the answer, and by its age only otherwise.
//
// What this does NOT decide: a process that is alive and has stopped making progress (a deadlock, an
// infinite loop) keeps what it holds until it is killed. That is deliberate — such a process may be
// one instruction away from the effect — and it is surfaced (`pending`), not taken over.
import { randomUUID, createHash } from 'node:crypto';
import { AsyncLocalStorage } from 'node:async_hooks';
import { createRequire } from 'node:module';
import { requireOptionalPeer } from './optional-peer.js';
import { mkdirSync, rmSync, existsSync, realpathSync, statSync, openSync, closeSync } from 'node:fs';
import { join, resolve as resolvePath, dirname, basename } from 'node:path';
import { refuseUnknownNames } from '@gnldev/options';
import { POSTGRES_LIVENESS_NAMES } from './option-names.js';

export interface ProcessLiveness {
  /**
   * This process's id: written into every holder stamp it writes (`proc`). It names ONE process lifetime
   * and does not change while the process lives: a session that was cut comes back under the same id
   * (see `reconnectGraceMs`). A stamp is this process's own while it names this id.
   */
  readonly id: string;
  /**
   * How long another process must find this store's lock of a holder gone — at two looks at least this
   * far apart — before it reads that holder as dead (`judgeAlive`). A live process whose session was cut
   * (a terminated backend, a restart, a failover) takes its lock back under the same id within it, so
   * nothing it holds is taken over beside it. Unset or 0: gone is dead at once — for a lock no live
   * process can lose (a Sqlite file lock, held by the kernel for the life of the process).
   */
  readonly reconnectGraceMs?: number;
  /**
   * Aborted when this process has gone half its `reconnectGraceMs` without proving its session — counted
   * from the last proof, so a loss the process never heard of counts too: from a whole grace after that
   * proof another process may read it as dead and take over what it holds, so a tool body it started is
   * told to stop first (durable-tool passes it to `execute` as part of `abortSignal`). Aborted while the
   * session stays unproven; a fresh signal once it is proven again. Absent: the lock cannot be lost while
   * the process lives.
   */
  sessionSignal?(): AbortSignal;
  /**
   * True for the in-memory liveness: it knows only this process's own ids, so it is never installed for the
   * process — a claim's stamp is then judged as before (by its age), not as "mine, so alive".
   */
  readonly processOnly?: boolean;
  /**
   * Whether the process with `id` is alive: `true`/`false` when the store can tell, `undefined` when
   * it cannot (an id from another kind of store) — the caller then falls back to the stamp's age.
   * Throws `LivenessUnavailableError` while this process cannot ask (its own session is gone).
   */
  isAlive(id: string): Promise<boolean | undefined>;
  /**
   * Proves this process still holds its own lock. Cheap when it was proven within `maxAgeMs` on this
   * process's monotonic clock; otherwise asks the store. False: the session is gone (a partition, a
   * terminated backend) and another process may already have judged this one dead — start nothing.
   */
  confirm(maxAgeMs?: number): Promise<boolean>;
  /** Releases the lock (a graceful exit). Everything this process held reads as dead afterwards. */
  close(): Promise<void>;
}

let installed: ProcessLiveness | undefined;
let draining = false;

/**
 * Installs this process's liveness for the stores that have none of their own (see `bindLiveness`):
 * from here on a claim, marker or execution record this process writes into such a store carries its
 * id, and a reader judges such stamps by it.
 */
export function installProcessLiveness(l: ProcessLiveness | undefined): void {
  installed = l;
}

/** The installed liveness, if any. */
export function processLiveness(): ProcessLiveness | undefined {
  return installed;
}

// ── One liveness per store ──────────────────────────────────────────────────────────────────────────
//
// A liveness answers for ONE database: Postgres scopes advisory locks to the session's database
// (pg_locks.database), and a Sqlite lock file sits beside one database file. A process that writes to
// two databases (a database per tenant) is alive in each only through a lock IN that database. It used
// to have one liveness, made from the first store it opened and installed for the process: a claim it
// wrote into the second database named an id with no lock there, and that database's other processes
// read a live holder as dead and ran the body beside it (one-process-two-databases.test.ts). So the
// rule: a stamp written into a store carries the id of THAT store's liveness, and a stamp read from a
// store is judged by that store's liveness. The installed one stands in only for a store with none.

const bound = new WeakMap<object, ProcessLiveness>();

/** The store a journal belongs to: the root under an organization's view, the source under a wrapper. @internal */
export function storeOf(journal: unknown): object | undefined {
  let cur = journal as Record<symbol, unknown> | null | undefined;
  for (let i = 0; i < 8 && cur; i++) {
    const parent = cur[Symbol.for('@gnldev/durable.orgParent')] as Record<symbol, unknown> | undefined;
    if (!parent) break;
    cur = parent;
  }
  if (!cur || typeof cur !== 'object') return undefined;
  return (cur[Symbol.for('@gnldev/durable.journalSource')] as object | undefined) ?? cur;
}

/** Makes `l` the liveness of `journal`'s store in this process (the executor's, the queue worker's). */
export function bindLiveness(journal: unknown, l: ProcessLiveness): void {
  const store = storeOf(journal);
  if (store && !l.processOnly) bound.set(store, l);
}

/** Forgets `journal`'s store's liveness (the store is closing). The liveness itself is its owner's to close. */
export function unbindLiveness(journal: unknown): void {
  const store = storeOf(journal);
  if (store) bound.delete(store);
}

/**
 * The liveness that is to answer for `journal`'s store in this process, settled once and bound: the
 * one `given` (configured), else the one already bound to the store, else the store's `own` (a
 * SqliteStorage or PostgresStorage makes one for itself), else the installed one. The executor and the
 * queue worker ask through here, so both stamp a store with the same id.
 *
 * @internal — the executor's, the queue worker's and `gnl pending`'s way to the store's liveness; a host passes `liveness` to them.
 */
export async function storeLiveness(
  journal: unknown,
  opts: { given?: ProcessLiveness; own?: () => ProcessLiveness | undefined | Promise<ProcessLiveness | undefined> } = {},
): Promise<ProcessLiveness | undefined> {
  const store = storeOf(journal);
  const l = opts.given ?? (store && bound.get(store)) ?? (opts.own ? await opts.own() : undefined) ?? installed;
  if (l) bindLiveness(journal, l);
  return l;
}

/**
 * A PRIMITIVE CALLED DIRECTLY names its process too. `durableTool`, `durableModel` and `runDurable` take a
 * journal, not an executor: before, only `createGnl`'s executor and `createWorker` bound the store's
 * liveness, so a direct call (a host's own loop, a tool in a workflow step, a script) wrote claims that
 * named no process, and another process judged them by their age — past the TTL, a frozen holder's
 * effect was run beside it (audit 2026-10-16, a-frozen-process-keeps-its-direct-claim.test.ts). So the
 * primitive settles the store's liveness on its first call, by the same rule as the executor
 * (`storeLiveness`): one already bound, else the store's own (a Sqlite file lock; a Postgres session — one
 * connection per store per process, the same one an executor or worker on that store would open, closed
 * with the store), else the installed one. A store only this process can reach needs none.
 */
export async function bindOwnLiveness(journal: unknown): Promise<void> {
  if (isProcessLocal(journal)) return;
  const store = storeOf(journal);
  if (!store || bound.has(store) || unbindable.has(store)) return;
  const refused = poolerRefused.get(store);
  if (refused) {
    if (installed) { bindLiveness(journal, installed); return; }
    throw refused;
  }
  const own = (store as { processLiveness?: () => ProcessLiveness | Promise<ProcessLiveness> }).processLiveness;
  if (typeof own !== 'function' && !installed) return;
  try {
    await storeLiveness(journal, typeof own === 'function' ? { own: () => own.call(store) } : {});
  } catch (err) {
    // A store reached through a transaction-mode pooler is NOT one that merely lacks a liveness: judging its
    // claims by their age would run a frozen holder's effect beside it — measured, through PgBouncer in
    // transaction mode: the body ran twice. A liveness this process installed for the database answers
    // instead; without one the call is refused before its body, every time, naming the fix.
    if (err instanceof TransactionPoolerError) {
      if (installed) { bindLiveness(journal, installed); return; }
      poolerRefused.set(store, err);
      throw err;
    }
    // A store that cannot make its liveness (a pool that does not say where it connects, a session that
    // could not be opened) keeps its claims judged by their age, as before — said once, not failed: the
    // call itself does not need it, and an executor or worker given a liveness binds one later.
    unbindable.add(store);
    console.warn('@gnldev/durable: no process liveness could be made for this store, so a claim another process holds on it is judged by its age (claimTtlMs) — pass `liveness` to createGnl or createWorker:', err instanceof Error ? err.message : err);
  }
}

/** Stores whose own liveness could not be made, asked once (see `bindOwnLiveness`). */
const unbindable = new WeakSet<object>();
/** Stores reached through a transaction-mode pooler, with the refusal every direct call on them gets. */
const poolerRefused = new WeakMap<object, TransactionPoolerError>();

/** The liveness that answers for `journal`'s store in this process: its own, else the installed one. */
export function livenessFor(journal: unknown): ProcessLiveness | undefined {
  const store = storeOf(journal);
  return (store && bound.get(store)) || installed;
}

/**
 * The `proc` field a holder stamp written into `journal` carries (spread into the stamp): the id of the
 * store's liveness. None when the journal is process-local (no other process can read the stamp, so
 * there is no other process to ask about — its age decides, as for an in-memory liveness).
 */
export function procStampFor(journal: unknown): { proc: string } | Record<string, never> {
  if (isProcessLocal(journal)) return {};
  const l = livenessFor(journal);
  return l ? { proc: l.id } : {};
}

/**
 * Whether the holder `proc` of a stamp read from `journal` is alive, by that store's liveness.
 * `undefined`: no answer (no liveness, no id on the stamp, or a store that cannot tell) — judge the
 * stamp by its age.
 */
export async function holderAlive(proc: unknown, journal: unknown): Promise<boolean | undefined> {
  const l = livenessFor(journal);
  if (!l || typeof proc !== 'string') return undefined;
  if (proc === l.id) return true;
  return judgeAlive(l, proc);
}

/**
 * GONE IS NOT YET DEAD — the one rule that reads another process as dead, asked by every reader of a
 * holder (`holderAlive`, an executor's owner check). A store's lock of a process goes away when its
 * SESSION ends, and a session ends under a live process too: a terminated backend, a database restart, a
 * failover, a pooler closing it. Read as dead at once, the process's call was taken over while its body
 * still ran: measured on Postgres (2026-10-18, raporlar/2026-10-18-session-cut), a cut liveness session
 * mid-body gave 2 effects in 5 of 5 rounds — and 1 with no cut. A live process takes its lock back under
 * the same id (`reconnectGraceMs`), so a holder is dead only when its lock is found gone at looks that
 * span the grace, none of them more than one and a half graces after the one before. A dead process is
 * taken over that much later; the first look of a judgment waits out the rest of the grace, within the
 * call that asked. STATED LIMIT: looks cannot see a holder that came back and was cut again between them.
 */
export async function judgeAlive(l: ProcessLiveness, id: string): Promise<boolean | undefined> {
  const grace = l.reconnectGraceMs ?? 0;
  for (;;) {
    const alive = await l.isAlive(id);
    if (alive !== false || !(grace > 0)) { if (alive !== false) absences.get(l)?.delete(id); return alive; }
    const now = performance.now();
    let seen = absences.get(l);
    if (!seen) absences.set(l, (seen = new Map()));
    const was = seen.get(id);
    // Looks further apart than the grace (and the slack a timer is late by) do not make one absence: the
    // holder may have been back in between — start over.
    const run = was && now - was.last <= grace * 1.5 ? { first: was.first, last: now } : { first: now, last: now };
    seen.set(id, run);
    if (run.last - run.first >= grace) return false;
    await new Promise((r) => setTimeout(r, run.first + grace - now));
  }
}
/** Per liveness, the holders found gone: when first in this run of looks, and when last. */
const absences = new WeakMap<ProcessLiveness, Map<string, { first: number; last: number }>>();

/**
 * The default `reconnectGraceMs` of the Postgres, MySQL and MongoDB livenesses: how long a live process
 * has to take its lock back after its session ends before the others read it as dead.
 */
export const RECONNECT_GRACE_MS = 5_000;

/**
 * `reconnectGraceMs` as given to a liveness factory: a finite number of ms, at least four heartbeats. A
 * proof comes at most two heartbeats apart (a beat, and its answer within one more — `proofWithin`), and
 * the bodies are told to stop half a grace after the last proof (`sessionSignals`): under four, a process
 * whose session is fine would tell its bodies to stop, and one whose session was lost silently would be
 * read as dead before it could know.
 */
export function reconnectGraceOf(factory: string, given: number | undefined, heartbeatMs: number): number {
  const g = given ?? Math.max(RECONNECT_GRACE_MS, 4 * heartbeatMs);
  if (!(Number.isFinite(g) && g >= 4 * heartbeatMs)) throw new Error(`@gnldev/durable: ${factory} reconnectGraceMs must be at least 4 × heartbeatMs (${4 * heartbeatMs} ms); got ${given}`);
  return g;
}

/** How often the Postgres, MySQL and MongoDB livenesses prove their own session, by default. */
export const HEARTBEAT_MS = 1_000;

/**
 * `proof`, or `false` when it is not answered within `ms`. A heartbeat waits on its session's answer, and a
 * session lost SILENTLY never answers: the server ended it (and freed the lock), the client heard nothing.
 * Measured before (raporlar/2026-10-19-silent-loss): the process had not noticed after 60 s, while the
 * others read it as dead at 5 s. Unanswered within a heartbeat, the session is treated as lost.
 */
export async function proofWithin(proof: Promise<boolean>, ms: number): Promise<boolean> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const late = new Promise<false>((r) => { timer = setTimeout(() => r(false), ms); timer.unref?.(); });
  try { return await Promise.race([proof.catch(() => false), late]); } finally { clearTimeout(timer); }
}

/**
 * The signal side of a session that can be lost (`ProcessLiveness.sessionSignal`), one per liveness, proven
 * at creation: `proven()` at every proof of the session. Half the grace after the last proof the signal is
 * aborted (with `LivenessUnavailableError`) and stays aborted until the next proof; then a fresh one.
 * The clock runs from the last PROOF, not from a loss the process noticed: the lock cannot have outlived
 * its last proof, the others read a holder as dead only a whole grace after its lock went (`judgeAlive`),
 * so the bodies are told first whether or not the process ever heard of the loss.
 */
export function sessionSignals(graceMs: number): { signal(): AbortSignal; proven(): void; close(): void } {
  let ctl = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const arm = () => {
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => { timer = undefined; ctl.abort(new LivenessUnavailableError()); }, graceMs / 2);
    timer.unref?.();
  };
  arm();
  return {
    signal: () => ctl.signal,
    proven() { if (ctl.signal.aborted) ctl = new AbortController(); arm(); },
    close() { if (timer) { clearTimeout(timer); timer = undefined; } },
  };
}

// ── The work in hand: one set, two faces ────────────────────────────────────────────────────────────
//
// THE WORK THIS PROCESS HOLDS that no executor owns — a run a host started with `runDurable`, a queue
// job from its lease to its settle, a scheduler fire from its lock to its release. One set, read two
// ways, so "what is in hand" has one answer:
//
//   · in this process: a drain waits for it (drain.ts `heldWorkSettled`). Before, a SIGTERM during such
//     a run reported a clean drain and exited with its tool body cut off (audit C3);
//   · from any process: `pendingWork` lists it (`gnl pending`, `gnl upgrade`). A unit that names what it
//     holds (`face`) is listed from here when the reader is this process, and — on a store other
//     processes share, under this process's liveness — from a SHADOW in the store: `__hand__:<scope>/
//     <name>#<proc>#` in the platform journal, written when the unit is taken, deleted when it settles,
//     and judged like every holder stamp: by its process's liveness, never by its age. Before, a run in
//     its model step and a job a worker held read "nothing blocks", and `gnl upgrade` went ahead (audit
//     C6/C7).
//
// A shadow names a run (a job's run, a fire's run), never its content; the erasure model deletes it with
// the run it names (model.ts RUN_DEPENDENTS), an organization's purge with its scope, a person's job
// erasure with the jobs. One left by a process that died is read as dead, and the first process to hold
// work in that store afterwards reclaims it — by the rule that judged it dead (`judgeAlive`: its lock gone
// for the reconnect grace; a liveness id names one process lifetime, so no LATER process can come back
// under it). STATED LIMIT: a live process kept off its database for longer than the grace is read as dead,
// and its shadow may be reclaimed while it still holds the work; its tool bodies were told to stop by then
// (`sessionSignal`).

/** What a held unit names: the run it executes (`name`), in the store `journal` belongs to. */
export interface HandFace {
  /** Any view of the store the unit works in: its store, and its organization scope unless `scope` is given. */
  journal: unknown;
  /** The run id the unit executes (a job's run, a fire's run) — what an operator cancels. */
  name: string;
  /** What it is doing, for a person: "the run is executing", "job 'mail' is running". */
  what: string;
  /** The organization the run belongs to, when `journal` is not that organization's view. */
  scope?: string;
}

/** The family every shadow lives under. */
export const HAND_PREFIX = '__hand__:';
/** Every shadow whose name starts with `namePrefix` in `scope` (a run's shadows, or an owner's jobs'). @internal — the erasers'. */
export const handNamePrefix = (scope: string | undefined, namePrefix: string): string =>
  `${HAND_PREFIX}${encodeURIComponent(scope ?? '')}/${encodeURIComponent(namePrefix)}`;
/** Every shadow of exactly `name` in `scope`, whichever process wrote it. */
export const handRunPrefix = (scope: string | undefined, name: string): string => `${handNamePrefix(scope, name)}#`;
/** Every shadow of one organization (its purge deletes them). */
export const handScopePrefix = (orgId: string): string => `${HAND_PREFIX}${encodeURIComponent(orgId)}/`;
const handKey = (scope: string | undefined, name: string, proc: string): string => `${handRunPrefix(scope, name)}${encodeURIComponent(proc)}#`;

/** One unit a reader lists. */
export interface HeldUnit {
  scope?: string;
  name: string;
  what: string;
  /** The process holding it (its liveness id), when known. */
  holder?: string;
  /** When it was taken in hand (ms since the epoch), when known. */
  since?: number;
}

function parseHandKey(key: string): { scope?: string; name: string; proc: string } | undefined {
  const m = /^__hand__:([^/#]*)\/([^#]*)#([^#]+)#$/.exec(key);
  if (!m) return undefined;
  try {
    const scope = decodeURIComponent(m[1]!);
    return { ...(scope !== '' ? { scope } : {}), name: decodeURIComponent(m[2]!), proc: decodeURIComponent(m[3]!) };
  } catch {
    return undefined;
  }
}

type PlatformJournal = { put(k: string, v: unknown): Promise<void>; get(k: string): Promise<unknown>; deletePrefix?(p: string): Promise<number>; listKeys?(p: string): Promise<string[]> };

/** The journal under every organization view: where platform records (shadows) live. */
function platformOf(journal: unknown): PlatformJournal {
  let cur = journal as Record<symbol, unknown>;
  for (let i = 0; i < 8; i++) {
    const parent = cur?.[Symbol.for('@gnldev/durable.orgParent')] as Record<symbol, unknown> | undefined;
    if (!parent) break;
    cur = parent;
  }
  return cur as unknown as PlatformJournal;
}
const scopeOfView = (journal: unknown): string | undefined => {
  const v = (journal as Record<symbol, unknown> | null | undefined)?.[Symbol.for('@gnldev/durable.orgScope')];
  return typeof v === 'string' ? v : undefined;
};

interface HeldEntry { store?: object; unit?: HeldUnit; since?: number }
const inHand = new Map<Promise<unknown>, HeldEntry>();

/**
 * A shadow per (store, scope, name) in this process, however many units of that name it holds (a job and
 * the run its handler starts share one): written by the first, deleted after the last. Each slot's store
 * writes run in order (`chain`), so a delete never lands after the put of a later hold.
 */
interface Slot { count: number; chain: Promise<void> }
const slots = new Map<string, Slot>();
const storeIds = new WeakMap<object, number>();
let nextStoreId = 1;
/** Stores whose dead processes' shadows this process has reclaimed (once per store per process). */
const reclaimed = new WeakSet<object>();

function shadowOf(face: HandFace, store: object): { slot: string; key: string; root: PlatformJournal } | undefined {
  if (isProcessLocal(face.journal)) return undefined; // only this process reads it: the set answers
  const proc = procStampFor(face.journal).proc;
  // No liveness answers for this store here: no other process could judge a shadow, so none is written.
  if (proc === undefined) return undefined;
  const root = platformOf(face.journal);
  if (typeof root?.put !== 'function' || typeof root.deletePrefix !== 'function' || typeof root.listKeys !== 'function') return undefined;
  let id = storeIds.get(store);
  if (id === undefined) storeIds.set(store, (id = nextStoreId++));
  const scope = face.scope ?? scopeOfView(face.journal);
  return { slot: `${id}\u0000${scope ?? ''}\u0000${face.name}`, key: handKey(scope, face.name, proc), root };
}

/** Deletes the shadows of processes this store's liveness reads as dead (the same rule that judged them). */
async function reclaimDeadShadows(root: PlatformJournal, journal: unknown): Promise<void> {
  const dead = new Map<string, Promise<boolean | undefined>>();
  for (const k of await root.listKeys!(HAND_PREFIX)) {
    const p = parseHandKey(k);
    if (!p) continue;
    let alive = dead.get(p.proc);
    if (!alive) dead.set(p.proc, (alive = holderAlive(p.proc, journal).catch(() => undefined)));
    if ((await alive) === false) await root.deletePrefix!(k);
  }
}

// ── Whose wait is it: the units the CALLER runs inside ───────────────────────────────────────────────
//
// A unit that waits for "everything in hand" while it is itself in hand waits for itself: a job that
// closes its own worker, a tool body that drains the process. Neither settles (audit R2-7: `close()` from
// a handler hung for good). The rule every wait follows instead: everything in hand EXCEPT the units the
// waiter runs inside. Which those are is carried by the async context, so it reaches a host's handler,
// a tool body and a nested run without anyone passing it: `within(unit, fn)` runs `fn` as part of
// `unit`, and `othersOf` leaves the caller's own units out of a wait. A settled unit is never waited for
// anyway, so carrying one past its end changes nothing; long-lived machinery (a poll loop's timer, an
// executor's sweeper) is started `outsideHeld`, so a unit started by it later is not taken for a part of
// whichever unit happened to create it.
const ownUnits = new AsyncLocalStorage<ReadonlySet<Promise<unknown>>>();

/** Runs `fn` as part of `unit`: a wait from inside it (a worker's close, a drain) does not wait for `unit`. @internal */
export function within<T>(unit: Promise<unknown>, fn: () => T): T {
  const outer = ownUnits.getStore();
  return ownUnits.run(new Set([...(outer ?? []), unit]), fn);
}

/** Runs `fn` as part of no unit — for machinery that outlives the call that started it (timers, loops). @internal */
export function outsideHeld<T>(fn: () => T): T {
  return ownUnits.exit(fn);
}

/** The units of `units` the caller does not run inside: what a wait from here may wait for. @internal */
function othersOf<T extends Promise<unknown>>(units: Iterable<T>): T[] {
  const own = ownUnits.getStore();
  return own ? [...units].filter((u) => !own.has(u)) : [...units];
}

/**
 * THE ONE WAIT for units in hand: resolves once every unit `units()` lists — read again after each round,
 * since new ones may be taken meanwhile — has settled, except the units the caller runs inside. A drain,
 * a worker's close and an executor's drain all wait through it. @internal
 */
export async function settledExceptOwn(units: () => Iterable<Promise<unknown>>): Promise<void> {
  // Each unit is waited for once (once waited, it has settled — whether or not the list still names it).
  const waited = new Set<Promise<unknown>>();
  for (;;) {
    const fresh = othersOf(units()).filter((u) => !waited.has(u));
    if (!fresh.length) return;
    for (const u of fresh) waited.add(u);
    await Promise.allSettled(fresh);
  }
}

/**
 * Holds the work `work()` does in this process until it settles: a drain waits for it, and — with a
 * `face` — `pendingWork` lists it (see above). Registered at once; `work` runs as part of the unit
 * (`within`), so a wait from inside it never waits for it; the shadow is written before the work starts
 * and deleted after it settles; the promise returned settles as `work` did, once the shadow is gone. A
 * shadow that cannot be written costs only its listing in another process; the work is never failed for
 * it. Only a store this process has a liveness for gets one (`procStampFor`): no other process could judge
 * it — there, as for every stamp, a process without a liveness is visible to itself only.
 *
 * The unit ENDS WHEN `work()` SETTLES, and only then: a call site hands the whole of what it holds — the
 * run, the job from its lease to its release, the fire from its lock to its release, a stream's run until
 * the run's own stream has ended — never a promise someone else must remember to resolve. Every ending of
 * the unit (done, failed, canceled, abandoned by its reader) is an ending of `work()`
 * (hold-endings.test.ts holds every call site to it).
 *
 * @internal — how `runDurable`, `streamDurable`, a queue worker and a scheduler hold their units; a host holds nothing.
 */
export function holdWhile<T>(work: () => Promise<T>, face?: HandFace): Promise<T> {
  const store = face ? storeOf(face.journal) : undefined;
  const unit = face ? { ...((face.scope ?? scopeOfView(face.journal)) !== undefined ? { scope: face.scope ?? scopeOfView(face.journal) } : {}), name: face.name, what: face.what } : undefined;
  const sh = face && store ? shadowOf(face, store) : undefined;
  // The unit's own promise exists before its work starts, so the work can run as part of it.
  let start!: (v: Promise<T>) => void;
  const begun = new Promise<T>((r) => (start = r));
  let tracked: Promise<T> = begun;
  // The work starts once its shadow is written (or failed to be): written AHEAD, so another process's
  // `pendingWork` never reads "nothing blocks" while a unit already runs (CI, Postgres under load: the
  // background write lost the race to a check made right after the job's handler started).
  let ready: Promise<unknown> = Promise.resolve();
  if (sh) {
    let slot = slots.get(sh.slot);
    if (!slot) slots.set(sh.slot, (slot = { count: 0, chain: Promise.resolve() }));
    const s = slot;
    if (++s.count === 1) {
      const first = !reclaimed.has(store!);
      if (first) reclaimed.add(store!);
      s.chain = s.chain
        .then(() => sh.root.put(sh.key, { what: face!.what, at: Date.now() }))
        .catch(() => undefined)
        // Once per store per process, in the same chain (so it never outlives the unit that started it).
        .then(() => (first ? reclaimDeadShadows(sh.root, face!.journal).catch(() => undefined) : undefined));
    }
    ready = s.chain;
    const settle = (): Promise<void> => {
      if (--s.count === 0) {
        s.chain = s.chain.then(() => sh.root.deletePrefix!(sh.key)).then(() => undefined, () => undefined);
        const mine = s.chain;
        void mine.then(() => { if (s.count === 0 && s.chain === mine) slots.delete(sh.slot); });
      }
      return s.chain;
    };
    // The unit is held until its shadow is gone too: what awaits it (a caller, a worker's close, a drain)
    // never closes the store under that delete.
    tracked = begun.then((v) => settle().then(() => v), (e) => settle().then(() => { throw e; }));
  }
  const entry: HeldEntry = { ...(store ? { store } : {}), ...(unit ? { unit } : {}), since: Date.now() };
  inHand.set(tracked, entry);
  void tracked.finally(() => inHand.delete(tracked)).catch(() => {});
  // A synchronous throw is the work's failure like any other: the unit ends with it.
  start(within(tracked, () => ready.then(() => work())));
  return tracked;
}

/** Resolves once nothing is held in this process — except the units the caller runs inside (drain.ts). */
export function heldWorkSettled(): Promise<void> {
  return settledExceptOwn(() => inHand.keys());
}

/**
 * What a reader of `journal`'s store lists as held: this process's own units in that store, and the
 * shadows other processes wrote there whose holder is alive. A holder the store cannot answer for counts
 * as alive — the safe side blocks.
 *
 * @internal — `pendingWork`'s one reading of the work in hand.
 */
export async function heldUnits(journal: unknown): Promise<HeldUnit[]> {
  const store = storeOf(journal);
  const out = new Map<string, HeldUnit>();
  const id = (u: HeldUnit) => `${u.scope ?? ''}\u0000${u.name}`;
  const own = livenessFor(journal)?.id;
  for (const e of inHand.values()) {
    if (e.unit && e.store === store) out.set(id(e.unit), { ...e.unit, ...(own !== undefined ? { holder: own } : {}), ...(e.since !== undefined ? { since: e.since } : {}) });
  }
  const root = platformOf(journal);
  if (!isProcessLocal(journal) && typeof root?.listKeys === 'function') {
    // This process's own units were read from the set above, which is exact; its shadows lag it.
    const mine = livenessFor(journal)?.id;
    const alive = new Map<string, Promise<boolean | undefined>>();
    for (const k of await root.listKeys(HAND_PREFIX)) {
      const p = parseHandKey(k);
      if (!p || p.proc === mine) continue;
      const unit: HeldUnit = { ...(p.scope !== undefined ? { scope: p.scope } : {}), name: p.name, what: '' };
      if (out.has(id(unit))) continue;
      let a = alive.get(p.proc);
      if (!a) alive.set(p.proc, (a = holderAlive(p.proc, journal)));
      if ((await a) === false) continue;
      const rec = (await root.get(k)) as { what?: unknown; at?: unknown } | undefined;
      if (!rec) continue; // settled meanwhile
      out.set(id(unit), { ...unit, what: typeof rec.what === 'string' ? rec.what : 'held by a live process', holder: p.proc, ...(typeof rec.at === 'number' ? { since: rec.at } : {}) });
    }
  }
  return [...out.values()];
}

/**
 * GRACEFUL DRAIN — this process stops starting new work: no new model step and no new tool body
 * begins (RunDrainedError at those boundaries); the step and tool already running finish. Process-wide
 * because the process is what is going away.
 */
export function beginDrain(): void {
  draining = true;
}
export function isDraining(): boolean {
  return draining;
}
/** @internal — tests that drain one in-process "process" and then continue in the same OS process. */
export function endDrain(): void {
  draining = false;
}

/** Thrown at a model-step or tool-body boundary while this process drains. Not a failure of the run. */
export class RunDrainedError extends Error {
  readonly code = 'run_drained';
  constructor(readonly runId: string) {
    super(`run '${runId}' was released: this process is shutting down and starts no new step — another process continues it`);
    this.name = 'RunDrainedError';
  }
}

/**
 * This process cannot tell, right now, whether another process is alive: its own liveness session is
 * gone (a terminated backend, a failover, a partition) and a new one is not yet held. Never read as
 * "dead" — that would take a run or a call over beside a live holder — nor as "alive". Retryable: every
 * door answers 503 with `Retry-After`; the process is serving again once it holds a lock anew.
 */
export class LivenessUnavailableError extends Error {
  readonly code = 'liveness_unavailable';
  constructor() {
    super('@gnldev/durable: this process has lost its liveness session and cannot judge other processes until it holds a new one — retry shortly');
    this.name = 'LivenessUnavailableError';
  }
}

// ── In memory ──────────────────────────────────────────────────────────────────────────────────────

const localIds = new Set<string>();

/** A single process by nature: an id is alive while its liveness is open in this process. */
/**
 * Marks a journal whose data lives in this process only (the in-memory journal): no other process can
 * reach it, so "every id that is not mine is dead" is the truth there — and only there.
 */
export const PROCESS_LOCAL = Symbol.for('@gnldev/durable.processLocal');

/** True when `journal` (or the root an organization view wraps) is process-local. */
export function isProcessLocal(journal: unknown): boolean {
  let cur = journal as Record<symbol, unknown> | null | undefined;
  for (let i = 0; i < 8 && cur; i++) {
    if (cur[PROCESS_LOCAL] === true) return true;
    cur = cur[Symbol.for('@gnldev/durable.orgParent')] as Record<symbol, unknown> | undefined;
  }
  return false;
}

/**
 * THE ID OF ONE PROCESS LIFETIME. A holder stamp names the process that wrote it, and a reader judges it
 * by that process's liveness — so an id must never name two lifetimes. A process restarted under the id
 * of one that crashed (a pm2 instance number, a hostname given as `id`) read the dead holder's stamps
 * as its own ("mine, so alive"): their work was never taken over, by it or by anyone (audit C8). And a
 * dead holder's lock file can be reclaimed only because no later process can come back under its id.
 * So a configured id is a PREFIX — what an operator recognizes the process by — and every opening adds
 * a fresh part of its own. The ONE place a liveness id is made.
 */
export function livenessIdOf(configured?: string): string {
  return configured === undefined ? randomUUID() : `${configured}:${randomUUID()}`;
}

export function inMemoryLiveness(prefix?: string): ProcessLiveness {
  const id = livenessIdOf(prefix);
  localIds.add(id);
  return {
    id,
    processOnly: true,
    isAlive: async (other) => localIds.has(other),
    confirm: async () => localIds.has(id),
    close: async () => { localIds.delete(id); },
  };
}

// ── Sqlite: one lock file per process ───────────────────────────────────────────────────────────────

/**
 * Where the lock files of the processes sharing the database FILE at `dbPath` live — keyed by the FILE,
 * not by a name of it. Two processes reaching one file by two paths looked in two directories, each judged
 * the other's live holder dead, and a job ran beside its frozen owner: first through a symlink or `..`
 * (audit C1), then through a hard link, which no path resolution folds (audit R2-6). The file's identity
 * is its device and inode, the one thing every name of it shares: the directory is
 * `<directory of the real file>/.<dev>-<ino>.gnl-procs`.
 *
 * A file that does not exist yet has no inode, and a first opener that keyed by its path while the later
 * ones keyed by the inode would split them again — so the first opener creates the file, empty (an empty
 * file is a valid new Sqlite database: SqliteStorage opens it as one). Every opener then reads one identity.
 *
 * STATED LIMIT: the directory lives beside the file, in the directory its real path names — nowhere else
 * is reachable from every name of it and also shared by every process that can open it (a temporary
 * directory is per host, per container, and cleaned under a live process). Two hard links in DIFFERENT
 * directories therefore still look in two places; a file with more than one link is said once, loudly.
 * A file that cannot be created (its directory missing or read-only) is keyed by its real path, as before.
 */
export function sqliteLivenessDir(dbPath: string): string {
  return storeIdentity(dbPath).dir;
}

function storeIdentity(dbPath: string): { dir: string; links: number } {
  const abs = resolvePath(dbPath);
  try { closeSync(openSync(abs, 'a')); } catch { /* cannot be created here: keyed by its path below */ }
  try {
    const real = realpathSync(abs);
    const st = statSync(real);
    return { dir: join(dirname(real), `.${st.dev}-${st.ino}.gnl-procs`), links: st.nlink };
  } catch { /* not created: resolve its directory */ }
  try { return { dir: `${join(realpathSync(dirname(abs)), basename(abs))}.procs`, links: 1 }; } catch { return { dir: `${abs}.procs`, links: 1 }; }
}

/** Database files already said to have more than one link (once per file per process). */
const linkedWarned = new Set<string>();

/**
 * A process lock on a Sqlite deployment: `<dbPath>.procs/<id>.lock`, held by an open exclusive
 * transaction for the life of the process. Liveness of another id: `BEGIN EXCLUSIVE` without waiting
 * on its file — busy means alive. A missing file is a process that closed cleanly (dead). `idPrefix`
 * names the process for a person; the id is unique to this opening (`livenessIdOf`).
 */
export function sqliteLiveness(dbPath: string, idPrefix?: string): ProcessLiveness {
  const id = livenessIdOf(idPrefix);
  const { DatabaseSync } = createRequire(import.meta.url)('node:sqlite') as { DatabaseSync: new (path: string) => any };
  const { dir, links } = storeIdentity(dbPath);
  if (links > 1 && !linkedWarned.has(dir)) {
    linkedWarned.add(dir);
    console.warn(`@gnldev/durable: the Sqlite database '${dbPath}' has ${links} hard links. Processes opening it through links in the same directory share one liveness; through a link in ANOTHER directory they do not, and each reads the other's live work as abandoned. Open it by one name (a symlink is fine).`);
  }
  mkdirSync(dir, { recursive: true });
  const file = (pid: string) => join(dir, `${encodeURIComponent(pid)}.lock`);
  const own = new DatabaseSync(file(id));
  own.exec('PRAGMA journal_mode = DELETE');
  own.exec('CREATE TABLE IF NOT EXISTS holder (pid INTEGER, at INTEGER)');
  own.exec('BEGIN EXCLUSIVE');
  own.prepare('INSERT INTO holder (pid, at) VALUES (?, ?)').run(process.pid, Date.now());
  let open = true;
  return {
    id,
    async isAlive(other) {
      if (other === id) return open;
      const f = file(other);
      if (!existsSync(f)) return false;
      const probe = new DatabaseSync(f);
      try {
        probe.exec('PRAGMA busy_timeout = 0');
        try {
          probe.exec('BEGIN EXCLUSIVE');
        } catch (e) {
          // SQLITE_BUSY (5) / SQLITE_LOCKED (6): the holder's exclusive transaction is still open.
          const code = (e as { errcode?: number }).errcode;
          if (code === 5 || code === 6 || /locked|busy/i.test(String((e as Error).message))) return true;
          throw e;
        }
        // DEAD, and the lock is this probe's now: the file (and the journal its holder's transaction
        // left) are reclaimed while it is held, by the answer that judged them. Safe because an id names
        // one process lifetime (`livenessIdOf`): nobody can be about to take this file's lock as its own.
        // Before, every process killed with its lock left both files behind for good (audit C10).
        rmSync(`${f}-journal`, { force: true });
        rmSync(f, { force: true });
        probe.exec('ROLLBACK');
        return false;
      } finally {
        probe.close();
      }
    },
    confirm: async () => open,
    async close() {
      if (!open) return;
      open = false;
      try { own.exec('ROLLBACK'); } catch { /* closing releases it anyway */ }
      own.close();
      rmSync(file(id), { force: true });
    },
  };
}

// ── Postgres: one session advisory lock per process ─────────────────────────────────────────────────

/**
 * The process lock key: 63 bits of sha256 over the id, for the one-key `pg_advisory_lock(bigint)` form.
 * It was a 32-bit FNV hash, taken with a BLOCKING lock: two ids that collided made the second process
 * wait at startup forever, and a dead id that collided with a live one was never taken over. 63 bits
 * make a collision negligible, and the lock is taken with `pg_try_advisory_lock`: one that is held
 * fails startup with a message instead of hanging. Positive, so `(classid << 32) | objid` reads it back.
 */
export function procLockKey(id: string): string {
  const h = createHash('sha256').update(`gnl-proc:${id}`).digest();
  return (h.readBigUInt64BE(0) & 0x7fffffffffffffffn).toString();
}

/**
 * A Postgres connection that cannot hold a process lock: it goes through a transaction-mode pooler
 * (`refuseSharedBackend`). Refused where a liveness is opened on it, and a call that would have used it is
 * refused too rather than judging claims by their age (`bindOwnLiveness`).
 */
export class TransactionPoolerError extends Error {
  constructor() {
    super(
      '@gnldev/durable: this Postgres connection goes through a transaction-mode pooler (PgBouncer `pool_mode=transaction`, '
      + 'a managed "-pooler" endpoint, port 6543 on some hosts), so it cannot hold a process lock: the lock lands on a server '
      + 'connection that is lent to other clients, a dead process keeps reading alive and two processes can hold one lock. '
      + 'Give the liveness a direct or session-mode URL — `postgresLiveness({ connectionString: <direct URL> })` passed as '
      + '`liveness` to createGnl / createWorker, or installed with installProcessLiveness — or build the PostgresStorage '
      + 'from the direct URL.',
    );
    this.name = 'TransactionPoolerError';
  }
}

/**
 * THE LOCK HOLDS ONLY ON A REAL SESSION. A session-level advisory lock belongs to the server backend that
 * ran the statement, and it is this process's lock only if every statement this client sends lands on that
 * same backend, and no other client's does. Behind a transaction-mode pooler neither holds: measured on a
 * managed pooler (2026-10-18), a SIGKILLed holder read alive 60 s later, and a second client re-took the
 * first one's lock on the same backend 10 of 10 times — while nothing said so.
 *
 * So the session is checked once, before it is used: a SECOND client tries the same lock (it can only
 * succeed, or report the holder's backend pid, if both clients share a backend), then the holder asks
 * again from its own client whether the lock is still granted to the backend it is on now (it is not when
 * its statements wander to another backend). On a direct or session-mode connection none of the three can
 * happen. Measured: refused 10 of 10 on a managed pooler and 20 of 20 on an idle PgBouncer in transaction
 * mode; opened 5 of 5 on a direct managed endpoint and 5 of 5 on a local server.
 */
/**
 * Rounds of the check above. One round can miss on a BUSY pooler — the probe lands on another backend and
 * the holder's next statement happens to land on its own: measured on PgBouncer in transaction mode under
 * twelve busy clients, 33 of 200 opens missed with one round, 1 of 200 with three, 0 of 200 with five. A
 * pooler is caught in its first round almost always (an idle one: 20 of 20), so the rounds cost a real
 * session ten short statements at open, once. What a miss leaves is caught by the heartbeat, which asks
 * the same question (`pid = pg_backend_pid()`) every `heartbeatMs`.
 */
const SHARED_BACKEND_ROUNDS = 5;
async function refuseSharedBackend(holder: any, config: Record<string, unknown>, key: string, holderPid: unknown): Promise<void> {
  const { Client } = requireOptionalPeer<{ Client: new (c: any) => any }>('pg');
  const probe = new Client(config);
  let shared = false;
  try {
    await probe.connect();
    for (let round = 0; round < SHARED_BACKEND_ROUNDS && !shared; round++) {
      // One statement, so the try and its release run on one backend whatever sits in between.
      const p = (await probe.query(
        'SELECT pg_backend_pid() AS pid, CASE WHEN pg_try_advisory_lock($1::bigint) THEN pg_advisory_unlock($1::bigint) ELSE false END AS took',
        [key],
      )).rows[0];
      const own = (await holder.query(
        `SELECT pg_backend_pid() AS pid, EXISTS (SELECT 1 FROM pg_locks WHERE locktype = 'advisory' AND objsubid = 1
           AND ((classid::bigint << 32) | objid::bigint) = $1::bigint AND pid = pg_backend_pid() AND granted) AS held`,
        [key],
      )).rows[0];
      shared = p?.took === true || p?.pid === holderPid || own?.pid !== holderPid || own?.held !== true;
    }
  } finally {
    await probe.end().catch(() => undefined);
  }
  if (shared) {
    // Best effort: the lock may sit on a backend this client no longer reaches. Its id was never used — no
    // stamp names it — so a lock left behind reads one unused id alive, and nothing else.
    await holder.query('SELECT pg_advisory_unlock($1::bigint)', [key]).catch(() => undefined);
    throw new TransactionPoolerError();
  }
}

/** What a liveness session takes from a pool's options: where to connect, never how many. */
const PG_CONNECTION_FIELDS = new Set(['connectionString', 'host', 'port', 'user', 'password', 'database', 'ssl', 'options', 'application_name']);

/** The server gives up on a silent session in ~25 s (keepalive 10 s + 3 × 5 s, set below). */
const SERVER_KEEPALIVE_MS = 25_000;

export interface PostgresLivenessOptions {
  /** A DIRECT (or session-mode pooler) URL — never a transaction-mode pooler; see the head of this file. */
  connectionString?: string;
  /** Or the connection fields of a `pg` client (host, port, user, password, database, ssl). */
  client?: Record<string, unknown>;
  /**
   * A name for this process (an instance number, a hostname) — the PREFIX of its liveness id: every
   * session adds a part of its own (`<id>:<uuid>`), so a restarted process never takes the id of the
   * one it replaced.
   */
  id?: string;
  /** How often this process proves its own session (and how stale a proof `confirm()` accepts); a proof not answered within one more is a lost session. Default 1 s. */
  heartbeatMs?: number;
  /**
   * How long another process waits, after this database's lock of a holder is gone, before it reads that
   * holder as dead — and how long a live process has to take its lock back after its session ends (a
   * terminated backend, a restart, a failover). Default 5 s. A killed process is
   * taken over this much later. 0: gone is dead at once — a cut session's call then runs a second time.
   */
  reconnectGraceMs?: number;
}

/** Signals delivered over the liveness session (LISTEN/NOTIFY), see `PgProcessSession.listen`. */
export interface PgProcessSession extends ProcessLiveness {
  notify(channel: string, payload: string): Promise<void>;
  listen(channel: string, onPayload: (payload: string) => void): Promise<void>;
  /** Statements this session sent (liveness, heartbeat, notify) — for measurement. */
  readonly statements: number;
}

/**
 * A process lock on a Postgres deployment: a session-level advisory lock held on one dedicated
 * connection for the life of the process. The server keeps it while the session lives: through a
 * freeze (the kernel answers keepalives for a stopped process) and until the session ends (exit,
 * crash, or the server's keepalive giving up on a partitioned host — set here to ~25 s).
 *
 * The same session carries LISTEN/NOTIFY for run events, so a process needs one connection for both.
 */
export async function postgresLiveness(opts: PostgresLivenessOptions): Promise<PgProcessSession> {
  refuseUnknownNames('postgresLiveness', opts, POSTGRES_LIVENESS_NAMES);
  const { Client } = requireOptionalPeer<{ Client: new (c: any) => any }>('pg');
  const heartbeatMs = opts.heartbeatMs ?? HEARTBEAT_MS;
  // `confirm()` accepts a self-proof this old. Past a third of the server's keepalive window, a process
  // could act on a proof older than the moment its session was dropped and its runs handed over.
  if (!(heartbeatMs > 0 && heartbeatMs <= SERVER_KEEPALIVE_MS / 3)) {
    throw new Error(`@gnldev/durable: postgresLiveness heartbeatMs must be between 1 and ${Math.floor(SERVER_KEEPALIVE_MS / 3)} ms (the server drops a silent session in ~${SERVER_KEEPALIVE_MS / 1000} s); got ${heartbeatMs}`);
  }
  const reconnectGraceMs = reconnectGraceOf('postgresLiveness', opts.reconnectGraceMs, heartbeatMs);
  const fields = opts.client ? Object.fromEntries(Object.entries(opts.client).filter(([k]) => PG_CONNECTION_FIELDS.has(k))) : {};
  const config = { ...fields, ...(opts.connectionString ? { connectionString: opts.connectionString } : {}), keepAlive: true, keepAliveInitialDelayMillis: 5_000 };
  let statements = 0;
  const listeners = new Map<string, Array<(payload: string) => void>>();
  let session: { client: any; key: string } | undefined;
  /** One session holding the lock for `sid`, or a refusal naming why. */
  const open = async (sid: string): Promise<{ client: any; key: string }> => {
    const c = new Client(config);
    c.on('error', () => { if (session?.client === c) lost(); });
    c.on('end', () => { if (session?.client === c) lost(); });
    c.on('notification', (n: { channel: string; payload?: string }) => {
      for (const fn of listeners.get(n.channel) ?? []) fn(n.payload ?? '');
    });
    await c.connect();
    try {
      // The server's side of a partition: give up on a silent peer in ~25 s rather than the OS default (2 h).
      await c.query('SET tcp_keepalives_idle = 10');
      await c.query('SET tcp_keepalives_interval = 5');
      await c.query('SET tcp_keepalives_count = 3');
      const key = procLockKey(sid);
      const got = await c.query('SELECT pg_try_advisory_lock($1::bigint) AS ok, pg_backend_pid() AS pid', [key]);
      statements += 4;
      if (got.rows[0]?.ok !== true) {
        throw new Error(`@gnldev/durable: the process lock for id '${sid}' is already held by another session — two processes share one liveness id.`);
      }
      await refuseSharedBackend(c, config, key, got.rows[0].pid);
      statements += 2;
      for (const ch of listeners.keys()) { await c.query(`LISTEN ${c.escapeIdentifier(ch)}`); statements++; }
      return { client: c, key };
    } catch (e) {
      await c.end().catch(() => undefined);
      throw e;
    }
  };
  const id = livenessIdOf(opts.id);
  session = await open(id);
  let healthy = true;
  let closed = false;
  let provenAt = performance.now();
  let reopening: Promise<void> | undefined;
  let saidPooler = false;
  const signals = sessionSignals(reconnectGraceMs);
  /**
   * THE SESSION IS GONE — the process is not. It takes its lock back under the SAME id, retrying until it
   * holds it (or the liveness is closed): the others read a holder as dead only once its lock has been
   * gone for `reconnectGraceMs` (`judgeAlive`), so a session that is back within it keeps everything the
   * process holds. It used to come back under a NEW id, and the old one read dead at once: a call whose
   * body was running was taken over beside it — 2 effects in 5 of 5 rounds (raporlar/2026-10-18-session-
   * cut). Until it is back, `confirm()` is false (nothing new starts) and a question about another process
   * is refused; past half the grace, the bodies it started are told to stop (`sessionSignal`).
   */
  function lost(): void {
    healthy = false;
    const was = session;
    session = undefined;
    // Destroyed, not ended: a session lost silently never answers the goodbye `end()` waits for.
    was?.client.connection?.stream?.destroy?.();
    if (closed || reopening) return;
    reopening = (async () => {
      // The first try at once: a terminated backend's lock is free the moment it is gone.
      for (let wait = 50; !closed; wait = Math.min(wait * 2, 1_000)) {
        try {
          const s2 = await open(id);
          if (closed) { await s2.client.end().catch(() => undefined); return; }
          session = s2;
          provenAt = performance.now();
          healthy = true;
          signals.proven();
          return;
        } catch (e) {
          // A session that turned out to be a pooler's (its statements wandered off the lock's backend) is
          // refused again on every attempt: say why, once, rather than answer 503 with no reason.
          if (e instanceof TransactionPoolerError && !saidPooler) {
            saidPooler = true;
            console.error(e.message);
          }
          await new Promise((r) => setTimeout(r, wait).unref?.());
        }
      }
    })().finally(() => { reopening = undefined; });
  }
  const q = async (sql: string, p?: unknown[]) => {
    const cur = session;
    if (!healthy || !cur) throw new LivenessUnavailableError();
    statements++;
    try {
      return await cur.client.query(sql, p);
    } catch (e) {
      if (session === cur) lost();
      throw new LivenessUnavailableError();
    }
  };
  let proving: Promise<boolean> | undefined;
  /** One proof at a time, answered within a heartbeat or the session is lost (`proofWithin`). */
  const holdsOwn = (): Promise<boolean> => proving ??= (async () => {
    const cur = session;
    if (!healthy || !cur) return false;
    const held = await proofWithin((async () => (await q(
      `SELECT 1 FROM pg_locks WHERE locktype = 'advisory' AND objsubid = 1 AND ((classid::bigint << 32) | objid::bigint) = $1::bigint AND pid = pg_backend_pid() AND granted`,
      [cur.key],
    )).rows.length === 1)(), heartbeatMs);
    if (session !== cur) return false;
    if (held) { provenAt = performance.now(); signals.proven(); } else lost();
    return held;
  })().finally(() => { proving = undefined; });
  const beat = setInterval(() => { void holdsOwn(); }, heartbeatMs);
  beat.unref?.();
  return {
    id,
    reconnectGraceMs,
    sessionSignal: signals.signal,
    get statements() { return statements; },
    async isAlive(other) {
      if (other === id) return healthy;
      const r = await q(
        `SELECT 1 FROM pg_locks WHERE locktype = 'advisory' AND objsubid = 1 AND ((classid::bigint << 32) | objid::bigint) = $1::bigint AND granted
           AND database = (SELECT oid FROM pg_database WHERE datname = current_database())`,
        [procLockKey(other)],
      );
      return r.rows.length > 0;
    },
    async confirm(maxAgeMs = heartbeatMs) {
      if (!healthy) return false;
      if (performance.now() - provenAt < maxAgeMs) return true;
      return holdsOwn();
    },
    async notify(channel, payload) {
      await q('SELECT pg_notify($1, $2)', [channel, payload]);
    },
    async listen(channel, onPayload) {
      const first = !listeners.has(channel);
      listeners.set(channel, [...(listeners.get(channel) ?? []), onPayload]);
      // A session opened later LISTENs to every channel registered here (see `open`).
      if (first && session) await q(`LISTEN ${session.client.escapeIdentifier(channel)}`);
    },
    async close() {
      if (closed) return;
      closed = true;
      clearInterval(beat);
      signals.close();
      healthy = false;
      const cur = session;
      session = undefined;
      // Ending the session releases the lock; one lost silently never answers, so it is destroyed then.
      if (cur && !(await proofWithin(cur.client.end().then(() => true), heartbeatMs))) cur.client.connection?.stream?.destroy?.();
    },
  };
}
