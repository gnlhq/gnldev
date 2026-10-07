/**
 * Who owns a thread — asked in ONE place, answered from a RECORD.
 *
 * A thread's owner used to be re-derived at every door: from the memory when it could name one
 * (`getThreadResource`), otherwise from whichever runs on the thread were still in the journal. Seven
 * call sites asked seven slightly different ways, and the derivation was not an owner, it was a
 * guess that moved:
 *  - the engine's own gate asked only a memory that could answer, so with `BasicMemory` a second
 *    user's run on the first user's thread went through, and the model was handed her history
 *    (the standalone chat and AG-UI routes rely on exactly that gate);
 *  - once a retention sweep removed the owner's runs, the thread had "no runs", read as "new", and
 *    the next caller became its owner — with the old messages still in it;
 *  - one foreign run on the thread made the derivation ambiguous, locking the owner out, and her
 *    messages were then deleted with the other person's account.
 *
 * So the first run on a thread writes `thread:<threadId>:owner`, first write wins, and the owner does
 * not move after that. It sits under the `thread:` root (reserved: no run id may start with it), next
 * to the thread's taint records, inside the organization prefix like every other thread key.
 *
 * A thread written before this record existed is still read the old way, and one step more strictly:
 * in a memory that cannot name owners, a thread with messages and no owner anywhere is NOT new. It
 * exists and nobody owns it — staff's.
 *
 * And it STAYS staff's (0.7.0 release panel D-3): a thread with history whose owner cannot be derived —
 * messages with no runs left, runs that name two users, runs that name nobody — used to go to the first
 * named user who ran on it, history included. Its verdict is now written as a staff record the first
 * time it is read, so no claim moves it; an operator gives it to a user with `assignThreadOwner`. The
 * one exception is kept on purpose: a thread whose only runs were born `unknown` under a versioned
 * record (an anonymous first turn in this release) is still claimed by the first named user (R11).
 */
import { claim, runKeys, listRunsArray } from './journal.js';
import type { Journal, JournalReader, RunSummary } from './journal.js';
import type { Memory } from './memory.js';
import { ThreadOwnerMismatchError } from './errors.js';
import type { Caller } from './identity-types.js';
import { recordOwner } from './run-identity.js';

export const threadOwnerKey = (threadId: string): string => `thread:${threadId}:owner`;

/**
 * An anonymous thread's mark: the thread exists, and an `unknown` caller of this release opened it.
 * Kept apart from the owner record so the record is still written once, by `claim` alone — the first
 * named user claims an anonymous thread exactly as she would claim a new one, and a race between two
 * of them is the same first-write-wins race, with no compare-and-set a journal may not have.
 */
export const threadSeenKey = (threadId: string): string => `thread:${threadId}:seen`;

/**
 * Written once a scope's every thread has its record or mark: by `storage.upgrade()`, or by the
 * gate itself when it first meets a scope with no runs at all. From then on a thread with neither is
 * new, and the gate never reads the scope's runs to find out.
 */
export const THREAD_RECORDS_KEY = 'thread:records:v1';

export interface ThreadOwnership {
  /** Whether the thread exists at all. A thread that does not exist yet is the first caller's to open. */
  exists: boolean;
  /** Its owner. */
  owner?: string;
  /**
   * An existing thread with no owner: `true` when staff CLAIMED it (a record says so — nobody else
   * may join), `false` when it only has anonymous history (the first named user claims it).
   */
  staffClaimed?: boolean;
}

type ThreadOwnerRecord = { resourceId?: string; ownerKind?: 'staff' | 'unknown'; at?: number; backfilled?: boolean; underivable?: boolean };

/**
 * The one answer to "whose thread is this" — for the gate, the listing, the reading and the
 * erasure alike. Read errors propagate: not knowing is not permission.
 *
 * The RECORD wins, with one exception: a record that names NOBODY — a legacy `{ at }` record, or one an
 * `unknown` caller left — never overrides a memory that names the owner; the record is upgraded to that
 * owner. (Written in 2a569018 for an anonymous first turn, such a record pinned the thread ownerless
 * and locked out the user the memory knew.) A record staff claimed stays staff's. A legacy thread's
 * derived owner is WRITTEN to the record the first time it is read, so a later runs sweep cannot move it.
 */
export async function threadOwnerOf(journal: Journal, memory: Memory | undefined, threadId: string): Promise<ThreadOwnership> {
  const key = threadOwnerKey(threadId);
  const rec = await journal.get<ThreadOwnerRecord>(key);
  if (rec !== undefined) {
    if (rec.resourceId) return { exists: true, owner: rec.resourceId };
    if (rec.ownerKind !== 'staff' && memory?.getThreadResource) {
      const owner = await memory.getThreadResource(threadId);
      if (owner) {
        await journal.put(key, { ...rec, resourceId: owner, upgradedAt: Date.now() });
        return { exists: true, owner };
      }
    }
    return { exists: true, staffClaimed: rec.ownerKind !== 'unknown' };
  }
  if (memory?.getThreadResource) {
    const owner = await memory.getThreadResource(threadId);
    if (owner) return settle(journal, threadId, { derived: owner });
  }
  if ((await journal.get(threadSeenKey(threadId))) !== undefined) return { exists: true, staffClaimed: false };
  // Older threads, from before the record and the mark: the runs, then the messages. Read only while the
  // scope still holds such threads — never once it is marked complete.
  let exists = false;
  let derived: string | undefined;
  let anonymous = false;
  if ((await journal.get(THREAD_RECORDS_KEY)) === undefined) {
    const { runs, scopeEmpty } = await runsOnThread(journal, threadId);
    if (scopeEmpty) await claim(journal, THREAD_RECORDS_KEY, { at: Date.now(), firstContact: true });
    if (runs.length) {
      exists = true;
      ({ derived, anonymous } = await verdictOfRuns(journal, runs));
    }
  }
  // Messages with no owner anywhere: the thread exists and is nobody's. Asked only of a memory that
  // cannot name owners — one that can is the authority on its own threads.
  if (!exists && memory && !memory.getThreadResource && ((await memory.getMessages(threadId)) ?? []).length > 0) exists = true;
  if (!exists) return { exists: false };
  return settle(journal, threadId, { derived, anonymous });
}

/** What a thread's runs say about its owner: one user's, or anonymous history of this release, or neither. */
async function verdictOfRuns(journal: Journal, runs: RunSummary[]): Promise<{ derived?: string; anonymous: boolean }> {
  const owners = new Set(runs.map((r) => r.resourceId));
  if (owners.size === 1 && [...owners][0]) return { derived: [...owners][0]!, anonymous: false };
  return { anonymous: owners.size === 1 && (await allBornUnknown(journal, runs)) };
}

/**
 * LAZY BACKFILL, first write wins: the derived owner — or, when none can be derived, staff (closed to
 * end users until an operator assigns it) — becomes the record, so a later sweep or claim cannot move
 * it. Anonymous history of this release gets its mark instead: the first named user claims it.
 */
async function settle(journal: Journal, threadId: string, v: { derived?: string; anonymous?: boolean }): Promise<ThreadOwnership> {
  if (!v.derived && v.anonymous) {
    await claim(journal, threadSeenKey(threadId), { at: Date.now(), ownerKind: 'unknown', backfilled: true });
    return { exists: true, staffClaimed: false };
  }
  const key = threadOwnerKey(threadId);
  await claim(journal, key, v.derived
    ? { at: Date.now(), resourceId: v.derived, backfilled: true }
    : { at: Date.now(), ownerKind: 'staff', backfilled: true, underivable: true });
  const now = await journal.get<ThreadOwnerRecord>(key);
  return { exists: true, ...(now?.resourceId ? { owner: now.resourceId } : { staffClaimed: now?.ownerKind !== 'unknown' }) };
}

/** Whether a scope's every thread has its record or mark (`THREAD_RECORDS_KEY`), so its gate never reads runs. */
export async function threadRecordsComplete(journal: Journal): Promise<boolean> {
  return (await journal.get(THREAD_RECORDS_KEY)) !== undefined;
}

/** Runs read per page by `writeThreadRecords`. */
const RECORD_PAGE = 1000;
/** Threads `writeThreadRecords` settles at once. */
const RECORD_WRITERS = 16;

/**
 * What one thread's runs said so far, kept per THREAD rather than per run — so the pass holds one small
 * entry for each thread, never every run (holding every run summary took 1.4 GB at 1 000 000 runs). It
 * is `verdictOfRuns` folded over the runs as they arrive: the same answer, in pieces.
 */
interface ThreadTally { owner: string | undefined; mixed: boolean; allBornUnknown: boolean }

/**
 * Gives every thread in the scope its record or mark, from its runs — the derivation `threadOwnerOf`
 * does lazily, thread by thread — then marks the scope complete, so no gate reads the runs again.
 * Reads the runs one page at a time. A thread's verdict needs ALL its runs and they arrive in creation
 * order, not by thread, so a pass interrupted part-way starts again from the first page: every write
 * here is first-write-wins, so running it again changes nothing that was already written.
 * @internal — `storage.upgrade({ only: ['thread-records'] })` runs it.
 */
export async function writeThreadRecords(journal: Journal, memory?: Memory): Promise<{ threads: number; recorded: number; marked: number }> {
  const tally = new Map<string, ThreadTally>();
  for await (const page of runPages(journal)) {
    for (const r of page) {
      if (!r.threadId) continue;
      // Born `unknown` under a versioned record: read only for a run that names nobody (allBornUnknown).
      const unknownBorn = r.resourceId ? false : recordOwner(await journal.get(runKeys.input(r.runId)))?.kind === 'unknown';
      const t = tally.get(r.threadId);
      if (!t) { tally.set(r.threadId, { owner: r.resourceId, mixed: false, allBornUnknown: unknownBorn }); continue; }
      if (t.owner !== r.resourceId) t.mixed = true;
      t.allBornUnknown &&= unknownBorn;
    }
  }
  let recorded = 0;
  let marked = 0;
  const one = async (threadId: string, t: ThreadTally) => {
    if ((await journal.get(threadOwnerKey(threadId))) !== undefined || (await journal.get(threadSeenKey(threadId))) !== undefined) return;
    const fromMemory = memory?.getThreadResource ? await memory.getThreadResource(threadId) : undefined;
    const v = fromMemory ? { derived: fromMemory, anonymous: false }
      : t.mixed ? { anonymous: false }
      : t.owner ? { derived: t.owner, anonymous: false }
      : { anonymous: t.allBornUnknown };
    await settle(journal, threadId, v);
    if (!v.derived && v.anonymous) marked++; else recorded++;
  };
  // Threads are independent and every write is first-write-wins, so a few go at once: one after another,
  // 199 543 threads on Postgres took 269 s, nearly all of it waiting on round trips.
  const queue = [...tally];
  await Promise.all(Array.from({ length: RECORD_WRITERS }, async () => {
    for (let next = queue.pop(); next; next = queue.pop()) await one(next[0], next[1]);
  }));
  await journal.put(THREAD_RECORDS_KEY, { at: Date.now(), upgraded: true });
  return { threads: tally.size, recorded, marked };
}

/** A journal's runs, a page at a time, through whichever listing it has. */
async function* runPages(journal: Journal): AsyncGenerator<RunSummary[]> {
  const j = journal as Partial<JournalReader> & { listRuns?: (q?: { cursor?: string; limit?: number }) => Promise<unknown> };
  if (typeof j.listRunsPaged === 'function') {
    let cursor: string | undefined;
    do {
      const p = await j.listRunsPaged.call(journal, { limit: RECORD_PAGE, ...(cursor ? { cursor } : {}) });
      yield p.items;
      cursor = p.nextCursor;
    } while (cursor);
    return;
  }
  if (typeof j.listRuns !== 'function') return;
  let page: unknown = await j.listRuns.call(journal, { limit: RECORD_PAGE });
  for (;;) {
    if (Array.isArray(page)) { yield page as RunSummary[]; return; } // an array reader hands every run at once
    const p = page as { items: RunSummary[]; nextCursor?: string };
    yield p.items;
    if (!p.nextCursor) return;
    page = await j.listRuns.call(journal, { cursor: p.nextCursor, limit: RECORD_PAGE });
  }
}

/**
 * Whether every run on the thread was born `unknown` under a VERSIONED owner record — an anonymous
 * caller of this release, whose thread the first named user may claim. An unversioned record (0.6) or
 * one that cannot be read is not that evidence: its thread stays closed.
 */
async function allBornUnknown(journal: Journal, runs: RunSummary[]): Promise<boolean> {
  for (const r of runs) {
    if (recordOwner(await journal.get(runKeys.input(r.runId)))?.kind !== 'unknown') return false;
  }
  return true;
}

/**
 * A memory created a thread for `resourceId` with no run: its owner record, first write wins — the
 * record the gate would otherwise backfill from the same `resourceId` on the thread's first run.
 * An organization's memory view (`withOrgStorage(...).memory.upsertThread`, the one path every writer of
 * an organization's thread takes) writes it, through that organization's journal view
 * (`org:<id>:thread:<t>:owner`): that record is what tells an organization's thread apart
 * from one 0.9 let the root create under the same physical id (`findReservedRootThreads` in
 * erase.ts). Without it a thread made by a memory alone is undecided there, every time.
 */
export async function recordThreadCreated(journal: Journal, threadId: string, resourceId: string): Promise<void> {
  if (typeof resourceId !== 'string' || resourceId === '') return; // names nobody: nothing to record
  await claim(journal, threadOwnerKey(threadId), { at: Date.now(), resourceId, created: true });
}

/**
 * An OPERATOR's answer to "whose thread is this": writes the owner record, replacing whatever it said.
 * The one way a closed thread (history, no derivable owner — see `threadOwnerOf`) reaches a user again.
 * Staff-only by nature: call it from an operator path, never with an id an end user supplied.
 */
export async function assignThreadOwner(journal: Journal, threadId: string, resourceId: string): Promise<void> {
  if (typeof resourceId !== 'string' || resourceId === '') throw new TypeError('@gnldev/durable: assignThreadOwner needs a user id.');
  await journal.put(threadOwnerKey(threadId), { at: Date.now(), resourceId, assigned: true });
}

/**
 * Every run on a thread. Two shapes reach here: a Journal's `listRuns` answers an array; a storage
 * `RunJournal`'s answers one page, so it is walked to the end — a thread's runs past the first page
 * are exactly the ones a partial read would miss.
 */
async function runsOnThread(journal: Journal, threadId: string): Promise<{ runs: RunSummary[]; scopeEmpty: boolean }> {
  const list = (journal as Partial<JournalReader> & { listRuns?: (q?: { cursor?: string; limit?: number }) => Promise<unknown> }).listRuns;
  if (typeof list !== 'function') return { runs: [], scopeEmpty: false };
  const first = await list.call(journal);
  if (Array.isArray(first)) return { runs: (first as RunSummary[]).filter((r) => r.threadId === threadId), scopeEmpty: first.length === 0 };
  const out: RunSummary[] = [];
  let page = first as { items: RunSummary[]; nextCursor?: string };
  const scopeEmpty = page.items.length === 0 && !page.nextCursor;
  for (;;) {
    out.push(...page.items.filter((r) => r.threadId === threadId));
    if (!page.nextCursor) return { runs: out, scopeEmpty };
    page = (await list.call(journal, { cursor: page.nextCursor })) as typeof page;
  }
}

/**
 * The engine's thread gate, for every door that starts a run on a thread. Returns the thread's
 * ownership after the gate (the run adopts a thread owner from THIS answer, not from memory).
 *
 *  - no thread yet: a user claims it; staff claims it ownerless; `unknown` claims nothing (an
 *    anonymous first turn does not pin the thread ownerless forever);
 *  - owned: only that user, or staff; `unknown` is refused (closed);
 *  - staff-claimed: staff only;
 *  - anonymous history of this release, no record: the first named user claims it; staff and unknown
 *    pass. History whose owner cannot be derived is staff-claimed (threadOwnerOf) and closed.
 */
export async function admitThreadRun(journal: Journal, memory: Memory | undefined, threadId: string, caller: Caller): Promise<ThreadOwnership> {
  let o = await threadOwnerOf(journal, memory, threadId);
  const claimFor = async (fields: ThreadOwnerRecord) => {
    await claim(journal, threadOwnerKey(threadId), { at: Date.now(), ...fields });
    const rec = await journal.get<ThreadOwnerRecord>(threadOwnerKey(threadId));
    return rec?.resourceId ? { exists: true, owner: rec.resourceId } : { exists: true, staffClaimed: rec?.ownerKind !== 'unknown' };
  };
  if (!o.exists || (o.owner === undefined && o.staffClaimed === false)) {
    if (caller.kind === 'user') o = await claimFor({ resourceId: caller.id });
    else if (caller.kind === 'staff' && !o.exists) o = await claimFor({ ownerKind: 'staff' });
    // Staff joining anonymous history: the history no longer names nobody, so the thread closes —
    // the verdict the runs gave before the mark existed (no derivable owner → staff's, D-3).
    else if (caller.kind === 'staff') o = await claimFor({ ownerKind: 'staff', backfilled: true, underivable: true });
    else {
      // An anonymous first turn claims nothing, but the thread now exists: its mark says so, so the
      // next caller is answered from it rather than from the scope's runs.
      if (caller.kind === 'unknown' && !o.exists) await claim(journal, threadSeenKey(threadId), { at: Date.now(), ownerKind: 'unknown' });
      return o;
    }
  }
  const refuse = (requested: string) => {
    throw new ThreadOwnerMismatchError(
      `@gnldev/durable: thread "${threadId}" belongs to ${o.owner ? 'a different resourceId' : 'staff'} — this run names "${requested}".`,
      { threadId, owner: o.owner ?? '(staff)', requested },
    );
  };
  if (caller.kind === 'staff') return o;
  if (caller.kind === 'unknown') return o.owner || o.staffClaimed ? refuse('(unknown)') : o;
  if (o.owner ? o.owner !== caller.id : o.staffClaimed) refuse(caller.id);
  return o;
}
