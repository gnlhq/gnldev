// @gnldev/durable/storage — Greenfield persistence contracts.
// TYPED store ports + an explicit capability matrix + composite storage, instead of "a single generic journal".
// PRESERVED moat: RunJournal = append-only journal (replay/time-travel). Other concerns are connected to
// whichever store fits best (composite), as needed. Contracts (pagination/cursor, mandatory CAS) are baked in from day one.
//
// NOTE: this file contains ONLY the INTERFACE + pure helpers (NO storage implementation) → the @gnldev/durable
// core stays thin; concrete impls (in-memory/sqlite/postgres-storage) implement these ports.

import type { Journal, JournalEntry, RunSummary, JournalReader, RunStatus } from './journal.js';
import type { RunOrder } from './run-cursor.js';
import { VectorOwnerConflictError, AdoptionConflictError } from './errors.js';
import { assertOwnerId, isWellFormed, OwnerIdError } from './owned-name.js';
import { ORG_KEY_PREFIX, isOrganizationKey, parseOrganizationKey, orgSpaceSql, prefixSql } from './organization.js';
import { refuseUnknownNames } from '@gnldev/options';
import { COMPOSITE_NAMES } from './option-names.js';
import { withBirth } from './run-identity.js';

// ── Common ──────────────────────────────────────────────────────────────────

/**
 * A page. If there's no `nextCursor`, it's the last page.
 *
 * `nextCursor` is OPAQUE to the caller: pass it back verbatim, never construct or parse one. That is
 * the contract; the encoding is not, and every adapter is free to change it.
 *
 * This used to claim the cursor was "NOT offset → O(log n) on a btree". It was neither: every
 * first-party adapter reads it as a row offset (`Number(q.cursor)`) and issues `LIMIT … OFFSET …`,
 * so a deep page costs a scan of everything before it, and a row inserted or deleted between two
 * requests shifts the window under the reader. Saying otherwise made the weaker guarantee look like
 * the stronger one — the reason the claim is written the other way round now is that a keyset cursor
 * is a change we intend to make, and the opacity above is what keeps it from being a breaking one.
 *
 * `WorkStore.list` is the first list that made it: its cursor is persisted by the queue and the
 * events consumer, so a window that shifts under the reader lost work (see `WorkStore.list`).
 * `RunJournal.listRuns` is the second (see run-cursor.ts). The other lists are still offsets.
 */
export interface Page<T> {
  items: T[];
  nextCursor?: string;
}

/** List query — present on every list method from day one (adding it later would be a breaking change). */
export interface ListQuery {
  limit?: number;
  cursor?: string;
  /**
   * P0.3 (RunJournal.listRuns only — MemoryStore/WorkStore ports ignore these):
   * optional run filters. Semantics MUST match `summarizeRun`'s status derivation (journal.ts:
   * 'suspended' iff the run has ANY tool record with status:'suspended', else 'completed') and the
   * `agent` field `listRuns` already surfaces on `RunSummary` (from the run's invisible `:input`
   * entry — see the "listRuns surfaces threadId + agent" conformance test). Adapters MUST filter
   * BEFORE slicing to `limit`/`cursor` — filtering after slicing silently drops matching items off a
   * page and desyncs `nextCursor`.
   */
  status?: RunStatus;
  /**
   * (RunJournal.listRuns only.) Any of these statuses — see `JournalReader.listRunsPaged`. The set of
   * every status but 'completed' reads the `gnl_runs_open` partial index on Sqlite and Postgres.
   */
  statuses?: readonly RunStatus[];
  agent?: string;
  /**
   * WHOSE runs to return — matches `RunSummary.resourceId` exactly (same `:input`-derived field the
   * summary surfaces). Same contract as `agent`: filter BEFORE slicing to `limit`/`cursor`, or a
   * matching item silently falls off a page and `nextCursor` desyncs from what the caller has seen.
   */
  resourceId?: string;
  /**
   * WHICH JOB — an EXACT match against `RunSummary.workKey` (the caller's declared name for the unit
   * of work, from the same `:input` entry). Exact and not prefix on purpose: `invoice-4` answering
   * for `invoice-4471` turns one operator question into a different one. Same filter-before-slice
   * contract as `agent`/`resourceId`, and the same honest cost — no adapter has a column for it.
   */
  workKey?: string;
  /** Only runs no other run started (`RunSummary.parentRunId` absent). Same filter-before-slice contract. */
  topLevel?: boolean;
  /** (RunJournal.listRuns only.) Runs on this thread (`RunSummary.threadId`). Same filter-before-slice contract. */
  threadId?: string;
  /**
   * (RunJournal.listRuns only.) Runs whose id starts with this — an organization's view asks for its
   * own `org:<id>:` runs this way. Sqlite and Postgres read it as a range of the run id's index, so a
   * small slice of a large store is not found by reading the rest; any other journal filters it like
   * the others. Same filter-before-slice contract.
   */
  runIdPrefix?: string;
  /**
   * (RunJournal.listRuns only.) `'desc'` lists newest first — what a run list on a screen shows.
   * Default `'asc'`, the order runs were created in. A cursor continues in the order it was handed
   * out in; it is not a position a caller converts between the two.
   */
  order?: RunOrder;
}

// ── 1) RunJournal = the PRESERVED journal ──────────────────────────────────────
// The durable core (run/durable-model/durable-tool/run-lock/time-travel) talks to this.
// ALL replay records live here: <runId>:model/tool/input/wf:*, <runId>:lock, mem-appended:<runId>,
// AND memory's replay-memoization om:<tid>:observe|reflect:<seq>.
// A superset of the existing `Journal` + `JournalReader` → existing adapters satisfy it structurally
// (except for paged listRuns); a RunJournal can be assigned anywhere a `Journal` is expected (putIfAbsent/listKeys are MANDATORY).
export interface RunJournal {
  get<T = unknown>(key: string): Promise<T | undefined>;
  put(key: string, value: unknown): Promise<void>;
  /** MANDATORY (exactly-once): write+true if the key is absent, don't touch+false if present (atomic CAS). */
  putIfAbsent(key: string, value: unknown): Promise<boolean>;
  /** Keys starting with a given prefix. `limit`: a bounded probe (see Journal.listKeys). */
  listKeys(prefix: string, opts?: { limit?: number }): Promise<string[]>;
  /** A run's entries (model/tool), in write order. */
  readRun(runId: string): Promise<JournalEntry[]>;
  /** Runs — PAGINATED (NO full-table scan). */
  listRuns(q?: ListQuery): Promise<Page<RunSummary>>;
}

// ── 2) MemoryStore = derived/queryable conversation artifacts (NOT replay state) ──

/**
 * Whose thread a thread RECORD names: its `resourceId`, or nobody. A thread a run started with no
 * resource is indexed with `resourceId: ''` (the column is NOT NULL) so it is listed; '' names nobody,
 * exactly as no record does, so ownership reads the same as before the entry existed.
 * @internal — storage plumbing: reads a stored thread record.
 */
export function threadRecordOwner(rec: { resourceId?: string } | undefined): string | undefined {
  return rec?.resourceId || undefined;
}

export interface ThreadRecord {
  id: string;
  resourceId: string;
  title?: string;
  metadata?: Record<string, unknown>;
  parentThreadId?: string;
  createdAt: number;
  updatedAt: number;
  deletedAt?: number;
}

/** A single message row (NOT a blob log → per-message atomic insert). */
export interface MessageRecord {
  threadId: string;
  seq: number;
  role: string;
  text?: string;
  embedding?: number[];
  metadata?: Record<string, unknown>;
  ts: number;
  /** The raw AI SDK message object. */
  message: unknown;
  /**
   * Recall provenance (set ONLY on records returned by `recall()`, and only on the actual similarity
   * HITS — `messageRange` context neighbors ride along unscored). Never persisted: the adapters stamp
   * it on the per-call copy so callers can answer "WHY did this message enter the context" (see
   * MemoryContextProvenance in memory.ts / the `:memctx` journal record). Before this, every adapter
   * computed the cosine score, used it to rank, and dropped it at the return boundary.
   */
  score?: number;
}

export interface Observation {
  id: string;
  text: string;
  createdAt: number;
  sourceIds: string[];
  level: number;
  condensed?: boolean;
}

/** @internal — the storage port's own query options: gnl's memory builds them, an adapter reads them. */
export interface RecallOptions {
  topK?: number;
  threshold?: number;
  /**
   * P1.5 expand each recalled hit with its surrounding messages BY SEQ within the
   * same thread — `n` is sugar for `{before: n, after: n}` (asymmetric windows supported). Adapters
   * (in-memory/sqlite/postgres-storage) apply this AFTER topK selection, dedup overlapping windows, and
   * return the union in seq order.
   */
  messageRange?: number | { before: number; after: number };
  /**
   * P1.5 metadata filter, applied BEFORE topK selection (a filtered-out message
   * must not consume a topK slot). `{field: value}` is sugar for `{field: {$eq: value}}`. See
   * `matchFilter` for the full operator subset ($eq/$ne/$gt/$gte/$lt/$lte/$in/$nin).
   */
  filter?: Record<string, unknown>;
  scope?: 'thread' | 'resource';
  resourceId?: string;
  /** Code-only: set by an organization's view. See `MEMORY_PARTITION`. */
  readonly [MEMORY_PARTITION]?: string;
}

/**
 * The partition a memory SCAN covers — a resource-scoped `recall`, a `listThreads` — named by WHO IS
 * ASKING, never by an argument the request supplies.
 *
 * Organization rows live physically in the root store under `org:<id>:` (`withOrgStorage`), and a
 * resource id is not unique across partitions. The first fix took the partition from the anchor
 * thread id: an id under `org:acme:` ranked acme's threads. But a thread id is the client's to choose,
 * so a root caller who named its thread `org:acme:fresh` recalled acme's rows (measured through REST:
 * acme's secret in the root user's prompt), and `listThreads({ resourceId })` on the root store simply
 * listed them.
 *
 * So: a store's own methods cover the ROOT's rows — every thread outside `org:`. An organization's
 * view (`withOrgStorage`) asks for its partition by passing `[MEMORY_PARTITION]: 'org:<id>:'` in the
 * options. The key is a Symbol: code holding the view can pass it; a request body (JSON) cannot.
 * ADR-0001: "In the root scope, every organization's rows are hidden."
 */
export const MEMORY_PARTITION: unique symbol = Symbol.for('@gnldev/durable.memoryPartition');
/** The code-only option an organization's view adds to a memory scan. See `MEMORY_PARTITION`. */
export interface MemoryPartitionOption {
  readonly [MEMORY_PARTITION]?: string;
}
export type MemoryPartition = { kind: 'root' } | { kind: 'org'; prefix: string };

/**
 * A root-scope caller named a thread in the organizations' reserved space. Thrown by a root-scope
 * `AgentMemory`, and answered `400 thread_id_reserved` on every door through `requestRefusal`
 * (errors.ts): such an id is an
 * organization's physical thread id, and a root caller that could use it would read that thread, or
 * write a thread INTO that organization's partition.
 */
export class ReservedThreadIdError extends Error {
  constructor(readonly threadId: string) {
    super(
      `@gnldev/durable: thread id '${threadId}' starts with '${ORG_KEY_PREFIX}', the space organizations' threads live in, ` +
        'and this memory is the root scope\'s, which cannot name them. Use a thread id that does not start with ' +
        `'${ORG_KEY_PREFIX}'; to work inside an organization, build the memory over withOrgStorage(storage, orgId). ` +
        'A thread 0.9 let the root create under that name is moved out with migrateReservedRootThreads (@gnldev/memory).',
    );
    this.name = 'ReservedThreadIdError';
  }
}
/** Refuses a thread id a root-scope caller may not name. See `ReservedThreadIdError`. */
export function assertRootThreadId(threadId: string): string {
  if (isOrganizationKey(threadId)) throw new ReservedThreadIdError(threadId);
  return threadId;
}

/** How often each partition has been read by a store — see `partitionReadCount`. */
const partitionSeen = new Map<string, number>();

/**
 * The partition a scan's options name: the root's unless an organization's view set `MEMORY_PARTITION`.
 *
 * `org:` alone (the whole reserved space) is accepted too, for the code that must find threads 0.9 let
 * the root create under that name (`reservedRootThreads`) — never set by an organization's view.
 */
export function memoryPartitionOf(opts: MemoryPartitionOption | undefined): MemoryPartition {
  const prefix = opts?.[MEMORY_PARTITION];
  if (prefix === undefined) return { kind: 'root' };
  // Written only by withOrgStorage, from a validated orgId. Anything else is a bug worth stopping on,
  // not a reason to widen the scan.
  if (typeof prefix !== 'string' || (prefix !== ORG_KEY_PREFIX && parseOrganizationKey(prefix)?.rest !== '')) {
    throw new Error(`@gnldev/durable: invalid memory partition '${String(prefix)}' — expected 'org:<id>:'`);
  }
  partitionSeen.set(prefix, (partitionSeen.get(prefix) ?? 0) + 1);
  return { kind: 'org', prefix };
}

/**
 * How many times any store has read partition `prefix` — the organization's view reads this before and
 * after a scan. If no store read it meanwhile, the option did not reach the store: a wrapper between
 * the view and the store rebuilt the options without the Symbol, and the store scanned the ROOT's rows.
 * Code-only and in-process, like the option itself.
 */
export function partitionReadCount(prefix: string): number {
  return partitionSeen.get(prefix) ?? 0;
}

/**
 * The one check `MemoryStore.deletePartition` makes before it deletes: `partition` is an organization's
 * prefix exactly as `orgPrefix` builds it (`org:<id>:`). Anything else — the root (`''`), the whole
 * reserved space (`org:`), a key inside a partition — is refused, never widened or narrowed.
 */
export function assertOrganizationPartition(partition: string): string {
  const parsed = parseOrganizationKey(partition);
  if (parsed === undefined || parsed.rest !== '') {
    throw new Error(`@gnldev/durable: '${partition}' is not an organization's partition (\`orgPrefix(orgId)\`, 'org:<id>:') — nothing was deleted`);
  }
  return partition;
}

/** Whether thread `id` is inside `partition` — the in-process twin of the SQL adapters' condition. */
export function inMemoryPartition(partition: MemoryPartition, id: string): boolean {
  return partition.kind === 'root' ? !isOrganizationKey(id) : id.startsWith(partition.prefix);
}
/**
 * The SQL condition on thread-id column `col` for `partition`, for the two SQL adapters — the same
 * rule as `orgSpaceSql` (the prefix is bound, and the database measures it: see that function for why
 * neither `LIKE` nor a length computed in JS). `ph()` renders the next placeholder in the adapter's
 * syntax (`?` or `$k`); `params` fill them in order.
 */
export function memoryPartitionSql(partition: MemoryPartition, col: string, ph: () => string): { cond: string; params: unknown[] } {
  if (partition.kind === 'root') return orgSpaceSql(col, ph, { outside: true });
  return prefixSql(col, partition.prefix, ph);
}

/**
 * P1.5 metadata filter matcher shared by in-memory/sqlite/postgres-storage's
 * `MemoryStore.recall` (previously three independent copies of a plain exact-equality matcher — unified
 * here so the operator set can't drift between adapters). ALL top-level fields in `filter` must match
 * (AND). A bare value is sugar for `$eq`: `{lang: 'tr'}` === `{lang: {$eq: 'tr'}}`.
 * Operators: $eq, $ne, $gt, $gte, $lt, $lte, $in, $nin (a common filter-operator subset — the two extra
 * operators some other implementations have beyond this, $contains/$exists, are deferred; not table-stakes per the P1.5 audit finding).
 */
export function matchFilter(meta: Record<string, unknown> | undefined, filter: Record<string, unknown>): boolean {
  if (!meta) return false;
  return Object.entries(filter).every(([field, spec]) => {
    const val = meta[field];
    if (spec !== null && typeof spec === 'object' && !Array.isArray(spec)) {
      return Object.entries(spec as Record<string, unknown>).every(([op, target]) => matchFilterOp(val, op, target));
    }
    return val === spec;
  });
}

function matchFilterOp(val: unknown, op: string, target: unknown): boolean {
  switch (op) {
    case '$eq': return val === target;
    case '$ne': return val !== target;
    case '$gt': return comparable(val, target) && (val as any) > (target as any);
    case '$gte': return comparable(val, target) && (val as any) >= (target as any);
    case '$lt': return comparable(val, target) && (val as any) < (target as any);
    case '$lte': return comparable(val, target) && (val as any) <= (target as any);
    case '$in': return Array.isArray(target) && target.includes(val);
    case '$nin': return Array.isArray(target) && !target.includes(val);
    default: return false; // unknown operator → fail closed (never silently treated as a pass-through match)
  }
}
// $gt/$gte/$lt/$lte only make sense between values of the SAME orderable type (number/string) — a type
// mismatch (e.g. comparing a string field against a number target) is a non-match, not a coerced compare.
function comparable(a: unknown, b: unknown): boolean {
  return (typeof a === 'number' || typeof a === 'string') && typeof a === typeof b;
}

/**
 * A message on the way IN. Identical to `MessageRecord` except that `seq` may be omitted, in which
 * case the store assigns it (see `MemoryStore.appendMessages`).
 *
 * Widening the existing parameter rather than adding a second method is deliberate: `cloneThread` and
 * transcript import genuinely need to place rows at chosen positions, so both modes have to exist, and
 * two methods would mean the same INSERT written twice in every adapter. `MessageRecord[]` is still
 * assignable here, so callers that pass explicit positions are unaffected.
 */
export type MessageAppend = Omit<MessageRecord, 'seq'> & { seq?: number };

/**
 * A batch either assigns every position or supplies every position — never both.
 *
 * Mixing them was measured losing rows INSIDE the all-or-nothing transaction: with `[{seq:2}, {}, {}]`
 * the store computed `next = MAX(seq)+1 = 2`, the explicit row also claimed 2, and one of them was
 * dropped — five rows expected, four stored. That is a partially persisted batch, which is exactly the
 * shape this whole design exists to make impossible. There is no legitimate caller for a mixed batch:
 * `AgentMemory.append` supplies none, `cloneThread` and transcript import supply all.
 *
 * Returns true when the store must assign positions.
 */
export function assertUniformSeq(threadId: string, rows: MessageAppend[]): boolean {
  const explicit = rows.reduce((n, r) => n + (r.seq === undefined ? 0 : 1), 0);
  if (explicit !== 0 && explicit !== rows.length) {
    throw new Error(`appendMessages(${threadId}): a batch must either supply 'seq' on every row or on `
      + `none — got ${explicit} of ${rows.length}. Mixing them makes the store assign a position a row `
      + `in the same batch already claims, and one of the two is lost.`);
  }
  return explicit === 0;
}

/**
 * The scope ids working memory is stored under, one namespace per scope, so no thread id can name a
 * person's working memory.
 *
 * Thread-scoped working memory used to live under the bare thread id and a person's under
 * `res:<resourceId>`. A caller who picked the thread id `res:u-ayse` (an anonymous caller, or any
 * thread-scoped agent on the same storage) read Ayse's working memory into its system prompt and could
 * write it through `updateWorkingMemory`. The two prefixes below cannot collide: every thread's key
 * begins `thread:`, every person's `resource:`.
 *
 * `MemoryStore.deleteThread` removes `workingMemoryScope.thread(id)`; a person's goes with
 * `eraseSubject`, through `deleteWorkingMemory(workingMemoryScope.resource(id))`.
 */
export const workingMemoryScope = {
  thread: (threadId: string): string => `thread:${threadId}`,
  resource: (resourceId: string): string => `resource:${resourceId}`,
} as const;

/**
 * Where 0.6.0 kept working memory: a person's under `res:<resourceId>`, a thread's under its bare id
 * (inside an organization both carry the `org:<id>:` prefix, which `withOrgStorage` adds). 0.7 no
 * longer reads these keys, so a record left there is a person's data nothing shows and nothing
 * erased — until `eraseSubject` and `MemoryStore.deleteThread` removed it too. `migrateWorkingMemoryKeys`
 * in @gnldev/memory moves it to `workingMemoryScope`.
 *
 * `thread` answers `undefined` for an id whose bare key is ambiguous: one that begins with a working-
 * memory prefix (`thread:`, `resource:`, `res:`), after an organization prefix if there is one. In 0.6
 * the thread `res:u-ayse` and the person `u-ayse` shared one key, and the thread `resource:u-ayse`
 * would now name Ayse's 0.7 record; deleting such a thread must not delete a person's working memory.
 */
export const legacyWorkingMemoryScope = {
  thread: (threadId: string): string | undefined => {
    const bare = parseOrganizationKey(threadId)?.rest ?? threadId;
    return /^(thread|resource|res):/.test(bare) ? undefined : threadId;
  },
  resource: (resourceId: string): string => `res:${resourceId}`,
} as const;

export interface MemoryStore {
  upsertThread(rec: ThreadRecord): Promise<void>;
  getThread(id: string): Promise<ThreadRecord | undefined>;
  /** If resourceId is given, that user's threads; otherwise global (studio). PAGINATED. */
  /**
   * Threads, newest first — in the caller's partition only, like `recall`: the root store lists no
   * organization's thread, and an organization's view lists its own (`MEMORY_PARTITION`).
   */
  listThreads(q: { resourceId?: string } & ListQuery & MemoryPartitionOption): Promise<Page<ThreadRecord>>;
  /**
   * THIS STORE'S HALF of a thread delete: the thread record, its messages, observations, batch markers
   * and its thread-scoped working memory (`workingMemoryScope.thread(id)`, and the 0.6 key
   * `legacyWorkingMemoryScope.thread(id)` when there is one). The record goes with the rest, not as a
   * tombstone: one kept its owner's id and the thread's id after an erasure, and nothing read it — every
   * reader already skipped it — so it served no purpose but to name the person.
   *
   * ATOMIC AGAINST AN APPEND: a batch's rows and its marker go together or stay together — an append
   * lands wholly before the delete or wholly after it. A run deleted while it runs takes back what it
   * appended after the deletion by its marker (`retractBatch`); rows whose marker went without them
   * stay in the deleted thread for good. The shipped stores hold the thread's append lock across one
   * transaction (Postgres) or delete in one transaction (Sqlite).
   *
   * Not a thread delete by itself: the thread's runs, its journal state, its observation vectors and
   * its owner record live elsewhere. `purgeThread(journal, id, { memory: store })` (model.ts's plan, or
   * `AgentMemory.deleteThread`) deletes all of it and calls this as one of its steps.
   */
  deleteThread(id: string): Promise<void>;

  /**
   * Append messages to the tail of a thread, atomically.
   *
   * `seq` IS OPTIONAL, and omitting it is the normal case. The store then assigns the next positions
   * itself, inside the same transaction that writes the rows, serialised per thread — so two callers
   * appending at once both land, one after the other, and neither loses anything.
   *
   * Supply `seq` only when you are reproducing positions that already have meaning: cloning a thread,
   * or importing a transcript. Those rows are written exactly where you say, and `(threadId, seq)` is
   * a CAS key, so writing the same row twice leaves one copy.
   *
   * WHY THIS IS NOT THE CALLER'S JOB. It used to be: `AgentMemory.append` read the thread, took
   * `existing.length` as the next position, and wrote there. Two runs answering one thread both read
   * the same length, both claimed the same positions, and `ON CONFLICT DO NOTHING` silently discarded
   * the loser — measured at a third of all messages under a three-way concurrent turn. A position is
   * only meaningful relative to the tail at the instant of writing, so only the writer can assign it.
   *
   * The previous version of this comment promised that "a concurrent append neither loses nor
   * double-writes". The first half was false in exactly the way above; the second half was true but
   * not because of this method — replay protection comes from the run-level marker in run.ts, and
   * appending the same batch twice through `AgentMemory` was measured to produce two copies.
   *
   * The batch is all-or-nothing. A half-written batch is worse than a lost one: a `tool-call` whose
   * `tool-result` never arrived makes later turns on that thread fail at the provider, until it
   * slides out of the memory window — five consecutive failures, measured, with the default preset.
   */
  appendMessages: (threadId: string, rows: MessageAppend[]) => Promise<void>;
  /**
   * Append a batch AT MOST ONCE, identified by `batchKey`. Returns false when that key was already
   * applied to this thread, in which case nothing is written.
   *
   * OPTIONAL. A store without it falls back to the run-level marker in run.ts, which is weaker in a
   * way worth stating: that marker is written AFTER the append returns, so a process that dies in
   * between leaves it unset, and the retry appends the whole turn a second time — same `toolCallId`
   * included, which real providers reject. Measured on sqlite through the full run path: 25 rows
   * became 50. Implementing this closes that window by construction, because the identity and the
   * rows land in one transaction and "written but not marked" stops existing.
   *
   * The key belongs beside the messages, not in the journal: that is what lets `composite()` put the
   * journal on one engine and memory on another without the guarantee falling apart.
   */
  appendMessagesOnce?: (threadId: string, rows: MessageAppend[], batchKey: string) => Promise<boolean>;
  /** Thread messages — PAGINATED (NO blob loading). */
  getMessages(threadId: string, q?: ListQuery): Promise<Page<MessageRecord>>;
  /**
   * Vector recall (thread or resource scope).
   *
   * `scope: 'resource'` ranks the user's threads in the CALLER'S partition only — the root's, or the
   * organization's whose view is asking (`MEMORY_PARTITION`) — never one derived from `threadId`. A
   * resource id names a user of one scope: `u-1` in the root and `u-1` in organization acme are two
   * people, and the root's recall must not return `org:acme:` rows (ADR-0001: "In the root scope, every
   * organization's rows are hidden"). The partition is applied BEFORE `topK`, so a foreign row can never
   * take a slot. To search one organization's threads, recall through that organization's view:
   * `withOrgStorage(storage, orgId).memory.recall(...)`.
   */
  recall(threadId: string, queryEmbedding: number[], opts: RecallOptions): Promise<MessageRecord[]>;

  /** `scopeId` is a `workingMemoryScope` key. */
  getWorkingMemory(scopeId: string): Promise<unknown>;
  setWorkingMemory(scopeId: string, data: unknown): Promise<void>;
  /** Removes the record, not only its value: a person's key names them. Returns whether one existed. */
  deleteWorkingMemory(scopeId: string): Promise<boolean>;

  /** ONLY final/derived observation texts (LLM-memoization stays in RunJournal). */
  getObservations(threadId: string): Promise<Observation[]>;
  putObservations(threadId: string, obs: Observation[]): Promise<void>;

  /**
   * FLOW-10 (optional capability): truncate a thread's tail — deletes every message with
   * `seq > afterSeq`; `afterSeq` itself, and everything before it, is KEPT (afterSeq is EXCLUSIVE
   * as a delete boundary, INCLUSIVE as a keep boundary). Anchored on `MessageRecord.seq` — a stable
   * per-thread sequence number — rather than a list index, because an index can shift under a
   * concurrent append while `seq` cannot.
   * Use case: "edit & resend" / "regenerate" in a chat UI. Today those flows only truncate the
   * CLIENT's view; the server-side thread keeps both the abandoned and the corrected turn, so the
   * next run replays both back to the model. This method lets a caller make the server's history
   * match what the user sees after such an edit.
   * Returns the number of messages actually removed, so a caller can surface e.g. "6 messages
   * removed" to the user.
   * Boundary behavior: unknown/nonexistent threadId → 0, never throws. `afterSeq` at or above the
   * thread's highest existing seq (nothing to remove) → 0. `afterSeq` below the thread's lowest
   * existing seq → removes ALL of the thread's messages and returns that count.
   * OPTIONAL: adapters that don't implement this leave the method `undefined`. Callers MUST treat an
   * absent method as "capability not available" (e.g. respond 501 / fall back) — never call it
   * unconditionally.
   */
  deleteMessagesAfter?(threadId: string, afterSeq: number): Promise<number>;

  /**
   * (optional) Takes back what `appendMessagesOnce` wrote under `batchKey` on this thread: those rows
   * and the batch's own record. Returns how many messages went; an unknown batch is 0.
   *
   * Called by a worker whose run was deleted while it ran (erasure-fence.ts): the turn it appended after
   * the deletion is the deleted run's, and only the worker knows which batch it was. Without it a turn
   * written in that moment stayed in the thread for good — nothing named it any more, so no later
   * erasure could find it (measured, c-erasure CE-2). Every bundled store implements it.
   */
  retractBatch?(threadId: string, batchKey: string): Promise<number>;

  /**
   * (optional) Deletes EVERY row of one partition — `org:<id>:` — in every table this store keeps: the
   * threads, their messages, observations and batch markers, and every working-memory record (a
   * thread's and a person's alike). The memory-store half of an organization's deletion
   * (`purgeOrganization`, model.ts `ORGANIZATION_DEPENDENTS`); the rows go outright, with no tombstone,
   * so an organization registered again under the id starts empty. Returns how many rows went.
   *
   * Refuses (throws) anything but an organization's prefix (`orgPrefix`): the root has no partition this
   * method may name. Not offered through an organization's view: an organization does not delete itself.
   */
  deletePartition?(partition: string): Promise<number>;
}

// ── 3) VectorStore = RAG corpus (structurally compatible with the rag package) ─

export interface VectorDoc {
  id: string;
  text: string;
  metadata?: Record<string, unknown>;
  /**
   * Partition this document belongs to. Documents in different namespaces never see each other.
   *
   * `undefined` is its own partition — the un-namespaced one — and is NOT a wildcard. That asymmetry is
   * the point: a store written before namespaces existed keeps every document in it, and a caller that
   * asks for namespace `x` must never be answered from it. See `VectorQueryOptions.namespace`.
   */
  namespace?: string;
  /**
   * The end user this document belongs to, inside its namespace. A document is either someone's
   * (`owner`), everyone's (`shared: true`), or unlabelled — and an unlabelled one is visible to no end
   * user. See `VectorQueryOptions.visibleTo`.
   */
  owner?: string;
  /** Visible to every end user of the namespace: the organization's general documents. */
  shared?: boolean;
}
export interface VectorItem extends VectorDoc {
  embedding: number[];
}
export interface VectorMatch extends VectorDoc {
  score: number;
}
/**
 * Narrows which documents a query may be answered from — see `VectorStore.query`.
 * @internal — the storage port's own query options: gnl's readers build them, an adapter reads them.
 */
export interface VectorQueryOptions extends VectorPartitionOption, VectorAllPartitionsOption {
  /**
   * Only documents in this namespace are eligible. Omitted means the ROOT's documents: every
   * namespace that is not an organization's (`org:<id>`), and documents with none. ADR-0001: in the
   * root scope every organization's rows are hidden, as a memory scan is (`MEMORY_PARTITION`). Code
   * that must search every organization too passes `[VECTOR_ALL_PARTITIONS]: true`.
   *
   * `withOrgStorage` supplies it on every call, so an organization-scoped store cannot be queried
   * without one. That is deliberate: an optional filter defaulting to unrestricted is safe as a port
   * contract and unsafe as an isolation mechanism, so the isolation lives in the wrapper — which
   * always passes it — rather than in this default.
   */
  namespace?: string;
  /**
   * Answer on behalf of this end user: only documents that are theirs (`owner`) or everyone's
   * (`shared`). An unlabelled document is neither — a label forgotten at upload reads as "not found",
   * never as "everyone's". Omitted means no end user, and nothing is narrowed.
   */
  visibleTo?: string;
  /**
   * Metadata narrowing, before ranking: every key must equal (`===`) the document's metadata value
   * (`vectorMetadataMatches`). `createRagTool` passes its `filter` here; this storage ignored it, so a
   * RAG tool with a filter answered from outside it on every `@gnldev/durable` store.
   */
  filter?: Record<string, unknown>;
}

/** What `VectorStore.delete` removes: every given condition must match. No condition removes nothing. */
export interface VectorDeleteWhere extends VectorPartitionOption, VectorAllPartitionsOption {
  /*
   * Without a `namespace`, a delete takes the ROOT's documents only — `outsideOrganizations` is the
   * default (`vectorDeletePlan`). An erasure of the same id in every organization passes
   * `[VECTOR_ALL_PARTITIONS]: true` (`purgeResource` without `outsideOrganizations`).
   */
  ids?: string[];
  /** Every document of this end user — the erasure path (`purgeResource(…, { vectors })`). */
  owner?: string;
  namespace?: string;
  /**
   * Only documents OUTSIDE every organization: no namespace, or one that is not an organization's
   * (`org:<id>`, the namespace `withOrgStorage` writes). The documents half of `purgeResource`'s
   * `outsideOrganizations`: erasing the organization-less `bob` named the owner alone and also took
   * acme's and globex's `bob`, who are other people. It narrows, it never selects: alone it is no
   * condition, and with an organization's `namespace` it matches nothing.
   *
   * A store that honours it says so with `VectorStore.rootOutsideOrganizations`. One written before
   * it would read this delete as "the owner everywhere", so erasure refuses such a store.
   */
  outsideOrganizations?: boolean;
  /** Metadata narrowing, as `VectorQueryOptions.filter`. An empty filter is no condition. */
  filter?: Record<string, unknown>;
}

/**
 * The metadata key that marks a vector as an observation of observational memory (@gnldev/memory
 * writes the observation's id under it). @gnldev/rag's document cleanup leaves such a record alone
 * when it sits at a document's raw id — one name, owned here, instead of a literal in each package.
 */
export const OBSERVATION_VECTOR_KEY = 'obsId';

/**
 * The metadata key that names the document a vector is a chunk of (@gnldev/rag's `chunkDocuments`
 * writes the document's id under it). Every store in this repository indexes it, so finding one
 * document's records costs a lookup, not a scan of the table: `ingestDocuments` lists a document after
 * each write, and a scan made re-indexing N documents cost N × the table (measured, SQLite, 8000 rows:
 * 99% of an ingest was that scan).
 */
export const VECTOR_DOCUMENT_KEY = '__gnlDoc';

/**
 * The document a record belongs to, as a store indexes it: the `VECTOR_DOCUMENT_KEY` value when it is
 * a string every store holds unchanged. Anything else is "no document" — such a record is never found
 * through the index, and a filter naming such a value is read by scanning (see `vectorFilterDocument`).
 */
export function vectorDocumentOf(metadata: Record<string, unknown> | undefined): string | undefined {
  const d = metadata?.[VECTOR_DOCUMENT_KEY];
  return typeof d === 'string' && isWellFormed(d) && !d.includes('\u0000') ? d : undefined;
}

/**
 * The document a metadata filter names, when the index can answer it: the filter's
 * `VECTOR_DOCUMENT_KEY` value, under the same rule as `vectorDocumentOf`. A store narrows to the
 * index's rows for it and still applies the whole filter (`vectorMetadataMatches`) to them, so the
 * index only ever removes rows the filter would remove.
 */
export function vectorFilterDocument(filter: Record<string, unknown> | undefined): string | undefined {
  return filter && Object.prototype.hasOwnProperty.call(filter, VECTOR_DOCUMENT_KEY) ? vectorDocumentOf(filter) : undefined;
}

/** The metadata narrowing of `filter` on a query or a delete: every key equals (`===`), as in @gnldev/rag. */
export function vectorMetadataMatches(metadata: Record<string, unknown> | undefined, filter: Record<string, unknown> | undefined): boolean {
  if (!filter) return true;
  const m = metadata ?? {};
  return Object.entries(filter).every(([k, v]) => m[k] === v);
}

/*
 * THE VECTOR WRITE RULE. Every store — the three in this package and the three in @gnldev/rag — runs
 * the same functions below, and one contract test (vector-store-contract.test.ts) feeds them all the
 * same input. Each store used to carry its own copy of these checks, and the copies disagreed: one
 * batch naming the same id under two owners was the second owner's document in memory, the first
 * owner's in Postgres, and a refused half-written batch in SQLite.
 */

type VectorLabels = { id: string; namespace?: unknown; owner?: unknown; shared?: unknown };

/**
 * The batch a store may write, checked before anything is written, so a refused batch leaves no half:
 *
 * - `shared` is `true`, `false` or absent. The SQL stores read any truthy `shared` as shared and the
 *   others only `true`, so `shared: "false"` from a JSON form was a private document in one store and
 *   everyone's in the next.
 * - `owner` is an id an end user can carry — the one owner-id rule, `ownerIdProblem`.
 * - `namespace` is a non-empty string or absent. `''` is refused: the Postgres stores compare
 *   labels with `COALESCE(namespace, '')`, where it is the un-namespaced partition.
 * - `id`, `owner` and `namespace` hold no lone surrogate: Postgres stores one as U+FFFD, so two
 *   owners became one there and stayed two in memory.
 * - The same id twice in one batch is one document: under the same labels the last copy wins, under
 *   different ones the batch is refused (`VectorOwnerConflictError`) — the same takeover as a second
 *   upsert, only in one call.
 *
 * Returns the batch with repeated ids collapsed to their last copy. The stored documents are then
 * checked with `assertSameVectorOwner`, by the store that can read them.
 */
export function vectorWriteBatch<T extends VectorLabels>(items: readonly T[]): T[] {
  const byId = new Map<string, T>();
  for (const it of items) {
    // A NUL is refused too: Postgres text cannot hold one, so the same id stored in memory or SQLite
    // failed there — half-way through a batch, after earlier documents' old chunks were deleted.
    if (typeof it.id !== 'string' || it.id === '' || !isWellFormed(it.id) || it.id.includes('\u0000')) {
      throw new TypeError(`@gnldev/durable: a document id must be a non-empty, well-formed string without NUL — got ${JSON.stringify(it.id)}`);
    }
    if (it.shared !== undefined && it.shared !== true && it.shared !== false) {
      throw new TypeError(`@gnldev/durable: document '${it.id}': 'shared' must be true, false or absent — got ${JSON.stringify(it.shared)}`);
    }
    if (it.owner !== undefined) {
      assertOwnerId(it.owner, `document '${it.id}': 'owner'`);
      if (!isWellFormed(it.owner)) throw new OwnerIdError('lone surrogate', `document '${it.id}': 'owner'`);
    }
    if (it.namespace !== undefined && (typeof it.namespace !== 'string' || it.namespace === '' || !isWellFormed(it.namespace))) {
      throw new TypeError(`@gnldev/durable: document '${it.id}': 'namespace' must be a non-empty, well-formed string or absent — got ${JSON.stringify(it.namespace)}`);
    }
    assertRootVectorNames({ namespace: it.namespace, ids: [it.id], [VECTOR_PARTITION]: (it as VectorPartitionOption)[VECTOR_PARTITION] });
    const before = byId.get(it.id);
    if (before) assertSameVectorOwner(before, it);
    byId.delete(it.id); // re-inserted, so the survivor sits where its last copy was
    byId.set(it.id, it);
  }
  return [...byId.values()];
}

/**
 * What an in-memory store keeps: a copy, as the SQL stores keep one — a caller changing its item
 * after the upsert (its text, its metadata, its `owner`) changes nothing stored.
 */
export function vectorItemCopy(it: VectorItem): VectorItem {
  // The grant (`VECTOR_PARTITION`) is the call's, not the document's: stored, it would come back on a
  // match the root could re-upsert as an organization's.
  const { [VECTOR_PARTITION]: _grant, ...doc } = it as VectorItem & VectorPartitionOption;
  return { ...doc, embedding: [...it.embedding], ...(it.metadata ? { metadata: structuredClone(it.metadata) } : {}) };
}

/**
 * An upsert updates a document; it does not move it to another owner, label or partition. The one
 * rule every store applies before writing over an existing id.
 * @internal — storage adapter plumbing.
 */
export function assertSameVectorOwner(
  existing: { namespace?: unknown; owner?: unknown; shared?: unknown } | undefined,
  incoming: VectorLabels,
): void {
  if (!existing) return;
  const same = (existing.namespace ?? undefined) === incoming.namespace
    && (existing.owner ?? undefined) === incoming.owner
    && !!existing.shared === !!incoming.shared;
  if (!same) {
    throw new VectorOwnerConflictError(
      `@gnldev/durable: document '${incoming.id}' already exists with a different owner or label — an upsert updates a ` +
        'document, it does not hand it to someone else. Use another id, or delete the document first.',
      { id: incoming.id },
    );
  }
}

/**
 * `visibleTo: SHARED_ONLY` narrows to the general shelf alone — what a caller whose identity was lost
 * (`unknown`, run-identity.ts) may read. It is the empty string: no document may be owned by ''
 * (vectorWriteBatch), so every store's existing `owner = visibleTo` test answers false for it.
 */
export const SHARED_ONLY = '';

/**
 * The narrowing a store applies to a query, as it should pass it on — `none` when nothing can match.
 * A `visibleTo` or `namespace` holding a lone surrogate names nobody (no document can carry one,
 * `vectorWriteBatch`), but Postgres would compare it as U+FFFD and answer with someone else's
 * documents; so it reads here as what it means in every store: the general shelf, or nothing.
 * @internal — storage adapter plumbing.
 */
export function vectorQueryScope(opts: ({ namespace?: string; visibleTo?: string } & VectorPartitionOption & VectorAllPartitionsOption) | undefined): { namespace?: string; visibleTo?: string; none: boolean; outsideOrganizations: boolean } {
  if (opts) assertRootVectorNames(opts);
  // No namespace is the ROOT's partition (ADR-0001), unless the caller holds the code-only grant.
  const out: { namespace?: string; visibleTo?: string; none: boolean; outsideOrganizations: boolean } = {
    none: false, outsideOrganizations: opts?.namespace === undefined && opts?.[VECTOR_ALL_PARTITIONS] !== true,
  };
  if (opts?.namespace !== undefined) {
    out.namespace = opts.namespace;
    if (!isWellFormed(opts.namespace)) out.none = true;
  }
  if (opts?.visibleTo !== undefined) out.visibleTo = isWellFormed(opts.visibleTo) ? opts.visibleTo : SHARED_ONLY;
  return out;
}

/**
 * The one reading of `VectorQueryOptions.visibleTo`, shared by every implementation that filters in code.
 * @internal — storage adapter plumbing.
 */
export function visibleToSubject(doc: { owner?: string; shared?: boolean }, visibleTo: string | undefined): boolean {
  return visibleTo === undefined || doc.shared === true || (doc.owner !== undefined && doc.owner === visibleTo);
}

/**
 * What a `delete` may touch, the same in every store — or `null` when it touches nothing. No condition
 * (`{}`, `{ ids: [] }`, `{ filter: {} }`) removes nothing: an empty filter matched EVERY document in
 * one store and was a SQL syntax error in another. A condition holding a lone surrogate names no
 * document either, where Postgres would compare it as U+FFFD: erasing user `u\uD800` must not delete
 * `u\uFFFD`'s documents.
 */
export function vectorDeletePlan(where: VectorDeleteWhere): VectorDeleteWhere | null {
  assertRootVectorNames(where);
  const ids = where.ids?.filter((id) => typeof id === 'string' && isWellFormed(id));
  if (ids !== undefined && ids.length === 0) return null;
  if (where.owner !== undefined && !isWellFormed(where.owner)) return null;
  if (where.namespace !== undefined && !isWellFormed(where.namespace)) return null;
  // Outside every organization and inside one names no document. With another namespace the flag
  // already holds, so the plan drops it and the store sees a plain namespace.
  // No namespace is the ROOT's partition (ADR-0001): `outsideOrganizations` unless the caller holds
  // the code-only grant to reach every organization too (`VECTOR_ALL_PARTITIONS`).
  const outside = where.outsideOrganizations === true
    || (where.namespace === undefined && (where as VectorAllPartitionsOption)[VECTOR_ALL_PARTITIONS] !== true);
  if (outside && vectorInOrganization(where.namespace)) return null;
  const filter = where.filter !== undefined && Object.keys(where.filter).length > 0 ? where.filter : undefined;
  // `outsideOrganizations` narrows and never selects: `{ outsideOrganizations: true }` alone would be
  // every document of every organization-less person.
  if (ids === undefined && where.owner === undefined && where.namespace === undefined && filter === undefined) return null;
  return {
    ...(ids ? { ids } : {}),
    ...(where.owner !== undefined ? { owner: where.owner } : {}),
    ...(where.namespace !== undefined ? { namespace: where.namespace } : {}),
    ...(outside && where.namespace === undefined ? { outsideOrganizations: true } : {}),
    ...(filter ? { filter } : {}),
  };
}

/*
 * WHICH DOCUMENTS ARE AN ORGANIZATION'S. `withOrgStorage` writes acme's documents under the namespace
 * `org:acme` (`orgPrefix` without its colon), so a namespace that starts `org:` is an organization's —
 * the same reading `purgeResource` gives a run id. Written once for the stores that filter in code
 * (`vectorInOrganization`) and once for the stores that filter in SQL (the fragment below); the
 * contract test holds the six stores to one answer. The rule is `isOrganizationKey`'s (organization.ts).
 */

/** Is this an organization's namespace? No namespace is nobody's organization. */
export function vectorInOrganization(namespace: string | null | undefined): boolean {
  return typeof namespace === 'string' && isOrganizationKey(namespace);
}

/**
 * The code-only grant an organization's view (`withOrgStorage(...).vectors`) adds to every call it
 * makes on the ROOT store: `[VECTOR_PARTITION]: 'org:<id>'` on each upserted item, on the query options
 * and on the delete condition. The vector twin of `MEMORY_PARTITION`: a Symbol, so code holding the
 * view (or building one, like an organization's observational memory) can pass it and a request body
 * (JSON) cannot.
 *
 * Without it a call is the ROOT's, and `assertRootVectorNames` refuses any namespace or id in the
 * organizations' reserved space. ADR-0001: in the root scope every organization's rows are hidden —
 * including when the caller names one.
 */
export const VECTOR_PARTITION: unique symbol = Symbol.for('@gnldev/durable.vectorPartition');
/** The code-only option an organization's view adds to a vector call. See `VECTOR_PARTITION`. */
export interface VectorPartitionOption {
  readonly [VECTOR_PARTITION]?: string;
}

/**
 * Refuses a vector store that has not declared `rootOutsideOrganizations`, before anything is touched.
 * Asked where organizations' documents would enter a store (an organization's write, `withOrgStorage`
 * or an organization's observational memory) and where the root deletes outside organizations
 * (erasure, ingest): a store that does not keep root calls outside organizations would show the root
 * an organization's documents, or delete another organization's person.
 */
export function assertRootOutsideOrganizations(vectors: Pick<VectorStore, 'rootOutsideOrganizations'>, who: string, orElse?: string): void {
  if (vectors.rootOutsideOrganizations === true) return;
  throw new Error(
    `${who}: the vector store does not declare rootOutsideOrganizations, so a root call without a namespace could reach ` +
      "organizations' documents. Nothing was written or deleted. Make its query and delete without a namespace skip " +
      '`org:` namespaces (run vectorQueryScope(opts) and vectorDeletePlan(where) and apply their `outsideOrganizations`), ' +
      'then add `readonly rootOutsideOrganizations = true`.' + (orElse ? ` ${orElse}` : ''),
  );
}

/**
 * The code-only grant to reach EVERY partition from the root store: a query or a delete without a
 * `namespace` then spans the root's documents and every organization's. Without it, such a call is the
 * root's alone (`vectorQueryScope`, `vectorDeletePlan`) — ADR-0001, as `MEMORY_PARTITION` is for memory.
 * A Symbol, so code can pass it and a request body (JSON) cannot. It names nothing: the naming rule
 * (`assertRootVectorNames`) is unchanged. Passed by `purgeResource` without `outsideOrganizations`.
 */
export const VECTOR_ALL_PARTITIONS: unique symbol = Symbol.for('@gnldev/durable.vectorAllPartitions');
/** The code-only option that widens a root vector query or delete to every partition. See `VECTOR_ALL_PARTITIONS`. */
export interface VectorAllPartitionsOption {
  readonly [VECTOR_ALL_PARTITIONS]?: true;
}

/**
 * A root-scope vector call named a namespace or an id in the organizations' reserved space (`org:`).
 * Such a namespace is an organization's partition (`withOrgStorage` writes acme's documents under
 * `org:acme`, ids `org:acme:<id>`), and a root caller that could name it would write, replace, read or
 * delete that organization's documents. Thrown by every bundled store, before anything is touched.
 */
export class ReservedVectorNameError extends Error {
  constructor(readonly what: 'namespace' | 'id', readonly value: string) {
    super(
      `@gnldev/durable: vector ${what} '${value}' starts with '${ORG_KEY_PREFIX}', the space organizations' documents live in, ` +
        'and this call is the root scope\'s, which cannot name them. Use a namespace (or id) that does not start with ' +
        `'${ORG_KEY_PREFIX}'; to work inside an organization, use withOrgStorage(storage, orgId).vectors.`,
    );
    this.name = 'ReservedVectorNameError';
  }
}

/**
 * THE ROOT-SCOPE NAMING RULE for vectors — `assertRootThreadId`'s twin, on the reading
 * `isOrganizationKey` owns. A call carrying an organization's grant (`VECTOR_PARTITION`) may name that
 * partition and ids under it, nothing else in the reserved space; a call without one names none of it.
 * Run by `vectorWriteBatch` (each item), `vectorQueryScope` and `vectorDeletePlan`, so every store
 * that runs the vector write rule refuses the same calls.
 * @internal — storage adapter plumbing.
 */
export function assertRootVectorNames(call: { namespace?: unknown; ids?: readonly unknown[] } & VectorPartitionOption): void {
  const granted = call[VECTOR_PARTITION];
  const ns = call.namespace;
  if (typeof ns === 'string' && isOrganizationKey(ns) && ns !== granted) throw new ReservedVectorNameError('namespace', ns);
  for (const id of call.ids ?? []) {
    if (typeof id === 'string' && isOrganizationKey(id) && !(granted !== undefined && id.startsWith(`${granted}:`))) {
      throw new ReservedVectorNameError('id', id);
    }
  }
}

/**
 * `outsideOrganizations` for a `namespace` column, in SQLite and Postgres alike. `substring`, not `LIKE`:
 * SQLite's LIKE ignores ASCII case, so `ORG:x` would be an organization there and nowhere else. (Not
 * `substr` or `left`: pg-mem has neither.) `NULL` is spelled out because a comparison with it is never true.
 */
export const VECTOR_OUTSIDE_ORGANIZATIONS_SQL = `(namespace IS NULL OR substring(namespace, 1, ${ORG_KEY_PREFIX.length}) <> '${ORG_KEY_PREFIX}')`;

/**
 * Which stored documents a delete plan (`vectorDeletePlan`) takes: every given condition must hold.
 * The one reading for the stores that delete in code; the SQL stores spell the same conditions.
 */
export function vectorDeleteMatcher(
  w: VectorDeleteWhere,
): (doc: { id: string; namespace?: string; owner?: string; metadata?: Record<string, unknown> }) => boolean {
  const ids = w.ids ? new Set(w.ids) : undefined;
  return (doc) => (!ids || ids.has(doc.id))
    && (w.owner === undefined || doc.owner === w.owner)
    && (w.namespace === undefined || doc.namespace === w.namespace)
    && (w.outsideOrganizations !== true || !vectorInOrganization(doc.namespace))
    && vectorMetadataMatches(doc.metadata, w.filter);
}

/**
 * The id a document adopted into an organization gets: the id `withOrgStorage` stores it under, so the
 * organization's next upsert of the same id updates it instead of adding a second one. The SQL stores
 * spell the same thing as `ns || ':' || id`; the contract test holds them to it.
 */
export const orgVectorId = (ns: string, id: string): string => `${ns}:${id}`;

/**
 * An adoption would give a legacy (un-namespaced) document an id another document already has — the
 * organization wrote the same id itself before the upgrade. Refused before anything moves, in every
 * store: renaming it anyway gave the organization two documents under one id in memory, and a raw
 * UNIQUE violation in SQL. The operator decides which copy stays.
 */
export function vectorAdoptCollision(id: string): VectorOwnerConflictError {
  return new VectorOwnerConflictError(
    `@gnldev/durable: adoptIntoOrg would store the un-namespaced document '${id}' under an id that is already taken. ` +
      'Delete or rename one of the two copies, then adopt again. Nothing was moved.',
    { id },
  );
}

export interface VectorStore {
  upsert(items: VectorItem[]): Promise<void>;
  /**
   * Nearest `topK` documents to `embedding`, most similar first.
   *
   * `opts` FILTERS BEFORE RANKING, in every implementation. Filtering afterwards would return the top
   * `topK` across all namespaces and then discard most of them, so a caller asking for 4 results from
   * its own namespace would get however few of the global top 4 happened to be its own — while looking
   * entirely correct. There would be no leak and no error; the answer would just quietly be worse for
   * every organization but the busiest one.
   */
  query(embedding: number[], topK: number, opts?: VectorQueryOptions): Promise<VectorMatch[]>;
  /** Removes the documents matching every given condition; returns how many. No condition removes nothing. */
  delete?(where: VectorDeleteWhere): Promise<number>;
  /**
   * `true` when a call WITHOUT a namespace stays outside every organization — `query` skips their
   * documents (`vectorQueryScope(opts).outsideOrganizations`) and `delete` leaves them
   * (`vectorDeletePlan`) — unless it carries `VECTOR_ALL_PARTITIONS`. ADR-0001. Declared, not assumed:
   * an organization's write into a store that does not declare it is refused
   * (`assertRootOutsideOrganizations`), so organizations' documents only ever sit in a store that keeps
   * them from the root; root erasure and root ingest refuse such a store too.
   */
  readonly rootOutsideOrganizations?: boolean;
}

// ── 4) WorkStore = queue + events + scheduler primitive (has its OWN namespace; doesn't pollute RunJournal) ──

export interface LogRecord<T = unknown> {
  id: string;
  payload: T;
  ts: number;
}

/**
 * Where a record sits in its work log: `seq` is assigned by the store (see `WorkStore.list` for when)
 * and only grows within a namespace; `seq` 0 means "not numbered yet", and `list` hands out no such
 * record. `ts` and `id` only break ties the numbering never produces; the triple is unique because
 * `id` is.
 */
export interface LogPosition {
  seq: number;
  ts: number;
  id: string;
}

const LOG_CURSOR = /^w1:(\d+):(-?\d+):([\s\S]*)$/;

/**
 * How many unnumbered records one `WorkStore.list` numbers (SQL), at least. A backlog larger
 * than this — the first read of a log written entirely by 0.9 — is numbered over successive reads,
 * oldest first; a record not numbered yet is not listed yet, and cannot be passed over for it.
 */
export const NUMBER_BATCH = 1000;

/** The opaque `nextCursor` of `WorkStore.list`: the position of the last record handed out. */
export function encodeLogCursor(p: LogPosition): string {
  return `w1:${p.seq}:${p.ts}:${p.id}`;
}

/**
 * The position a `WorkStore.list` cursor names, or `undefined` for "from the head" — which is also
 * what a cursor this store never issued means (a 0.9 row offset such as `'300'`). Reading an offset
 * as a position would skip or repeat an arbitrary stretch of the log; restarting cannot skip.
 */
export function decodeLogCursor(cursor: string | undefined): LogPosition | undefined {
  const m = cursor ? LOG_CURSOR.exec(cursor) : null;
  return m ? { seq: Number(m[1]), ts: Number(m[2]), id: m[3]! } : undefined;
}

/**
 * THE ADOPTION RULE FOR A WORK-STORE KEY — one rule, applied by every store's `adoptIntoOrg`.
 *
 * A read position (a consumer's or the queue's cursor: a value this store issued as `nextCursor`, or
 * `''`, the events package's "from the head") is NEVER carried into the organization. The log it points
 * into moves with the adoption and is RENUMBERED after the organization's own records, so the root
 * position names the wrong record there: carried, it overwrote the organization's own cursor (in-memory,
 * Redis — measured: 10 of 10 pending organization jobs stranded behind it) or collided with it (SQLite,
 * Postgres — the whole adoption refused on a raw UNIQUE error). Not carried, the organization keeps its
 * own position, and every moved record lands after it; with none, its consumers read from the head and
 * skip finished records by their markers — one re-scan, nothing runs twice.
 *
 * Any OTHER root key the organization already holds refuses the adoption before anything moves: that
 * is somebody's data, and neither copy may silently win.
 */
export function workKeyAdoption(rootValue: unknown, orgHasKey: boolean): 'move' | 'reset-position' | 'collision' {
  if (typeof rootValue === 'string' && (rootValue === '' || decodeLogCursor(rootValue) !== undefined)) return 'reset-position';
  return orgHasKey ? 'collision' : 'move';
}

/** The refusal for a work-store key both the root and the organization hold — see `workKeyAdoption`. */
export function workKeyAdoptCollision(orgKey: string): AdoptionConflictError {
  return new AdoptionConflictError(
    `@gnldev/durable: adoptIntoOrg would move a work-store key onto '${orgKey}', which the organization already holds. `
      + 'Delete one of the two (they are not a read position, so neither can be dropped for you), then adopt again. Nothing was moved.',
    { orgId: parseOrganizationKey(orgKey)?.orgId ?? '', keys: [orgKey], count: 1 },
  );
}

/** Orders two log positions: sequence, then producer time, then id (the order unnumbered records are numbered in). */
export function compareLogPosition(a: LogPosition, b: LogPosition): number {
  return a.seq - b.seq || a.ts - b.ts || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
}

export interface WorkStore {
  /** Idempotent append to an append-only log (same id → a single record). Returns eventId/jobId. */
  append(ns: string, payload: unknown, id?: string): Promise<string>;
  /**
   * List a log namespace — PAGINATED, in append order.
   *
   * THE CURSOR IS A POSITION, NOT A COUNT. @gnldev/queue (`qcursor`) and @gnldev/events
   * (`evtcursor:*`) persist `nextCursor` and resume from it in every process, so it means "every record
   * before this one has been handled". Two things may therefore never move a record across it:
   *   · a deletion (`deleteIdPrefix`, `deletePrefix`) of records BEHIND it. The cursor used to be a row
   *     offset: erasing 300 of one person's jobs shifted everyone else's rows 300 places under a cursor
   *     that stayed put, and their pending jobs never ran;
   *   · the producer's clock. Records used to be ordered by the writer's `Date.now()`, so a producer 5s
   *     behind wrote BEFORE the cursor and was never read.
   *   · the version of the process that wrote it. During a rolling deploy a 0.9 process keeps writing
   *     with its own statement, which knows nothing of positions.
   * Every bundled store orders by a store-assigned per-namespace sequence (`LogPosition`), which only
   * grows — deletions leave gaps, never reuse — and hands out the cursor as the last record's position.
   * WHERE a record gets its number differs by store, and the rule they share is that a number is
   * always above every number already handed out, so no writer, of any version, can put a record
   * behind a cursor:
   *   · in-memory: at append (one writer).
   *   · SQLite: at insert, by a trigger in the database (`gnl_work_log_number`), so a 0.9 process's
   *     INSERT on the same file is numbered too — inside its own write, under SQLite's single writer
   *     lock. A row the trigger never saw (written before it existed, or reset by `adoptIntoOrg`) is
   *     numbered by the first `list` that sees it.
   *   · Postgres: by the reader. The write is the same one 0.9 made, and `list` numbers every committed
   *     unnumbered record after all numbered ones before it reads a page, with the counter row locked
   *     until commit; a record still being written is invisible to that numbering and gets a later
   *     number when it is seen.
   * A cursor the store did not issue (a 0.9 row offset) restarts
   * at the head: the queue and the consumer skip finished records by their markers, so that costs one
   * re-scan and nothing runs twice.
   */
  list<T = unknown>(ns: string, q?: ListQuery): Promise<Page<LogRecord<T>>>;
  /** Work-scope KV (markers like qdone/qfail/qatt, sched:def — NOT in RunJournal). */
  get<T = unknown>(key: string): Promise<T | undefined>;
  put(key: string, value: unknown): Promise<void>;
  /** Exactly-once consumer ack (CAS): true on the first call, false on subsequent ones. */
  ackOnce(key: string): Promise<boolean>;
  /**
   * 8.2 (optional): atomic CONDITIONAL replace — the SAME spirit as RunJournal.putIfMatch (H1), adapted to
   * WorkStore's OWN KV schema (in WorkStore there's no separate ns+key parameter, just a single flat
   * `key` — the same addressing as get/put/ackOnce). If the key's CURRENT value matches `expected`, it
   * writes `value` + returns `true`; otherwise (different/changed/absent) it returns `false` WITHOUT
   * touching anything.
   * Usage: @gnldev/queue's terminal writes (qdone/qfail/qatt). Until now these writes were a PLAIN
   * overwrite via `put` — there was NO fencing (only the client-side `lockLost` flag, a DELAYED
   * approximation on the order of the heartbeat tick). `putIfMatch` provides an engine-internal
   * (engine-level) CAS: when a worker claims a job it writes the lock's fencing token to WorkStore;
   * RIGHT BEFORE the terminal write, this method verifies on the same key "am I still the owner" — if
   * ownership has been taken over, the write is SKIPPED (the new owner will already write its own
   * result). If undefined (an old/custom WorkStore implementation) the queue falls back to the old
   * `lockLost` approximation (a documented risk, the same the core-hardening review philosophy).
   */
  putIfMatch?(key: string, expected: unknown, value: unknown): Promise<boolean>;
  /**
   * FAZ-9 (optional): PREFIX delete across BOTH work families — log namespaces AND KV keys.
   *
   * WHY IT EXISTS: `withOrg` prefixes every work namespace and key, so one sweep of `org:<id>:` is an
   * organization's entire queue and event footprint. Until this method there was no delete on this
   * port at all, which meant `purgeOrganization` — the GDPR/KVKK erasure runbook — deleted an org's
   * journal and left its queue jobs and event log in place. That gap was documented in the retention
   * notes and in the legal brief as a promise the framework could not keep; this is the surface that
   * keeps it.
   *
   * Returns the number of records removed (log records + KV entries). Optional like the rest of this
   * port's extensions: a custom WorkStore without it makes `purgeOrganization` refuse, deleting nothing,
   * rather than report a silent success.
   */
  deletePrefix?(prefix: string): Promise<number>;
  /**
   * (optional) Delete every LOG RECORD whose id starts with `idPrefix`, in every namespace. An owned
   * job or event carries its owner in its id (`ownedName`), so this is how one person's jobs and
   * events are erased without the store knowing what a job is. The prefix is LITERAL (no wildcard
   * characters), and KV keys are not touched — only log records. Every bundled store implements it
   * (in-memory, SQLite, Postgres); `eraseSubject` refuses a work store without it.
   */
  deleteIdPrefix?(idPrefix: string): Promise<number>;
}

// ── 5) CacheStore = content-addressed cache (optional TTL) ────────────────────

export interface CacheStore {
  get<T = unknown>(key: string): Promise<T | undefined>;
  set(key: string, value: unknown, opts?: { ttlMs?: number }): Promise<void>;
  delete(key: string): Promise<void>;
  /**
   * (optional) Every entry whose key starts with `prefix` — the cache half of an organization's deletion
   * (`purgeOrganization`): an organization's view keys its entries `org:<id>:…`, and a cached answer is
   * the organization's data like any other. Literal, not a pattern. Returns how many went. Every bundled
   * store implements it; `purgeOrganization` refuses a cache without it rather than leave entries behind.
   */
  deletePrefix?(prefix: string): Promise<number>;
}

// ── 6) MetaStore = schema_version / capability persistence ────────────────────

export interface MetaStore {
  get(key: string): Promise<string | undefined>;
  set(key: string, value: string): Promise<void>;
  /** (optional) Every key starting with `prefix`, as `CacheStore.deletePrefix` — an organization's view keys its own `org:<id>:…`. */
  deletePrefix?(prefix: string): Promise<number>;
}

// ── Storage (composite) + Capability ───────────────────────────────────────

/** A port's level of support in a storage. `none` = this store must be overridden with another storage. */
export type CapabilityLevel = 'full' | 'scan' | 'ttl' | 'none';

export interface CapabilityMatrix {
  runs: CapabilityLevel; // always 'full' for a usable storage
  memory: CapabilityLevel;
  vectors: CapabilityLevel;
  work: CapabilityLevel;
  cache: CapabilityLevel;
}

/** A unit that carries all the store ports + its capability. A single storage does NOT have to provide every port. */
export interface Storage {
  readonly name: string;
  readonly capabilities: CapabilityMatrix;
  readonly runs: RunJournal;
  readonly memory?: MemoryStore;
  readonly vectors?: VectorStore;
  readonly work?: WorkStore;
  readonly cache?: CacheStore;
  readonly meta: MetaStore;
  /** Schema/table setup (idempotent). Called automatically once the storage is handed to the registry. */
  init?(): Promise<void>;
  /**
   * This process's liveness on this store (process-liveness.ts): what a detached run's executor holds
   * while it lives, and what another process asks before taking its runs over. Optional: a store that
   * only one process can reach needs none (the in-memory store), and one that others can reach and
   * cannot answer leaves the registry asking for one explicitly.
   */
  processLiveness?(): import('./process-liveness.js').ProcessLiveness | Promise<import('./process-liveness.js').ProcessLiveness>;
  close?(): Promise<void>;
  /**
   * Brings data an earlier version wrote up to this one: the steps this store has (`schema`,
   * `thread-records`, `relations` — see `UPGRADE_STEPS`), every pending one or those named in `only`.
   * `dryRun` lists them and what each would do, writing nothing — what `gnl upgrade --list` prints.
   * Each step is idempotent; until one has run, the store answers correctly at the earlier version's
   * speed. A store with nothing to upgrade leaves it out.
   */
  upgrade?(opts?: import('./upgrade.js').UpgradeOptions): Promise<import('./upgrade.js').UpgradeReport>;
  /**
   * H12 (optional): reclaiming DELETED space back to DISK (compaction). purge/sweep rows are logically
   * deleted but the engine does NOT RETURN empty pages to the OS (it reuses them → doesn't grow
   * unbounded, but the file doesn't shrink after a big purge). `compact` reclaims this space: SQLite
   * `wal_checkpoint(TRUNCATE)` + `VACUUM`; Postgres's default `VACUUM` (non-locking, returns free space
   * to the freelist — for OS-level reclaiming use `{ full: true }` → `VACUUM FULL`, which LOCKS the
   * table, only during a maintenance window). Should be called rarely, via cron (NOT on every write).
   * `reclaimedBytes` is the approximate disk reclaimed (-1 if unknown).
   */
  compact?(opts?: { full?: boolean }): Promise<{ reclaimedBytes: number }>;
  /**
   * Moves data written BEFORE organizations were configured into `orgId`.
   *
   * A deployment that ran without `org` wrote unprefixed keys. Turning organizations on does not
   * migrate them, so every one of those rows becomes invisible to organization-bound identities while
   * remaining visible to an unscoped operator — measured on a real free-tier database: the operator
   * still saw its runs, `acme` saw none. Nothing is lost and nothing leaks, but to the people using it
   * their entire history has disappeared, which is the same "the owner cannot reach their own data"
   * failure the scoping itself is written to avoid.
   *
   * ENGINE-LEVEL on purpose. The ports cannot express this: `vectors` has only `upsert`/`query`,
   * `cache` only `get`/`set`/`delete`, `meta` only `get`/`set` — none of them can enumerate what they
   * hold, so a migration written against the port interfaces could reach the run journal and the
   * conversation store and nothing else. Each adapter knows its own key layout and can move all of it.
   *
   * Only rows that are NOT already organization-prefixed are touched, so it is idempotent: running it
   * twice moves nothing the second time, and it can never nest `org:a:org:b:`. Call it ONCE, with the
   * deployment stopped — an upgrade is not a live operation, and this does not coordinate with writers.
   *
   * REFUSES an organization that is not registered (`__org__:<id>` absent), because the mistake it
   * prevents is irreversible: adopting into a mistyped id moves every row under that prefix, and
   * running it again with the correct name skips them as `alreadyScoped`. `allowUnregistered: true`
   * opts out for a deployment with no registration path.
   *
   * REFUSES while a run is still executing. Measured on SQLite with a live model call: the migration
   * moved three of the run's keys and the run wrote its next one at the root, leaving the same
   * exactly-once claim marker in two places — no error, no whole record. The transaction protects the
   * migration from failing halfway; it does not stop anything else writing meanwhile.
   * `allowInFlight: true` opts out for runs known to be abandoned.
   *
   * NEVER OVERWRITES what the organization holds (adoption.ts `onAdoptionCollision`): a root record whose
   * organization twin exists — a thread's owner record, a run, a memory thread, a meta or work key —
   * refuses the whole adoption before anything moves (`AdoptionConflictError`, every id named); a counter
   * is summed into the organization's; a cache entry (content-addressed) stays the organization's. A
   * scope's facts (`thread:records:v1`) never move.
   *
   * `dryRun` reports the same counts without writing, and refuses the same conflicts.
   */
  adoptIntoOrg?(orgId: string, opts?: { dryRun?: boolean; allowUnregistered?: boolean; allowInFlight?: boolean }): Promise<AdoptIntoOrgResult>;
}

/** What `Storage.adoptIntoOrg` moved, or would move under `dryRun` — one entry per store it touched. */
export interface AdoptIntoOrgResult {
  orgId: string;
  dryRun: boolean;
  /**
   * Rows moved into the organization, by store. A store the engine does not have is absent, not zero.
   *
   * ROWS, not logical keys, and the two differ by engine. SQLite and Postgres materialise a per-run
   * summary row (`gnl_runs`) alongside the journal entries, so they report one more than the
   * key-value engines do for the same data — measured: 5 against in-memory's 4. Nothing is
   * lost either way; a migration rehearsed on one engine simply reports a different figure than
   * production, and an operator counting with `listKeys` afterwards will find the key-value number.
   */
  moved: Record<string, number>;
  /** Rows left alone because they already carried an organization prefix. */
  alreadyScoped: number;
  /**
   * Platform-level keys deliberately NOT moved, by name — `__org__`, `__agent_registry__`, the paid
   * user store, budgets, policy, pricing. Reported rather than silent: an operator running a migration
   * is entitled to see what it decided not to touch, and this is the list that would break
   * authentication and organization registration if it were ever wrong.
   */
  skippedPlatformKeys: string[];
  /**
   * Root work-store keys that held a read position (`qcursor`, `evtcursor:*`) and were NOT carried into
   * the organization, by name — see `workKeyAdoption`. The organization's own position, if it had one,
   * is unchanged; otherwise its consumers start from the head of the log and skip what is finished.
   * Present on every bundled store's result.
   */
  resetPositions?: string[];
}

export type StoreName = keyof CapabilityMatrix;

/**
 * Wraps a RunJournal into the old `Journal & JournalReader` contract (array `listRuns` + get/put) — a
 * bridge for consumers like studio that expect a non-paginated reader. get/put/putIfAbsent/listKeys are
 * forwarded → studio sees it as "writable" (fork/resume works). (A true paginated studio integration is a later step.)
 */
/**
 * THE one answer to "is this the whole Storage" — read by toJournal, portOf, storageOf, journalOf and
 * eraseSubject alike, so every function gives the same answer for the same value.
 */
export function isStorage(x: unknown): x is Storage {
  const o = x as Record<string, unknown> | null | undefined;
  return typeof o === 'object' && o !== null && typeof o.capabilities === 'object' && o.capabilities !== null
    && typeof o.runs === 'object' && o.runs !== null;
}

/**
 * The journal view every reader takes (Studio's `reader`, `exportRun`, `sweepRuns`, …), from a
 * `Storage` or from its `runs` port; anything else is refused naming what it is.
 */
/**
 * The storage a work port belongs to (not enumerable, like `JOURNAL_SOURCE`). A job is accepted through
 * the work port alone (`enqueue(storage.work, …)`) but runs in the storage's run journal; the door reads
 * that journal through this mark to refuse a job its run could never be born for (an erased run id).
 * Each built-in storage marks its own port; `composite` marks the port it hands out as its own, since
 * its jobs run in its run journal. A port nothing marked (a host's own store) is answered by its worker.
 */
const WORK_OF = Symbol.for('@gnldev/durable.workOf');
/** @internal — a storage marks its work port as its own. */
export function markWorkOf<S extends Storage>(storage: S): S {
  if (storage.work) Object.defineProperty(storage.work, WORK_OF, { value: storage, enumerable: false, configurable: true, writable: false });
  return storage;
}
/** @internal — the storage that marked this work port, if one did. */
export function storageOfWork(work: unknown): Storage | undefined {
  const s = (work as Record<symbol, unknown> | null | undefined)?.[WORK_OF];
  return s !== undefined && isStorage(s) ? s : undefined;
}

/** The store behind a `toJournal` bridge (not enumerable: it is the bridge's identity, never copied onto a wrapper). */
export const JOURNAL_SOURCE = Symbol.for('@gnldev/durable.journalSource');

export function toJournal(source: RunJournal | Storage): Journal & JournalReader {
  const runs: RunJournal = portOf(source, 'runs', 'toJournal');
  const j: Journal & JournalReader = {
    get: (k) => runs.get(k),
    put: (k, v) => runs.put(k, v),
    putIfAbsent: (k, v) => runs.putIfAbsent(k, v),
    listKeys: (p, opts) => runs.listKeys(p, opts),
    readRun: (runId) => runs.readRun(runId),
    listRuns: async () => (await runs.listRuns({ limit: 1_000_000_000 })).items,
    // P0.3: RunJournal.listRuns is MANDATORY (unlike the optional methods forwarded in the loop below)
    // → this bridge is unconditional. Delegates straight through — every RunJournal (in-memory/sqlite/
    // postgres) already implements the filter+pagination contract itself (see each adapter's
    // listRuns), so there's nothing extra to do here beyond exposing it under the paged capability name.
    listRunsPaged: (q) => runs.listRuns(q),
  };
  // Bug: previously the optional Journal methods (deletePrefix/putIfMatch/now/incrBy/getCounters/
  // listStaleRuns/readRunStats) were NOT forwarded → even if the underlying SqliteStorage/Postgres
  // provided them, the reader capabilities wrapped by toJournal were SILENTLY DROPPED (studio
  // organization-deletion, retention/purge, budget incrBy, CAS-based paths were falling back to
  // 501/fallback). Forward every existing optional method at runtime (leave it alone if absent — old behavior preserved).
  const anyJ = j as unknown as Record<string, unknown>;
  const anyRuns = runs as unknown as Record<string, unknown>;
  // P1.6b: applyBatch/getMany/countRunsByStatus forwarded the SAME way — SqliteRunJournal/PgRunJournal
  // expose them as EXTRA (non-RunJournal-interface) methods; without this they'd be
  // silently dropped here exactly like the other optional methods were before the bug fix above.
  for (const m of ['deletePrefix', 'putIfMatch', 'now', 'incrBy', 'getCounters', 'listStaleRuns', 'readRunStats', 'applyBatch', 'getMany', 'countRunsByStatus', 'listOwnerRecords', 'countRuns', 'listRunsChangedSince', 'processLiveness', 'readRange']) {
    if (typeof anyRuns[m] === 'function') anyJ[m] = (...args: unknown[]) => (anyRuns[m] as (...a: unknown[]) => unknown).call(runs, ...args);
  }
  // The port's markers (an organization view's `ORG_SCOPE` and `ORG_PARENT`) go along too. This bridge
  // built a fresh object and dropped them, so a door's `{ storage }` org view read as the root: the
  // provider-facing idempotency key lost its `org:<id>:` part (two organizations charging one order id
  // handed the provider the same key) and an organization purge's fence was never consulted.
  for (const s of Object.getOwnPropertySymbols(runs)) {
    const d = Object.getOwnPropertyDescriptor(runs, s);
    if (d?.enumerable) Object.defineProperty(j, s, d);
  }
  // Which store this journal is: a bridge is made per call, so its identity says nothing (executors.ts).
  Object.defineProperty(j, JOURNAL_SOURCE, { value: (runs as unknown as Record<symbol, unknown>)[JOURNAL_SOURCE] ?? runs, enumerable: false });
  return withBirth(j);
}

/** Missing/insufficient capability → a clear error at wiring time (never a silent `[]`/throw mix-up). */
export class CapabilityError extends Error {
  constructor(
    readonly store: StoreName,
    readonly have: CapabilityLevel,
    readonly hint?: string,
  ) {
    super(
      `@gnldev: storage does not support the '${store}' store (capability='${have}').` +
        (hint ? ` ${hint}` : ` Override this store with a suitable storage via composite().`),
    );
    this.name = 'CapabilityError';
  }
}

/** Require a store to be present at at least the 'scan' level (throws CapabilityError otherwise). */
export function requireCapability(storage: Storage, store: StoreName): void {
  const level = storage.capabilities[store];
  if (level === 'none' || storage[storePortKey(store)] == null) {
    throw new CapabilityError(store, level);
  }
}

/** The methods that make a value a port of each kind — what `portOf` checks before trusting it. */
const PORT_METHODS = { runs: ['get', 'put', 'readRun'], work: ['append', 'put', 'ackOnce'], cache: ['get', 'set', 'delete'] } as const;
type Ports = { runs: RunJournal; work: WorkStore; cache: CacheStore };

/** What a wrong handle is, when it is a part of a storage — the one description every refusal uses. */
function partOf(o: Record<string, unknown>): string | undefined {
  if (typeof o.append === 'function' && typeof o.ackOnce === 'function') return 'a work port (storage.work)';
  if (typeof o.readRun === 'function') return 'a run journal (storage.runs)';
  if (typeof o.get === 'function' && typeof o.set === 'function' && typeof o.delete === 'function') return 'a cache port (storage.cache)';
  return undefined;
}

/**
 * THE reading of "the storage, or one of its ports" for every function that needs a port: the
 * Storage itself (its port is taken, `requireCapability` refusing one it lacks) or the port. Anything
 * else is refused naming what it is and the two calls that work.
 */
export function portOf<P extends keyof Ports>(arg: unknown, port: P, call: string): Ports[P] {
  if (arg === null || typeof arg !== 'object') {
    throw new TypeError(`${call} needs the storage or its ${port} port, got ${arg === null ? 'null' : typeof arg}. Pass the storage, or storage.${port}.`);
  }
  if (isStorage(arg)) {
    if (port !== 'runs') requireCapability(arg, port as StoreName);
    return arg[storePortKey(port as StoreName)] as unknown as Ports[P];
  }
  const o = arg as Record<string, unknown>;
  const missing = PORT_METHODS[port].filter((m) => typeof o[m] !== 'function');
  if (missing.length) {
    const was = partOf(o);
    throw new TypeError(
      `${call}: the value passed has no ${missing.join('/')} method${missing.length > 1 ? 's' : ''} — ` +
        (was ? `it is ${was}, not the ${port} port.` : `it is not a ${port} port.`) +
        ` Pass the storage, or storage.${port}.`,
    );
  }
  return arg as Ports[P];
}

/** The same for a function that needs the whole Storage (several of its ports). */
export function storageOf(arg: unknown, call: string): Storage {
  if (isStorage(arg)) return arg;
  const o = arg as Record<string, unknown> | null | undefined;
  const was = o && typeof o === 'object' ? (partOf(o) ? ` — this is ${partOf(o)}` : '') : ` — got ${o === null ? 'null' : typeof o}`;
  throw new TypeError(`${call} needs the whole storage (it reads more than one of its ports)${was}. Pass the storage itself.`);
}

/**
 * The same for a function that takes a key/value journal (the scheduler): the Storage gives its
 * journal view, a journal is taken as it is, and a work or cache port is refused naming it.
 */
export function journalOf(arg: unknown, call: string): Journal {
  if (isStorage(arg)) return toJournal(arg);
  if (arg === null || typeof arg !== 'object') {
    throw new TypeError(`${call} needs the storage or a journal, got ${arg === null ? 'null' : typeof arg}. Pass the storage, or toJournal(storage).`);
  }
  const o = arg as Record<string, unknown>;
  const was = partOf(o);
  if ((was !== undefined && was !== 'a run journal (storage.runs)') || typeof o.get !== 'function' || typeof o.put !== 'function') {
    throw new TypeError(`${call}: ${was ? `the value passed is ${was}, not a journal` : 'the value passed has no get/put — it is not a journal'}. Pass the storage, or toJournal(storage).`);
  }
  return arg as unknown as Journal;
}

function storePortKey(store: StoreName): keyof Storage {
  // capability name → Storage port field (all under the same name; a helper for narrowing the type).
  return store as keyof Storage;
}

// ── composite(): default storage + per-store override ────────────────────────

export interface CompositeConfig {
  /** The main storage that provides every undefined port (runs + meta come from here). */
  default: Storage;
  /** Route specific ports to another storage (e.g. cache: new InMemoryStorage()). */
  overrides?: Partial<Record<Exclude<StoreName, 'runs'>, Storage>>;
}

/**
 * Composite storage: takes each port from override?.[port] ?? default; recomputes the capability matrix.
 * runs + meta always come from default (replay must live in a single RunJournal). The init/close of an
 * overridden port is also called (init: all of them; close: unique storages, once each).
 */
export function composite(cfg: CompositeConfig): Storage {
  refuseUnknownNames('composite', cfg, COMPOSITE_NAMES);
  const ov = cfg.overrides ?? {};
  const pick = <K extends Exclude<StoreName, 'runs'>>(k: K): Storage => ov[k] ?? cfg.default;

  const memStorage = pick('memory');
  const vecStorage = pick('vectors');
  const workStorage = pick('work');
  const cacheStorage = pick('cache');

  const storages = new Set<Storage>([cfg.default, memStorage, vecStorage, workStorage, cacheStorage]);

  const capabilities: CapabilityMatrix = {
    runs: cfg.default.capabilities.runs,
    memory: memStorage.capabilities.memory,
    vectors: vecStorage.capabilities.vectors,
    work: workStorage.capabilities.work,
    cache: cacheStorage.capabilities.cache,
  };

  return markWorkOf({
    name: `composite(${cfg.default.name})`,
    capabilities,
    runs: cfg.default.runs,
    meta: cfg.default.meta,
    memory: memStorage.memory,
    vectors: vecStorage.vectors,
    work: workStorage.work,
    cache: cacheStorage.cache,
    async init() {
      for (const b of storages) await b.init?.();
    },
    async close() {
      for (const b of storages) await b.close?.();
    },
  });
}
