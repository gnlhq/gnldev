// What a person owns, by person: one key per run and per thread they own, under their own prefix.
//
// Ownership is written INSIDE records — a run's `:input`, a thread's `thread:<t>:owner` — so the one
// question an erasure asks, "what is this person's", had no key to read: it walked every run (5 067
// queries for one person at 1 000 000 runs) and opened every thread's owner record (404 674 point
// reads at 200 000 threads). Measured on Postgres: 90 s and 425 966 queries to erase one person with
// ~500 runs. The index answers it by listing one prefix.
//
// Three rules keep it from weakening the erasure:
//  - WRITTEN FIRST. The index key goes in before the record it points at, so a crash between the two
//    leaves an entry for a run that does not exist (harmless) — never a run the index cannot find.
//  - NEVER TRUSTED ALONE. A reader checks each entry against the record itself before acting on it:
//    an entry for a run someone else won is skipped, not erased.
//  - A SCOPE IS ON ONLY WHEN COMPLETE. Until every run and thread of the scope is in it — a scope with
//    no runs at first contact, or the `subject-index` step of `storage.upgrade()` — readers keep the
//    full scan, so an older store loses nothing.
//
// The key names the person, so it goes with what it points at: purgeRun, purgeThread and a thread
// changing owner remove theirs, and an erasure removes the person's whole prefix.
import { claim, runKeys, runPages } from './journal.js';
import type { Journal, RunSummary } from './journal.js';
import { esc, unesc } from './owned-name.js';

export type SubjectKind = 'run' | 'thread';

const SUBJ = 'subj:';
/**
 * Written once a scope's every run and thread is indexed; from then on readers trust the prefix. A
 * platform key (`__`): it names no one, survives a person's erasure, and is not carried by adoptIntoOrg —
 * an organization holding adopted rows walks until its own step marks it.
 */
export const SUBJECT_INDEX_KEY = '__subject_index__:v1';

/**
 * `subj:<escaped person>:` — the escape leaves no `:`, so `bob`'s prefix never reaches `bob:evil`'s.
 * Not `ownedPrefix`: its `~o~<org>:` names an organization, and the key already lives in its scope.
 */
export const subjectPrefix = (resourceId: string): string => `${SUBJ}${esc(resourceId)}:`;
/**
 * The id is escaped (no `:` or `~` left) and ends in `~`, so no key is a prefix of another — the journal
 * deletes by prefix, and `run:r1` must not take `run:r10` with it.
 */
export const subjectKey = (kind: SubjectKind, resourceId: string, id: string): string => `${subjectPrefix(resourceId)}${kind}:${esc(id)}~`;

/** Indexes what `resourceId` owns. Call BEFORE writing the record it points at. */
export async function indexSubject(journal: Journal, kind: SubjectKind, resourceId: string | undefined, id: string): Promise<void> {
  if (typeof resourceId !== 'string' || resourceId === '') return;
  await claim(journal, subjectKey(kind, resourceId, id), { at: Date.now() });
}

/** Removes one entry — when what it points at is deleted, or changes owner. */
export async function unindexSubject(journal: Journal, kind: SubjectKind, resourceId: string | undefined, id: string): Promise<void> {
  if (typeof resourceId !== 'string' || resourceId === '' || typeof journal.deletePrefix !== 'function') return;
  await journal.deletePrefix(subjectKey(kind, resourceId, id));
}

/** Scopes known complete, per journal object: the marker never goes away once written. */
const complete = new WeakSet<object>();

/** Whether this scope's index can be trusted: its marker is there. */
export async function subjectIndexComplete(journal: Journal): Promise<boolean> {
  if (complete.has(journal)) return true;
  if ((await journal.get(SUBJECT_INDEX_KEY)) === undefined) return false;
  complete.add(journal);
  return true;
}

/**
 * Marks a scope complete when it holds nothing yet — called by every first writer of a scope (a run's
 * birth, the thread gate, a memory creating a thread) before it writes. A scope that holds anything
 * waits for the `subject-index` step — so does a root holding organization records. Asked with ONE key read: an organization's
 * `listRuns` reads the whole store (organization.ts), and asking it here put that walk on every birth
 * in a scope not yet upgraded (found by the pg-mem erasure contract). A scope with keys but no runs is
 * left unmarked — the side that costs speed, never an erasure.
 */
const checked = new WeakSet<object>();
export async function markSubjectIndexIfEmpty(journal: Journal): Promise<void> {
  if (checked.has(journal) || complete.has(journal)) return;
  checked.add(journal);
  if ((await journal.get(SUBJECT_INDEX_KEY)) !== undefined) { complete.add(journal); return; }
  if (typeof journal.listKeys !== 'function') return;
  if ((await journal.listKeys('', { limit: 1 })).length > 0) return;
  await claim(journal, SUBJECT_INDEX_KEY, { at: Date.now(), firstContact: true });
  complete.add(journal);
}

/** The ids of `kind` this person's index lists. Only meaningful once `subjectIndexComplete`. */
export async function indexedIds(journal: Journal, kind: SubjectKind, resourceId: string): Promise<string[]> {
  if (typeof journal.listKeys !== 'function') return [];
  const pre = `${subjectPrefix(resourceId)}${kind}:`;
  return (await journal.listKeys(pre)).filter((k) => k.endsWith('~')).map((k) => unesc(k.slice(pre.length, -1)));
}

/**
 * The person's runs: from the index, each checked against its `:input`, once the scope is complete;
 * otherwise by walking every run, as before. Same answer either way (subject-index tests).
 */
export async function runsOfSubject(journal: Journal, resourceId: string): Promise<Array<{ runId: string; threadId?: string }>> {
  if (await subjectIndexComplete(journal)) {
    const out: Array<{ runId: string; threadId?: string }> = [];
    for (const runId of await indexedIds(journal, 'run', resourceId)) {
      const input = await journal.get<{ resourceId?: unknown; threadId?: unknown }>(runKeys.input(runId));
      if (input?.resourceId !== resourceId) continue; // gone, or another person's: not this person's run
      out.push({ runId, ...(typeof input.threadId === 'string' ? { threadId: input.threadId } : {}) });
    }
    return out;
  }
  const paged = (journal as unknown as {
    listRunsPaged?: (q: { resourceId: string; limit: number; cursor?: string }) => Promise<{ items: RunSummary[]; nextCursor?: string }>;
  }).listRunsPaged;
  if (typeof paged !== 'function') return [];
  const out: Array<{ runId: string; threadId?: string }> = [];
  let cursor: string | undefined;
  do {
    const page = await paged.call(journal, { resourceId, limit: 200, ...(cursor ? { cursor } : {}) });
    for (const r of page.items) out.push({ runId: r.runId, ...(r.threadId ? { threadId: r.threadId } : {}) });
    cursor = page.nextCursor;
  } while (cursor);
  return out;
}

/** Runs read per page, and entries written at once, by `writeSubjectIndex`. */
const INDEX_PAGE = 1000;
const INDEX_WRITERS = 16;

/**
 * Indexes every run and every owned thread of a scope an earlier version wrote, then marks it complete.
 * One page of runs at a time; thread owner records are listed by their key family. Every write is
 * first-write-wins, so an interrupted pass is simply run again.
 * @internal — `storage.upgrade({ only: ['subject-index'] })` runs it.
 */
export async function writeSubjectIndex(journal: Journal): Promise<{ runs: number; threads: number }> {
  const each = async <T>(items: T[], f: (x: T) => Promise<void>) => {
    const queue = [...items];
    await Promise.all(Array.from({ length: INDEX_WRITERS }, async () => { for (let x = queue.pop(); x !== undefined; x = queue.pop()) await f(x); }));
  };
  let runs = 0;
  for await (const page of runPages(journal, INDEX_PAGE)) {
    const owned = page.filter((r) => typeof r.resourceId === 'string' && r.resourceId !== '');
    await each(owned, (r) => indexSubject(journal, 'run', r.resourceId, r.runId));
    runs += owned.length;
  }
  let threads = 0;
  if (typeof journal.listKeys === 'function') {
    const ids = (await journal.listKeys('thread:')).filter((k) => k.endsWith(':owner')).map((k) => k.slice('thread:'.length, -':owner'.length));
    await each(ids, async (t) => {
      const rec = await journal.get<{ resourceId?: unknown }>(`thread:${t}:owner`);
      if (typeof rec?.resourceId === 'string' && rec.resourceId !== '') { await indexSubject(journal, 'thread', rec.resourceId, t); threads++; }
    });
  }
  await claim(journal, SUBJECT_INDEX_KEY, { at: Date.now(), upgraded: true });
  complete.add(journal);
  return { runs, threads };
}
