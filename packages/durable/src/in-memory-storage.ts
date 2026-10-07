// @gnldev/durable/in-memory-storage — Reference (Map) implementation of all store ports.
// Zero-infra test storage (moat): per-storage bundles mimic this behavior.
// Correctness matters, not perf (naive filter/sort). Date.now/Math.random are free to use here (runtime code).
import { cosineSimilarity } from 'ai';
import { serialize, deserialize, copyValue } from './serialize.js';
import { assertUniformSeq, workingMemoryScope, legacyWorkingMemoryScope } from './storage.js';
import { memoryPartitionOf, inMemoryPartition, type MemoryPartitionOption } from './storage.js';
import { InMemoryJournal } from './journal.js';
import { pageRunsFromArray } from './run-cursor.js';
import { runUpgrade, threadRecordsStep, type UpgradeOptions, type UpgradeReport } from './upgrade.js';
import { UPGRADE_NAMES } from './option-names.js';
import { stableStringify } from './hash.js';
import { ENGINE_META_KEYS, assertNoRunsInFlight, assertOrgRegistered, isPlatformKey, orgPrefix, isOrganizationKey } from './organization.js';
import type { JournalEntry, RunSummary } from './journal.js';
import { decodeLogCursor, encodeLogCursor, compareLogPosition, workKeyAdoption, workKeyAdoptCollision, matchFilter, visibleToSubject, vectorWriteBatch, assertSameVectorOwner, vectorDeletePlan, vectorDeleteMatcher, vectorQueryScope, vectorMetadataMatches, vectorItemCopy, orgVectorId, vectorAdoptCollision, vectorInOrganization, vectorDocumentOf, vectorFilterDocument } from './storage.js';
import type {
  Storage, CapabilityMatrix, Page, ListQuery,
  RunJournal, MemoryStore, VectorStore, WorkStore, CacheStore, MetaStore,
  ThreadRecord, MessageRecord, MessageAppend, Observation, RecallOptions,
  AdoptIntoOrgResult, VectorItem, VectorMatch, VectorQueryOptions, VectorDeleteWhere, LogRecord } from './storage.js';
import { refuseUnknownNames } from '@gnldev/options';
import { ADOPT_INTO_ORG_NAMES } from './option-names.js';

let idc = 0;
function genId(prefix: string): string {
  return `${prefix}-${Date.now().toString(36)}-${(idc++).toString(36)}`;
}

/**
 * Offset-cursor pagination (every list here except `WorkStore.list` and `RunJournal.listRuns`, which are keyed).
 *
 * The note here used to say "real storages use a keyset cursor". They do not — postgres, sqlite and
 * redis all read the cursor as a row offset, exactly like this one. The line described an intention
 * as if it were the state of the code, which is the most expensive kind of comment: someone
 * reasoning about drift would have trusted the wrong adapter.
 */
function paginate<T>(items: T[], q?: ListQuery): Page<T> {
  const start = q?.cursor ? Number(q.cursor) || 0 : 0;
  const limit = q?.limit ?? 50;
  const slice = items.slice(start, start + limit);
  const next = start + limit;
  return { items: slice, nextCursor: next < items.length ? String(next) : undefined };
}

// P1.5 matchFilter is now shared (storage.ts) — see its JSDoc for the operator
// subset ($eq/$ne/$gt/$gte/$lt/$lte/$in/$nin). Import above (was a local exact-equality-only copy).
function normRange(r?: number | { before: number; after: number }): { before: number; after: number } {
  if (r == null) return { before: 0, after: 0 };
  return typeof r === 'number' ? { before: r, after: r } : r;
}
const hasNorm = (v?: number[]): v is number[] => !!v && v.some((x) => x !== 0);

// ── RunJournal: wrap the existing InMemoryJournal, add paged listRuns ───────────────
/**
 * Moves the keys of a `Map` through `rename`, in place. `undefined` from `rename` leaves the entry
 * alone — that is how platform keys stay where they are.
 */
function rekeyMap<V>(m: Map<string, V>, rename: (k: string) => string | undefined): number {
  let n = 0;
  for (const k of [...m.keys()]) {
    const to = rename(k);
    if (to === undefined || to === k) continue;
    m.set(to, m.get(k)!); m.delete(k); n++;
  }
  return n;
}

class InMemoryRunJournal implements RunJournal {
  constructor(readonly journal = new InMemoryJournal()) {}
  get<T = unknown>(k: string) { return this.journal.get<T>(k); }
  put(k: string, v: unknown) { return this.journal.put(k, v); }
  putIfAbsent(k: string, v: unknown) { return this.journal.putIfAbsent(k, v); }
  /** H1: delegates to InMemoryJournal.putIfMatch (stableStringify comparison, structurally atomic). */
  putIfMatch(k: string, e: unknown, v: unknown) { return this.journal.putIfMatch(k, e, v); }
  listKeys(p: string, opts?: { limit?: number }) { return this.journal.listKeys(p, opts); }
  readRun(runId: string): Promise<JournalEntry[]> { return this.journal.readRun(runId); }
  // Capability parity with the real adapters (sqlite/postgres expose these as extra methods and
  // toJournal forwards whatever exists): the inner InMemoryJournal always had them, but this wrapper
  // silently HID them — so recordRunMetrics bailed at its incrBy/applyBatch gate and InMemoryStorage
  // users got NO materialized metrics rows at all (caught by metrics-stream.test.ts).
  incrBy(k: string, f: Record<string, number>) { return this.journal.incrBy(k, f); }
  getCounters(k: string) { return this.journal.getCounters(k); }
  applyBatch(b: Parameters<InMemoryJournal['applyBatch']>[0]) { return this.journal.applyBatch(b); }
  countRunsByStatus() { return this.journal.countRunsByStatus(); }
  listStaleRuns(cutoffTs: number, opts?: { includeSuspended?: boolean }) { return this.journal.listStaleRuns(cutoffTs, opts); }
  readRunStats(runId: string) { return this.journal.readRunStats(runId); }
  deletePrefix(prefix: string) { return this.journal.deletePrefix(prefix); }
  // Filtered before it is sliced, and paged by run rather than by row number (run-cursor.ts) — the
  // same cursor every other run listing hands out.
  async listRuns(q?: ListQuery): Promise<Page<RunSummary>> {
    return pageRunsFromArray(await this.journal.listRuns(), q);
  }
}

// ── MemoryStore ───────────────────────────────────────────────────────────────
class InMemoryMemoryStore implements MemoryStore {
  /** @internal — see Storage.adoptIntoOrg. */
  _rekey(f: (k: string) => string | undefined): number {
    return rekeyMap(this.threads, f) + rekeyMap(this.messages, f) + rekeyMap(this.wm, f) + rekeyMap(this.obs, f)
      + rekeyMap(this.batches, f);
  }

  private threads = new Map<string, ThreadRecord>();
  private messages = new Map<string, MessageRecord[]>(); // threadId → seq-ordered rows
  private wm = new Map<string, unknown>();
  private obs = new Map<string, Observation[]>();
  /** threadId → batchKey → the seq range that batch wrote. See `appendMessagesOnce`. */
  private batches = new Map<string, Map<string, { from: number; to: number }>>();

  async upsertThread(rec: ThreadRecord) { this.threads.set(rec.id, { ...rec }); }
  async getThread(id: string) {
    const t = this.threads.get(id);
    return t && !t.deletedAt ? { ...t } : undefined;
  }
  async listThreads(q: { resourceId?: string } & ListQuery & MemoryPartitionOption): Promise<Page<ThreadRecord>> {
    const partition = memoryPartitionOf(q);
    const all = [...this.threads.values()]
      .filter((t) => !t.deletedAt && (q.resourceId == null || t.resourceId === q.resourceId) && inMemoryPartition(partition, t.id))
      .sort((a, b) => b.updatedAt - a.updatedAt);
    return paginate(all, q);
  }
  async deleteThread(id: string) {
    const t = this.threads.get(id);
    // Soft delete, and the record keeps nothing the person wrote: its title is often their first message.
    if (t) this.threads.set(id, { id: t.id, resourceId: t.resourceId, createdAt: t.createdAt, updatedAt: t.updatedAt, deletedAt: Date.now() });
    this.messages.delete(id);
    this.wm.delete(workingMemoryScope.thread(id));
    const legacy = legacyWorkingMemoryScope.thread(id);
    if (legacy !== undefined) this.wm.delete(legacy);
    this.obs.delete(id);
    // A soft-deleted thread can be brought back by `upsertThread`; markers left behind would answer a
    // legitimate later batch with "already applied" and drop it silently.
    this.batches.delete(id);
  }

  /**
   * Already all-or-nothing, and load-bearing that it stays so: there is NO `await` in this body, so it
   * runs to completion in one microtask and a batch can never be observed half-written. The SQL
   * adapters had to be given an explicit transaction to reach the same guarantee.
   *
   * The flip side is a testing hazard worth stating: because this adapter cannot produce a partially
   * written batch, it cannot reproduce the orphaned-tool-call failure that the SQL adapters produced
   * in production (measured: 0/30 here vs 16/30 against real Postgres). A green concurrency test
   * against InMemoryStorage is not evidence that the SQL adapters are safe.
   */
  async appendMessagesOnce(threadId: string, rows: MessageAppend[], batchKey: string): Promise<boolean> {
    const seen = this.batches.get(threadId) ?? new Map();
    if (seen.has(batchKey)) return false;
    const log = this.messages.get(threadId) ?? [];
    const from = log.reduce((m, r) => Math.max(m, r.seq + 1), 0);
    await this.appendMessages(threadId, rows);
    const after = (this.messages.get(threadId) ?? []).reduce((m, r) => Math.max(m, r.seq + 1), 0);
    seen.set(batchKey, { from, to: after });
    this.batches.set(threadId, seen);
    return true;
  }

  async appendMessages(threadId: string, rows: MessageAppend[]) {
    const log = this.messages.get(threadId) ?? [];
    const seen = new Set(log.map((m) => m.seq));
    // Assigning from the tail inside this same synchronous body is what makes the store the authority
    // on position. There is no lock because there is nothing to lock against: no `await` runs between
    // reading the tail and writing the rows.
    assertUniformSeq(threadId, rows);
    let next = log.reduce((m, r) => Math.max(m, r.seq + 1), 0);
    for (const r of rows) {
      const seq = r.seq ?? next++;
      if (seen.has(seq)) continue; // per-message idempotent (CAS equivalent)
      log.push({ ...r, threadId, seq });
      seen.add(seq);
    }
    log.sort((a, b) => a.seq - b.seq);
    this.messages.set(threadId, log);
  }
  async getMessages(threadId: string, q?: ListQuery): Promise<Page<MessageRecord>> {
    return paginate(this.messages.get(threadId) ?? [], q);
  }
  async recall(threadId: string, query: number[], opts: RecallOptions): Promise<MessageRecord[]> {
    if (!hasNorm(query)) return [];
    const byThread = new Map<string, MessageRecord[]>();
    if (opts.scope === 'resource' && opts.resourceId) {
      const partition = memoryPartitionOf(opts);
      for (const [tid, rows] of this.messages) {
        const t = this.threads.get(tid);
        if (t && !t.deletedAt && t.resourceId === opts.resourceId && inMemoryPartition(partition, tid)) byThread.set(tid, rows);
      }
    } else {
      byThread.set(threadId, this.messages.get(threadId) ?? []);
    }
    const threshold = opts.threshold ?? 0;
    const cand: { m: MessageRecord; tid: string; idx: number; score: number }[] = [];
    for (const [tid, rows] of byThread) {
      rows.forEach((m, idx) => {
        if (!hasNorm(m.embedding)) return;
        const score = cosineSimilarity(query, m.embedding);
        if (score > 0 && score >= threshold) cand.push({ m, tid, idx, score });
      });
    }
    let scored = cand;
    if (opts.filter) scored = scored.filter((c) => matchFilter(c.m.metadata, opts.filter!));
    scored.sort((a, b) => b.score - a.score);
    const hits = scored.slice(0, opts.topK ?? 3);
    const range = normRange(opts.messageRange);
    const picked = new Map<string, MessageRecord>();
    for (const h of hits) {
      const rows = byThread.get(h.tid)!;
      const lo = Math.max(0, h.idx - range.before);
      const hi = Math.min(rows.length - 1, h.idx + range.after);
      for (let i = lo; i <= hi; i++) picked.set(`${h.tid}:${rows[i]!.seq}`, rows[i]!);
    }
    // Provenance parity with sqlite-storage.ts — the spread copy also keeps the STORED record
    // unmutated (this adapter returns direct references for neighbors).
    for (const h of hits) picked.set(`${h.tid}:${h.m.seq}`, { ...h.m, score: h.score });
    return [...picked.values()].sort((a, b) => a.ts - b.ts || a.seq - b.seq);
  }

  async getWorkingMemory(scopeId: string) { return this.wm.get(scopeId); }
  async setWorkingMemory(scopeId: string, data: unknown) { this.wm.set(scopeId, data); }
  async deleteWorkingMemory(scopeId: string) { return this.wm.delete(scopeId); }
  async getObservations(threadId: string) { return [...(this.obs.get(threadId) ?? [])]; }
  async putObservations(threadId: string, obs: Observation[]) { this.obs.set(threadId, [...obs]); }

  /** FLOW-10 (reference behavior — see storage.ts JSDoc): keep seq <= afterSeq, drop the rest. */
  async deleteMessagesAfter(threadId: string, afterSeq: number): Promise<number> {
    // Markers past the cut go with the rows — see the Postgres twin.
    const b = this.batches.get(threadId);
    if (b) for (const [k, v] of b) if (v.to > afterSeq) b.delete(k);
    const log = this.messages.get(threadId);
    if (!log || log.length === 0) return 0;
    const kept = log.filter((m) => m.seq <= afterSeq);
    const removed = log.length - kept.length;
    if (removed > 0) this.messages.set(threadId, kept);
    return removed;
  }
}

// ── VectorStore (cosine, same behavior as rag's InMemoryVectorStore) ───────────
class InMemoryVectorStore implements VectorStore {
  readonly rootOutsideOrganizations = true;
  /** @internal — see Storage.adoptIntoOrg. Stamps the namespace on documents that have none. */
  _stamp(ns: string, dryRun: boolean): number {
    // Renamed as well as stamped: an organization's documents are stored under `<ns>:<id>` (see
    // withOrgStorage), so an adopted document keeps its identity instead of being duplicated by the
    // organization's next upsert of the same id. A rename onto a taken id is refused first.
    const legacy = this.items.filter((it) => it.namespace === undefined);
    const clash = legacy.find((it) => this.byId.has(orgVectorId(ns, it.id)));
    if (clash) throw vectorAdoptCollision(clash.id);
    if (!dryRun) {
      const all = this.items;
      for (const it of legacy) { it.namespace = ns; it.id = orgVectorId(ns, it.id); }
      this.byId.clear();
      this.byDoc.clear();
      for (const it of all) this.put(it);
    }
    return legacy.length;
  }

  /**
   * By id, in insertion order (a Map keeps a replaced entry where it was, as the array did), and by
   * document (`vectorDocumentOf`): a write, a delete by id and a document's records cost a lookup,
   * not a pass over every record.
   */
  private byId = new Map<string, VectorItem>();
  private byDoc = new Map<string, Set<string>>();
  get items(): VectorItem[] { return [...this.byId.values()]; }
  private put(it: VectorItem): void {
    this.remove(it.id);
    this.byId.set(it.id, it);
    const d = vectorDocumentOf(it.metadata);
    if (d !== undefined) { const ids = this.byDoc.get(d) ?? new Set<string>(); ids.add(it.id); this.byDoc.set(d, ids); }
  }
  private remove(id: string): void {
    const old = this.byId.get(id);
    if (!old) return;
    const d = vectorDocumentOf(old.metadata);
    if (d !== undefined) { const ids = this.byDoc.get(d); ids?.delete(id); if (ids && ids.size === 0) this.byDoc.delete(d); }
    // A replaced entry keeps its place: `put` sets it again straight after, and Map.set on an existing key does not move it.
  }
  /** The records a condition can match: by id, by document, or every record. */
  protected candidates(ids: string[] | undefined, doc: string | undefined): Iterable<VectorItem> {
    if (ids) return ids.flatMap((id) => { const it = this.byId.get(id); return it ? [it] : []; });
    if (doc !== undefined) return [...(this.byDoc.get(doc) ?? [])].map((id) => this.byId.get(id)!);
    return this.byId.values();
  }
  async upsert(items: VectorItem[]) {
    const batch = vectorWriteBatch(items);
    // Checked for the whole batch before anything is written, so a refused batch leaves no half.
    for (const it of batch) assertSameVectorOwner(this.byId.get(it.id), it);
    for (const it of batch) this.put(vectorItemCopy(it));
  }
  async delete(where: VectorDeleteWhere): Promise<number> {
    const w = vectorDeletePlan(where);
    if (!w) return 0;
    const gone = vectorDeleteMatcher(w);
    const doomed = [...new Set([...this.candidates(w.ids, vectorFilterDocument(w.filter))])].filter(gone);
    for (const it of doomed) { this.remove(it.id); this.byId.delete(it.id); }
    return doomed.length;
  }
  async query(embedding: number[], topK: number, opts?: VectorQueryOptions): Promise<VectorMatch[]> {
    // Filter, THEN rank, THEN slice. Ranking first and filtering after would make a caller's result
    // count depend on how many other namespaces exist and how similar their documents happen to be:
    // ask for 4, get however many of the global top 4 were yours. No error, no leak, just recall that
    // quietly degrades as other organizations upload — invisible unless a test has two of them in it.
    const scope = vectorQueryScope(opts);
    if (scope.none) return [];
    return [...this.candidates(undefined, vectorFilterDocument(opts?.filter))]
      .filter((it) => (scope.namespace === undefined || it.namespace === scope.namespace) && !(scope.outsideOrganizations && vectorInOrganization(it.namespace)) && visibleToSubject(it, scope.visibleTo) && vectorMetadataMatches(it.metadata, opts?.filter))
      .map((it) => ({ id: it.id, text: it.text, metadata: it.metadata, ...(it.namespace !== undefined ? { namespace: it.namespace } : {}), ...(it.owner !== undefined ? { owner: it.owner } : {}), ...(it.shared ? { shared: true } : {}), score: cosineSimilarity(embedding, it.embedding) }))
      .sort((a, b) => b.score - a.score)
      .slice(0, topK);
  }
}

// ── WorkStore (append-log + KV + CAS ack) ─────────────────────────────────────
class InMemoryWorkStore implements WorkStore {
  /**
   * @internal — see Storage.adoptIntoOrg. A moved log is APPENDED to the log already under its new
   * name and numbered after that log's last number, so it lands after any cursor the organization's
   * consumer has persisted. It used to be `rekeyMap`: the moved log REPLACED the organization's (its
   * records gone) and kept its own low numbers, behind that cursor.
   */
  _rekey(f: (k: string) => string | undefined, resetPositions: string[] = []): number {
    let n = 0;
    for (const [ns, recs] of [...this.logs]) {
      const to = f(ns);
      if (to === undefined || to === ns) continue;
      const target = this.logs.get(to) ?? [];
      let seq = Math.max(this.seqs.get(to) ?? 0, target[target.length - 1]?.seq ?? 0);
      for (const r of recs) target.push({ ...r, seq: ++seq });
      this.seqs.set(to, seq);
      this.logs.set(to, target);
      this.logs.delete(ns);
      n++;
    }
    // Keys by `workKeyAdoption` — a read position is dropped, not carried (a collision on any other key
    // was refused by `_kvCollision` before anything moved).
    for (const k of [...this.kv.keys()]) {
      const to = f(k);
      if (to === undefined || to === k) continue;
      if (workKeyAdoption(this.kv.get(k), this.kv.has(to)) === 'reset-position') { resetPositions.push(k); this.kv.delete(k); continue; }
      this.kv.set(to, this.kv.get(k)); this.kv.delete(k); n++;
    }
    return n;
  }
  /** @internal — what `workKeyAdoption` decides for each key, before anything moves: a refusal, and the positions a move would drop. */
  _kvPlan(f: (k: string) => string | undefined): { collision?: Error; resets: string[] } {
    const resets: string[] = [];
    for (const [k, v] of this.kv) {
      const to = f(k);
      if (to === undefined || to === k) continue;
      const d = workKeyAdoption(v, this.kv.has(to));
      if (d === 'collision') return { collision: workKeyAdoptCollision(to), resets };
      if (d === 'reset-position') resets.push(k);
    }
    return { resets: resets.sort() };
  }
  /** @internal — an id a moved log shares with the log it would join (adoptIntoOrg refuses, as SQL's key does). */
  _logCollision(f: (k: string) => string | undefined): string | undefined {
    for (const [ns, recs] of this.logs) {
      const to = f(ns);
      if (to === undefined || to === ns) continue;
      const taken = new Set((this.logs.get(to) ?? []).map((r) => r.id));
      const hit = recs.find((r) => taken.has(r.id));
      if (hit) return `${to}/${hit.id}`;
    }
    return undefined;
  }

  /** Each namespace's records in append (= `seq`) order. */
  private logs = new Map<string, Array<LogRecord & { seq: number }>>();
  /** The last sequence handed out per namespace. Survives deletions on purpose: see `WorkStore.list`. */
  private seqs = new Map<string, number>();
  private kv = new Map<string, unknown>();
  async append(ns: string, payload: unknown, id?: string): Promise<string> {
    const log = this.logs.get(ns) ?? [];
    const eid = id ?? genId(ns);
    if (!log.some((r) => r.id === eid)) {
      // max(...) with the log's tail too: `_rekey` (adoptIntoOrg) moves a log under a new name, and the
      // new name's counter must not start below the records it now holds.
      const seq = Math.max(this.seqs.get(ns) ?? 0, log[log.length - 1]?.seq ?? 0) + 1;
      this.seqs.set(ns, seq);
      log.push({ id: eid, payload: copyValue(payload), ts: Date.now(), seq });
      this.logs.set(ns, log);
    }
    return eid;
  }
  /** Keyset on the store-assigned sequence (`WorkStore.list`): a deletion behind the cursor cannot move it. */
  async list<T = unknown>(ns: string, q?: ListQuery): Promise<Page<LogRecord<T>>> {
    const log = this.logs.get(ns) ?? [];
    const after = decodeLogCursor(q?.cursor);
    const limit = q?.limit ?? 50;
    let start = 0;
    if (after) {
      let hi = log.length; // first index whose position is past `after` (the log is sorted by seq)
      while (start < hi) {
        const mid = (start + hi) >>> 1;
        if (compareLogPosition(log[mid]!, after) <= 0) start = mid + 1; else hi = mid;
      }
    }
    const slice = log.slice(start, start + limit);
    const last = slice[slice.length - 1];
    return {
      items: slice.map((r) => ({ id: r.id, payload: copyValue(r.payload) as T, ts: r.ts })),
      nextCursor: start + limit < log.length && last ? encodeLogCursor(last) : undefined,
    };
  }
  // Copies in and out, as the SQL work stores (serialized rows) do: see copyValue.
  async get<T = unknown>(key: string) { return this.kv.has(key) ? copyValue(this.kv.get(key) as T) : undefined; }
  async put(key: string, value: unknown) { this.kv.set(key, copyValue(value)); }
  async ackOnce(key: string): Promise<boolean> {
    if (this.kv.has(key)) return false;
    this.kv.set(key, true);
    return true;
  }
  /** FAZ-9: both families in one sweep — a log namespace and a KV key share the same prefix space
   *  under `withOrg`, so an org purge cannot half-clean. */
  async deleteIdPrefix(idPrefix: string): Promise<number> {
    let n = 0;
    for (const [ns, log] of this.logs) {
      const keep = log.filter((r) => !r.id.startsWith(idPrefix));
      n += log.length - keep.length;
      this.logs.set(ns, keep);
    }
    return n;
  }
  async deletePrefix(prefix: string): Promise<number> {
    let n = 0;
    for (const ns of [...this.logs.keys()]) {
      if (ns.startsWith(prefix)) { n += this.logs.get(ns)!.length; this.logs.delete(ns); }
    }
    for (const k of [...this.kv.keys()]) {
      if (k.startsWith(prefix)) { this.kv.delete(k); n++; }
    }
    return n;
  }
  /** 8.2: SAME pattern as RunJournal.putIfMatch (stableStringify comparison) — there is NO await
   *  between has→compare→set → structurally atomic in single-threaded JS. */
  async putIfMatch(key: string, expected: unknown, value: unknown): Promise<boolean> {
    if (!this.kv.has(key)) return false;
    if (stableStringify(this.kv.get(key)) !== stableStringify(expected)) return false;
    this.kv.set(key, copyValue(value));
    return true;
  }
}

// ── CacheStore (with TTL) ───────────────────────────────────────────────────────
class InMemoryCacheStore implements CacheStore {
  /** @internal — see Storage.adoptIntoOrg. */
  _rekey(f: (k: string) => string | undefined): number { return rekeyMap(this.m, f); }

  // Values are held SERIALIZED, as the SQLite and Postgres cache stores hold them: a store that kept
  // the object itself handed every reader the same instance, so a caller's mutation of a cached value
  // changed what the next reader got — measured: `["a","MUTATED"]` in memory, `["a"]` on SQLite.
  private m = new Map<string, { v: string; exp?: number }>();
  async get<T = unknown>(key: string): Promise<T | undefined> {
    const e = this.m.get(key);
    if (!e) return undefined;
    if (e.exp != null && e.exp <= Date.now()) { this.m.delete(key); return undefined; }
    return deserialize<T>(e.v);
  }
  async set(key: string, value: unknown, opts?: { ttlMs?: number }) {
    this.m.set(key, { v: serialize(value), exp: opts?.ttlMs != null ? Date.now() + opts.ttlMs : undefined });
  }
  async delete(key: string) { this.m.delete(key); }
}

class InMemoryMetaStore implements MetaStore {
  /** @internal — see Storage.adoptIntoOrg. */
  _rekey(f: (k: string) => string | undefined): number { return rekeyMap(this.m, f); }

  private m = new Map<string, string>();
  async get(key: string) { return this.m.get(key); }
  async set(key: string, value: string) { this.m.set(key, value); }
}

const ALL_FULL: CapabilityMatrix = { runs: 'full', memory: 'full', vectors: 'full', work: 'full', cache: 'full' };

/** Reference storage providing all ports on top of Map. For tests and dev. */
export class InMemoryStorage implements Storage {
  readonly name = 'in-memory';
  readonly capabilities = ALL_FULL;
  /** See `Storage.upgrade`. One step, `thread-records` — for runs written into this store before its threads had marks. */
  async upgrade(opts?: UpgradeOptions): Promise<UpgradeReport> {
    refuseUnknownNames('InMemoryStorage.upgrade', opts, UPGRADE_NAMES);
    return runUpgrade('InMemoryStorage', [threadRecordsStep(this)], opts);
  }
  readonly runs = new InMemoryRunJournal();
  readonly memory = new InMemoryMemoryStore();
  readonly vectors = new InMemoryVectorStore();
  readonly work = new InMemoryWorkStore();
  readonly cache = new InMemoryCacheStore();
  readonly meta = new InMemoryMetaStore();

  /**
   * See `Storage.adoptIntoOrg`.
   *
   * Present mostly so the contract has a fast, dependency-free adapter to be TESTED against — this
   * engine does not survive a restart, so a real upgrade never happens on it. Same rules as the
   * persistent adapters: platform keys stay put, already-scoped rows are counted not moved, and it is
   * idempotent.
   */
  async adoptIntoOrg(orgId: string, opts?: { dryRun?: boolean; allowUnregistered?: boolean; allowInFlight?: boolean }): Promise<AdoptIntoOrgResult> {
    refuseUnknownNames('adoptIntoOrg', opts, ADOPT_INTO_ORG_NAMES);
    const prefix = orgPrefix(orgId);
    await assertOrgRegistered(this.runs, orgId, opts?.allowUnregistered);
    await assertNoRunsInFlight(this.runs, opts?.allowInFlight);
    const dryRun = opts?.dryRun === true;
    const skipped = new Set<string>();
    let alreadyScoped = 0;
    const rename = (k: string): string | undefined => {
      if (isOrganizationKey(k)) { alreadyScoped++; return undefined; }
      if (isPlatformKey(k) || ENGINE_META_KEYS.includes(k)) { skipped.add(k.split(':')[0]!); return undefined; }
      return prefix + k;
    };
    // Counting pass: `rename` has the side effects, so a dry run must not mutate. Run it over the keys
    // without applying, which is what passing a no-op mover does.
    const count = (keys: string[]): number => keys.filter((k) => rename(k) !== undefined).length;

    // Vectors are checked first, before anything moves: a rename onto a taken id refuses the adoption.
    const vectors = this.vectors._stamp(prefix.slice(0, -1), true);
    // So is a work-log record whose id the organization's log already holds. The rule is spelled out
    // rather than passing `rename`, whose counters belong to the adoption, not to this question.
    const clash = this.work._logCollision((k) => (isOrganizationKey(k) || isPlatformKey(k) ? undefined : prefix + k));
    if (clash) throw new Error(`@gnldev/durable: adoptIntoOrg would move a work-log record onto '${clash}', which the organization's log already holds. Nothing was moved.`);
    const kvPlan = this.work._kvPlan((k) => (isOrganizationKey(k) || isPlatformKey(k) ? undefined : prefix + k));
    if (kvPlan.collision) throw kvPlan.collision;
    if (dryRun) {
      const moved = {
        runs: count([...this.runs.journal.keys()]),
        memory: 0, work: 0, cache: 0, meta: 0,
        vectors,
      };
      return { orgId, dryRun, moved, alreadyScoped, skippedPlatformKeys: [...skipped].sort(), resetPositions: kvPlan.resets };
    }
    const resetPositions: string[] = [];
    const moved = {
      runs: this.runs.journal.rekey(rename),
      memory: this.memory._rekey(rename),
      work: this.work._rekey(rename, resetPositions),
      cache: this.cache._rekey(rename),
      meta: this.meta._rekey(rename),
      vectors: this.vectors._stamp(prefix.slice(0, -1), false),
    };
    return { orgId, dryRun, moved, alreadyScoped, skippedPlatformKeys: [...skipped].sort(), resetPositions: resetPositions.sort() };
  }
  /** Access to the underlying journal for replay/time-travel tests. */
  get journal() { return this.runs.journal; }
}
