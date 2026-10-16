/**
 * WHOSE IS THIS — one module, one value.
 *
 * Two questions live here, each answered once:
 *
 *  1. Who is a run acting for? Every run carries ONE `RunIdentity`, decided at the run's start from
 *     the `Caller` a door (or a direct engine call) hands over and the owner already recorded for the
 *     run. It is passed explicitly — never through ambient state — to everything that acts on the
 *     run's behalf: `DurableCtx.identity`, the workflow `StepCtx.identity`, and `options.gnl` of a
 *     tool's `execute`. A child run (agent-as-tool, network sub-agent, a run started inside a
 *     workflow step, a batch item) takes its caller from its parent's value, so the owner that is
 *     recorded and the identity a tool sees are the same value.
 *
 *  2. Does this run exist, and whose is it? `runOwnerOf` is the ONE reading, for every run kind and
 *     every door; `decideRunAccess` is the ONE rule on top of it. Every run birth writes its owner
 *     through `claimRunOwner` — ownerless too — so "no record" never means "not started" for a run
 *     that has started.
 *
 * Three callers, not two: `user` is an end user; `staff` is an EXPLICIT operator/system decision;
 * `unknown` means the identity was lost on the way (a tool called by hand without its options, a run
 * started with no caller). `unknown` is closed wherever an end user's data would be served.
 *
 * No HTTP here: the engine answers `allow | deny | missing`, and each door maps that to its own wire.
 */
import { runRecordKey, isBookkeepingRest, isRunRecordRest, isEngineBegunRunId, admitRunId, ENGINE_MINT, withMintOf } from './run-id-grammar.js';
import { claim, runKeys, isVersionedRecord, type Journal, type JournalBatch } from './journal.js';
import { stampFormat } from './format.js';
import { RunOwnerMismatchError, RunTargetMismatchError, RunNotFoundError } from './errors.js';
import { erasureBaseline, assertNotErased, runErasedSince, RunErasedError } from './erasure-fence.js';

import type { Caller, RunIdentity, GnlToolContext, StaffCaller, UnknownCaller, UserCaller } from './identity-types.js';
export type { UserCaller, StaffCaller, UnknownCaller, Caller, RunIdentity, GnlToolContext } from './identity-types.js';

export const STAFF: StaffCaller = Object.freeze({ kind: 'staff' }) as StaffCaller;
export const UNKNOWN: UnknownCaller = Object.freeze({ kind: 'unknown' }) as UnknownCaller;

/** An end user, validated: a user with no id is a bug, not an anonymous caller. */
export function user(id: string, orgId?: string): UserCaller {
  if (typeof id !== 'string' || id === '') {
    throw new TypeError(`@gnldev/durable: a user caller needs a non-empty id — got ${JSON.stringify(id)}`);
  }
  return { kind: 'user', id, ...(orgId !== undefined ? { orgId } : {}) };
}

/** Staff (an operator, or the system itself), said out loud. `orgId` is where it acts, not who it is. */
export function staff(orgId?: string): StaffCaller {
  return orgId === undefined ? STAFF : { kind: 'staff', orgId };
}

/** The `resourceId?: string` shorthand read as a caller. Absent is `unknown` — never staff by omission. */
export function callerFromResourceId(resourceId: string | undefined, orgId?: string): Caller {
  return resourceId !== undefined && resourceId !== '' ? user(resourceId, orgId) : UNKNOWN;
}

/** The caller half of an identity (drops the run placement fields). */
export function callerOf(c: Caller): Caller {
  if (c.kind === 'user') return user(c.id, c.orgId);
  if (c.kind === 'staff') return staff(c.orgId);
  return UNKNOWN;
}

/** The end user a caller stands for, or undefined for staff/unknown. */
export function userIdOf(c: Caller | undefined): string | undefined {
  return c?.kind === 'user' ? c.id : undefined;
}

/** The fields a server seals onto a request context (`sealRequestContext`) for this caller. */
export interface SealFields { resourceId?: string; orgId?: string; staff?: true }

/**
 * THE caller → seal mapping, for every door: a user seals its id, staff seals the staff flag, `unknown`
 * seals neither (it stays closed), and the organization is the one the door established. The REST,
 * chat, AG-UI and MCP doors each wrote this out by hand.
 */
export function sealFieldsOf(caller: Caller, orgId?: string): SealFields {
  return {
    ...(caller.kind === 'user' ? { resourceId: caller.id } : {}),
    ...(orgId !== undefined ? { orgId } : {}),
    ...(caller.kind === 'staff' ? { staff: true as const } : {}),
  };
}

/** Whether two callers are the same party: kind, user id, and organization where both name one. */
function sameParty(a: Caller, b: Caller): boolean {
  if (a.kind !== b.kind) return false;
  if (a.kind === 'user' && a.id !== (b as UserCaller).id) return false;
  const ao = a.kind === 'unknown' ? undefined : a.orgId;
  const bo = b.kind === 'unknown' ? undefined : b.orgId;
  return ao === undefined || bo === undefined || ao === bo;
}

/**
 * THE caller of a call, decided once, from what the server sealed and what the call declared (`caller`,
 * or the `resourceId` shorthand). The seal is what a server verified, so it decides.
 *
 * An explicit `caller` that names somebody else is REFUSED, not overruled: `caller` is a door's own
 * decision, and the seal used to win silently — a host passing `caller: mallory` with a context sealed
 * for ayse started ayse's run and was never told. The `resourceId` shorthand keeps its documented
 * precedence (P1.7: a sealed identity overrides it): it is the field a request body reaches, and the
 * seal is there to overrule exactly that.
 * @internal — door plumbing shared by the GNL doors; gnl builds its argument, no host writes it.
 */
export function resolveCaller(seal: SealFields, declared?: { resourceId?: string; caller?: Caller }): Caller {
  let named: Caller | undefined;
  if (declared?.caller) {
    named = callerOf(declared.caller);
    if (declared.resourceId !== undefined && userIdOf(named) !== declared.resourceId) {
      throw new TypeError('@gnldev/durable: a call was given both `caller` and a different `resourceId` — one caller per call.');
    }
  }
  const sealed = seal.resourceId !== undefined ? user(seal.resourceId, seal.orgId) : seal.staff ? staff(seal.orgId) : undefined;
  if (!sealed) return named ?? callerFromResourceId(declared?.resourceId, seal.orgId);
  if (named && !sameParty(sealed, named)) {
    throw new TypeError(
      `@gnldev/durable: the request context is sealed for ${ownerLabel(sealed)} and the call names ${ownerLabel(named)} — one caller per call. ` +
        'Pass the caller the server established (or drop the declaration and let the seal speak).',
    );
  }
  return sealed;
}

/** @internal — engine plumbing shared with the GNL door, memory and rag packages; gnl builds its argument, no host writes it. */
export function runIdentity(c: Caller, runId: string, place: { threadId?: string; parentRunId?: string; requestRunId?: string } = {}): RunIdentity {
  return {
    ...callerOf(c), runId,
    ...(place.threadId ? { threadId: place.threadId } : {}),
    ...(place.parentRunId ? { parentRunId: place.parentRunId } : {}),
    ...(place.requestRunId ? { requestRunId: place.requestRunId } : {}),
  };
}

/**
 * The request a run belongs to: the run the request started (`requestRunId`), or the run itself when
 * nothing delegated it. THE one reading — the request's dedup window, duplicate markers and limits are
 * all keyed by it.
 */
export function requestOf(identity: Pick<RunIdentity, 'runId' | 'requestRunId'>): string {
  return identity.requestRunId ?? identity.runId;
}

/**
 * A child's identity: the parent's caller, the child's placement.
 * @internal — engine plumbing shared with the GNL door, memory and rag packages; gnl builds its argument, no host writes it.
 */
export function childIdentity(parent: RunIdentity, childRunId: string, threadId?: string): RunIdentity {
  const thread = threadId ?? parent.threadId;
  return runIdentity(parent, childRunId, { ...(thread ? { threadId: thread } : {}), parentRunId: parent.runId, requestRunId: requestOf(parent) });
}

/**
 * The tool-execution context the engine passes for a run (`options.gnl`).
 * @internal — engine plumbing shared with the GNL door, memory and rag packages; gnl builds its argument, no host writes it.
 */
export function toolContextFor(identity: RunIdentity): GnlToolContext {
  return { identity, runId: identity.runId, ...(identity.parentRunId ? { parentRunId: identity.parentRunId } : {}) };
}

/**
 * THE way a tool reads who it runs for: `identityOf(options)`. A tool called without the engine's
 * options (by hand, or from another tool that did not forward them) is `unknown` — closed, not open.
 */
export function identityOf(options: unknown): RunIdentity {
  const g = (options as { gnl?: GnlToolContext } | undefined)?.gnl;
  const id = g && typeof g === 'object' ? g.identity : undefined;
  if (id && typeof id === 'object' && (id.kind === 'user' || id.kind === 'staff' || id.kind === 'unknown')) return id;
  return { kind: 'unknown', runId: '' };
}

/**
 * The old channel, closed loudly. Tools used to read the user from `options.resourceId`; that key is
 * gone, and a type error alone did not stop a tool from reading it (measured: `(options as any)
 * .resourceId` compiles and reads `undefined` — i.e. "nobody", which a rag tool served as the whole
 * index). So the engine plants a getter that THROWS. It is not enumerable: spreading or forwarding
 * the options (`{ ...options }`, `JSON.stringify`) does not trip it — only reading it does.
 */
export function closeLegacyResourceId<T extends object>(options: T): T {
  Object.defineProperty(options, 'resourceId', {
    enumerable: false,
    configurable: true,
    get() {
      throw new TypeError(
        '@gnldev/durable: `options.resourceId` was removed from tool options — read who the tool runs for with ' +
          '`identityOf(options)` (a user, staff, or `unknown`, which is closed). See the 0.7.0 CHANGELOG.',
      );
    },
  });
  return options;
}

// ─── Ownership: "does this run exist, and whose is it" ─────────────────────────────────────────

/** The owner fields of a `<runId>:input` record. `ownerKind` marks a run born with no end user. */
export type OwnerRecord = { resourceId?: string; orgId?: string; ownerKind?: 'staff' | 'unknown' } & Record<string, unknown>;

export type RunKind = 'agent' | 'workflow' | 'network' | 'batch' | 'other';

/**
 * The answer to "does this run exist, and whose is it":
 *  - `missing`: no owner record and no rows — the run has not started (a door may start it).
 *  - `owned`: the run exists. `owner` is who it belongs to; `staff` also for a run nobody claimed and
 *    for a run whose record is missing but whose rows are present. `record` is the raw record when
 *    there is one (an agent run's frozen input), `recorded: false` when the owner was inferred.
 *  - `unreadable`: the store failed. Not knowing is not permission: every decision reads it as deny,
 *    and no birth proceeds on it.
 */
export type RunOwner =
  | { state: 'missing' }
  | { state: 'owned'; owner: Caller; kind: RunKind; recorded: boolean; record?: OwnerRecord }
  | { state: 'unreadable'; error: unknown };

/**
 * A raw (unscoped) journal. The subject view carries the `SUBJECT_VIEW` brand, so a decision cannot
 * be computed over an end user's filtered view by mistake.
 */
export const SUBJECT_VIEW = '__gnlSubjectView' as const;
/** The brand a subject view carries (a string key, so packages without a durable dependency can refuse it too). */
export type SubjectViewBrand = { readonly __gnlSubjectView: true };
export type RawJournal = Journal & { readonly __gnlSubjectView?: never };

export function assertRaw(journal: object, fn: string): void {
  if ((journal as { __gnlSubjectView?: unknown }).__gnlSubjectView === true) {
    throw new TypeError(`@gnldev/durable: ${fn} was handed an end user's VIEW — decisions read the raw journal`);
  }
}

/**
 * Whose a stored `:input` record says the run is — the ONE reading of the owner fields.
 *
 * The `_v` rule (see `runIdOfKey` in journal.ts): only a record the journal itself stamped names an
 * owner. `appendLog(journal, ns, payload, 'input')` writes an unstamped `<ns>:input` through a public
 * API, so an unstamped record's `resourceId` is a caller's bytes, not an owner — it still proves the
 * key is taken, so it reads as staff's (closed), never as the user it names.
 */
export function recordOwner(rec: unknown): Caller | undefined {
  if (rec === undefined || rec === null || typeof rec !== 'object') return undefined;
  const r = rec as OwnerRecord;
  if (!isVersionedRecord(r)) return STAFF;
  if (typeof r.resourceId === 'string' && r.resourceId !== '') return user(r.resourceId, typeof r.orgId === 'string' ? r.orgId : undefined);
  if (r.ownerKind === 'unknown') return UNKNOWN;
  return staff(typeof r.orgId === 'string' ? r.orgId : undefined);
}

function kindOf(rec: OwnerRecord): RunKind {
  if (typeof rec.workflow === 'string') return 'workflow';
  if (typeof rec.network === 'string') return 'network';
  if (typeof rec.batch === 'string') return 'batch';
  if (rec.prompt !== undefined || rec.messages !== undefined) return 'agent';
  return 'other';
}

/** Rows a run writes early, read point by point when the journal cannot list (the bounded fallback). */
const PROBE_KEYS = (runId: string) => [runKeys.model(runId, 0), runRecordKey(runId, 'outcome'), runRecordKey(runId, 'wf', '_input'), runRecordKey(runId, 'net', 'route:0')];

/**
 * Keys the engine writes under a run's id that say nothing about the run having STARTED: the locks
 * taken before a run starts (the run lock, a queue worker's `lease:lock`, the scheduler's
 * `fire:lock`), a parent's taint copied into a child before the child starts
 * (`proc:__gnl_taint`), frozen configuration written before the owner record (`cfg:lessons`
 * is resolved before the run is entered) and the retention tombstone a sweep leaves after deleting a
 * run (a late retry of a swept run is a new run — `tombstonePolicy` decides that, not ownership).
 */
const isBookkeeping = isBookkeepingRest; // the families run-id-grammar.ts marks `bookkeeping`
/** A run has a handful of bookkeeping keys at most; a probe this wide always sees past them. */
const PROBE_LIMIT = 16;

/**
 * Whether anything is stored under the run's id although its owner record is not: a run whose record
 * was lost (a crash between a fork's row copy and its record, a record deleted by hand, data from
 * before records existed), or a `:`-prefix of another run's id (`team` over `team:1`), which must
 * not be born: its keys would be ambiguous with the longer run's.
 *
 * BOUNDED: one `listKeys(prefix, { limit: PROBE_LIMIT })` — the store stops early — plus the workflow
 * registry row, which lives outside the prefix. A journal without `listKeys` gets a fixed set of point
 * reads instead. Never a full scan of the prefix: this runs on every new run.
 */
async function rowsPresent(journal: Journal, runId: string): Promise<boolean> {
  if ((await journal.get(`wfrun:${runId}`)) !== undefined) return true;
  if (typeof journal.listKeys === 'function') {
    const prefix = `${runId}:`;
    return (await journal.listKeys(prefix, { limit: PROBE_LIMIT })).some((k) => !isBookkeeping(k.slice(prefix.length)));
  }
  for (const k of PROBE_KEYS(runId)) if ((await journal.get(k)) !== undefined) return true;
  return false;
}

/** The ONE reading of "does this run exist, and whose is it", for every run kind and every door. */
export async function runOwnerOf(journal: RawJournal, runId: string): Promise<RunOwner> {
  assertRaw(journal, 'runOwnerOf');
  try {
    const rec = await journal.get<OwnerRecord>(runKeys.input(runId));
    const owner = recordOwner(rec);
    if (owner) return { state: 'owned', owner, kind: kindOf(rec!), recorded: isVersionedRecord(rec), record: rec };
    if (await rowsPresent(journal, runId)) {
      // Rows with no record is a run from before owners were recorded — unless the record was written
      // between the two reads: a birth writes its owner before its first row, so a run being born by
      // another process shows up here as "no record, rows present". Read the record once more; only a
      // run that still has none is the legacy, staff-owned case.
      const again = await journal.get<OwnerRecord>(runKeys.input(runId));
      const born = recordOwner(again);
      if (born) return { state: 'owned', owner: born, kind: kindOf(again!), recorded: isVersionedRecord(again), record: again };
      return { state: 'owned', owner: STAFF, kind: 'other', recorded: false };
    }
    return { state: 'missing' };
  } catch (error) {
    return { state: 'unreadable', error };
  }
}

export type RunDecision = 'allow' | 'deny' | 'missing';

/**
 * The ONE access rule over `runOwnerOf`'s answer:
 *  - unreadable → deny (not knowing is not permission);
 *  - missing → missing (the door decides whether that means "not found" or "you may start it");
 *  - staff reaches every run that exists;
 *  - an end user reaches a run whose owner IS that user — never an ownerless (staff) run;
 *  - `unknown` reaches only a run that was itself born `unknown` (a direct engine caller that never
 *    named anyone continuing its own work) — never a user's or staff's.
 * @internal — engine plumbing shared with the GNL door, memory and rag packages; gnl builds its argument, no host writes it.
 */
export function decideRunAccess(owner: RunOwner, caller: Caller): RunDecision {
  if (owner.state === 'unreadable') return 'deny';
  if (owner.state === 'missing') return 'missing';
  if (caller.kind === 'staff') return 'allow';
  if (caller.kind === 'unknown') return owner.owner.kind === 'unknown' ? 'allow' : 'deny';
  return owner.owner.kind === 'user' && owner.owner.id === caller.id ? 'allow' : 'deny';
}

/**
 * `decideRunAccess` as a DOOR asks it, for a run id a request named. One difference, and it is the
 * grammar's: an id of a family only the engine begins (`task:`, `cont:`, `agent:`, `wf:`, `net:` —
 * run-id-grammar.ts) is never a door caller's to start, because no door holds the engine's mark. So when
 * it does not exist it is `deny`, not `missing` — the answer a foreign run gets — and a door answers the
 * two alike (`runNotFound`, errors.ts) BEFORE any other gate runs: a budget gate between them answered
 * an over-budget organization's stranger 402 for the absent id and 404 for the existing one.
 * @internal — the door packages' gate; gnl builds its argument, no host writes it.
 */
export function decideDoorRunAccess(owner: RunOwner, caller: Caller, runId: string): RunDecision {
  const d = decideRunAccess(owner, caller);
  return d === 'missing' && isEngineBegunRunId(runId) ? 'deny' : d;
}

export async function decideRun(journal: RawJournal, runId: string, caller: Caller): Promise<RunDecision> {
  return decideRunAccess(await runOwnerOf(journal, runId), caller);
}

/**
 * Who a run acts for once it is admitted: a new run acts for its caller; an existing run ALWAYS acts
 * for its recorded owner (staff resuming a user's run runs it as that user). `undefined` when the
 * decision is not `allow`/`missing` — the caller is refused, never run as itself.
 */
export function actingCaller(owner: RunOwner, caller: Caller): Caller | undefined {
  const d = decideRunAccess(owner, caller);
  if (d === 'missing') return callerOf(caller);
  if (d === 'deny' || owner.state !== 'owned') return undefined;
  return owner.owner;
}

/** The owner fields every run kind writes into its `:input` record. */
export function ownerFields(c: Caller): { resourceId?: string; orgId?: string; ownerKind?: 'staff' | 'unknown' } {
  if (c.kind === 'user') return { resourceId: c.id, ...(c.orgId !== undefined ? { orgId: c.orgId } : {}) };
  if (c.kind === 'staff') return { ownerKind: 'staff', ...(c.orgId !== undefined ? { orgId: c.orgId } : {}) };
  return { ownerKind: 'unknown' };
}

/**
 * Whether `runId` may still be born: an id a deletion fenced never is (erasure-fence.ts) — throws
 * `RunErasedError`. The rule `claimRunOwner` applies at a birth, asked by the doors that take work now
 * under a run id born later (a queued job, a scheduled trigger), so they refuse it when it is handed in
 * instead of accepting work that can never run.
 */
export async function refuseErasedRunId(journal: Journal, runId: string): Promise<void> {
  if (await runErasedSince(journal, runId, undefined)) throw new RunErasedError(runId);
}

/**
 * THE common start point of every run birth: agent (run.ts bornAs), workflow, network, batch item,
 * MCP call, fork, rollover, replay. Writes the owner record UNCONDITIONALLY — ownerless too — first
 * write wins, and returns the owner that is recorded afterwards (the winner's, on a race).
 *
 * STAMPED (`_v`), which is not cosmetic: the readers that ENUMERATE runs (`runIdOfKey`, hence
 * `listRunsPaged`, `purgeResource`) only count a stamped `:input`, so an unstamped owner record
 * satisfied the gates that read it by key and was invisible to erasure. Not best-effort either: a
 * birth that cannot record its owner does not start.
 */
export async function claimRunOwner(journal: RawJournal, runId: string, caller: Caller, fields: Record<string, unknown> = {}): Promise<Caller> {
  assertRaw(journal, 'claimRunOwner');
  // THE run-id gate, at the one place a run is born (run-id-grammar.ts): its spelling, and — for an id
  // only the engine begins — the engine's mark, which the birth record carries (`withMintOf`) and which
  // is not written.
  const { [ENGINE_MINT]: mint, ...record } = fields as Record<string | symbol, unknown>;
  await admitRunId(runId, { journal, mint });
  // A run deleted under a live worker stays deleted (erasure-fence.ts): its id is not born again — for
  // any kind, by any path, before anything of it is written.
  await refuseErasedRunId(journal, runId);
  const key = runKeys.input(runId);
  await claim(journal, key, stampFormat({ at: Date.now(), ...record, ...ownerFields(caller) }));
  const recorded = recordOwner(await journal.get<OwnerRecord>(key)) ?? callerOf(caller);
  // Two births racing for one id: the claim has one winner, and a loser that may not act on the
  // winner's run is refused HERE — for every kind of birth, so no birth site has to remember to look.
  if (decideRunAccess({ state: 'owned', owner: recorded, kind: 'other', recorded: true }, caller) === 'deny') throw runOwnerRefusal(runId, recorded, caller);
  return recorded;
}

/**
 * The run a primitive writes under, born before its first row. `durableTool`, `withDurableModel` and
 * the tools `withIdempotency` wraps can be handed any `{ journal, runId }` — a host's own loop, a door's
 * test run — and their rows used to land under an id nobody had begun: rows without an owner record
 * read as a run that exists (`runOwnerOf`: staff's), so the id was taken from whoever it belonged to.
 *
 * Now the ctx's journal births the run at the first write of one of ITS records (`<runId>:<family>…`;
 * a primitive that writes nothing under the id — `withIdempotency`'s cross-run window — begins no
 * run): a run that exists is continued as it is (its entry judged who may act); one that does not is
 * born through the one birth, for the ctx's identity, and an id that may not be born (its spelling, an
 * engine-begun family without the engine's mark) is refused before anything is written. The write is
 * judged where it happens, so no write site in a primitive has to remember to ask. A ctx the engine
 * built after its own admission is marked born and left as it is.
 */
const bornCtx = new WeakSet<object>();
const BIRTH_ON_WRITE = Symbol('gnl.birthOnWrite');
/** Marks a ctx the engine built for a run it has just admitted (and so born). @internal */
export function engineBorn<T extends object>(ctx: T): T {
  bornCtx.add(ctx);
  return ctx;
}
/** @internal — what a primitive does to the ctx it is handed, before it uses it. */
export function bornOnFirstWrite(ctx: { journal: Journal; runId: string; identity?: Caller | RunIdentity }): void {
  if (bornCtx.has(ctx) || (ctx.journal as unknown as Record<symbol, unknown>)[BIRTH_ON_WRITE] === ctx.runId) return;
  const journal = ctx.journal;
  const runId = ctx.runId;
  const head = `${runId}:`;
  const ofRun = (key: unknown) => typeof key === 'string' && key.startsWith(head) && isRunRecordRest(key.slice(head.length)) && !isBookkeepingRest(key.slice(head.length));
  let born: Promise<void> | undefined;
  const birth = (): Promise<void> => (born ??= birthIfMissing(journal, runId, ctx.identity ? callerOf(ctx.identity) : UNKNOWN, ctx).catch((e) => { born = undefined; throw e; }));
  ctx.journal = new Proxy(journal, {
    get(target, prop) {
      if (prop === BIRTH_ON_WRITE) return runId;
      const v = Reflect.get(target, prop, target);
      if (typeof v !== 'function') return v;
      if (prop === 'put' || prop === 'putIfAbsent' || prop === 'putIfMatch' || prop === 'incrBy') {
        return async (key: string, ...rest: unknown[]) => { if (ofRun(key)) await birth(); return (v as (...a: unknown[]) => unknown).call(target, key, ...rest); };
      }
      if (prop === 'applyBatch') {
        return async (batch: JournalBatch) => {
          const keys = [batch.claim?.key, ...(batch.puts ?? []).map((p) => p.key), ...(batch.incrs ?? []).map((p) => p.key)];
          if (keys.some(ofRun)) await birth();
          return (v as (b: JournalBatch) => unknown).call(target, batch);
        };
      }
      return (v as (...a: unknown[]) => unknown).bind(target);
    },
  });
}
/** A run that does not exist is born for `caller` (the engine's mark read off `marked`); one that does is left as it is. @internal */
export async function birthIfMissing(journal: Journal, runId: string, caller: Caller, marked: unknown): Promise<void> {
  const owner = await runOwnerOf(journal as RawJournal, runId);
  if (owner.state === 'unreadable') throw owner.error;
  if (owner.state === 'missing') await claimRunOwner(journal as RawJournal, runId, caller, withMintOf({}, marked));
}

/**
 * What a journal offers a package that cannot depend on this one (@gnldev/workflow): the ENTRY of a
 * run, through the same rules every other run kind meets. `beginRun(runId, ctx)` before the caller's
 * first write under the id:
 *  - who may act: `admitRun`, the one rule the agent door uses — a run that does not exist is born for
 *    `ctx.identity` (`claimRunOwner`, which holds the run-id gate and refuses a deleted id), the loser
 *    of a birth race is held to the winner, and a run the identity may not act on is refused
 *    (`RunOwnerMismatchError`, which a door answers as `run_not_found`); a fork (`from`) is born for its
 *    source's owner; a run another target began is refused;
 *  - whether it still exists: the lease it returns. `live()` at every step boundary refuses a run
 *    deleted since it began (`RunErasedError`); `settle()` after the attempt's last write takes back
 *    what it wrote if the run was deleted meanwhile, and refuses — the fence is written first and read
 *    last, as for an agent run (erasure-fence.ts).
 * A store without it keeps no owners and no fences, as before.
 */
export interface RunBirth {
  beginRun(runId: string, ctx?: { identity?: Caller | RunIdentity; from?: string }): Promise<RunLease>;
}
/** A run's entry, as `beginRun` hands it back. @see RunBirth */
export interface RunLease {
  /** Who the run acts for: its caller for a new run, its recorded owner for one that exists. */
  readonly acting: Caller;
  /** Throws `RunErasedError` when the run was deleted since it began. */
  live(): Promise<void>;
  /** After the attempt's last write: a run deleted meanwhile has that write taken back, and this throws `RunErasedError`. */
  settle(): Promise<void>;
}
/** Gives `journal` its `beginRun` (not enumerable: a spread copy of a view must not carry the view's birth). */
export function withBirth<J extends Journal>(journal: J): J & RunBirth {
  const beginRun = (runId: string, ctx?: { identity?: Caller | RunIdentity; from?: string }) => beginRunIn(journal, runId, ctx);
  Object.defineProperty(journal, 'beginRun', { value: beginRun, enumerable: false, configurable: true, writable: true });
  return journal as J & RunBirth;
}

/** THE `beginRun`, through `journal` (a view passes itself, so the owner record lands in its scope). @internal */
export async function beginRunIn(journal: Journal, runId: string, ctx?: { identity?: Caller | RunIdentity; from?: string }): Promise<RunLease> {
  const birth = withMintOf({ workflow: '' }, ctx);
  const parent = (ctx?.identity as { parentRunId?: unknown } | undefined)?.parentRunId;
  const erasure = await erasureBaseline(journal, typeof parent === 'string' ? parent : undefined);
  // A fork is born to its source's owner, like every run born from another; every other entry is the
  // one the agent door makes (`admitRun`).
  const acting = ctx?.from !== undefined
    ? await inheritRunOwner(journal as RawJournal, ctx.from, runId, birth)
    : (await admitRun(journal as RawJournal, runId, ctx?.identity ? callerOf(ctx.identity) : UNKNOWN, birth)).acting;
  const live = () => assertNotErased(journal, runId, erasure);
  await live();
  return {
    acting,
    live,
    settle: async () => {
      if (!(await runErasedSince(journal, runId, erasure))) return;
      // Read here, not imported: the deletion plan sits above the journals that hand out this lease.
      const { settleErasedRun } = await import('./model.js');
      await settleErasedRun(journal, runId, erasure);
      throw new RunErasedError(runId);
    },
  };
}

/**
 * An operation on a run that is not its birth — a cancel, an unwind, a score — needs the run. Absent, it
 * is refused as `RunNotFoundError` and writes nothing: its rows would have made the id read as a run that
 * exists (staff's), lost to whoever could still begin it.
 */
export async function existingRun(journal: Journal, runId: string): Promise<Extract<RunOwner, { state: 'owned' }>> {
  const owner = await runOwnerOf(journal as RawJournal, runId);
  if (owner.state === 'unreadable') throw owner.error;
  if (owner.state === 'missing') throw new RunNotFoundError(runId);
  return owner;
}

/**
 * A run born FROM another (fork, rollover, replay) belongs to the source's owner. Written FIRST — before
 * a single row is copied — so a crash half-way leaves a fork its owner can finish and nobody else can
 * take. A source that does not exist (or cannot be read) gives the new run nothing to inherit: refused.
 */
export async function inheritRunOwner(journal: RawJournal, srcRunId: string, dstRunId: string, fields: Record<string, unknown> = {}): Promise<Caller> {
  const src = await runOwnerOf(journal, srcRunId);
  if (src.state === 'unreadable') throw src.error;
  if (src.state === 'missing') throw new Error(`@gnldev/durable: run '${srcRunId}' does not exist — nothing to derive '${dstRunId}' from.`);
  return claimRunOwner(journal, dstRunId, src.owner, fields);
}

/**
 * The owner of a record that is NOT a run's `:input` (e.g. a cross-run idempotency window's owner
 * record): the same fields, no `_v` rule. A record with no owner fields — or none at all — was made
 * before owners were recorded, and is read as `unknown`'s: reachable by staff and by `unknown` only.
 */
export function fieldsOwner(rec: unknown): Caller {
  const r = (rec && typeof rec === 'object' ? rec : {}) as OwnerRecord;
  if (typeof r.resourceId === 'string' && r.resourceId !== '') return user(r.resourceId);
  return r.ownerKind === 'staff' ? STAFF : UNKNOWN;
}

/** How a refusal names an owner in its `detail` (never in the sentence — see RunOwnerMismatchError). */
export function ownerLabel(c: Caller): string {
  return c.kind === 'user' ? c.id : `(${c.kind})`;
}

/**
 * What a run was started FOR: an agent, a workflow, a network or a batch. `name` is absent when it is
 * not known — a nameless primitive (`runNetwork` records `network: ''`, `runDurable` without an
 * `agentName`) — and then only the kind is compared.
 */
export type RunTarget = { kind: 'agent' | 'workflow' | 'network' | 'batch'; name?: string };

/**
 * The target an owner record names, or `undefined` when it names none — a record written before
 * targets were recorded. Absence is not evidence: such a run is not refused to anyone. An agent's
 * record is its frozen request (`prompt`/`messages`), named by `agent` when the door knew the name.
 */
export function runTargetOf(rec: unknown): RunTarget | undefined {
  if (rec === null || typeof rec !== 'object') return undefined;
  const r = rec as Record<string, unknown>;
  for (const kind of ['workflow', 'network', 'batch'] as const) {
    const name = r[kind];
    if (typeof name === 'string') return { kind, ...(name !== '' ? { name } : {}) };
  }
  if (typeof r.agent === 'string' && r.agent !== '') return { kind: 'agent', name: r.agent };
  if (r.prompt !== undefined || r.messages !== undefined || r.system !== undefined) return { kind: 'agent' };
  return undefined;
}

/** Whether a run recorded for `recorded` may be driven as `requested`: same kind, and the same name when both are known. */
function sameTarget(recorded: RunTarget, requested: RunTarget): boolean {
  return recorded.kind === requested.kind && (recorded.name === undefined || requested.name === undefined || recorded.name === requested.name);
}

/**
 * THE rule "a runId belongs to the target that started it", for every run kind and every door.
 * `stranger` is the refusal for a caller who may not act on the run: a mismatched target is refused
 * to them as THAT, so the target is named only to someone who may act on the run.
 */
export function assertRunTarget(record: unknown, requested: RunTarget, runId: string, stranger?: Error): void {
  const recorded = runTargetOf(record);
  if (recorded === undefined || sameTarget(recorded, requested)) return;
  if (stranger) throw stranger;
  const label = (t: RunTarget) => (t.name !== undefined ? `${t.kind} '${t.name}'` : `a ${t.kind}`);
  throw new RunTargetMismatchError(
    `@gnldev/durable: runId "${runId}" was started for ${label(recorded)} and is now being run for ${label(requested)}. ` +
      `A runId belongs to one target: its journal holds that target's steps and result. Give each target its own runId.`,
    { runId, startedFor: recorded, requested },
  );
}

/**
 * THE refusal for a caller who may not act on a run: names nobody in the sentence (the owner is in
 * `detail`), and — only when the call named nobody at all — says how to name someone. A host resuming
 * a user's run from its own backend (an approval button) without a `caller` met this sentence and no
 * way through; measured on the support-desk example, whose approval never refunded.
 */
export function runOwnerRefusal(runId: string, recorded: Caller, requested: Caller): RunOwnerMismatchError {
  const hint = requested.kind === 'unknown'
    ? ' This call named nobody: pass `caller` — `STAFF` when your own backend acts as an operator (an approval, a resume), or the user it acts for.'
    : '';
  return new RunOwnerMismatchError(
    `@gnldev/durable: run '${runId}' belongs to a different subject. A run acts for the owner recorded at its start.${hint}`,
    { runId, owner: ownerLabel(recorded), requested: ownerLabel(requested) },
  );
}

/**
 * THE ENTRY of a run, for every kind: read the owner once, decide, and — for a run that does not exist
 * yet, when `birth` is given — record the owner at once (`claimRunOwner`). Returns who the run acts
 * for (`actingCaller`). Refuses with the store's own error when the owner cannot be read, and with
 * `RunOwnerMismatchError` when the caller may not act on the run; the refusal names nobody.
 *
 * An agent run passes no `birth`: its record is its frozen input, written later by `persistInput`
 * through the same `claimRunOwner`.
 */
export async function admitRun(
  journal: RawJournal,
  runId: string,
  caller: Caller,
  birth?: Record<string, unknown>,
): Promise<{ acting: Caller; owner: RunOwner }> {
  const owner = await runOwnerOf(journal, runId);
  if (owner.state === 'unreadable') throw owner.error;
  const refuse = (recorded: Caller) => runOwnerRefusal(runId, recorded, caller);
  const acting = actingCaller(owner, caller);
  if (!acting) throw refuse(owner.state === 'owned' ? owner.owner : UNKNOWN);
  const requested = runTargetOf(birth);
  if (requested && owner.state === 'owned') assertRunTarget(owner.record, requested, runId);
  if (owner.state === 'missing' && birth) {
    // Two births racing for one id: the claim has one winner, and the loser is held to it (claimRunOwner).
    const recorded = await claimRunOwner(journal, runId, acting, birth);
    const born: RunOwner = { state: 'owned', owner: recorded, kind: 'other', recorded: true };
    return { acting: actingCaller(born, caller)!, owner: born };
  }
  return { acting, owner };
}
