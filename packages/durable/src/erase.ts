/**
 * ONE erasure for a person: runs, threads, documents, and — through the erasers the background
 * packages hand in — queued jobs, triggers and events.
 *
 * THE SEAM. `@gnldev/durable` cannot import `@gnldev/queue`, `@gnldev/scheduler` or `@gnldev/events`
 * (they depend on it). Two things make one call possible anyway:
 *  - the owner is recorded in ONE shape wherever it is not a run record: in the NAME the engine writes
 *    (`ownedName`, `~o~<org>:<user>:<name>`), so every owned log record in the work store is found by
 *    its id prefix without knowing what a job or an event is (`deleteIdPrefix`, done here);
 *  - everything ELSE a package keeps about an owned record (markers, locks, trigger definitions) is
 *    keyed in that package's own format, so the package that writes it erases it: `jobEraser`,
 *    `triggerEraser`, `eventEraser`, passed in as `erasers`. A copy of those formats in this file had
 *    already drifted (it knew the trigger families but not the fire locks, nor any job marker).
 * Runs, threads and documents are erased by `purgeResource`, whose thread question is `threadOwnerOf`
 * — the same one the gate and the listing ask.
 *
 * IT TAKES THE STORAGE, NOT A LIST OF ITS STORES. It used to take `{ journal, work?, vectors?, memory? }`,
 * and a store left off the list was a store left untouched, with a report that read like success:
 * without `memory` a person's AgentMemory threads stayed (the queue README's own example did that),
 * and even with it their working memory (`res:<id>`) stayed. Every store the storage carries is now
 * erased from, or the erasure refuses. What lives OUTSIDE the storage — another package's records in
 * its own format, or a memory kept in some other database — comes in as an eraser.
 */
import { purgeResource, purgeThread } from './retention.js';
import { threadRecordOwner, assertRootOutsideOrganizations } from './storage.js';
import { ownedPrefix } from './owned-name.js';
import { threadOwnerOf, threadOwnerKey } from './thread-owner.js';
import { withOrg, isOrganizationKey, parseOrganizationKey, orgPrefix, ORG_KEY_PREFIX, ORG_RECORD_PRE } from './organization.js';
import { orgVectorDelete, orgStorageScopeOf, withOrgStorage } from './org-storage.js';
import { toJournal, isStorage, workingMemoryScope, legacyWorkingMemoryScope, MEMORY_PARTITION } from './storage.js';
import { memKey, MEM_LEAVES, OM_VECTOR_SOURCE, semanticLogKey } from './memory.js';
import type { Memory } from './memory.js';
import { runKeys } from './journal.js';
import type { Journal } from './journal.js';
import type { MemoryStore, Storage, WorkStore } from './storage.js';
import { refuseUnknownNames } from '@gnldev/options';
import { ERASE_SUBJECT_NAMES, RESERVED_ROOT_THREADS_NAMES, SUBJECT_RUNS_NAMES } from './option-names.js';
import { runsOfSubject, subjectIndexComplete, indexedIds } from './subject-index.js';

/** One package's share of a person's erasure (`jobEraser`, `triggerEraser`, `eventEraser`), or a store outside the storage. */
export interface SubjectEraser {
  name: string;
  erase(owner: { resourceId: string; orgId?: string }): Promise<number>;
}

export interface EraseOptions {
  /** The person's organization. Their runs, threads, working memory and documents in THAT organization go; the same id elsewhere is somebody else. */
  orgId?: string;
  /** The background packages' erasers — `jobEraser(storage)`, `triggerEraser(journal)`, `eventEraser(work)` — and any store the storage does not hold. */
  erasers?: SubjectEraser[];
  /**
   * The storage the agents' memory was built over, when it is not `storage` — `createGnl({ storage,
   * memory: memoryPreset(otherStorage) })`. Its threads, working memory, observational-memory records
   * and documents are erased by the same rules as `storage`'s: the ROOT storage again, with `orgId`
   * naming the organization. Nothing in `storage` says a memory lives elsewhere, so the erasure cannot
   * find it by itself; what it can see is a thread whose owner record names this person and whose
   * messages it found nowhere, and it lists those in `unreachedThreads`.
   */
  memory?: Storage;
}

export interface EraseReport {
  journalRows: number;
  /** Owned log records (jobs, events, their depth-index records) found by id prefix. */
  workRecords: number;
  /** Threads removed from a memory store, with their messages, observations and working memory. Only threads a store actually held. */
  memoryThreads: number;
  /** Working-memory records removed: the person's own (`workingMemoryScope.resource`, and the 0.6 key `res:<id>`). */
  workingMemory: number;
  /**
   * Threads this person owns (their owner record says so) whose messages were in no store this erasure
   * reached. Most often a memory kept in another storage: pass it as `memory`. Not empty means the
   * erasure did NOT reach everything, whatever the other counts say.
   *
   * Also lists, for an erasure outside organizations, this person's threads that 0.9 let the root
   * create under an `org:` id and that are not certainly the root's (`findReservedRootThreads`,
   * `rootOnly: false`): they may be an organization's, so they are not deleted here. The certain ones
   * are erased like any other thread. Decide each one, move it with `migrateReservedRootThreads`
   * (@gnldev/memory, naming it in `threadIds`), and erase again.
   */
  unreachedThreads: string[];
  /** What each eraser removed, by its name. */
  byEraser: Record<string, number>;
}

/**
 * Refuses an organization's view of the work store in an erasure. Owned jobs and events live in the
 * ROOT work log — their owner, organization included, is in their id — so the organization's view holds
 * none of them, and its `deleteIdPrefix` cannot be confined: the port deletes by id prefix in every
 * namespace. `eraseSubject`, `jobEraser` and `eventEraser` all ask this, so the three say one thing.
 */
export function assertRootWorkForErasure(work: WorkStore | undefined, who: string): void {
  const org = work ? orgStorageScopeOf(work) : undefined;
  if (org !== undefined) {
    throw new Error(
      `${who} was handed organization '${org}''s work store. A person's jobs and events live in the root work log, ` +
        "with their organization in their id, so this view holds none of them. Pass the root storage (its `work`), " +
        'and name the organization with `{ orgId }`.',
    );
  }
}

/** The memory store answering "whose thread", the one question `threadOwnerOf` asks a memory. */
const ownerAsker = (store: MemoryStore): Memory =>
  ({ getThreadResource: async (id: string) => threadRecordOwner(await store.getThread(id)) }) as unknown as Memory;

/** Does this store hold anything of the thread — its record, a message, or its working memory? */
async function holdsThread(store: MemoryStore, threadId: string): Promise<boolean> {
  if ((await store.getThread(threadId)) !== undefined) return true;
  if ((await store.getMessages(threadId, { limit: 1 })).items.length > 0) return true;
  const legacy = legacyWorkingMemoryScope.thread(threadId);
  return (await store.getWorkingMemory(workingMemoryScope.thread(threadId))) !== undefined
    || (legacy !== undefined && (await store.getWorkingMemory(legacy)) !== undefined);
}

/** Does the journal hold the thread's messages (a journal-kept memory, `BasicMemory`)? */
async function journalHoldsThread(runs: Journal, threadId: string): Promise<boolean> {
  for (const leaf of MEM_LEAVES) {
    let key: string;
    try { key = memKey(threadId, leaf); } catch { return false; }
    if ((await runs.get(key)) !== undefined) return true;
  }
  // SemanticMemory (@gnldev/rag) keeps the thread's messages in its own log; purgeThread erases it.
  return (await runs.get(semanticLogKey(threadId))) !== undefined;
}

/** Every thread the store lists for this person. Outside organizations, an organization's thread (`org:<id>:…`) is a namesake's. */
async function listedThreads(store: MemoryStore, resourceId: string, outsideOrganizations: boolean): Promise<string[]> {
  const out: string[] = [];
  let cursor: string | undefined;
  do {
    const page = await store.listThreads({ resourceId, limit: 500, ...(cursor !== undefined ? { cursor } : {}) });
    for (const t of page.items) if (!(outsideOrganizations && isOrganizationKey(t.id))) out.push(t.id);
    cursor = page.nextCursor;
  } while (cursor !== undefined);
  return out;
}

/** A thread in the ROOT store whose id is in the organizations' reserved space — see `findReservedRootThreads`. */
export interface ReservedRootThread {
  id: string;
  resourceId: string;
  /**
   * `true`: certainly the root's (`reservedThreadVerdict`) — no organization's view can produce this id
   * (`org:123`, `org::x`), or the root journal holds an owner record the root itself wrote. `false`:
   * shaped like an organization's thread (`org:acme:support`) and nothing says whose it is — it may be
   * that organization's own (0.9 registered no organization, a memory-only thread leaves no record, and
   * 0.9's gate BACKFILLED a root record from the store's resourceId even for a refused root request),
   * so it is not guessed; decide by hand and name it in `migrateReservedRootThreads`'s `threadIds`.
   */
  rootOnly: boolean;
}

/** Whose a reserved-space thread is, as far as the journal can tell. */
type ReservedVerdict = 'organization' | 'root' | 'undecided';

/**
 * THE question for a thread in the root store under an `org:` id: is it certainly the ROOT's? Asked by
 * `findReservedRootThreads` (so `migrateReservedRootThreads`) and by the root `eraseSubject` — one
 * answer, so the finder cannot list as the root's what the erasure would then delete, or the reverse.
 *
 *  1. An owner record the ORGANIZATION wrote (`org:<id>:thread:<t>:owner`) decides first: its own.
 *  2. A root record with `backfilled: true` is NOT evidence. The gate wrote it by copying the store's
 *     `resourceId` — the organization's own user, for an organization's thread — and 0.9 wrote it even
 *     for a root request it then refused (measured on the 0.9.0 fixture: the default migration moved
 *     acme's `t-run` to `legacy-org:acme:t-run`, acme read nothing, and the root user read its secret).
 *  3. Certainly the root's: an id no organization's view can produce (`org:123`, `org::x`), or a root
 *     owner record the root wrote itself (its first run on a thread that did not exist yet).
 *  4. Anything else: undecided. Never guessed in either direction.
 */
async function reservedThreadVerdict(runs: Journal, threadId: string): Promise<ReservedVerdict> {
  const shaped = parseOrganizationKey(threadId);
  if (shaped === undefined) return 'root';
  if ((await runs.get(orgPrefix(shaped.orgId) + threadOwnerKey(shaped.rest))) !== undefined) return 'organization';
  const rec = await runs.get<{ backfilled?: unknown } | null>(threadOwnerKey(threadId));
  if (rec !== undefined && rec !== null && rec.backfilled !== true) return 'root';
  return 'undecided';
}

/** The reserved-space threads one memory store holds that are not an organization's, by `reservedThreadVerdict` over `runs`. */
async function reservedThreadsIn(store: MemoryStore, runs: Journal, resourceId?: string): Promise<ReservedRootThread[]> {
  const out: ReservedRootThread[] = [];
  let cursor: string | undefined;
  do {
    // The whole reserved space: a code-only partition no organization's view uses.
    const page = await store.listThreads({
      ...(resourceId !== undefined ? { resourceId } : {}),
      limit: 500, ...(cursor !== undefined ? { cursor } : {}), [MEMORY_PARTITION]: ORG_KEY_PREFIX,
    });
    for (const t of page.items) {
      if (!isOrganizationKey(t.id)) continue; // a store that ignores the partition lists the root's too
      if (resourceId !== undefined && t.resourceId !== resourceId) continue; // …or ignores the filter
      const verdict = await reservedThreadVerdict(runs, t.id);
      if (verdict !== 'organization') out.push({ id: t.id, resourceId: t.resourceId, rootOnly: verdict === 'root' });
    }
    cursor = page.nextCursor;
  } while (cursor !== undefined);
  return out.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
}

/**
 * Threads 0.9 let the ROOT scope create under an id in the organizations' reserved space (`org:…`).
 *
 * 0.9's root `AgentMemory` accepted any thread id. Now the root scope cannot name an `org:` id
 * (`ReservedThreadIdError`) and its scans skip them, so such a thread is unreachable from the root —
 * and one shaped like an organization's (`org:acme:support`) is READ by that organization, whose view
 * resolves `support` to the same physical id. `migrateReservedRootThreads` (@gnldev/memory) moves them
 * to a free id; the root `eraseSubject` erases the person's certain ones and lists the undecided ones.
 *
 * Whose each one is: `reservedThreadVerdict` — an organization's owner record excludes it; only an id no
 * organization can produce, or a root owner record the root wrote itself (not a backfilled one), makes
 * it `rootOnly`; anything else is listed as undecided, never guessed.
 */
export async function findReservedRootThreads(storage: Storage, opts: { resourceId?: string } = {}): Promise<ReservedRootThread[]> {
  refuseUnknownNames('findReservedRootThreads', opts, RESERVED_ROOT_THREADS_NAMES);
  if (orgStorageScopeOf(storage) !== undefined) {
    throw new Error('@gnldev/durable: findReservedRootThreads takes the root storage — an organization\'s view has no root threads');
  }
  if (!storage.memory) return [];
  return reservedThreadsIn(storage.memory, toJournal(storage.runs), opts.resourceId);
}

/** A storage handed in as `memory`: the root one, with a memory store; `storage` itself counts once. */
function memoryHome(storage: Storage, memory: Storage | undefined): Storage | undefined {
  if (memory === undefined || memory === storage) return undefined;
  if (!isStorage(memory) || !memory.memory) {
    throw new TypeError('@gnldev/durable: eraseSubject\'s `memory` is the storage your memory was built over (`eraseSubject(storage, id, { memory: otherStorage })`), and it needs a memory store');
  }
  const scoped = orgStorageScopeOf(memory);
  if (scoped !== undefined) {
    throw new Error(
      `@gnldev/durable: eraseSubject's \`memory\` is organization '${scoped}''s storage. Pass the root storage the memory ` +
        'was built over, and name the organization with `{ orgId }`.',
    );
  }
  return memory;
}

/** One of a person's runs, as `subjectRuns` sees it. */
export interface SubjectRun {
  runId: string;
  threadId?: string;
  /**
   * The run may still write: its outcome is the write-ahead `running` (a run's own LAST write turns it
   * terminal), or a model step or tool call of it is claimed `running` right now (the step a canceled
   * run is still inside). A run whose worker died stays `running` until someone purges or cancels it.
   */
  inFlight: boolean;
}

/** Is any model-step or tool claim of this run `running` at this moment? */
async function hasRunningClaim(runs: Journal, runId: string): Promise<boolean> {
  if (typeof runs.listKeys !== 'function') return false;
  for (const k of await runs.listKeys(`${runId}:`)) {
    if (!k.includes(':proc:') && !k.includes(':tool:')) continue;
    const v = await runs.get<{ status?: unknown }>(k);
    if (v && typeof v === 'object' && v.status === 'running') return true;
  }
  return false;
}

/**
 * A person's runs in a storage, and which of them may still write — what an erasure must wait for.
 *
 * `eraseSubject` deletes what is there when it runs. A turn in flight at that moment writes its answer,
 * the thread's messages and its outcome AFTER the erasure, under ids the erasure just took the owner
 * records of (measured: `DELETE /users/:id` in Studio during a running turn answered `complete: true`,
 * and the turn's secret sat in `mem:<thread>:messages` afterwards, owned by nobody). Revoke the person
 * first, so no new turn starts; ask this until nothing is `inFlight`, cancelling what should not finish
 * (`cancelAgentRun`), then erase — and ask again afterwards: a run listed then was started by a request
 * that had authenticated before the revoke. Same scope rules as `eraseSubject`.
 */
export async function subjectRuns(storage: Storage, resourceId: string, opts: { orgId?: string } = {}): Promise<SubjectRun[]> {
  refuseUnknownNames('subjectRuns', opts, SUBJECT_RUNS_NAMES);
  if (typeof resourceId !== 'string' || resourceId === '') throw new TypeError('@gnldev/durable: subjectRuns needs the id of the person');
  if (orgStorageScopeOf(storage) !== undefined) {
    throw new Error('@gnldev/durable: subjectRuns takes the root storage; name the organization with `{ orgId }`, as for eraseSubject');
  }
  const journal = toJournal(storage.runs);
  const outside = opts.orgId === undefined;
  const runs = outside ? journal : withOrg(journal, opts.orgId!);
  if (typeof (runs as unknown as { listRunsPaged?: unknown }).listRunsPaged !== 'function') throw new Error('@gnldev/durable: subjectRuns needs a journal that lists runs by owner (listRunsPaged)');
  const out: SubjectRun[] = [];
  // From the person's index once the scope's is complete, by walking every run before (subject-index.ts).
  for (const r of await runsOfSubject(runs, resourceId)) {
    if (outside && isOrganizationKey(r.runId)) continue;
    const outcome = await runs.get<{ status?: unknown }>(runKeys.outcome(r.runId));
    const inFlight = outcome?.status === 'running' || (await hasRunningClaim(runs, r.runId));
    out.push({ runId: r.runId, ...(r.threadId ? { threadId: r.threadId } : {}), inFlight });
  }
  return out;
}

/**
 * Erase one person from a storage: runs, threads (journal- and memory-store-kept, with their
 * observational-memory records and vectors), working memory (0.7 and 0.6 keys), documents, and owned
 * jobs and events; plus what the erasers hand in, and a memory kept in another storage (`memory`).
 * `storage` is the ROOT storage; `orgId` names the person's organization.
 *
 * The report counts what was deleted, never what was looked for: a thread whose owner record names
 * this person but that no store held is not counted — it is listed in `unreachedThreads`.
 *
 * Refuses, before deleting anything, a storage whose journal cannot `deletePrefix`, whose work store
 * cannot `deleteIdPrefix`, or whose vector store cannot delete (or, without an organization, cannot
 * confine the delete to documents outside organizations) — and the same of the `memory` storage.
 */
export async function eraseSubject(storage: Storage, resourceId: string, opts: EraseOptions = {}): Promise<EraseReport> {
  refuseUnknownNames('eraseSubject', opts, ERASE_SUBJECT_NAMES);
  if (typeof resourceId !== 'string' || resourceId === '') throw new TypeError('@gnldev/durable: eraseSubject needs the id of the person to erase');
  if (!isStorage(storage)) {
    throw new TypeError('@gnldev/durable: eraseSubject takes the storage itself (`eraseSubject(storage, id, { orgId, erasers })`), so no store it holds is left out');
  }
  const scoped = orgStorageScopeOf(storage);
  if (scoped !== undefined) {
    throw new Error(
      `@gnldev/durable: eraseSubject was handed organization '${scoped}''s storage. Jobs and events live in the root work log, ` +
        'so this view cannot reach them. Pass the root storage and name the organization with `{ orgId }`.',
    );
  }
  // NOT A SNAPSHOT: a run of this person in flight while this runs writes after it returns. See
  // `subjectRuns` for the order that closes that (revoke, wait or cancel, erase, check again).
  const home = memoryHome(storage, opts.memory);
  const journal = toJournal(storage.runs);
  if (typeof journal.deletePrefix !== 'function') throw new Error('@gnldev/durable: eraseSubject needs a journal that can deletePrefix');
  const homeJournal = home ? toJournal(home.runs) : undefined;
  if (homeJournal && typeof homeJournal.deletePrefix !== 'function') throw new Error('@gnldev/durable: eraseSubject\'s `memory` storage needs a journal that can deletePrefix');
  const work = storage.work;
  if (work && typeof work.deleteIdPrefix !== 'function') {
    throw new Error('@gnldev/durable: eraseSubject was given a work store that cannot delete by id prefix, so this person\'s jobs and events cannot be erased');
  }
  const outside = opts.orgId === undefined;
  // The memory storage's documents are erased too (observational-memory vectors live there when
  // `omVectors.store` is its vector store) — unless they are the same store.
  const homeVectors = home?.vectors && home.vectors !== storage.vectors ? home.vectors : undefined;
  for (const [v, what] of [[storage.vectors, 'vector store'], [homeVectors, '`memory` storage\'s vector store']] as const) {
    if (!v) continue;
    if (typeof v.delete !== 'function') {
      throw new Error(`@gnldev/durable: eraseSubject was given a ${what} that cannot delete, so this person's documents cannot be erased`);
    }
    // Without an organization, the documents half says "outside every organization" — asked here,
    // before anything goes, so a store that cannot honour it leaves this person entirely in place.
    if (outside) assertRootOutsideOrganizations(v, '@gnldev/durable: eraseSubject');
  }
  // A person in an organization: their runs, threads and working memory live in that organization's
  // partition, and the same id in another organization is somebody else.
  const runs = outside ? journal : withOrg(journal, opts.orgId!);
  const view = (s: Storage): Storage => (outside ? s : withOrgStorage(s, opts.orgId!));
  // …and their documents in that organization's namespace, the one withOrgStorage writes them under.
  const docs = (v: Storage['vectors']) => v && (outside ? v : orgVectorDelete(v, opts.orgId!));
  const vectors = docs(storage.vectors);
  // Every memory store this erasure reaches, each with the journal its memory keeps observational
  // memory in: `storage`'s own, and the `memory` storage's.
  const stores: Array<{ store: MemoryStore; runs: Journal }> = [];
  if (storage.memory) stores.push({ store: view(storage).memory!, runs });
  if (home) stores.push({ store: view(home).memory!, runs: outside ? homeJournal! : withOrg(homeJournal!, opts.orgId!) });
  const asker = stores[0] ? ownerAsker(stores[0].store) : undefined;

  // Threads first, while the owner records still exist: the ones this person owns, by the ONE question.
  // From the person's index once the scope's is complete; before, every thread's owner record. Each is
  // checked below with threadOwnerOf either way: the index names candidates, the record decides.
  const ownedByRecord = new Set<string>();
  if (await subjectIndexComplete(runs)) for (const t of await indexedIds(runs, 'thread', resourceId)) ownedByRecord.add(t);
  else for (const k of (await runs.listKeys?.('thread:')) ?? []) if (k.endsWith(':owner')) ownedByRecord.add(k.slice('thread:'.length, -':owner'.length));
  // Outside organizations, a thread under an `org:` id is the root's to erase only when it is CERTAINLY
  // the root's (`reservedThreadVerdict`); an organization's goes with that organization's erasure, and
  // an undecided one is reported, not deleted. Asked before `threadOwnerOf`, which would backfill.
  const verdicts = new Map<string, ReservedVerdict>();
  const verdictOf = async (t: string) => {
    let v = verdicts.get(t);
    if (v === undefined) verdicts.set(t, (v = await reservedThreadVerdict(runs, t)));
    return v;
  };
  const reserved: ReservedRootThread[] = [];
  const deleted: Array<{ thread: string; runs: Journal }> = [];
  const reached = new Set<string>();
  let workingMemory = 0;
  for (const { store, runs: memRuns } of stores) {
    // This person's threads in the reserved space of this store; the certain ones are erased here.
    const mine = outside ? await reservedThreadsIn(store, runs, resourceId) : [];
    reserved.push(...mine);
    const candidates = new Set<string>([
      ...(await listedThreads(store, resourceId, outside)), ...ownedByRecord, ...mine.filter((t) => t.rootOnly).map((t) => t.id),
    ]);
    for (const t of candidates) {
      if (outside && isOrganizationKey(t) && (await verdictOf(t)) !== 'root') continue;
      if ((await threadOwnerOf(runs, ownerAsker(store), t)).owner !== resourceId) continue;
      // Counted only when the store held it: a thread found by its owner record may live elsewhere.
      if (!(await holdsThread(store, t))) continue;
      await store.deleteThread(t);
      deleted.push({ thread: t, runs: memRuns });
      reached.add(t);
    }
    for (const key of [workingMemoryScope.resource(resourceId), legacyWorkingMemoryScope.resource(resourceId)]) {
      if (await store.deleteWorkingMemory(key)) workingMemory++;
    }
  }
  // Threads the record gives this person and no memory store held: kept in the journal (BasicMemory),
  // or somewhere this erasure was not shown. Asked before `purgeResource` removes the owner records.
  const unreachedThreads: string[] = [];
  const journalKept: string[] = [];
  for (const t of ownedByRecord) {
    if (reached.has(t)) continue;
    if (outside && isOrganizationKey(t)) {
      const v = await verdictOf(t);
      if (v === 'organization') continue; // the organization's: its own erasure (`{ orgId }`) reaches it
      if (v === 'undecided') {
        // The record does not say whose it is; it is neither deleted nor guessed — named, when it names this person.
        if ((await runs.get<{ resourceId?: string }>(threadOwnerKey(t)))?.resourceId === resourceId) unreachedThreads.push(t);
        continue;
      }
    }
    if ((await threadOwnerOf(runs, asker, t)).owner !== resourceId) continue;
    // A journal-kept thread (BasicMemory, SemanticMemory) is erased here, by its owner record: it used
    // to be reached only through a run of this person, so a thread with none kept every message and
    // the report named nothing.
    if (await journalHoldsThread(runs, t)) journalKept.push(t);
    else unreachedThreads.push(t);
  }
  // Threads 0.9 let the root create under an `org:` id: the certain ones were erased above; every other
  // one of the person's in that space is reported — undecided, so this erasure did not take it (if it is
  // an organization's, that organization's erasure, `{ orgId }`, does) — with the way through
  // (`findReservedRootThreads` / `migrateReservedRootThreads` with `threadIds`, then erase again).
  for (const t of reserved) if (!reached.has(t.id)) unreachedThreads.push(t.id);
  let journalRows = await purgeResource(runs, resourceId, {
    ...(vectors ? { vectors } : {}),
    ...(asker ? { memory: asker } : {}),
    ...(outside ? { outsideOrganizations: true } : {}),
  });
  if (homeVectors) journalRows += await docs(homeVectors)!.delete!({ owner: resourceId, ...(outside ? { outsideOrganizations: true } : {}) });
  // A memory-store thread's journal side (observational memory, dedup window, owner record) — reached
  // here too, for a thread with no run left to lead `purgeResource` to it; and in the `memory`
  // storage's journal, where that memory kept its observational-memory records.
  for (const t of journalKept) journalRows += await purgeThread(runs, t);
  for (const { thread, runs: memRuns } of deleted) {
    journalRows += await purgeThread(runs, thread);
    if (memRuns !== runs) journalRows += await purgeThread(memRuns, thread);
    // …and its observational-memory vectors, by thread: one indexed while the thread was anonymous
    // has no owner label, and the owner delete above does not see it.
    const ofThread = { filter: { source: OM_VECTOR_SOURCE, threadId: thread }, ...(outside ? { outsideOrganizations: true } : {}) };
    for (const v of [vectors, homeVectors && docs(homeVectors)]) if (v) journalRows += await v.delete!(ofThread);
  }
  const owner = { resourceId, ...(opts.orgId !== undefined ? { orgId: opts.orgId } : {}) };
  const workRecords = work ? await work.deleteIdPrefix!(ownedPrefix(owner)) : 0;
  const byEraser: Record<string, number> = {};
  for (const e of opts.erasers ?? []) byEraser[e.name] = (byEraser[e.name] ?? 0) + (await e.erase(owner));
  return { journalRows, workRecords, memoryThreads: deleted.length, workingMemory, unreachedThreads: [...new Set(unreachedThreads)].sort(), byEraser };
}
