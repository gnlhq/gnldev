/**
 * Moving working memory 0.6.0 wrote to the keys 0.7 reads.
 *
 * 0.6.0's AgentMemory kept a person's working memory under `res:<resourceId>` and a thread's under the
 * bare thread id. 0.7 reads `workingMemoryScope.resource(id)` / `workingMemoryScope.thread(id)` only,
 * so after an upgrade the old records are still stored and no longer shown to the model. (Erasure and
 * thread deletion remove them either way — `legacyWorkingMemoryScope` in @gnldev/durable.)
 */
import {
  legacyWorkingMemoryScope, workingMemoryScope, findReservedRootThreads, isOrganizationKey, purgeThread, threadOwnerKey,
  toJournal, orgStorageScopeOf, type MemoryStore, type MessageAppend, type MessageRecord, type Storage,
} from '@gnldev/durable';

export interface MigrateWorkingMemoryOptions {
  /** The people whose `res:<id>` record to move. Omitted: every owner of a thread the store lists. */
  resourceIds?: string[];
  /** The threads whose bare-id record to move. Omitted: every thread the store lists. */
  threadIds?: string[];
}

export interface MigrateWorkingMemoryReport {
  /** 0.6 keys moved to their 0.7 key and removed. */
  moved: string[];
  /** 0.6 keys left in place because the 0.7 key already held a (newer) value — which is kept, never overwritten. */
  kept: string[];
  /**
   * Thread ids whose bare key holds a record but is ambiguous — it begins `thread:`, `resource:` or
   * `res:`, so it is, or could be, a person's record or a 0.7 one: not touched. Decide by hand.
   */
  skipped: string[];
}

/**
 * Moves each 0.6 working-memory record to its 0.7 key, without overwriting a value already there.
 * Idempotent: a second run moves nothing.
 *
 * `store` is the memory store the records live in. For an organization, pass its view
 * (`withOrgStorage(storage, orgId).memory`): the `org:<id>:` prefix is that view's to add, so each
 * organization is migrated on its own and none reaches another's records.
 */
export async function migrateWorkingMemoryKeys(store: MemoryStore, opts: MigrateWorkingMemoryOptions = {}): Promise<MigrateWorkingMemoryReport> {
  let threadIds = opts.threadIds;
  let resourceIds = opts.resourceIds;
  if (threadIds === undefined || resourceIds === undefined) {
    const threads: Array<{ id: string; resourceId: string }> = [];
    let cursor: string | undefined;
    do {
      const page = await store.listThreads({ limit: 500, ...(cursor !== undefined ? { cursor } : {}) });
      threads.push(...page.items);
      cursor = page.nextCursor;
    } while (cursor !== undefined);
    threadIds ??= threads.map((t) => t.id);
    resourceIds ??= [...new Set(threads.map((t) => t.resourceId))];
  }
  const report: MigrateWorkingMemoryReport = { moved: [], kept: [], skipped: [] };
  const move = async (from: string, to: string) => {
    const value = await store.getWorkingMemory(from);
    if (value === undefined) return;
    if ((await store.getWorkingMemory(to)) !== undefined) {
      report.kept.push(from);
      return;
    }
    await store.setWorkingMemory(to, value);
    await store.deleteWorkingMemory(from);
    report.moved.push(from);
  };
  for (const id of new Set(resourceIds)) await move(legacyWorkingMemoryScope.resource(id), workingMemoryScope.resource(id));
  for (const id of new Set(threadIds)) {
    const from = legacyWorkingMemoryScope.thread(id);
    if (from === undefined) {
      if ((await store.getWorkingMemory(id)) !== undefined) report.skipped.push(id);
      continue;
    }
    await move(from, workingMemoryScope.thread(id));
  }
  return report;
}

export interface MigrateReservedRootThreadsOptions {
  /**
   * Threads to move. Omitted: every thread `findReservedRootThreads` is certain is the root's
   * (`rootOnly`). A thread shaped like an organization's with no owner record either way is only
   * moved when named here — it may be that organization's own.
   */
  threadIds?: string[];
  /** The new id for a thread. Default: `legacy-<id>` (`org:acme:support` → `legacy-org:acme:support`). */
  rename?: (threadId: string) => string;
  /** Report what would move, and move nothing. */
  dryRun?: boolean;
}

export interface MigrateReservedRootThreadsReport {
  moved: Array<{ from: string; to: string }>;
  /** Root threads in the reserved space that were not moved because they may be an organization's: name them in `threadIds` to move them. */
  undecided: string[];
  /** Not moved, with the reason: the new id is taken, or is itself in the reserved space. */
  skipped: Array<{ id: string; reason: string }>;
}

/**
 * Moves the threads 0.9 let the ROOT scope create under an `org:` id to a free id.
 *
 * 0.9's root `AgentMemory` accepted any thread id. Now the root scope cannot name an id under `org:`
 * (`ReservedThreadIdError`) — that space is where organizations' threads live physically — so such a
 * thread is unreachable from the root, and one shaped like an organization's (`org:acme:support`) is
 * READ by that organization, whose view resolves `support` to the same physical id. This is the way
 * through: the thread, its messages (positions kept), its thread working memory, its observations and
 * its owner record move to `rename(id)`, and the old id is deleted.
 *
 * Which threads are the root's is `findReservedRootThreads`'s answer (@gnldev/durable). Idempotent: a
 * second run finds nothing to move. Run it with writes stopped: a turn on the old id meanwhile writes
 * where nothing reads it. The thread's journal-side state under the old id (observational-memory
 * progress, its dedup window) is removed rather than moved, and starts fresh under the new id.
 *
 * `storage` is the ROOT storage. Tell the thread's user the new id: their client still holds the old one.
 */
export async function migrateReservedRootThreads(storage: Storage, opts: MigrateReservedRootThreadsOptions = {}): Promise<MigrateReservedRootThreadsReport> {
  if (orgStorageScopeOf(storage) !== undefined) {
    throw new Error('@gnldev/memory: migrateReservedRootThreads takes the root storage — an organization\'s view has no root threads');
  }
  const store = storage.memory;
  const report: MigrateReservedRootThreadsReport = { moved: [], undecided: [], skipped: [] };
  if (!store) return report;
  const rename = opts.rename ?? ((id: string) => `legacy-${id}`);
  const found = await findReservedRootThreads(storage);
  const named = opts.threadIds ? new Set(opts.threadIds) : undefined;
  const runs = toJournal(storage.runs);
  for (const t of found) {
    if (named ? !named.has(t.id) : !t.rootOnly) {
      if (!t.rootOnly) report.undecided.push(t.id);
      continue;
    }
    const to = rename(t.id);
    if (isOrganizationKey(to)) { report.skipped.push({ id: t.id, reason: `the new id '${to}' is in the organizations' reserved space too` }); continue; }
    if ((await store.getThread(to)) !== undefined) { report.skipped.push({ id: t.id, reason: `a thread '${to}' already exists` }); continue; }
    report.moved.push({ from: t.id, to });
    if (opts.dryRun) continue;
    await moveThread(store, t.id, to);
    const owner = await runs.get(threadOwnerKey(t.id));
    if (owner !== undefined) await runs.put(threadOwnerKey(to), owner);
    if (typeof runs.deletePrefix === 'function') await purgeThread(runs, t.id);
  }
  return report;
}

async function moveThread(store: MemoryStore, from: string, to: string): Promise<void> {
  const rec = await store.getThread(from);
  if (rec) await store.upsertThread({ ...rec, id: to });
  const rows: MessageRecord[] = [];
  let cursor: string | undefined;
  do {
    const page = await store.getMessages(from, { limit: 500, ...(cursor !== undefined ? { cursor } : {}) });
    rows.push(...page.items);
    cursor = page.nextCursor;
  } while (cursor !== undefined);
  if (rows.length) {
    await store.appendMessages(to, rows.map(({ score: _s, ...r }): MessageAppend => ({ ...r, threadId: to })));
  }
  for (const [src, dst] of [[workingMemoryScope.thread(from), workingMemoryScope.thread(to)], [legacyWorkingMemoryScope.thread(from), legacyWorkingMemoryScope.thread(to)]] as const) {
    if (src === undefined || dst === undefined) continue;
    const wm = await store.getWorkingMemory(src);
    if (wm !== undefined) await store.setWorkingMemory(dst, wm);
  }
  const obs = await store.getObservations(from);
  if (obs.length) await store.putObservations(to, obs);
  await store.deleteThread(from);
}
