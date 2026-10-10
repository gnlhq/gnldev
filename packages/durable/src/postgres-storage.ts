// @gnldev/durable/postgres — Postgres implementation of all store ports (prod default).
// Same schema/semantics as SqliteStorage; pg async API ($N placeholders, CAS detection via RETURNING).
// Injectable pool pattern → zero-infra testing with pg-mem. `pg` is an optional peer dep.
// Vector is 'scan' for now (brute-force cosine; pgvector deferred — pg-mem compatibility + lean first cut).
import { prefixUpperBound } from './organization.js';
import { assertUniformSeq, workingMemoryScope, legacyWorkingMemoryScope } from './storage.js';
import { memoryPartitionOf, memoryPartitionSql, type MemoryPartitionOption } from './storage.js';
import { createRequire } from 'node:module';
import { cosineSimilarity } from 'ai';
import { runIdOfKey, parseJournalKey, outcomeStatusOf, runRelationsOf, relationsOfInput, ownerColumnOf, ownerOfRecord, OWNER_RECORD_LIKE, RunRowChanges, runStatusOf, runStatusCaseSql, storedOutcomeOf } from './journal.js';
import { keysetRunPage, rangeOrder, runStatusSql, openRunPredicate, decodeChangeCursor, encodeChangeCursor, type RunRelationRead } from './run-cursor.js';
import type { JournalBatch, JournalEntry, RunChange, RunStatus, RunSummary, ToolJournalRecord } from './journal.js';
import { serialize, deserialize } from './serialize.js';
import { NUMBER_BATCH, decodeLogCursor, encodeLogCursor, workKeyAdoption, workKeyAdoptCollision, matchFilter, vectorWriteBatch, assertSameVectorOwner, vectorDeletePlan, VECTOR_OUTSIDE_ORGANIZATIONS_SQL, vectorQueryScope, vectorMetadataMatches, vectorAdoptCollision, vectorDocumentOf, vectorFilterDocument } from './storage.js';
import type { AdoptIntoOrgResult,
  Storage, CapabilityMatrix, Page, ListQuery,
  RunJournal, MemoryStore, VectorStore, WorkStore, CacheStore, MetaStore,
  ThreadRecord, MessageRecord, MessageAppend, Observation, RecallOptions, VectorItem, VectorMatch, VectorQueryOptions, VectorDeleteWhere, LogRecord,
} from './storage.js';
// P2-migrate schema introspection/migration façade — see migrate.ts's header.
import { tablesFromDDL, indexesFromDDL } from './migrate.js';
import { ENGINE_META_KEYS, assertNoRunsInFlight, assertOrgRegistered, isPlatformKey, orgPrefix, orgSpaceSql } from './organization.js';
import type { SchemaCheckResult, SchemaMigrationResult, MissingColumn } from './migrate.js';
import { refuseUnknownNames } from '@gnldev/options';
import { POSTGRES_STORAGE_NAMES, ADOPT_INTO_ORG_NAMES, COMPACT_NAMES } from './option-names.js';
import { runUpgrade, threadRecordsStep, relationsStep, verifyRelationsStep, runStatusStep, runStatusPending, RUN_STATUS_FLAGS, RUN_STATUS_PENDING_MESSAGE, RELATIONS_PENDING_ADVICE, type UpgradeOptions, type UpgradeReport, type UpgradeStep } from './upgrade.js';
import { UPGRADE_NAMES } from './option-names.js';
import { SCOPE_TABLES } from './model.js';

type QueryResult = { rows: any[]; rowCount?: number | null };
type PoolClient = { query: (sql: string, params?: unknown[]) => Promise<QueryResult>; release?: (destroy?: boolean) => void };
type Pool = {
  query: (sql: string, params?: unknown[]) => Promise<QueryResult>;
  connect?: () => Promise<PoolClient>;
  end?: () => Promise<void>;
  /**
   * EventEmitter surface. TWO events, because `pg` reports a lost connection through two different
   * objects depending on whether it was busy: an IDLE connection fails on the pool, a CHECKED-OUT
   * one fails on the Client. Only the first was declared here, which is also the only one that was
   * handled — see the constructor for what that cost.
   */
  on?: {
    (event: 'error', listener: (err: Error) => void): unknown;
    (event: 'connect', listener: (client: PoolClientEvents) => void): unknown;
  };
  listenerCount?: (event: string) => number;
};
/** The EventEmitter surface of a pooled client — the object `pg` hands to the 'connect' event. */
type PoolClientEvents = {
  on?: (event: 'error', listener: (err: Error) => void) => unknown;
  listenerCount?: (event: string) => number;
};
const SCHEMA_VERSION = '1';

export interface PostgresStorageOptions {
  connectionString?: string;
  pool?: Pool;
}

function offset(q?: ListQuery) { return { start: q?.cursor ? Number(q.cursor) || 0 : 0, limit: q?.limit ?? 50 }; }
function pageOf<T>(rows: T[], start: number, limit: number, total: number): Page<T> {
  const next = start + limit;
  return { items: rows, nextCursor: next < total ? String(next) : undefined };
}
// P1.5 matchFilter is now shared (storage.ts) — see its JSDoc for the operator
// subset ($eq/$ne/$gt/$gte/$lt/$lte/$in/$nin). Import above (was a local exact-equality-only copy).
function normRange(r?: number | { before: number; after: number }) {
  if (r == null) return { before: 0, after: 0 };
  return typeof r === 'number' ? { before: r, after: r } : r;
}
const hasNorm = (v?: number[] | null): v is number[] => !!v && v.some((x) => x !== 0);

/**
 * Does plain `<` on this backend order strings by bytes?
 *
 * Every prefix scan here is a range: `key >= prefix AND key < prefix + U+FFFF`. That is only a
 * prefix under BYTE ordering. Under a linguistic collation -- en_US.utf8, the default of nearly
 * every managed Postgres -- U+FFFF is a noncharacter that collates as if absent, so the upper bound
 * reduces to `key < prefix` and the range matches NOTHING: listKeys returns empty, deletePrefix
 * deletes nothing and reports 0, with no error anywhere.
 *
 * `COLLATE "C"` fixes it, but cannot simply be hardcoded: pg-mem (which this suite runs most of its
 * Postgres tests against) rejects the statement at parse time, and its own comparison is already
 * byte order, so it does not need it. A database created with C collation does not need it either.
 *
 * So probe the behaviour instead of guessing the backend, the same way the advisory lock above is
 * best-effort rather than version-gated. Returns the clause to splice into the comparisons.
 */
type PrefixShape = {
  collate: string;
  /**
   * Whether OWNER_UNPLACE and RUN_UNPLACE guard the relation columns on this database (settled at boot).
   * Until they do, no relation column is read: lookups by person or thread walk the records.
   */
  relationGuard?: boolean;
  /** Both guards installed and enabled (settled at boot) — what placing a run with no `:input` needs; RELATIONS_VERIFY_KEY aside. */
  guardsInstalled?: boolean;
};

/**
 * An owner record REWRITTEN by a writer that leaves `owner` as it was — an older process, whose
 * statement sets the value and knows nothing of the column — goes back to "not placed" (NULL), so
 * every lookup reads it and decides from the record. Without it the column kept the previous person:
 * the record now named carl, the column still said ayse, and carl's erasure left that thread behind.
 * It lives in the database, so it holds for every writer (Sqlite's twin: OWNER_UNPLACE_TRIGGER). The
 * WHEN clause keeps it off every row that is not a placed owner record — the journal's hot writes. A
 * rewrite by this version that keeps the same person lands unplaced too: still found, from the record.
 */
const OWNER_UNPLACE = [
  `CREATE OR REPLACE FUNCTION gnl_owner_unplace() RETURNS trigger LANGUAGE plpgsql AS $$
   BEGIN
     IF NEW.value IS DISTINCT FROM OLD.value AND NEW.owner IS NOT DISTINCT FROM OLD.owner THEN NEW.owner := NULL; END IF;
     RETURN NEW;
   END $$`,
  `CREATE TRIGGER gnl_owner_unplace BEFORE UPDATE ON gnl_run_journal FOR EACH ROW
   WHEN (OLD.owner IS NOT NULL) EXECUTE FUNCTION gnl_owner_unplace()`,
];
/**
 * The same guard for a run's `gnl_runs.resource_id`/`thread_id`: a run's `:input` INSERTED or with its
 * value CHANGED leaves the run unplaced (NULL), read and decided from the record by every lookup, until
 * the writer places it. This version places it in the same transaction, after the write (`writeRunRows`),
 * so its own runs stay placed; an older process, a raw put of an unversioned record, or plain SQL does
 * not, and its record — naming carl on thread t2 — is no longer listed and erased as ayse's on t1, which
 * is what the column said before. Sqlite's twin: RUN_UNPLACE_TRIGGERS.
 */
const RUN_UNPLACE = [
  `CREATE OR REPLACE FUNCTION gnl_run_unplace() RETURNS trigger LANGUAGE plpgsql AS $$
   BEGIN
     IF TG_OP = 'UPDATE' AND NEW.value IS NOT DISTINCT FROM OLD.value THEN RETURN NULL; END IF;
     -- The table of the schema that fired it, not the writer's search_path (a data-only restore runs with an empty one).
     -- Unconditional: under REPEATABLE READ a writer that waited on the relations step still sees the run
     -- as unplaced; 'WHERE resource_id IS NOT NULL' matched nothing in that snapshot and left the step's
     -- placement standing under the old person. Updating the row it cannot see changed makes Postgres
     -- refuse the write (40001) instead — surfaced, retried by its caller.
     EXECUTE format('UPDATE %I.gnl_runs SET resource_id = NULL, thread_id = NULL WHERE run_id = $1', TG_TABLE_SCHEMA)
       USING left(NEW.key, length(NEW.key) - 6);
     RETURN NULL;
   END $$`,
  `CREATE TRIGGER gnl_run_unplace AFTER INSERT OR UPDATE OF value ON gnl_run_journal FOR EACH ROW
   WHEN (NEW.key LIKE '%:input') EXECUTE FUNCTION gnl_run_unplace()`,
];
/** The guards as the catalog has them, each with `tgenabled` ('D' = disabled; they guard nothing then). */
const RELATION_GUARDS_STATE = `SELECT t.tgname AS name, t.tgenabled::text AS enabled, p.prosrc AS body
  FROM pg_trigger t JOIN pg_proc p ON p.oid = t.tgfoid
  WHERE t.tgname IN ('gnl_owner_unplace', 'gnl_run_unplace') AND t.tgrelid = 'gnl_run_journal'::regclass`;
/** The body a guard's function must have — this version's, as `pg_proc.prosrc` stores it (the text between the `$$`). */
const guardBody = (fn: string): string => fn.slice(fn.indexOf('$$') + 2, fn.lastIndexOf('$$'));
const GUARD_BODIES: Record<string, string> = { gnl_owner_unplace: guardBody(OWNER_UNPLACE[0]!), gnl_run_unplace: guardBody(RUN_UNPLACE[0]!) };
/**
 * `gnl_meta` key set when a boot finds the guards missing or disabled on a store whose columns already
 * hold placements: writes made while nothing guarded them may have left a run or owner record placed
 * under someone its record no longer names. While it is set no column is trusted, and the `relations`
 * step clears every placement and places again from the records, then removes it.
 */
const RELATIONS_VERIFY_KEY = 'relations_verify';

const DDL = [
  `CREATE TABLE IF NOT EXISTS gnl_meta (k TEXT PRIMARY KEY, v TEXT NOT NULL)`,
  `CREATE TABLE IF NOT EXISTS gnl_run_journal (key TEXT PRIMARY KEY, run_id TEXT, kind TEXT, suspended BOOLEAN NOT NULL DEFAULT false, value TEXT NOT NULL, created_at BIGINT NOT NULL, owner TEXT, ord BIGINT NOT NULL DEFAULT 0)`,
  `CREATE INDEX IF NOT EXISTS gnl_run_journal_run ON gnl_run_journal (run_id, created_at)`,
  // A run's status is two inputs and their result, all three written by the adapter in the statement that
  // writes the run's counters (`writeRunRows`): `suspended_count` (its tool records waiting on a human),
  // `outcome` (its `:outcome` record: 'running' | 'failed' | 'canceled', NULL for 'completed' or none —
  // `storedOutcomeOf`) and `status`, `runStatusOf` of the two — what every listing, count and filter
  // reads. Up to 0.10 the status was four boolean flags (`suspended`, `failed`, `running`, `canceled`)
  // decoded on every read; the `run-status` upgrade step moves a store from those to these.
  `CREATE TABLE IF NOT EXISTS gnl_runs (run_id TEXT PRIMARY KEY, model_steps INTEGER NOT NULL DEFAULT 0, tool_calls INTEGER NOT NULL DEFAULT 0, suspended_count INTEGER NOT NULL DEFAULT 0, outcome TEXT, status TEXT NOT NULL, created_at BIGINT NOT NULL, updated_at BIGINT NOT NULL, thread_id TEXT, resource_id TEXT)`,
  `CREATE INDEX IF NOT EXISTS gnl_runs_updated ON gnl_runs (updated_at)`,
  // H11b migration: add the column if missing in an old setup (backfill once at init, below).
  `ALTER TABLE gnl_runs ADD COLUMN IF NOT EXISTS suspended_count INTEGER NOT NULL DEFAULT 0`,
  // The runs that are not 'completed' — what the approval inbox and the usage total ask for — in two
  // partial indexes: `gnl_runs_open` in creation order (every open run: the usage total) and
  // `gnl_runs_status` by status, then creation order (one status: the approval inbox). 1M-run store, 167
  // such runs: GET /approvals read all 1 000 020 runs (20 001 pages, 23.3 s) to find them before them.
  // Every status filter that admits no completed run carries the predicate word for word
  // (`runStatusSql`), which is how both planners prove a status read may use them. Small and cold: a run
  // enters them while open and leaves when it completes, and a completed run's writes never touch them.
  // Two, because the open runs are not one kind (C+ A2, index-choice, 1M store with 500 000 failed runs):
  // through `(created_at, run_id)` alone a page of suspended runs read 65 ms (every failed run in
  // between, filtered), through `(status, …)` 1.5 ms; through `(status, …)` alone a page of ALL open runs
  // went to `gnl_runs_created` and filtered the completed ones — on a store with few open runs, every run.
  `CREATE INDEX IF NOT EXISTS gnl_runs_open ON gnl_runs (created_at, run_id) WHERE ${openRunPredicate()}`,
  `CREATE INDEX IF NOT EXISTS gnl_runs_status ON gnl_runs (status, created_at, run_id) WHERE ${openRunPredicate()}`,
  // RELATIONS: a run's person and thread (`runRelationsOf`), and a thread owner record's person
  // (`ownerColumnOf`), as columns the adapter fills in the transaction that writes the record. NULL =
  // not placed yet — a row written before these columns, or by an older process whose INSERT knows
  // nothing of them. Every lookup reads those rows too and decides them from the record (keysetRunPage,
  // listOwnerRecords), so nothing depends on the `relations` upgrade step having placed them. Same
  // additive shape as the columns above; the indexes come after the ALTERs so an existing table has
  // the column.
  //  - `gnl_runs_resource` serves both halves of a person's lookup: `resource_id = $1` (placed) and
  //    `resource_id IS NULL` (not placed — also the second half of a thread's), each in creation order.
  //  - `gnl_run_journal_owner` holds owner records only (partial, by key shape; the journal's other
  //    rows never enter it), placed and not: the one index both halves of `listOwnerRecords` read. A
  //    partial index `WHERE owner IS NOT NULL` was the obvious shape and is wrong here: pg-mem answers
  //    `owner IS NULL` from it with nothing (measured), and the unplaced half is exactly that question.
  `ALTER TABLE gnl_runs ADD COLUMN IF NOT EXISTS thread_id TEXT`,
  `ALTER TABLE gnl_runs ADD COLUMN IF NOT EXISTS resource_id TEXT`,
  `CREATE INDEX IF NOT EXISTS gnl_runs_resource ON gnl_runs (resource_id, created_at, run_id)`,
  `CREATE INDEX IF NOT EXISTS gnl_runs_thread ON gnl_runs (thread_id, created_at, run_id)`,
  `ALTER TABLE gnl_run_journal ADD COLUMN IF NOT EXISTS owner TEXT`,
  // `ord`: the order a run's records were FIRST written in — what `readRun` returns them in
  // (JournalReader's ordering contract). `created_at` cannot be that order: it is a millisecond from the
  // WRITER's clock, so two records of one run written in the same millisecond tied and came back by key
  // (`model:10` before `model:2`, every tool after every step: compensation unwound in the wrong order),
  // and a worker whose clock is behind put a resumed run's later steps before its earlier ones
  // (measured, H7). A column DEFAULT, not a value the write names, so an older process's INSERT gets one
  // too; an overwrite (ON CONFLICT DO UPDATE, putIfMatch) never sets it, so a record keeps its place.
  // Added at 0 and only then given the default — `ADD COLUMN … DEFAULT nextval` would rewrite the table
  // and number the existing rows in physical order; at 0 they keep `(created_at, key)`, and every one of
  // them was written before any numbered row. Same shape as `gnl_work_log.ord`.
  `CREATE SEQUENCE IF NOT EXISTS gnl_run_journal_ord`,
  `ALTER TABLE gnl_run_journal ADD COLUMN IF NOT EXISTS ord BIGINT NOT NULL DEFAULT 0`,
  `ALTER TABLE gnl_run_journal ALTER COLUMN ord SET DEFAULT nextval('gnl_run_journal_ord')`,
  `CREATE INDEX IF NOT EXISTS gnl_run_journal_owner ON gnl_run_journal (owner, key) WHERE key LIKE '${OWNER_RECORD_LIKE}'`,
  `CREATE TABLE IF NOT EXISTS gnl_counters (key TEXT NOT NULL, field TEXT NOT NULL, value DOUBLE PRECISION NOT NULL, PRIMARY KEY (key, field))`,
  `CREATE INDEX IF NOT EXISTS gnl_runs_created ON gnl_runs (created_at, run_id)`,
  `CREATE TABLE IF NOT EXISTS gnl_threads (id TEXT PRIMARY KEY, resource_id TEXT NOT NULL, title TEXT, parent_thread_id TEXT, metadata TEXT, created_at BIGINT NOT NULL, updated_at BIGINT NOT NULL, deleted_at BIGINT)`,
  `CREATE INDEX IF NOT EXISTS gnl_threads_res ON gnl_threads (resource_id, updated_at)`,
  `CREATE TABLE IF NOT EXISTS gnl_messages (thread_id TEXT NOT NULL, seq INTEGER NOT NULL, role TEXT NOT NULL, text TEXT, embedding TEXT, metadata TEXT, ts BIGINT NOT NULL, message TEXT NOT NULL, PRIMARY KEY (thread_id, seq))`,
  `CREATE TABLE IF NOT EXISTS gnl_working_memory (scope_id TEXT PRIMARY KEY, data TEXT NOT NULL, updated_at BIGINT NOT NULL)`,
  `CREATE TABLE IF NOT EXISTS gnl_observations (thread_id TEXT PRIMARY KEY, obs TEXT NOT NULL)`,
  // Batch identity, beside the messages rather than in the journal. Same transaction as the rows it
  // covers, so "written but not marked" stops being a state this store can be in — see
  // `appendMessagesOnce`. A NEW TABLE rather than a column on gnl_messages: `migrateSchema` emits
  // CREATE TABLE with its constraints for a missing table, but has no path to add an index to one
  // that already exists, so the column-plus-unique-index shape would reach new installs and silently
  // skip existing ones.
  `CREATE TABLE IF NOT EXISTS gnl_message_batches (thread_id TEXT NOT NULL, batch_key TEXT NOT NULL, seq_from INTEGER NOT NULL, seq_to INTEGER NOT NULL, ts BIGINT NOT NULL, PRIMARY KEY (thread_id, batch_key))`,
  `CREATE TABLE IF NOT EXISTS gnl_vectors (id TEXT PRIMARY KEY, text TEXT NOT NULL, embedding TEXT NOT NULL, metadata TEXT, namespace TEXT, created_at BIGINT NOT NULL, doc TEXT)`,
  // Same migration shape as the gnl_runs columns above: `CREATE TABLE IF NOT EXISTS` does nothing to
  // a table that already exists, so an old database would keep a five-column gnl_vectors and every
  // upsert would fail with "column namespace does not exist". Deliberately NOT backfilled — rows
  // written before namespaces existed belong to the un-namespaced partition, and a query for a real
  // namespace must not be answered from them.
  `ALTER TABLE gnl_vectors ADD COLUMN IF NOT EXISTS namespace TEXT`,
  // Same shape, same reason. NULL is right here too: a row written before end users had documents of
  // their own is unlabelled, and an unlabelled row is visible to no end user.
  `ALTER TABLE gnl_vectors ADD COLUMN IF NOT EXISTS owner TEXT`,
  `ALTER TABLE gnl_vectors ADD COLUMN IF NOT EXISTS shared BOOLEAN`,
  // The document a row belongs to (`vectorDocumentOf` its metadata), written by the store on every
  // upsert so finding one document's rows is an index lookup. A column the store fills rather than an
  // index on the metadata: metadata is TEXT, and casting it to json in an index would refuse every
  // write whose metadata holds a lone surrogate or a NUL (measured: "Unicode low surrogate must follow
  // a high surrogate") — writes this table accepts today. '' = no document; NULL = not computed yet
  // (a row written before this column, or by an older process), which every lookup includes.
  `ALTER TABLE gnl_vectors ADD COLUMN IF NOT EXISTS doc TEXT`,
  `CREATE INDEX IF NOT EXISTS gnl_vectors_doc ON gnl_vectors (doc)`,
  `CREATE TABLE IF NOT EXISTS gnl_work_log (ns TEXT NOT NULL, id TEXT NOT NULL, payload TEXT NOT NULL, ts BIGINT NOT NULL, seq BIGINT NOT NULL DEFAULT 0, ord BIGINT NOT NULL DEFAULT 0, PRIMARY KEY (ns, id))`,
  `CREATE INDEX IF NOT EXISTS gnl_work_log_ns ON gnl_work_log (ns, ts)`,
  // The store-assigned position `WorkStore.list` pages by (see the port). Same shape as the columns
  // above; no backfill: 0 means "not numbered yet" — a row written before sequences, or by a 0.9
  // process still running — and the first `list` numbers it. The index comes after the ALTER so an
  // existing table has the column; it also serves the `seq = 0 ORDER BY ts, id` numbering scan.
  `ALTER TABLE gnl_work_log ADD COLUMN IF NOT EXISTS seq BIGINT NOT NULL DEFAULT 0`,
  `CREATE INDEX IF NOT EXISTS gnl_work_log_seq ON gnl_work_log (ns, seq, ts, id)`,
  // `ord`: the order a namespace's unnumbered records are numbered in — the order they were appended
  // (`nextval`), where `(ts, id)` alone put two same-millisecond records of one producer in the order
  // of their random id suffixes. A column DEFAULT, not a value the append names, so a 0.9 process's
  // INSERT gets one too. Added at 0 and only then given the default: `ADD COLUMN ... DEFAULT nextval`
  // would number the existing rows in physical order; at 0 they keep `(ts, id)`. Writers take no lock
  // for it — a sequence is not transactional, and it decides order only, never visibility.
  `CREATE SEQUENCE IF NOT EXISTS gnl_work_log_ord`,
  `ALTER TABLE gnl_work_log ADD COLUMN IF NOT EXISTS ord BIGINT NOT NULL DEFAULT 0`,
  `ALTER TABLE gnl_work_log ALTER COLUMN ord SET DEFAULT nextval('gnl_work_log_ord')`,
  `CREATE TABLE IF NOT EXISTS gnl_work_seq (ns TEXT PRIMARY KEY, seq BIGINT NOT NULL)`,
  `CREATE TABLE IF NOT EXISTS gnl_work_kv (key TEXT PRIMARY KEY, value TEXT NOT NULL)`,
  `CREATE TABLE IF NOT EXISTS gnl_cache (key TEXT PRIMARY KEY, value TEXT NOT NULL, expires_at BIGINT)`,
];


/**
 * `col >= $n [AND col < $n+1]` with the collation suffix, starting at `from`. The upper bound is omitted
 * for an empty prefix, which means every key — `col < ''` is never true, so emitting it unconditionally
 * turned `deletePrefix('')` into a delete of nothing that still reported success.
 */
function pgRange(col: string, collate: string, prefix: string, from: number): { where: string; params: string[] } {
  const upper = prefixUpperBound(prefix);
  return upper === undefined
    ? { where: `${col}${collate} >= $${from}`, params: [prefix] }
    : { where: `${col}${collate} >= $${from} AND ${col}${collate} < $${from + 1}`, params: [prefix, upper] };
}

/**
 * CONNECTION BUDGET. Measured failure, not a hypothetical: two 8-worker app groups against one
 * Postgres asked for 16 x 10 = 160 connections against `max_connections = 100`, and 513 of 600
 * requests came back as 500s carrying nothing but Postgres's own `sorry, too many clients already`.
 * Nothing in gnl chose that 10 — it is node-postgres's default pool size — and nothing anywhere told
 * the operator the arithmetic that had just broken.
 *
 * gnl cannot see how many processes a deployment runs, so it cannot check the product. What it CAN
 * do is state its own share once, and name the arithmetic when the server refuses a connection.
 */
function connectionAdvice(poolMax: number, serverMax: number): string {
  const safe = Math.max(1, Math.floor((serverMax - 20) / Math.max(1, poolMax)));
  return `@gnldev/durable: this process reserves up to ${poolMax} Postgres connections and the server allows `
    + `${serverMax}. Keep (processes x pool size) under ${serverMax - 20} -- roughly ${safe} process(es) at this `
    + `pool size, leaving headroom for autovacuum and superuser sessions. Set a smaller pool via `
    + `new PostgresStorage({ pool }) if you run more.`;
}

/** Postgres says this when the connection slots are gone. Its own message names no remedy. */
function isTooManyClients(e: unknown): boolean {
  const code = (e as { code?: string } | null)?.code;
  const msg = String((e as { message?: string } | null)?.message ?? '');
  return code === '53300' || /too many clients/i.test(msg);
}

/**
 * One statement for a whole set of counter increments, instead of one awaited round trip per field.
 *
 * A completed agent turn writes three counter keys of seven fields each plus the usage counter — 24
 * sequential round trips, for advisory statistics, inside the transaction that also carries the
 * exactly-once claim. Traced against a live server: 24 of the ~114 round trips a request makes.
 *
 * The dedupe is not tidiness. Postgres rejects `ON CONFLICT DO UPDATE` when one statement would touch
 * the same row twice ("cannot affect row a second time"), and a caller may legitimately pass the same
 * (key, field) more than once — the deltas are additive, so summing them first is both the fix and
 * the correct semantics.
 */
function flattenIncrs(incrs: ReadonlyArray<{ key: string; fields: Record<string, number> }>): Array<string | number> {
  const merged = new Map<string, { key: string; field: string; delta: number }>();
  for (const { key, fields } of incrs) {
    for (const [field, delta] of Object.entries(fields)) {
      const id = `${key}\u0000${field}`;
      const prev = merged.get(id);
      if (prev) prev.delta += delta;
      else merged.set(id, { key, field, delta });
    }
  }
  const flat: Array<string | number> = [];
  for (const m of merged.values()) flat.push(m.key, m.field, m.delta);
  return flat;   // [key, field, delta, key, field, delta, ...] — one triple per placeholder group
}

/**
 * The multi-row upsert `flattenIncrs` feeds, built as an explicit `VALUES` list rather than with
 * `UNNEST($1::text[], ...)`. The array form is tidier and works on real Postgres, but pg-mem — which
 * the default suite runs the whole Postgres contract against — answers it with
 * `unnest expects 1 arguments, given 3`. A numbered VALUES list is understood by both, so there is
 * one code path instead of a capability probe and a fallback that would diverge in silence.
 */
function incrSql(rows: number): string {
  const values = Array.from({ length: rows }, (_, i) => `($${i * 3 + 1}, $${i * 3 + 2}, $${i * 3 + 3})`).join(', ');
  return `INSERT INTO gnl_counters (key, field, value) VALUES ${values}
          ON CONFLICT (key, field) DO UPDATE SET value = gnl_counters.value + EXCLUDED.value`;
}

export class PostgresStorage implements Storage {
  /** Filled in by ensureReady's probe; shared BY REFERENCE with PgRunJournal (see PrefixShape). */
  private prefixShape: PrefixShape = { collate: '' };
  /** Filled by ensureReady's budget probe; used to explain a connection refusal. */
  private connectionBudget?: { poolMax: number; serverMax: number };
  /** Per-INSTANCE, never module-global: a test double must not disable the lock for a real pool. */
  private advisoryLocks = true;
  /** H10a: deployment durability report (delegates to the runs journal — see PgRunJournal.durabilityReport). */
  durabilityReport() { return (this.runs as any).durabilityReport() as ReturnType<any>; }

  readonly name = 'postgres';
  readonly capabilities: CapabilityMatrix = { runs: 'full', memory: 'full', vectors: 'scan', work: 'full', cache: 'ttl' };
  private _pool: Pool;
  /**
   * The underlying connection pool. Exposed so COMPANION stores that live in the SAME Postgres
   * database can share this exact pool — notably `@gnldev/auth-ee`'s `createPostgresUserStore(storage.pool)`,
   * which puts admin/developer accounts in their own `gnl_ee_*` tables next to the run journal.
   */
  get pool(): Pool { return this._pool; }
  private ready?: Promise<void>;
  readonly runs: RunJournal;
  /** Absent when the pool cannot hold a transaction — see the constructor and NO_TX_MSG. */
  readonly memory!: MemoryStore;
  readonly vectors: VectorStore;
  readonly work: WorkStore;
  readonly cache: CacheStore;
  readonly meta: MetaStore;

  constructor(opts: PostgresStorageOptions = {}) {
    refuseUnknownNames('PostgresStorage', opts, POSTGRES_STORAGE_NAMES);
    if (opts.pool) this._pool = opts.pool;
    else {
      const { Pool } = createRequire(import.meta.url)('pg') as { Pool: new (c: any) => Pool };
      this._pool = new Pool(opts.connectionString ? { connectionString: opts.connectionString } : {});
    }
    // `pg` emits 'error' on IDLE clients — a server restart, a failover, a scale-to-zero, a PgBouncer
    // idle reap. An EventEmitter 'error' with no listener is an uncaught exception, so without this
    // the host process DIES, and it dies where no try/catch around a call site can reach: the pool is
    // idle, nobody is awaiting it. Measured: `docker restart` on the database took down a plain
    // `@hono/node-server` process behind ~200 lines of dumped Client internals.
    //
    // The right behaviour is to say so and carry on. `pg` evicts the broken client itself and the
    // next checkout opens a fresh connection; in-flight queries still reject at their own call sites,
    // which is where a caller can actually handle them. Attached only when no listener exists, so a
    // caller who passed their own pool and their own handler keeps theirs.
    if (this._pool.on && this._pool.listenerCount?.('error') === 0) {
      this._pool.on('error', (err: Error) => {
        console.error(
          `@gnldev/durable: postgres pool error on an idle connection — ${err.message}. ` +
            'The pool drops that connection and reconnects on the next query; in-flight queries reject ' +
            'at their call sites. This is logged rather than thrown because an unhandled pool error ' +
            'would terminate the process.',
        );
      });
    }
    // THE OTHER HALF, and the half that kills the process. The handler above covers a connection
    // sitting IDLE in the pool. A connection that is CHECKED OUT — one with a query in flight —
    // does not route its failure through the pool at all: `pg` emits 'error' on the Client itself,
    // and an EventEmitter with no 'error' listener is a `throw` that no `try` around the query can
    // catch, because it arrives on the socket's turn of the event loop rather than the caller's.
    //
    // Measured against a real Postgres: 120 concurrent writes in flight, backends terminated the way
    // a managed failover terminates them (`pg_terminate_backend`), and the whole Node process died
    // with `Unhandled 'error' event ... Emitted 'error' event on Client instance`. Not the query —
    // the PROCESS, and with it whatever application had mounted this engine.
    //
    // A failover is not an exotic event; it is the normal operating behaviour of every managed
    // Postgres. So each connection gets the same treatment the pool got: say what happened and let
    // `pg` evict it. The in-flight query still rejects at its own call site, which is unchanged and
    // is where a caller can actually do something about it.
    if (this._pool.on) {
      this._pool.on('connect', (client: PoolClientEvents) => {
        // NO `listenerCount === 0` GUARD HERE, unlike the pool above, and the difference is the
        // whole fix. `pg` attaches its own 'error' listener to every client before handing it to
        // this event — so the guard that is correct for the pool (respect a caller's handler) read
        // as "already handled" and attached nothing. Measured: listener count is 1 at 'connect', and
        // the process still died. That internal listener serves `pg`'s own bookkeeping; it does not
        // make the emit safe for anyone else. A second listener is harmless and is what keeps the
        // emit from reaching Node's unhandled-'error' throw.
        if (client.on) {
          client.on('error', (err: Error) => {
            console.error(
              `@gnldev/durable: postgres connection lost mid-query — ${err.message}. ` +
                'The query rejects at its call site and `pg` discards this connection; the next one ' +
                'reconnects. Logged rather than rethrown: an unhandled Client error event would ' +
                'terminate the process, which is not a failure mode a database failover should have.',
            );
          });
        }
      });
    }
    /**
     * Wraps a connection refusal with the arithmetic that caused it. Postgres answers
     * `sorry, too many clients already` and stops there; the operator is left to work out that
     * processes x pool size has crossed `max_connections`. The original error is kept as `cause`.
     */
    const explain = (e: unknown): unknown => {
      if (!isTooManyClients(e) || !this.connectionBudget) return e;
      const { poolMax, serverMax } = this.connectionBudget;
      const err = new Error(`${String((e as Error).message)} -- ${connectionAdvice(poolMax, serverMax)}`, { cause: e });
      (err as { code?: string }).code = (e as { code?: string }).code;
      return err;
    };
    const q = (sql: string, p?: unknown[]) =>
      this.ensureReady().then(() => this._pool.query(sql, p)).catch((e) => { throw explain(e); });
    // T1 audit fix — transaction helper: all queries inside fn run within BEGIN/COMMIT (error →
    // ROLLBACK) on a SINGLE client checked out from the pool. `pool.query('BEGIN')` on a pg Pool is
    // UNSAFE (each query can go to a different connection) → connect pins the client.
    // Lower-fidelity fallbacks (behavior = old autocommit, test-only):
    // if pool.connect is missing (minimal injected pool): no transaction, queries run sequentially via pool.query.
    // pg-mem: accepts BEGIN/COMMIT/ROLLBACK but ROLLBACK does NOT actually UNDO (verified
    //     experimentally) → no proof of atomicity under pg-mem; real atomicity proof is in integration-real.test.ts.
    // `atomic: true` means the caller's correctness DEPENDS on the transaction, so the two
    // lower-fidelity fallbacks below must refuse rather than quietly run unwrapped. Without it, a
    // query-only pool made `appendMessages` send its lock and its `SET LOCAL` as separate autocommit
    // statements — the lock released at the end of its own statement, `SET LOCAL` drew a server
    // warning, and the batch was not atomic. Measured on a real server: 23 of 24 appends rejected,
    // 3 rows of 48 stored, and an orphaned tool call — exactly the defect this all exists to remove,
    // with the capability probe reporting everything fine.
    //
    // `BEGIN` runs BEFORE `fn`, so refusing there writes nothing; there is no half-done state.
    const tx = async <T>(fn: (q: Q) => Promise<T>, opts?: TxOptions): Promise<T> => {
      await this.ensureReady();
      if (typeof this._pool.connect !== 'function') {
        if (opts?.atomic) throw new Error(NO_TX_MSG);
        return fn((s, p) => this._pool.query(s, p));
      }
      const client = await this._pool.connect().catch((e: unknown) => { throw explain(e); });
      let inTx = false;
      let destroy = false;
      try {
        try { await client.query(opts?.readCommitted ? 'BEGIN ISOLATION LEVEL READ COMMITTED' : 'BEGIN'); inTx = true; } catch (e) { if (opts?.atomic) throw new Error(NO_TX_MSG, { cause: e }); /* else: transaction not supported → proceed unwrapped */ }
        const out = await fn((s, p) => client.query(s, p));
        if (inTx) await client.query('COMMIT');
        return out;
      } catch (e) {
        if (inTx) { try { await client.query('ROLLBACK'); } catch { destroy = true; /* client in an uncertain state must not return to the pool */ } }
        throw e;
      } finally {
        client.release?.(destroy);
      }
    };
    this.runs = new PgRunJournal(q, tx, this.prefixShape);
    // A1 — DOWNGRADE THE PORT, do not throw. `connect` is a synchronous check, so there is no reason
    // to defer it to the first query; and killing the whole Storage would take the runs journal, work
    // queue and cache down with it, for a deployment that may never touch memory at all. Declaring
    // the port absent is this repo's own idiom for "this adapter cannot offer that" (a capability
    // of 'none'), and it leaves the operator a real way out: route memory elsewhere with
    // composite({ default: pg, overrides: { memory: sqlite() } }).
    if (typeof (this._pool as { connect?: unknown }).connect !== 'function') {
      (this.capabilities as { memory: string }).memory = 'none';
      console.error(NO_TX_MSG);
    } else {
      this.memory = new PgMemoryStore(q, tx, () => this.advisoryLocks);
    }
    this.vectors = new PgVectorStore(q, tx);
    this.work = new PgWorkStore(q, tx, this.prefixShape);
    this.cache = new PgCacheStore(q);
    this.meta = new PgMetaStore(q);
  }
  private ensureReady(): Promise<void> {
    if (!this.ready) {
      const booting = (async () => {
        // `CREATE TABLE IF NOT EXISTS` is not safe against a concurrent copy of itself. Two sessions
        // both pass the existence check, both proceed, and the loser dies inside Postgres' catalog
        // with `duplicate key value violates unique constraint "pg_type_typname_nsp_index"` — a
        // message about an internal index, offering the reader nothing to act on.
        //
        // Measured, not theorised: two PostgresStorage instances opened against a fresh database in
        // the same moment, one of them rejected exactly like that. Which is the shape of a fleet
        // boot — several instances starting together against a database that was created minutes
        // ago, the normal case on a managed platform that scales by adding copies.
        //
        // A session-level advisory lock serialises the whole block: the first arrival creates the
        // schema, the others wait and then find it already there. The key is an arbitrary constant,
        // scoped to this database and to us; `pg_advisory_lock` blocks rather than failing, so no
        // caller has to retry. Released in `finally` — an error during DDL must not leave every
        // other instance waiting forever.
        // Best-effort, not required. The key is inlined rather than bound: a parameter makes the
        // argument's type ambiguous and picks the `text` overload, which does not exist. And a
        // backend without advisory locks at all — pg-mem, which this suite runs most of its Postgres
        // tests against — must still come up: it has no second writer to race with, so losing the
        // lock costs it nothing. Failing here instead would trade a rare boot race for a certain one.
        const locked = await this._pool.query('SELECT pg_advisory_lock(47110001)').then(() => true, () => false);
        try {
          // A run table in an earlier version's format (status flags) is refused before anything is
          // created or read: this version neither reads nor writes the flags, so serving it would read
          // a status nobody keeps. `gnl upgrade` (the `run-status` step) moves it; see RUN_STATUS_PENDING_MESSAGE.
          // Thrown from here, the boot is not memoised: the next call asks again, so a process that
          // started before the step ran elsewhere serves the store once it has.
          if (runStatusPending(await this.runColumns())) throw new Error(RUN_STATUS_PENDING_MESSAGE);
          for (const sql of DDL) await this._pool.query(sql);
          // The relation columns are trusted only where OWNER_UNPLACE and RUN_UNPLACE guard them, ENABLED.
          // The functions are (re)defined on every boot — the current body, whatever an earlier boot left;
          // CREATE OR REPLACE FUNCTION takes no lock on the journal. A missing trigger is created, a
          // disabled one enabled. Then the catalog is asked again: the answer is what the database HAS.
          // A backend without triggers or plpgsql (pg-mem, some Postgres-compatible servers) never reads
          // the columns — lookups by person or thread walk the records, exact and slower.
          const guards = async () => {
            const rows = await this._pool.query(RELATION_GUARDS_STATE).then((r: QueryResult) => r.rows as { name: string; enabled: string; body: string }[], () => []);
            // 'O' fires for ordinary sessions, 'A' always; 'D' never, and 'R' only in a replica-role
            // session (ENABLE REPLICA TRIGGER) — neither guards this application's writes. And the
            // function a trigger calls must have THIS version's body: a function another role owns
            // refuses the CREATE OR REPLACE below, and an older or altered body guards something else.
            return { rows, ok: rows.length === 2 && rows.every((x) => (x.enabled === 'O' || x.enabled === 'A') && x.body === GUARD_BODIES[x.name]) };
          };
          const before = await guards();
          for (const [name, [fn, trigger]] of [['gnl_owner_unplace', OWNER_UNPLACE], ['gnl_run_unplace', RUN_UNPLACE]] as const) {
            const row = before.rows.find((x) => x.name === name);
            await this._pool.query(fn)
              .then(() => (!row ? this._pool.query(trigger)
                : row.enabled !== 'O' && row.enabled !== 'A' ? this._pool.query(`ALTER TABLE gnl_run_journal ENABLE TRIGGER ${name}`) : undefined))
              .catch(() => undefined); // verified below, by asking the catalog
          }
          const after = await guards();
          if (!after.ok && after.rows.length > 0) {
            // Present, and not this version's or not firing: say so — lookups by person or thread walk until it is fixed.
            console.warn(`@gnldev/durable: the relation guards on gnl_run_journal (gnl_owner_unplace, gnl_run_unplace) are not this version's — their function is owned by another role, altered, or the trigger is disabled. Lookups by person or thread read every record until they are: boot once as the tables' owner, then run \`gnl upgrade --only verify-relations\`.`);
          }
          // Found unguarded on a store that already holds placements: some may be wrong (see RELATIONS_VERIFY_KEY).
          if (after.ok && !before.ok) {
            const placed = await this._pool.query(
              `SELECT 1 AS x FROM gnl_runs WHERE resource_id IS NOT NULL UNION ALL SELECT 1 FROM gnl_run_journal WHERE owner IS NOT NULL LIMIT 1`,
            ).then((r: QueryResult) => r.rows.length > 0, () => false);
            if (placed) await this._pool.query(`INSERT INTO gnl_meta (k, v) VALUES ($1, $2) ON CONFLICT (k) DO NOTHING`, [RELATIONS_VERIFY_KEY, String(Date.now())]);
          }
          const verify = after.ok && (await this._pool.query(`SELECT 1 AS x FROM gnl_meta WHERE k = $1`, [RELATIONS_VERIFY_KEY]).then((r: QueryResult) => r.rows.length > 0, () => false));
          this.prefixShape.guardsInstalled = after.ok;
          this.prefixShape.relationGuard = after.ok && !verify;
          // Rows the step can place — runs from before the columns, or placements to verify — make every
          // lookup by person or thread read them all (see RELATIONS_PENDING_ADVICE). Said once, at boot,
          // with the one command that ends it. A run with no `:input` stays unplaced for good (no record
          // says whose it is), so it is not counted here: no command would make the warning go away.
          if (after.ok && (verify || await this._pool.query(`SELECT 1 AS x FROM gnl_runs r JOIN gnl_run_journal j ON j.key = r.run_id || ':input' WHERE r.resource_id IS NULL LIMIT 1`).then((r: QueryResult) => r.rows.length > 0, () => false))) {
            console.warn(RELATIONS_PENDING_ADVICE);
          }
          // Ask the backend what its `<` actually does, rather than assuming. 'a:b' sorts below
          // 'a:' + U+FFFF under byte order and NOT under a linguistic collation, so this single
          // comparison separates the two. A backend that cannot answer is treated as byte-ordered:
          // that is the behaviour every backend had before this probe existed.
          const probe = await this._pool
            .query(`SELECT ('a:b' < ('a:' || U&'\\FFFF')) AS byte_ordered`)
            .then((r: any) => r.rows?.[0]?.byte_ordered !== false, () => true);
          if (!probe) {
            this.prefixShape.collate = ' COLLATE "C"';
            // The PK indexes are in the database's own collation and cannot serve a COLLATE "C"
            // range, so a prefix scan would degrade to a seq scan without these.
            for (const sql of [
              `CREATE INDEX IF NOT EXISTS gnl_run_journal_cprefix ON gnl_run_journal (key COLLATE "C")`,
              `CREATE INDEX IF NOT EXISTS gnl_runs_cprefix ON gnl_runs (run_id COLLATE "C")`,
              `CREATE INDEX IF NOT EXISTS gnl_counters_cprefix ON gnl_counters (key COLLATE "C")`,
            ]) await this._pool.query(sql);
          }
          await backfillVectorDocuments((sql, p) => this._pool.query(sql, p));
          await this._pool.query(`INSERT INTO gnl_meta (k, v) VALUES ('schema_version', $1) ON CONFLICT (k) DO NOTHING`, [SCHEMA_VERSION]);
          // One extra query at startup to read the budget this process is spending against. Warned
          // only when the margin is genuinely thin, so a single-process deployment stays silent.
          try {
            const serverMax = Number((await this._pool.query('SHOW max_connections')).rows?.[0]?.max_connections);
            const poolMax = Number((this._pool as { options?: { max?: number } }).options?.max ?? 10);
            this.connectionBudget = { poolMax, serverMax };
            if (Number.isFinite(serverMax) && poolMax * 4 > serverMax - 20) {
              console.warn(connectionAdvice(poolMax, serverMax));
            }
          } catch { /* a backend that cannot answer SHOW is left alone -- this is advice, not a gate */ }
          // Can this server serialise appends to one thread? Settled ONCE, here, outside any
          // transaction — see the note on THREAD_LOCK_NS for why asking mid-transaction cannot work.
          // Fail-closed in production: without this lock two runs answering one thread lose messages,
          // and shipping that silently is the exact failure this whole change exists to remove. Test
          // doubles (pg-mem has no advisory locks) are not production, so they warn and carry on.
          // `to_regprocedure` asks the catalog whether the function exists — no lock is taken, nothing
          // is unlocked, and the server logs no warning. Probing by CALLING pg_advisory_unlock would
          // have worked too, but it makes the backend warn about releasing a lock we never held.
          this.advisoryLocks = await this._pool
            .query(`SELECT to_regprocedure('pg_advisory_xact_lock(int,int)') IS NOT NULL AS ok`)
            .then((r: any) => r.rows?.[0]?.ok === true, () => false);
          if (!this.advisoryLocks) {
            // DOWNGRADE, not throw — and with no NODE_ENV branch. Throwing here killed the whole
            // storage: a deployment running Postgres purely for the exactly-once journal, never
            // touching memory, died on its first query with a message about "concurrent appends to
            // one thread". And branching a correctness guarantee on NODE_ENV means two environments
            // get two different guarantees, which is its own smell. Declaring the port absent lets
            // `requireCapability` stop anyone who tries to USE memory, exactly as for any absent port,
            // and leaves everything else running.
            (this.capabilities as { memory: string }).memory = 'none';
            console.error(
              '@gnldev/durable: this Postgres has no pg_advisory_xact_lock, so appends to one thread '
              + 'cannot be serialised and two concurrent turns would silently lose messages. The memory '
              + 'port is disabled (capabilities.memory = "none"); the runs journal, work queue, cache '
              + 'and meta stores are unaffected and exactly-once still holds. Route memory elsewhere — '
              + 'composite({ default: postgres, overrides: { memory: sqlite() } }) — or use a Postgres '
              + 'that exposes pg_advisory_xact_lock(int, int). Postgres-compatible proxies and '
              + 'derivatives are the usual cause.',
            );
          }
        } finally {
          if (locked) await this._pool.query('SELECT pg_advisory_unlock(47110001)').catch(() => {});
        }
      })();
      this.ready = booting;
      // Memoising the promise is the point — the schema is set up once per instance. Memoising a
      // REJECTED one is not: it makes a transient failure permanent. Measured against a real
      // Postgres: a backend terminated mid-DDL (`57P01`) left this instance answering every later
      // call with that same dead error, while a brand-new instance against the same database wrote
      // fine half a second later. Which is precisely a failover — the database comes back, this
      // copy does not, and only a restart fixes it.
      //
      // Clearing the memo lets the next caller retry the schema work. The identity check is not
      // decoration: by the time this handler runs, a later call may already have started its own
      // boot, and undefining that one would make two boots race.
      booting.catch(() => { if (this.ready === booting) this.ready = undefined; });
      return booting;
    }
    return this.ready;
  }
  async init() { await this.ensureReady(); }
  async close() { if (this._pool.end) await this._pool.end(); }

  /**
   * H12: reclaiming deleted space. In Postgres, autovacuum AUTOMATICALLY moves dead rows to the
   * freelist (reused → no unbounded growth); this method triggers it manually. The default `VACUUM`
   * does NOT LOCK but does NOT RETURN disk to the OS either (keeps it in the freelist — subsequent
   * writes reuse it). To actually reclaim disk, use `{ full: true }` → `VACUUM FULL`: this LOCKS the
   * table + temporarily needs 2× disk → only during a maintenance window. Postgres doesn't expose file
   * size via the API → reclaimedBytes = -1 (unknown).
   */
  /** See `Storage.adoptIntoOrg`. The table list is model.ts's `SCOPE_TABLES`, the platform-key rule `isPlatformKey` — both shared with the SQLite adapter. */
  async adoptIntoOrg(orgId: string, opts?: { dryRun?: boolean; allowUnregistered?: boolean; allowInFlight?: boolean }): Promise<AdoptIntoOrgResult> {
    refuseUnknownNames('adoptIntoOrg', opts, ADOPT_INTO_ORG_NAMES);
    const prefix = orgPrefix(orgId);
    const ns = prefix.slice(0, -1);
    const dryRun = opts?.dryRun === true;
    await this.ensureReady();
    // A DEDICATED connection, not the pool. `BEGIN` and `COMMIT` issued through `pool.query` can land
    // on different connections, so the statements between them would not be in a transaction at all —
    // and a half-migrated store is worse than an unmigrated one, because nobody can tell which half is
    // which.
    if (typeof this._pool.connect !== 'function') {
      // Refused rather than run without one. A duck-typed pool that cannot hand out a connection
      // cannot give us a transaction, and this migration rewrites every key in the store — running it
      // non-atomically would leave a store nobody can classify if it failed halfway.
      throw new Error(
        '@gnldev/durable: adoptIntoOrg needs a pool that supports connect() so the migration runs in one '
        + 'transaction. Pass a real `pg` Pool (or a connectionString) rather than a minimal query-only object.',
      );
    }
    const client = await this._pool.connect();
    const q = (sql: string, p?: unknown[]) => client.query(sql, p);
    // AFTER the connect() check, because a pool that cannot give a transaction is a configuration
    // error and should be reported as one — checking registration first would answer a question about
    // the data while the setup is unusable.
    try { await assertOrgRegistered(this.runs, orgId, opts?.allowUnregistered);
      await assertNoRunsInFlight(this.runs, opts?.allowInFlight); }
    catch (e) { client.release?.(); throw e; }
    const moved: Record<string, number> = {};
    const skipped = new Set<string>();
    const resetPositions: string[] = [];
    let alreadyScoped = 0;
    const bump = (store: string, n: number) => { moved[store] = (moved[store] ?? 0) + n; };

    if (!dryRun) await q('BEGIN');
    try {
      // Vectors first, before anything moves (pg-mem's ROLLBACK undoes nothing): a legacy document
      // whose adopted id (`orgVectorId`) is already taken refuses the whole adoption, as in every store.
      const clash = (await q(
        `SELECT a.id AS id FROM gnl_vectors a JOIN gnl_vectors b ON b.id = $1 || ':' || a.id WHERE a.namespace IS NULL LIMIT 1`, [ns],
      )).rows[0] as { id: string } | undefined;
      if (clash) throw vectorAdoptCollision(clash.id);
      // The organization-space rule is `orgSpaceSql`'s (organization.ts), not a `LIKE` restated here.
      const space = (col: string, outside = false) => { let n = 0; return orgSpaceSql(col, () => `$${++n}`, { outside }); };
      // Work-store keys by `workKeyAdoption` (see the SQLite twin), decided before anything moves.
      const kvRoot = space('key', true);
      for (const { key, value } of (await q(`SELECT key, value FROM gnl_work_kv WHERE ${kvRoot.cond}`, kvRoot.params)).rows as { key: string; value: string }[]) {
        if (isPlatformKey(key)) continue;
        const orgHas = (await q('SELECT 1 AS x FROM gnl_work_kv WHERE key = $1', [prefix + key])).rows.length > 0;
        const d = workKeyAdoption(deserialize(value), orgHas);
        if (d === 'collision') throw workKeyAdoptCollision(prefix + key);
        if (d === 'reset-position') resetPositions.push(key);
      }
      if (!dryRun) for (const k of resetPositions) await q('DELETE FROM gnl_work_kv WHERE key = $1', [k]);
      const notCarried = new Set(resetPositions);
      // The tables and columns are the model's (`SCOPE_TABLES`, model.ts) — one list for both SQL stores.
      for (const [table, col, store, counted] of SCOPE_TABLES) {
        const inQ = space(col);
        if (counted) alreadyScoped += Number((await q(`SELECT COUNT(*) AS c FROM ${table} WHERE ${inQ.cond}`, inQ.params)).rows[0].c);
        const rootQ = space(col, true);
        const rows = (await q(`SELECT DISTINCT ${col} AS k FROM ${table} WHERE ${rootQ.cond}`, rootQ.params)).rows as { k: string }[];
        let n = 0;
        for (const { k } of rows) {
          if (isPlatformKey(k)) { skipped.add(k.split(':')[0]!); continue; }
          if (table === 'gnl_work_kv' && notCarried.has(k)) continue;
          if (counted) n += Number((await q(`SELECT COUNT(*) AS c FROM ${table} WHERE ${col} = $1`, [k])).rows[0].c);
          if (dryRun) continue;
          if (table === 'gnl_work_log') {
            // APPENDED to the organization's log: unnumbered, so the next `list` numbers them after
            // everything it already holds (see the SQLite twin, and `WorkStore.list`).
            await q('UPDATE gnl_work_log SET ns = $1, seq = 0 WHERE ns = $2', [prefix + k, k]);
          } else {
            await q(`UPDATE ${table} SET ${col} = $1 WHERE ${col} = $2`, [prefix + k, k]);
          }
        }
        bump(store, n);
      }
      // gnl_meta minus the engine's own rows — see ENGINE_META_KEYS.
      const metaRoot = space('k', true);
      const metaIn = space('k');
      const metaRows = (await q(`SELECT k FROM gnl_meta WHERE ${metaRoot.cond}`, metaRoot.params)).rows as { k: string }[];
      alreadyScoped += Number((await q(`SELECT COUNT(*) AS c FROM gnl_meta WHERE ${metaIn.cond}`, metaIn.params)).rows[0].c);
      let metaN = 0;
      for (const { k } of metaRows) {
        // Reported as the platform keys of every other table are, by family; the engine's own rows are
        // not platform keys and are not reported (the three stores used to answer three different lists).
        if (ENGINE_META_KEYS.includes(k)) continue;
        if (isPlatformKey(k)) { skipped.add(k.split(':')[0]!); continue; }
        metaN++;
        if (!dryRun) await q(`UPDATE gnl_meta SET k = $1 WHERE k = $2`, [prefix + k, k]);
      }
      bump('meta', metaN);

      const vecs = Number((await q(`SELECT COUNT(*) AS c FROM gnl_vectors WHERE namespace IS NULL`)).rows[0].c);
      alreadyScoped += Number((await q(`SELECT COUNT(*) AS c FROM gnl_vectors WHERE namespace IS NOT NULL`)).rows[0].c);
      // Renamed as well as stamped: an organization stores its documents as `<ns>:<id>` (withOrgStorage).
      if (!dryRun && vecs) await q(`UPDATE gnl_vectors SET namespace = $1, id = $1 || ':' || id WHERE namespace IS NULL`, [ns]);
      bump('vectors', vecs);

      if (!dryRun) await q('COMMIT');
    } catch (e) {
      if (!dryRun) await q('ROLLBACK').catch(() => {});
      throw e;
    } finally { client.release?.(); }
    return { orgId, dryRun, moved, alreadyScoped, skippedPlatformKeys: [...skipped].sort(), resetPositions: resetPositions.sort() };
  }

  async compact(opts?: { full?: boolean }): Promise<{ reclaimedBytes: number }> {
    refuseUnknownNames('compact', opts, COMPACT_NAMES);
    const tables = ['gnl_run_journal', 'gnl_runs', 'gnl_messages', 'gnl_work_log', 'gnl_vectors'];
    for (const t of tables) {
      await this.ensureReady();
      await this._pool.query(`VACUUM ${opts?.full ? 'FULL ' : ''}${t}`); // FULL: ACCESS EXCLUSIVE lock
    }
    return { reclaimedBytes: -1 };
  }

  /**
   * P2-migrate connectionless — the exact DDL array `ensureReady()` executes
   * (already includes the H11b `suspended_count` ALTER, see the DDL const above). For CI schema diffing
   * or an out-of-band migration script.
   */
  exportSchema(): string[] {
    return [...DDL];
  }

  /**
   * Each index of the current schema by name, and whether it is valid (`pg_index.indisvalid`). Rejects
   * when the backend cannot say — no catalog, or one without a real `indisvalid` (pg-mem answers with
   * none) — so a caller leaves indexes out rather than reading every one as invalid.
   */
  private async indexValidity(): Promise<Map<string, boolean>> {
    const r = await this._pool.query(
      `SELECT c.relname AS name, i.indisvalid AS valid FROM pg_index i JOIN pg_class c ON c.oid = i.indexrelid
        JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = current_schema()`,
    );
    const rows = r.rows as { name: string; valid: unknown }[];
    // A Postgres with these tables always has their primary keys' indexes: an empty catalog (pg-mem's)
    // or one with no real `indisvalid` is a backend that cannot say, not one with no index.
    if (rows.length === 0 || rows.some((x) => typeof x.valid !== 'boolean')) throw new Error('this backend does not report index validity');
    return new Map(rows.map((x) => [x.name, x.valid as boolean]));
  }

  /**
   * P2-migrate: READ-ONLY dry-run against information_schema — deliberately bypasses `this.q`/
   * `ensureReady()` (unlike every other method on this class) so calling it does NOT auto-create the
   * schema first. That's what makes "disable auto-init, run checkSchema/migrateSchema out-of-band"
   * actually work for Postgres: `ensureReady` is already lazy (only `this.q`-routed calls trigger it), so
   * simply not routing through it is enough — no constructor change needed. Never mutates.
   */
  async checkSchema(): Promise<SchemaCheckResult> {
    const expected = tablesFromDDL(DDL);
    const tRes = await this._pool.query(`SELECT table_name FROM information_schema.tables WHERE table_schema = current_schema()`);
    const liveTables = new Set(
      (tRes.rows as { table_name: string }[]).map((r) => r.table_name).filter((t) => t.startsWith('gnl_')),
    );
    const cRes = await this._pool.query(`SELECT table_name, column_name FROM information_schema.columns WHERE table_schema = current_schema()`);
    const liveCols = new Map<string, Set<string>>();
    for (const row of cRes.rows as { table_name: string; column_name: string }[]) {
      if (!row.table_name.startsWith('gnl_')) continue;
      if (!liveCols.has(row.table_name)) liveCols.set(row.table_name, new Set());
      liveCols.get(row.table_name)!.add(row.column_name);
    }
    const missingTables: string[] = [];
    const missingColumns: MissingColumn[] = [];
    for (const [table, cols] of expected) {
      if (!liveTables.has(table)) { missingTables.push(table); continue; }
      const have = liveCols.get(table) ?? new Set<string>();
      for (const col of cols.keys()) if (!have.has(col)) missingColumns.push({ table, column: col });
    }
    const unknownTables = [...liveTables].filter((t) => !expected.has(t));
    // An index is there only when it is VALID: a CREATE INDEX CONCURRENTLY that failed (a lock timeout, a
    // cancel) leaves its name in the catalog with `indisvalid = false` — never used, never maintained, and
    // skipped by every `IF NOT EXISTS`. Read by name it looked present, and the schema step never ran
    // again. pg-mem has no `pg_index`: there the index half is left out rather than reported as all missing.
    // A role REFUSED the catalog (42501) is not a backend without one: the indexes cannot be vouched for,
    // so the schema is not reported whole — an INVALID index would otherwise stay unreported for good.
    let unreadable = false;
    const liveIndexes = await this.indexValidity()
      .then((m) => new Set([...m].filter(([, valid]) => valid).map(([name]) => name)), (e: unknown) => {
        unreadable = (e as { code?: string } | undefined)?.code === '42501';
        return undefined;
      });
    const missingIndexes = liveIndexes ? [...indexesFromDDL(DDL).keys()].filter((n) => !liveIndexes.has(n)) : undefined;
    return {
      ok: missingTables.length === 0 && missingColumns.length === 0 && (missingIndexes?.length ?? 0) === 0 && !unreadable,
      missingTables, missingColumns, unknownTables, ...(missingIndexes ? { missingIndexes } : {}),
    };
  }

  /**
   * P2-migrate: applies exactly the gap checkSchema reports (same additive-only contract as
   * SqliteStorage.migrateSchema — never drops/renames, see migrate.ts's header). Also bypasses
   * `this.q`/`ensureReady()` — queries `this._pool` directly so it never implicitly runs the full DDL
   * first. `dryRun: true` returns the statements it WOULD run without touching the DB.
   */
  /**
   * See `Storage.upgrade`. Steps: `run-status` (an earlier version's status flags into `status` and
   * `outcome` — the one step that drops columns), `schema` (the tables, columns and indexes this version
   * expects — additive only), then `thread-records`, then `relations` (places older rows' person and thread).
   */
  async upgrade(opts?: UpgradeOptions): Promise<UpgradeReport> {
    refuseUnknownNames('PostgresStorage.upgrade', opts, UPGRADE_NAMES);
    return runUpgrade('PostgresStorage', [
      runStatusStep(this),
      {
        name: 'schema',
        description: 'adds the tables, columns and indexes this version expects (additive: never drops or renames)',
        requires: ['run-status'],
        pending: async () => !(await this.checkSchema()).ok,
        plan: async () => ({ statements: (await this.applySchemaGap({ dryRun: true })).statements }),
        run: async () => ({ statements: (await this.applySchemaGap()).statements }),
      },
      this.booted(threadRecordsStep(this, ['schema'])),
      this.booted(relationsStep(this.runs as PgRunJournal, ['schema'])),
      this.booted(verifyRelationsStep(this.runs as PgRunJournal, ['schema'])),
    ], opts);
  }

  /**
   * A step that reads through the adapter, run on a booted one. Some of the adapter's SQL is shaped by
   * what the boot settles — the collation its key ranges need (`COLLATE "C"` on a linguistic database),
   * whether the relation guards hold — and a statement built before the boot is built without it: on an
   * en_US.utf8 database the first `listKeys('__org__:')` of an unbooted instance matched nothing, so the
   * `thread-records` step saw no organization and called every scope complete (measured on a store
   * 19b94c3f wrote: acme's threads were marked only by a second `gnl upgrade`). Before this step existed
   * the CLI booted the store first; a store whose `run-status` step is pending refuses to boot, so each
   * step boots it once the steps before it have run.
   */
  private booted(step: UpgradeStep): UpgradeStep {
    const plan = step.plan;
    return {
      ...step,
      pending: async () => { await this.ensureReady(); return step.pending(); },
      ...(plan ? { plan: async () => { await this.ensureReady(); return plan.call(step); } } : {}),
      run: async () => { await this.ensureReady(); return step.run(); },
    };
  }

  /** `gnl_runs`' columns as the catalog has them; empty when there is no such table yet. */
  private async runColumns(on: { query: Pool['query'] } = this._pool): Promise<Set<string>> {
    const r = await on.query(`SELECT column_name FROM information_schema.columns WHERE table_schema = current_schema() AND table_name = 'gnl_runs'`);
    return new Set((r.rows as { column_name: string }[]).map((x) => x.column_name));
  }

  /** See RunStatusMigrator. Asks the catalog, never `ensureReady` (which refuses such a store). */
  async runStatusPending(): Promise<boolean> {
    return runStatusPending(await this.runColumns());
  }

  /** The statements `migrateRunStatus` runs on this store, in order (`gnl upgrade --list`). */
  async runStatusPlan(): Promise<string[]> {
    const cols = await this.runColumns();
    if (!runStatusPending(cols)) return [];
    const m = runStatusMigration(cols);
    return [m.add, `${m.page} -- then, per page: ${m.fill('$1, …')}`, m.index, m.byStatus, 'ANALYZE gnl_runs', 'BEGIN', 'LOCK TABLE gnl_runs IN ACCESS EXCLUSIVE MODE', m.reconcile,
      'DROP INDEX IF EXISTS gnl_runs_open', 'ALTER INDEX gnl_runs_open_status RENAME TO gnl_runs_open', m.drop, m.dropDefault, 'COMMIT'];
  }

  /**
   * The `run-status` step: `gnl_runs`' four flags into `outcome` and `status`, then the flags dropped.
   *
   * 1. The two columns added — `status` with a DEFAULT of 'completed', which Postgres (11+) stores once
   *    in the catalog rather than in every row: no table rewrite, a lock held for milliseconds. Every run
   *    no flag marks is then already right.
   * 2. The runs a flag marks filled, FILL_PAGE at a time in creation order, each page its own statement:
   *    row locks only, no table lock, client memory bounded by a page. A page picks only rows still at
   *    the default — a filled row never is (a flag always means a status other than 'completed') — so a
   *    step killed here and run again continues where it stopped.
   * 3. The two indexes on `status` built CONCURRENTLY (writers are not held off) — `gnl_runs_open` under a
   *    temporary name, since the old one on the flags still has it — then ANALYZE, so the planner knows
   *    the new column before the lock is taken.
   * 4. One short transaction under an ACCESS EXCLUSIVE lock on `gnl_runs`: every row a flag marks or
   *    whose status is not the default is compared with what its flags say, and the few that differ —
   *    written by an earlier version's process after their page — are written again; then the old index
   *    and the flags go, the new index takes the old name, and the default goes, so a write that names no
   *    status fails instead of quietly reading 'completed'. A write of an earlier version either commits
   *    before the lock (and is reconciled) or after it (and fails on the missing column). Killed, the
   *    transaction rolls back and the step runs again from 2 (nothing left to fill) on.
   * Measured on 1 000 000 runs (C+ A2): 167 flagged — 0.6 s, the lock held 6 ms (99 ms on a store 0.10.0
   * wrote: no index on the flags, so the reconcile reads the table); 500 167 flagged — 20 s, nearly all
   * of it the fill, the lock 216 ms. A first design that filled under the lock held it 16 s there.
   */
  async migrateRunStatus(): Promise<Record<string, unknown>> {
    const ms: Record<string, number> = {};
    const timed = async <T>(phase: string, f: () => Promise<T>): Promise<T> => {
      const t0 = Date.now();
      try { return await f(); } finally { ms[phase] = (ms[phase] ?? 0) + Date.now() - t0; }
    };
    if (!runStatusPending(await this.runColumns())) return { runs: 0, ms };
    if (typeof this._pool.connect !== 'function') {
      throw new Error('@gnldev/durable: the run-status step needs a pool that supports connect(), so its last part is one transaction. Pass a real `pg` Pool (or a connectionString).');
    }
    // A backend without some statement (pg-mem: LOCK TABLE, CREATE INDEX CONCURRENTLY, ALTER INDEX) answers
    // with an error that carries no SQLSTATE; a real Postgres error always has one, and is never swallowed.
    const unsupported = (e: unknown) => (e as { code?: string } | undefined)?.code === undefined;
    await timed('addColumns', () => this._pool.query(runStatusMigration(new Set()).add));
    const m = runStatusMigration(await this.runColumns());
    let runs = 0;
    let pages = 0;
    await timed('fill', async () => {
      let after: { at: unknown; runId: string } | undefined;
      for (;;) {
        const page = (await this._pool.query(m.page, after ? [after.at, after.runId] : [null, null])).rows as { run_id: string; created_at: unknown }[];
        if (page.length === 0) break;
        const r = await this._pool.query(m.fill(page.map((_, k) => `$${k + 1}`).join(', ')), page.map((x) => x.run_id));
        runs += Number(r.rowCount ?? page.length);
        pages++;
        const last = page[page.length - 1]!;
        after = { at: last.created_at, runId: last.run_id };
        if (page.length < FILL_PAGE) break;
      }
    });
    await timed('index', async () => {
      const valid = await this.indexValidity().catch(() => undefined);
      for (const [name, sql] of [['gnl_runs_open_status', m.index], ['gnl_runs_status', m.byStatus]] as const) {
        if (valid?.get(name) === false) await this._pool.query(`DROP INDEX CONCURRENTLY IF EXISTS ${name}`);
        await this._pool.query(sql).catch((e: unknown) => {
          if (!unsupported(e)) throw e;
          return this._pool.query(sql.replace(' CONCURRENTLY', ''));
        });
      }
    });
    // The planner's picture of the new column BEFORE the lock: without it the reconcile below read the
    // whole table under the lock (1 000 000 runs: a sequential scan, 135 ms) instead of the two indexes
    // (0.5 ms).
    const analyzed = await timed('analyze', () => this._pool.query('ANALYZE gnl_runs').then(() => true, () => false));
    const client = await this._pool.connect();
    let reconciled = 0;
    let destroy = false;
    try {
      await timed('lockedSwap', async () => {
        await client.query('BEGIN');
        try {
          await client.query('LOCK TABLE gnl_runs IN ACCESS EXCLUSIVE MODE').catch((e: unknown) => { if (!unsupported(e)) throw e; });
          // Asked again under the lock: another `gnl upgrade` may have finished while this one waited.
          const cols = await this.runColumns(client);
          if (RUN_STATUS_FLAGS.some((f) => cols.has(f))) {
            const now = runStatusMigration(cols);
            reconciled = Number((await client.query(now.reconcile)).rowCount ?? 0);
            await client.query('DROP INDEX IF EXISTS gnl_runs_open');
            await client.query('ALTER INDEX gnl_runs_open_status RENAME TO gnl_runs_open').catch(async (e: unknown) => {
              if (!unsupported(e)) throw e;
              await client.query('DROP INDEX IF EXISTS gnl_runs_open_status');
              await client.query(now.index.replace(' CONCURRENTLY', '').replace('gnl_runs_open_status', 'gnl_runs_open'));
            });
            await client.query(now.drop);
            await client.query(now.dropDefault);
          }
          await client.query('COMMIT');
        } catch (e) {
          await client.query('ROLLBACK').catch(() => { destroy = true; });
          throw e;
        }
      });
    } finally {
      client.release?.(destroy);
    }
    return { runs, pages, reconciled, analyzed, ms };
  }

  /** The `schema` step: applies exactly the gap checkSchema reports (see above). */
  private async applySchemaGap(opts?: { dryRun?: boolean }): Promise<SchemaMigrationResult> {
    const check = await this.checkSchema();
    const expected = tablesFromDDL(DDL);
    const statements: string[] = [];
    for (const table of check.missingTables) {
      for (const stmt of DDL) {
        if (new RegExp(`^CREATE TABLE IF NOT EXISTS ${table}\\b`, 'i').test(stmt)
          || new RegExp(`^CREATE INDEX IF NOT EXISTS \\S+ ON ${table}\\b`, 'i').test(stmt)) {
          statements.push(stmt);
        }
      }
    }
    for (const { table, column } of check.missingColumns) {
      const def = expected.get(table)?.get(column);
      if (def) statements.push(`ALTER TABLE ${table} ADD COLUMN IF NOT EXISTS ${def}`);
      // A column numbered by a sequence (`gnl_run_journal.ord`, `gnl_work_log.ord`) is added at 0 and only
      // then given its default — the DDL's own two statements, carried with it. Without them every INSERT
      // until the first boot of this version, an older process's included, would write 0: "written
      // before the column", which a numbered row of the same run then follows.
      for (const stmt of DDL) {
        const m = /^ALTER TABLE (\S+) ALTER COLUMN (\S+) SET DEFAULT nextval\('([^']+)'\)$/.exec(stmt);
        if (m && m[1] === table && m[2] === column) statements.push(`CREATE SEQUENCE IF NOT EXISTS ${m[3]}`, stmt);
      }
    }
    // An index an existing table lacks — after the columns it may need, and CONCURRENTLY, so building it
    // over a large table does not hold every writer off (a plain CREATE INDEX takes a lock that blocks
    // writes for the whole build). Run this step before the new version's processes boot: their boot
    // DDL would otherwise build the same index the blocking way. A backend that cannot build
    // concurrently (pg-mem) builds it plainly.
    // An INVALID one (see checkSchema) is dropped first, the same non-blocking way, or `IF NOT EXISTS`
    // would skip it. A build that fails throws: the step stays pending and runs again, rather than
    // falling back to a plain CREATE INDEX — which waits on the same lock, holding writers off, and
    // skips the invalid entry anyway.
    const all = indexesFromDDL(DDL);
    const present = (check.missingIndexes ?? []).length ? await this.indexValidity() : new Map<string, boolean>(); // asked only where checkSchema could
    for (const name of check.missingIndexes ?? []) {
      const ix = all.get(name);
      if (!ix || statements.includes(ix.statement)) continue;
      if (present.get(name) === false) statements.push(`DROP INDEX CONCURRENTLY IF EXISTS ${name}`);
      statements.push(ix.statement.replace(/^CREATE INDEX /i, 'CREATE INDEX CONCURRENTLY '));
    }
    if (opts?.dryRun) return { statements, dryRun: true };
    for (const stmt of statements) await this._pool.query(stmt);
    return { statements, dryRun: false };
  }
}

/** Runs the `run-status` step fills per statement (Postgres). */
const FILL_PAGE = 5000;

/**
 * The `run-status` step's statements for a `gnl_runs` with these columns (the flags it has: a store from
 * before one of them existed lacks it, and a missing flag reads false, as it did there — except
 * `suspended`, which every version had: without it the flags are ones an earlier version's boot put back
 * on a migrated table, and the counter decides, as it does for this version).
 */
function runStatusMigration(cols: ReadonlySet<string>): {
  add: string; page: string; fill: (ids: string) => string; index: string; byStatus: string; reconcile: string; drop: string; dropDefault: string;
} {
  const flags = RUN_STATUS_FLAGS.filter((f) => cols.has(f));
  const on = (f: (typeof RUN_STATUS_FLAGS)[number]) => (flags.includes(f) ? `${f} = true` : 'false');
  // The order 0.10 decoded the flags in (`outcomeOfRow`); they were written together from one outcome,
  // so at most one is set and the order never decides anything on a row 0.10 wrote.
  const outcome = `(CASE WHEN ${on('canceled')} THEN 'canceled' WHEN ${on('failed')} THEN 'failed' WHEN ${on('running')} THEN 'running' END)`;
  const status = runStatusCaseSql(flags.includes('suspended') ? on('suspended') : 'suspended_count > 0', outcome);
  // The runs a flag marks, in the order of 0.10's `gnl_runs_open` predicate, so the planner reads them from it.
  const flagged = flags.length ? `(${(['canceled', 'suspended', 'failed', 'running'] as const).filter((f) => flags.includes(f)).map((f) => `${f} = true`).join(' OR ')})` : 'false';
  const set = `outcome = ${outcome}, status = ${status}`;
  return {
    add: `ALTER TABLE gnl_runs ADD COLUMN IF NOT EXISTS outcome TEXT, ADD COLUMN IF NOT EXISTS status TEXT NOT NULL DEFAULT 'completed'`,
    // Keyset by (created_at, run_id), expanded rather than a row comparison (pg-mem refuses those);
    // `$1` NULL on the first page.
    page: `SELECT run_id, created_at FROM gnl_runs WHERE ${flagged} AND status = 'completed'`
      + ` AND ($1::bigint IS NULL OR created_at > $1::bigint OR (created_at = $1::bigint AND run_id > $2::text)) ORDER BY created_at, run_id LIMIT ${FILL_PAGE}`,
    fill: (ids) => `UPDATE gnl_runs SET ${set} WHERE run_id IN (${ids})`,
    index: `CREATE INDEX CONCURRENTLY IF NOT EXISTS gnl_runs_open_status ON gnl_runs (created_at, run_id) WHERE ${openRunPredicate()}`,
    byStatus: `CREATE INDEX CONCURRENTLY IF NOT EXISTS gnl_runs_status ON gnl_runs (status, created_at, run_id) WHERE ${openRunPredicate()}`,
    // A run a flag marks, or one already filled whose flags an earlier version's write has since cleared,
    // that says something else than its flags. Without `suspended` the flags are an earlier version's
    // boot put back after the step (empty, never written: its writes all name `suspended`) and the
    // columns are the truth, so only a row such a flag marks is looked at — none.
    // COALESCE rather than IS DISTINCT FROM: the same answer, and pg-mem parses it.
    reconcile: `UPDATE gnl_runs SET ${set} WHERE ${flags.includes('suspended') ? `(${flagged} OR ${openRunPredicate()})` : flagged}`
      + ` AND (status <> ${status} OR COALESCE(outcome, '') <> COALESCE(${outcome}, ''))`,
    drop: `ALTER TABLE gnl_runs ${(flags.length ? flags : RUN_STATUS_FLAGS).map((f) => `DROP COLUMN IF EXISTS ${f}`).join(', ')}`,
    dropDefault: `ALTER TABLE gnl_runs ALTER COLUMN status DROP DEFAULT`,
  };
}

type Q = (sql: string, params?: unknown[]) => Promise<QueryResult>;
/** `where` (empty, or ` WHERE …` from keysetRunPage) with one more condition. */
const and = (where: string, cond: string): string => (where ? `${where} AND ${cond}` : ` WHERE ${cond}`);
/**
 * A page of the `relations` step again, when Postgres refused its transaction for a deadlock (40P01) or a
 * serialization failure (40001): the step's FOR SHARE read and its UPDATE meet live writers on the same
 * rows, and Postgres resolves that by aborting one side — measured, 190 of ~5 000 step calls under
 * load. The page placed nothing (its transaction rolled back), so running it again is exact. Five tries,
 * then the error is the caller's: the step stays pending and runs again.
 */
async function againOnConflict<T>(page: () => Promise<T>): Promise<T> {
  for (let attempt = 1; ; attempt++) {
    try {
      return await page();
    } catch (e) {
      const code = (e as { code?: string } | undefined)?.code;
      if ((code !== '40P01' && code !== '40001') || attempt >= 5) throw e;
      await new Promise((r) => setTimeout(r, 10 * attempt * attempt));
    }
  }
}
/** Rows the `relations` step reads and places per transaction. */
const PLACE_PAGE = 1000;
/** Number of rows inserted: real pg rowCount (0 on a DO NOTHING conflict); pg-mem fallback is rows.length. */
const inserted1 = (r: QueryResult) => (r.rowCount ?? r.rows.length) === 1;

/** A journal record's row. `owner` (ownerColumnOf): written with the record, in the same statement, every time the record is. */
const journalRow = (key: string, value: unknown, p: { runId: string; kind: string } | null, suspended: boolean): unknown[] =>
  [key, p?.runId ?? null, p?.kind ?? null, !!suspended, serialize(value), Date.now(), ownerColumnOf(key, value)];
const JOURNAL_UPSERT = `INSERT INTO gnl_run_journal (key, run_id, kind, suspended, value, created_at, owner) VALUES ($1,$2,$3,$4,$5,$6,$7)
  ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, suspended = EXCLUDED.suspended, owner = EXCLUDED.owner`;
const JOURNAL_INSERT = `INSERT INTO gnl_run_journal (key, run_id, kind, suspended, value, created_at, owner) VALUES ($1,$2,$3,$4,$5,$6,$7)
  ON CONFLICT (key) DO NOTHING RETURNING key`;

/**
 * `atomic: true` marks a caller whose correctness DEPENDS on the transaction, so `tx` refuses instead
 * of quietly running the body unwrapped. Every journal write below is such a caller — their own
 * comments say "closes the crash window" and "in a single transaction", and that was true only when a
 * transaction could actually be opened.
 */
/**
 * `atomic`: the caller's correctness depends on the transaction (see the helper). `readCommitted`: run
 * it at READ COMMITTED whatever the database's `default_transaction_isolation` says — for a statement
 * written for that level's semantics (`PgWorkStore.numberNew`).
 */
type TxOptions = { atomic?: true; readCommitted?: true };
type Tx = <T>(fn: (q: Q) => Promise<T>, opts?: TxOptions) => Promise<T>;

/** A `gnl_runs` row (with its `:input` value as `input_val`) as the summary every listing hands out. */
function pgRunSummary(x: any): RunSummary {
  const input = x.input_val ? deserialize<{ threadId?: string; agent?: string; resourceId?: string; workKey?: string; parentRunId?: string }>(x.input_val) : undefined;
  return {
    runId: x.run_id, status: x.status as RunStatus, modelSteps: Number(x.model_steps), toolCalls: Number(x.tool_calls),
    ...(input?.threadId ? { threadId: input.threadId } : {}),
    ...(input?.agent ? { agent: input.agent } : {}),
    ...(input?.resourceId ? { resourceId: input.resourceId } : {}),
    ...(input?.workKey ? { workKey: input.workKey } : {}),
    ...(input?.parentRunId ? { parentRunId: input.parentRunId } : {}),
  };
}

class PgRunJournal implements RunJournal {
  constructor(private q: Q, private tx: Tx, private shape: PrefixShape) {}
  async get<T = unknown>(key: string): Promise<T | undefined> {
    const r = await this.q('SELECT value FROM gnl_run_journal WHERE key = $1', [key]);
    return r.rows[0] ? deserialize<T>(r.rows[0].value) : undefined;
  }
  async put(key: string, value: unknown): Promise<void> {
    const p = parseJournalKey(key);
    const suspended = p?.kind === 'tool' && (value as ToolJournalRecord | undefined)?.status === 'suspended';
    if (!p && !runIdOfKey(key, value) && outcomeStatusOf(key, value) === null) {
      await this.q(JOURNAL_UPSERT, journalRow(key, value, p, suspended)); // genuinely run-less key
      return;
    }
    // T1 audit fix: prev → journal write → run row, all in ONE transaction. Under autocommit there were
    // two hazards: (1) two workers on the same NEW key both see prev=none → the counter
    // double-increments; (2) a crash between the suspended write and the gnl_runs update → stale
    // suspended=false → retention could delete a suspended run. `writeRecord` closes (1) on the
    // JOURNAL row: the second writer of a key waits for the first and reads what it committed.
    // Not a replayable entry (`!p`: no run_id / no kind in the journal table — readRun and
    // time-travel must not start seeing it) may still BELONG to a run: its `:input` registers and
    // places the run, its outcome record sets its outcome and status (`RunRowChanges.noteWrite`).
    await this.writeTx(async (q) => {
      const prev = await this.writeRecord(q, key, value, p, suspended);
      await this.writeRunRows(q, new RunRowChanges().noteWrite(key, value, prev));
    });
  }
  async putIfAbsent(key: string, value: unknown): Promise<boolean> {
    const p = parseJournalKey(key);
    const suspended = p?.kind === 'tool' && (value as ToolJournalRecord | undefined)?.status === 'suspended';
    if (!p && !runIdOfKey(key, value) && outcomeStatusOf(key, value) === null) {
      return inserted1(await this.q(JOURNAL_INSERT, journalRow(key, value, p, suspended))); // genuinely run-less key
    }
    // The INSERT is the claim and its own lock: a concurrent claim of the same key waits for this
    // transaction and then finds the row (DO NOTHING). Only the winner touches the run's row — a lost
    // claim writes nothing at all, run row and relation columns included.
    return this.writeTx(async (q) => {
      const inserted = inserted1(await q(JOURNAL_INSERT, journalRow(key, value, p, suspended)));
      if (inserted) await this.writeRunRows(q, new RunRowChanges().noteWrite(key, value, undefined));
      return inserted;
    });
  }
  /**
   * H1: atomic conditional replace (expired run-lock takeover, see journal.ts JSDoc).
   * Stored form is the same as SQLite: PLAIN serialize() TEXT (no envelope) → comparison happens
   * directly in SQL via `WHERE key=$ AND value=serialize(expected)`; if the affected row count is 1, we won.
   * The superjson roundtrip stability assumption is the same as the note in SQLite — a mismatch = false = the safe side.
   * NOTE: pg-mem faithfully reports UPDATE rowCount (unlike the RETURNING limitation) → verified in conformance;
   * the real PG proof is in integration-real.test.ts.
   */
  async putIfMatch(key: string, expected: unknown, value: unknown): Promise<boolean> {
    const p = parseJournalKey(key);
    const suspended = p?.kind === 'tool' && (value as ToolJournalRecord | undefined)?.status === 'suspended';
    const upd = (q: Q) => q(
      'UPDATE gnl_run_journal SET value = $1, suspended = $2, owner = $5 WHERE key = $3 AND value = $4',
      [serialize(value), !!suspended, key, serialize(expected), ownerColumnOf(key, value)],
    );
    if (!p) {
      const oc = outcomeStatusOf(key, value);
      const placed = runRelationsOf(key, value) !== undefined;
      if (oc === null && !placed) return Number((await upd(this.q)).rowCount ?? 0) === 1; // ':lock' etc. → no derived index
      // The monotonic outcome REPLACEMENT (running→terminal) arrives here: the outcome follows the record,
      // and so do a run's person and thread should its `:input` be replaced this way.
      return await this.writeTx(async (q) => {
        const ok = Number((await upd(q)).rowCount ?? 0) === 1;
        if (ok) await this.writeRunRows(q, new RunRowChanges().noteWrite(key, value, undefined));
        return ok;
      });
    }
    // T1: UPDATE + recountRun in one transaction (closes the crash → stale gnl_runs window). The lock
    // order is the journal row, then the run's row — the order every write path takes.
    return this.writeTx(async (q) => {
      const ok = Number((await upd(q)).rowCount ?? 0) === 1;
      if (ok) await this.recountRun(q, p.runId); // rare path (takeover) → a full recount is safe and sufficient
      return ok;
    });
  }

  /** H8a: in-engine atomic counter (UPSERT arithmetic) — lost-update is impossible, hot-row lock is short. */
  async incrBy(key: string, fields: Record<string, number>): Promise<Record<string, number>> {
    const flat = flattenIncrs([{ key, fields }]);
    if (!flat.length) return {};
    const r = await this.q(`${incrSql(flat.length / 3)} RETURNING field, value`, flat);
    return Object.fromEntries(r.rows.map((row: any) => [row.field, Number(row.value)]));
  }
  async getCounters(key: string): Promise<Record<string, number> | undefined> {
    const r = await this.q('SELECT field, value FROM gnl_counters WHERE key = $1', [key]);
    if (!r.rows.length) return undefined;
    return Object.fromEntries(r.rows.map((row: any) => [row.field, Number(row.value)]));
  }

  /**
   * H10a — DURABILITY REPORT: queries the setup ITSELF for the precondition of exactly-once ("an
   * acked write is never lost"). In multi-server production, asynchronous replication = a lost-write
   * window on failover = exactly-once CAN BE VIOLATED (see the core-hardening review) — this method surfaces
   * that before the run starts. A single node (no replica) is safe for a single worker; noted as such.
   */
  async durabilityReport(): Promise<{
    syncCommit: string;
    standbyNames: string;
    connectedStandbys: number;
    syncStandbys: number;
    safeForFailover: boolean;
    notes: string[];
  }> {
    const one = async (sql: string): Promise<string> => String((await this.q(sql)).rows[0]?.v ?? '');
    const syncCommit = await one("SELECT setting AS v FROM pg_settings WHERE name = 'synchronous_commit'");
    const standbyNames = await one("SELECT setting AS v FROM pg_settings WHERE name = 'synchronous_standby_names'");
    let connectedStandbys = 0;
    let syncStandbys = 0;
    try {
      const r = await this.q("SELECT COUNT(*) AS c, COUNT(*) FILTER (WHERE sync_state = 'sync') AS s FROM pg_stat_replication");
      connectedStandbys = Number(r.rows[0]?.c ?? 0);
      syncStandbys = Number(r.rows[0]?.s ?? 0);
    } catch {
      // if we lack view permission, assume 0 (noted in notes)
    }
    const notes: string[] = [];
    const syncOn = !['off', 'local'].includes(syncCommit);
    let safeForFailover = false;
    if (connectedStandbys === 0) {
      notes.push('No replica (single node): no failover scenario; sufficient for single-worker/single-node. Add a synchronous standby for multi-server production.');
    } else if (!syncOn || standbyNames.trim() === '') {
      notes.push(`ASYNCHRONOUS replication detected (synchronous_commit=${syncCommit}, standby_names='${standbyNames}') — acked CAS writes MAY BE LOST on primary failover → exactly-once can be violated. Set synchronous_commit=on + synchronous_standby_names (see README deployment notes).`);
    } else if (syncStandbys === 0) {
      notes.push('Synchronous config is present but no standby is currently in SYNC state — check replication health.');
    } else {
      safeForFailover = true;
      notes.push(`Synchronous replication active (${syncStandbys} sync standby): acked writes survive failover — live proof: test/failover-real.test.ts.`);
    }
    return { syncCommit, standbyNames, connectedStandbys, syncStandbys, safeForFailover, notes };
  }

  /** H8b: indexed age query for sweepRuns (gnl_runs.updated_at) — without transferring entries. */
  async listStaleRuns(cutoffTs: number, opts?: { includeSuspended?: boolean }): Promise<string[]> {
    const sql = opts?.includeSuspended
      ? 'SELECT run_id FROM gnl_runs WHERE updated_at < $1'
      : 'SELECT run_id FROM gnl_runs WHERE updated_at < $1 AND suspended_count <= 0'; // what 0.10's `suspended` flag was: count > 0
    const r = await this.q(sql, [cutoffTs]);
    return r.rows.map((row: any) => row.run_id);
  }

  /** H8c: cheap run statistics — COUNT + SUM(length(value)) (without transferring data). */
  async readRunStats(runId: string): Promise<{ entries: number; bytes: number }> {
    const r = await this.q(
      'SELECT COUNT(*) AS c, COALESCE(SUM(LENGTH(value)), 0) AS b FROM gnl_run_journal WHERE run_id = $1',
      [runId],
    );
    return { entries: Number(r.rows[0].c), bytes: Number(r.rows[0].b) };
  }
  /** H2: the storage's own clock (epoch ms) — lock TTL decisions become independent of worker clock-skew. */
  async now(): Promise<number> {
    const r = await this.q(`SELECT (extract(epoch from now())*1000)::bigint AS ms`);
    return Number(r.rows[0].ms);
  }
  /**
   * A journal write's transaction (`atomic`), run again when Postgres aborts it as a deadlock victim
   * (40P01). The abort rolled ALL of it back — the record, a claim, the run's row — so running it again
   * is the same write, and a claim that another writer won meanwhile is then simply lost.
   *
   * The one deadlock this version can meet is with an OLDER process (0.10 and before), which locks the
   * run's row before the record's while this version locks the record's first (`writeRecord`): the two
   * writing the SAME key at the same moment can each hold what the other waits for. Postgres breaks it
   * after `deadlock_timeout` (1 s by default) by aborting one; this side retries, the older side
   * surfaces the error as any failed write. Between two processes of this version the order is the same
   * everywhere — journal rows, then run rows in run-id order — so they cannot deadlock on each other.
   */
  private async writeTx<T>(fn: (q: Q) => Promise<T>): Promise<T> {
    for (let attempt = 1; ; attempt++) {
      try {
        return await this.tx(fn, { atomic: true });
      } catch (e) {
        if ((e as { code?: string })?.code !== '40P01' || attempt >= 3) throw e;
      }
    }
  }

  /**
   * Writes a record and returns the row it replaced (`undefined`: a fresh insert, or a record that is
   * not run-scoped) — for a run-scoped record (`<run>:model:…`/`<run>:tool:…`), what its run's counters
   * need, read under the JOURNAL row's lock.
   *
   * An existing key: `SELECT … FOR UPDATE` locks it (and, at READ COMMITTED, reads the latest committed
   * version), then the upsert overwrites it. A new key: the INSERT is the lock — a concurrent writer of
   * the same key waits for this transaction, finds the row (DO NOTHING) and goes round again, now seeing
   * it. So two writers of one key are serialized on that key, and the counter counts it once (T1 (1)).
   *
   * This replaced a lock on the RUN's row (`lockRunRow`: an `ON CONFLICT DO UPDATE` no-op) taken before
   * every write. That serialized every writer of a run — including every sub-agent's tool-call record
   * on its PARENT's row — for the whole transaction, and wrote a dead tuple each time. Measured on the
   * 1M-run Postgres, 200 sub-agents under one parent step: 45 of 119 sampled active backends waited on
   * that row; with a 40-connection pool, 217 samples did. The run's row is now locked by its one upsert
   * (`writeRunRows`), at the end of the transaction, for one statement and the COMMIT.
   */
  private async writeRecord(q: Q, key: string, value: unknown, p: { runId: string; kind: string } | null, suspended: boolean): Promise<{ suspended: boolean } | undefined> {
    if (!p) { await q(JOURNAL_UPSERT, journalRow(key, value, p, suspended)); return undefined; } // counts nothing: no prev needed
    // Twice is the bound for a key that is not deleted in between: the second pass finds the row the
    // first one's INSERT lost to. A third means the key was deleted and inserted again meanwhile.
    for (let attempt = 0; attempt < 3; attempt++) {
      const prev = (await q('SELECT suspended FROM gnl_run_journal WHERE key = $1 FOR UPDATE', [key])).rows[0] as { suspended: boolean } | undefined;
      if (prev) { await q(JOURNAL_UPSERT, journalRow(key, value, p, suspended)); return { suspended: !!prev.suspended }; }
      if (inserted1(await q(JOURNAL_INSERT, journalRow(key, value, p, suspended)))) return undefined;
    }
    throw new Error(`@gnldev/durable: journal key ${JSON.stringify(key)} was deleted and written again by other writers three times while this write waited; nothing was written — retry the write.`);
  }

  /**
   * The runs' rows for one transaction's writes: ONE upsert per run (`RunRowChanges`, run-id order),
   * carrying the counters (H11b: O(1) deltas, never a recount), the `:input`'s person and thread, the
   * outcome, the status, and `updated_at` — which every write advances (the change feed reads it).
   * An upsert, so the row exists whichever write of the run came first (the write-ahead outcome may
   * precede `:input`). After the journal write, so the relation guard (RUN_UNPLACE) has already
   * unplaced the run when this places it again.
   *
   * The status is written in this same statement from its two inputs: a new row's from the values it is
   * inserted with (`runStatusOf`), an existing row's in SQL from its counter after the delta and its
   * outcome after this write (`runStatusCaseSql` — the one place the rule is SQL, generated from the same
   * precedence table), since only the database knows the row's counter.
   */
  private async writeRunRows(q: Q, changes: RunRowChanges): Promise<void> {
    for (const [runId, c] of changes.entries()) {
      const now = Date.now();
      const outcome = storedOutcomeOf(c.outcome);
      const row: [string, unknown][] = [['run_id', runId], ['model_steps', c.models], ['tool_calls', c.tools],
        ['suspended_count', Math.max(0, c.suspendedDelta)], ['outcome', outcome], ['status', runStatusOf(Math.max(0, c.suspendedDelta), outcome)],
        ['created_at', now], ['updated_at', now]];
      const sets: string[] = [];
      if (c.relations) {
        row.push(['resource_id', c.relations.resourceId], ['thread_id', c.relations.threadId]);
        sets.push('resource_id = EXCLUDED.resource_id', 'thread_id = EXCLUDED.thread_id');
      }
      // An outcome written in this transaction replaces the row's (every transition clears its
      // predecessor, 'completed' included: NULL); otherwise the row keeps its own.
      if (c.outcome) sets.push('outcome = EXCLUDED.outcome');
      const vals = row.map(([, v]) => v);
      const param = (v: unknown) => `$${vals.push(v)}`;
      const delta = param(c.suspendedDelta);
      // `status` first: Postgres reads every `gnl_runs.` in the SET as the row before the update, whatever
      // the order; pg-mem reads each after the assignments before it (measured: a run with two approvals
      // pending, one resolved, read 'completed' — the count already decremented when the status was
      // computed). First, it is the row before the update on both.
      await q(
        `INSERT INTO gnl_runs (${row.map(([col]) => col).join(', ')}) VALUES (${row.map((_, i) => `$${i + 1}`).join(',')})
         ON CONFLICT (run_id) DO UPDATE SET
           status = ${runStatusCaseSql(`gnl_runs.suspended_count + ${delta} > 0`, c.outcome ? 'EXCLUDED.outcome' : 'gnl_runs.outcome')},
           model_steps = gnl_runs.model_steps + ${param(c.models)},
           tool_calls = gnl_runs.tool_calls + ${param(c.tools)},
           suspended_count = gnl_runs.suspended_count + ${delta},
           updated_at = ${param(now)}${sets.map((x) => `, ${x}`).join('')}`,
        vals,
      );
    }
  }

  /**
   * Whether a lookup may read the relation columns: both guards in place (settled at boot) and no
   * placements waiting to be verified. A process that booted while RELATIONS_VERIFY_KEY was set asks
   * again on each lookup — the `relations` step may since have run in another process (`gnl upgrade`)
   * — and trusts the columns from the first answer that it is gone. Settled processes ask nothing.
   */
  private async relationsTrusted(): Promise<boolean> {
    if (this.shape.relationGuard) return true;
    if (!this.shape.guardsInstalled) return false;
    const r = await this.q(`SELECT 1 AS x FROM gnl_meta WHERE k = $1`, [RELATIONS_VERIFY_KEY]);
    if (r.rows.length === 0) this.shape.relationGuard = true;
    return this.shape.relationGuard === true;
  }

  /**
   * See `Journal.listOwnerRecords` and the sqlite twin: ONE statement, the placed half and the unplaced
   * half over the owner-record index, each record decided from its value.
   */
  async listOwnerRecords(resourceId: string, opts?: { prefix?: string }): Promise<string[]> {
    const c = this.shape.collate;
    if (!(await this.relationsTrusted())) {
      // Nothing keeps the column true here (no OWNER_UNPLACE): every owner record, decided from itself.
      const all = pgRange('key', c, opts?.prefix ?? '', 1);
      const r = await this.q(`SELECT key, value FROM gnl_run_journal WHERE key LIKE '${OWNER_RECORD_LIKE}' AND ${all.where}`, all.params);
      return r.rows.filter((x: { key: string; value: string }) => ownerOfRecord(deserialize(x.value)) === resourceId).map((x: { key: string }) => x.key);
    }
    const a = pgRange('key', c, opts?.prefix ?? '', 2);
    const b = pgRange('key', c, opts?.prefix ?? '', 2 + a.params.length);
    const r = await this.q(
      `(SELECT key, value FROM gnl_run_journal WHERE owner = $1 AND key LIKE '${OWNER_RECORD_LIKE}' AND ${a.where})
       UNION ALL
       (SELECT key, value FROM gnl_run_journal WHERE owner IS NULL AND key LIKE '${OWNER_RECORD_LIKE}' AND ${b.where})`,
      [resourceId, ...a.params, ...b.params],
    );
    return r.rows.filter((x: { key: string; value: string }) => ownerOfRecord(deserialize(x.value)) === resourceId).map((x: { key: string }) => x.key);
  }

  /** See RelationPlacer and `verify-relations`. Nothing to verify where the columns are never trusted (no guards). */
  async requestRelationsVerify(): Promise<void> {
    if (!this.shape.guardsInstalled) return;
    await this.q(`INSERT INTO gnl_meta (k, v) VALUES ($1, $2) ON CONFLICT (k) DO NOTHING`, [RELATIONS_VERIFY_KEY, String(Date.now())]);
    this.shape.relationGuard = false;
  }

  /** See the sqlite twin. */
  async relationsPending(): Promise<boolean> {
    if (this.shape.guardsInstalled) {
      // Placements to verify.
      const v = await this.q(`SELECT 1 AS x FROM gnl_meta WHERE k = $1`, [RELATIONS_VERIFY_KEY]);
      if (v.rows.length) return true;
    }
    const r = await this.q(`SELECT 1 AS x FROM gnl_runs r JOIN gnl_run_journal j ON j.key = r.run_id || ':input' WHERE r.resource_id IS NULL LIMIT 1`);
    if (r.rows.length) return true;
    for (let after = '';;) {
      const rows = await this.unplacedOwners(after);
      if (rows.some((x) => ownerColumnOf(x.key, deserialize(x.value)) !== null)) return true;
      if (rows.length < PLACE_PAGE) return false;
      after = rows[rows.length - 1]!.key;
    }
  }

  /** Owner records not placed yet, after `after` in key order, one page. */
  private async unplacedOwners(after: string): Promise<Array<{ key: string; value: string }>> {
    const c = this.shape.collate;
    return (await this.q(
      `SELECT key, value FROM gnl_run_journal WHERE owner IS NULL AND key LIKE '${OWNER_RECORD_LIKE}' AND key${c} > $1 ORDER BY key${c} LIMIT $2`,
      [after, PLACE_PAGE],
    )).rows as Array<{ key: string; value: string }>;
  }

  /**
   * The `relations` step — see the sqlite twin for every rule: a page at a time, each page in one
   * transaction, a row placed only while it is unplaced and its record is the one read. A page is ONE
   * locked read and ONE update, not one statement a row: the records are read `FOR SHARE` inside the
   * transaction, so none can change before it commits, and the columns are set by a single `CASE` UPDATE
   * (the form pg-mem also runs; it has neither `UPDATE … FROM` nor a correlated subquery there). Row by
   * row, 1 000 000 runs took 1 170 198 statements and 28–31 min, and left the statistics of a table whose
   * every row was NULL. It ends with an ANALYZE so the planner sees the columns it now has.
   * @internal — `storage.upgrade({ only: ['relations'] })` runs it.
   */
  async placeRelations(): Promise<{ runs: number; owners: number; analyzed: boolean }> {
    let runs = 0;
    let owners = 0;
    // Placements made while nothing guarded them (RELATIONS_VERIFY_KEY): cleared, a page at a time, and
    // placed again below from the records. A run placed by a live writer meanwhile may be cleared too —
    // unplaced is always correct, and it is placed again by this pass or the next.
    const verify = this.shape.guardsInstalled === true
      && (await this.q(`SELECT 1 AS x FROM gnl_meta WHERE k = $1`, [RELATIONS_VERIFY_KEY])).rows.length > 0;
    if (verify) {
      while (Number((await this.q(`UPDATE gnl_runs SET resource_id = NULL, thread_id = NULL WHERE run_id IN
        (SELECT run_id FROM gnl_runs WHERE resource_id IS NOT NULL LIMIT ${PLACE_PAGE})`)).rowCount ?? 0) > 0);
      while (Number((await this.q(`UPDATE gnl_run_journal SET owner = NULL WHERE key IN
        (SELECT key FROM gnl_run_journal WHERE owner IS NOT NULL AND key LIKE '${OWNER_RECORD_LIKE}' LIMIT ${PLACE_PAGE})`)).rowCount ?? 0) > 0);
    }
    for (let after = { at: Number.MIN_SAFE_INTEGER, runId: '' };;) {
      const page = (await this.q(
        `SELECT r.run_id, r.created_at FROM gnl_runs r JOIN gnl_run_journal j ON j.key = r.run_id || ':input'
         WHERE r.resource_id IS NULL AND r.created_at >= $1 AND (r.created_at > $1 OR r.run_id > $2) ORDER BY r.created_at, r.run_id LIMIT $3`,
        [after.at, after.runId, PLACE_PAGE],
      )).rows as Array<{ run_id: string; created_at: string | number }>;
      if (page.length) {
        runs += await againOnConflict(() => this.tx(async (q) => {
          const keys = page.map((x) => `${x.run_id}:input`);
          const read = (await q(`SELECT key, value FROM gnl_run_journal WHERE key IN (${keys.map((_, i) => `$${i + 1}`).join(', ')}) FOR SHARE`, keys))
            .rows as Array<{ key: string; value: string }>;
          const placed = read.map((x) => ({ runId: x.key.slice(0, -':input'.length), ...relationsOfInput(deserialize(x.value)) }));
          if (!placed.length) return 0;
          const params: unknown[] = [];
          const whens = placed.map((x) => { params.push(x.runId, x.resourceId, x.threadId); const i = params.length; return [i - 2, i - 1, i] as const; });
          const u = await q(
            `UPDATE gnl_runs SET resource_id = CASE run_id ${whens.map(([id, res]) => `WHEN $${id} THEN $${res}`).join(' ')} END,
                                 thread_id = CASE run_id ${whens.map(([id, , th]) => `WHEN $${id} THEN $${th}`).join(' ')} END
             WHERE resource_id IS NULL AND run_id IN (${whens.map(([id]) => `$${id}`).join(', ')})`,
            params,
          );
          return Number(u.rowCount ?? 0);
        }, { atomic: true }));
      }
      if (page.length < PLACE_PAGE) break;
      const last = page[page.length - 1]!;
      after = { at: Number(last.created_at), runId: last.run_id };
    }
    const c = this.shape.collate;
    for (let after = '';;) {
      const { got, last, placed } = await againOnConflict(() => this.tx(async (q) => {
        const rows = (await q(
          `SELECT key, value FROM gnl_run_journal WHERE owner IS NULL AND key LIKE '${OWNER_RECORD_LIKE}' AND key${c} > $1 ORDER BY key${c} LIMIT $2 FOR SHARE`,
          [after, PLACE_PAGE],
        )).rows as Array<{ key: string; value: string }>;
        const params: unknown[] = [];
        let placed = 0;
        for (const x of rows) {
          const col = ownerColumnOf(x.key, deserialize(x.value));
          if (col !== null) params.push(x.key, col);
        }
        if (params.length) {
          const pairs = Array.from({ length: params.length / 2 }, (_, i) => [2 * i + 1, 2 * i + 2] as const);
          const u = await q(
            `UPDATE gnl_run_journal SET owner = CASE key ${pairs.map(([k, o]) => `WHEN $${k} THEN $${o}`).join(' ')} END
             WHERE owner IS NULL AND key IN (${pairs.map(([k]) => `$${k}`).join(', ')})`,
            params,
          );
          placed = Number(u.rowCount ?? 0);
        }
        return { got: rows.length, last: rows[rows.length - 1]?.key, placed };
      }, { atomic: true }));
      owners += placed;
      if (got < PLACE_PAGE || last === undefined) break;
      after = last;
    }
    // The planner's picture of the new columns: before it, every row reads as unplaced to it. A backend
    // without ANALYZE (pg-mem) says so in the report; nothing about the answers depends on it.
    if (verify) {
      await this.q(`DELETE FROM gnl_meta WHERE k = $1`, [RELATIONS_VERIFY_KEY]);
      this.shape.relationGuard = true;
    }
    const analyzed = runs + owners === 0 ? false
      : await this.q('ANALYZE gnl_runs').then(() => this.q('ANALYZE gnl_run_journal')).then(() => true, () => false);
    return { runs, owners, analyzed };
  }

  /** Full recount — for rare paths (putIfMatch/repair). */
  private async recountRun(q: Q, runId: string): Promise<void> {
    const c = (await q(
      `SELECT SUM(CASE WHEN kind='model' THEN 1 ELSE 0 END) AS m, SUM(CASE WHEN kind='tool' THEN 1 ELSE 0 END) AS t,
              SUM(CASE WHEN suspended THEN 1 ELSE 0 END) AS s, MIN(created_at) AS c0 FROM gnl_run_journal WHERE run_id = $1`,
      [runId],
    )).rows[0];
    // The counter is recounted; the outcome is the row's own (a new row has none), and the status follows both.
    await q(
      `INSERT INTO gnl_runs (run_id, model_steps, tool_calls, suspended_count, status, created_at, updated_at) VALUES ($1,$2,$3,$4,$5,$6,$7)
       ON CONFLICT (run_id) DO UPDATE SET status=${runStatusCaseSql('EXCLUDED.suspended_count > 0', 'gnl_runs.outcome')},
         model_steps=EXCLUDED.model_steps, tool_calls=EXCLUDED.tool_calls, suspended_count=EXCLUDED.suspended_count, updated_at=EXCLUDED.updated_at`,
      [runId, Number(c.m) || 0, Number(c.t) || 0, Number(c.s) || 0, runStatusOf(Number(c.s) || 0, null), Number(c.c0) || Date.now(), Date.now()],
    );
  }
  async listKeys(prefix: string, opts?: { limit?: number }): Promise<string[]> {
    // COLLATE "C" is load-bearing, not a micro-optimisation. Under a linguistic collation (en_US.utf8,
    // the default of nearly every managed Postgres) string comparison is NOT byte order: U+FFFF is a
    // noncharacter and collates as if absent, so `key < prefix || U+FFFF` reduces to `key < prefix` and
    // the range matches NOTHING. Measured on a stock pgvector/pg16 (en_US.utf8): the same range that
    // matches 3 rows under "C" matched 0 under the default. That made listKeys silently return empty
    // and deletePrefix silently delete nothing -- returning 0 with no error, so an org purge, a
    // retention sweep and `deletePrefix('xrun:')` all reported success while the rows stayed. SQLite is
    // unaffected: its default collation IS byte order. The gnl_*_cprefix indexes below are declared
    // with the same collation so these stay index-backed range scans rather than seq scans.
    // Same upper bound as the SQLite approach: prefixUpperBound(prefix).
    const c = this.shape.collate;
    const rg = pgRange('key', c, prefix, 1);
    // `key` tie-breaker: Postgres does not guarantee order for equal ORDER BY keys, and entries written
    // in the same millisecond (parallel tool calls) could otherwise come back in a different order on
    // every read. (Not write order — `readRun` gives that, by `ord`.) Sqlite sorts the same way; this
    // call once sorted without the tie-breaker, so two
    // reads of the same prefix could disagree and a caller paging through them could see a key twice
    // or not at all.
    // A bounded probe asks "is anything here", not "in what order": no sort, the index stops early.
    if (opts?.limit !== undefined) {
      const p = await this.q(`SELECT key FROM gnl_run_journal WHERE ${rg.where} LIMIT $${rg.params.length + 1}`, [...rg.params, opts.limit]);
      return p.rows.map((x) => x.key);
    }
    const r = await this.q(`SELECT key FROM gnl_run_journal WHERE ${rg.where} ORDER BY created_at, key`, rg.params);
    return r.rows.map((x) => x.key);
  }

  /** Retention/GDPR: PERMANENTLY delete keys starting with a prefix; also clean up the derived gnl_runs index. */
  async deletePrefix(prefix: string): Promise<number> {
    const c = this.shape.collate;
    const jr = pgRange('key', c, prefix, 1);
    const r = await this.q(`DELETE FROM gnl_run_journal WHERE ${jr.where}`, jr.params);
    const rid = prefix.endsWith(':') ? prefix.slice(0, -1) : prefix;
    const rr = pgRange('run_id', c, prefix, 2);
    await this.q(`DELETE FROM gnl_runs WHERE run_id = $1 OR (${rr.where})`, [rid, ...rr.params]);
    // Counters (incrBy/H8a) are keys too — see the sqlite-storage.ts deletePrefix note (GDPR org purge
    // + rebuildMetrics correctness). Not included in the return count, same as the gnl_runs rows.
    const cr = pgRange('key', c, prefix, 1);
    await this.q(`DELETE FROM gnl_counters WHERE ${cr.where}`, cr.params);
    return r.rowCount ?? 0;
  }
  async readRun(runId: string): Promise<JournalEntry[]> {
    // JournalReader's ordering contract: first-write order is `ord` (the DDL note on it). Rows written
    // before the column hold 0 — all of them older than every numbered row — and keep the order they
    // had, `(created_at, key)`.
    const r = await this.q('SELECT key, kind, value, created_at FROM gnl_run_journal WHERE run_id = $1 ORDER BY ord, created_at, key', [runId]);
    return r.rows.map((x, seq) => ({ key: x.key, runId, kind: x.kind as JournalEntry['kind'], value: deserialize(x.value), seq, ts: Number(x.created_at) }));
  }
  /**
   * AUDIT (threadId first-class): SAME purpose as the SQLite equivalent — the `<run_id>:input` row is
   * embedded into a SINGLE query (NOT an N+1 round-trip). LEFT JOIN INSTEAD OF a correlated subquery:
   * pg-mem (test-only in-memory Postgres) does NOT SUPPORT a correlated subquery that references the
   * outer alias ("column r.run_id does not exist") — a LEFT JOIN is planned equivalently (and usually
   * faster) on real Postgres too, same behavior. `||` is the string concat operator in Postgres.
   *
   * P0.3 filters — same split as sqlite-storage.ts's listRuns: `status` pushes
   * down to a WHERE on `gnl_runs.status` (the same column every row's summary reads, so a filter cannot
   * drift from it); `agent` has no indexed column (it's inside the `:input` blob) — when given,
   * this fetches every (status-filtered) row WITHOUT LIMIT/OFFSET, filters+paginates in JS (filter
   * BEFORE slicing). Honest scan cost, acceptable for an operator/debug filter — see the sqlite
   * comment for the full rationale.
   */
  async listRuns(q?: ListQuery): Promise<Page<RunSummary>> {
    // The column the summaries read, so a filtered page cannot disagree with a full scan.
    const statusCond = runStatusSql(q);
    const toSummary = pgRunSummary;
    const atOf = async (runId: string) => {
      const r = await this.q('SELECT created_at FROM gnl_runs WHERE run_id = $1', [runId]);
      return r.rows[0] ? Number(r.rows[0].created_at) : undefined;
    };
    const runCols = 'r.run_id, r.created_at, r.model_steps, r.tool_calls, r.status';
    const cols = `${runCols}, j.value AS input_val`;
    const trusted = await this.relationsTrusted();
    return keysetRunPage(q, statusCond, atOf, async (where, params, dir, take, skip, rel?: RunRelationRead) => {
      const order = `ORDER BY r.created_at ${dir}, r.run_id ${dir}`;
      const n = params.length;
      // By a relation: two index ranges (`gnl_runs_resource`/`gnl_runs_thread`), the placed rows that
      // match and the rows not placed yet, each already in order, then cut together — Merge Append.
      // Written as one `(resource_id = $k OR resource_id IS NULL)` the plan depended on the statistics:
      // 100 000 runs, 6 matching, 76 ms walking the created_at index before an ANALYZE, 0.8 ms as two
      // ranges either way. See keysetRunPage for why the unplaced range is never left out.
      // Each range is ordered by its whole index, leading column first: Postgres does not count
      // `resource_id IS NULL` as an equality that fixes that column, so `ORDER BY created_at, run_id`
      // alone let the planner sort the range instead of reading it in order — with the statistics of a
      // table whose columns were just added (every row NULL, estimated 2 840), 1 000 000 runs: 560 742
      // rows read and sorted per page, 308 ms; ordered by the index, 0.17 ms, before and after an ANALYZE.
      // Each range carries its rows' own columns out, rather than run ids joined back to gnl_runs: the
      // join back cost a second index lookup per row — on 1 000 000 unplaced runs a 200-run page took
      // 1.80 ms against the plain listing's 1.02; carrying the columns, 1.02.
      const r = rel
        ? await this.q(
          `SELECT u.*, j.value AS input_val
           FROM ((SELECT ${runCols} FROM gnl_runs r${and(where, `r.${rel.column} = $${n + 1}`)} ${rangeOrder(rel.column, dir)} LIMIT $${n + 2})
                 UNION ALL
                 (SELECT ${runCols} FROM gnl_runs r${and(where, 'r.resource_id IS NULL')} ${rangeOrder('resource_id', dir)} LIMIT $${n + 2})) u
           LEFT JOIN gnl_run_journal j ON j.key = u.run_id || ':input'
           ORDER BY u.created_at ${dir}, u.run_id ${dir} LIMIT $${n + 3} OFFSET $${n + 4}`,
          [...params, rel.value, take + skip, take, skip],
        )
        : await this.q(
          `SELECT ${cols} FROM gnl_runs r LEFT JOIN gnl_run_journal j ON j.key = r.run_id || ':input'${where}
           ${order} LIMIT $${n + 1} OFFSET $${n + 2}`,
          [...params, take, skip],
        );
      return r.rows.map((x: any) => ({ summary: toSummary(x), at: Number(x.created_at) }));
    }, (n) => `$${n}`, trusted, (prefix, from) => pgRange('r.run_id', this.shape.collate, prefix, from)); // the columns, only where both guards keep them true
  }

  /**
   * P1.6b: atomic batch — claim + counter increments + puts as ONE transaction (a single pinned client
   * via `tx`, same helper `put`/`putIfAbsent` use). `put`/`putIfAbsent` themselves can't be REUSED here
   * (each opens its OWN client via `tx()`, which would be a SEPARATE Postgres session — nesting them
   * would silently defeat atomicity) — so it runs the same statements (`JOURNAL_INSERT`, `writeRecord`,
   * `writeRunRows`) on `tx`'s pinned client, and a put derives its run-row change exactly as `put` does.
   *
   * pg-mem NOTE (test-only limitation, see the file-header comment + `exactCas` in the conformance
   * matrix): pg-mem's `INSERT ... ON CONFLICT DO NOTHING RETURNING`/`rowCount` reports 1 even on a
   * genuine conflict — verified experimentally, independent of whether `RETURNING` is present. A
   * SELECT-before-INSERT existence check would dodge that specific test-double bug, but would REGRESS
   * real-Postgres correctness (a genuine TOCTOU race between two concurrent claims on the SAME key —
   * exactly the scenario `applyBatch`'s claim exists to protect). So this mirrors `putIfAbsent`'s
   * genuinely-atomic INSERT-based check (correct on real Postgres, proven in integration-real.test.ts);
   * the pg-mem test suite gates BOTH the boolean AND the resulting counters/puts invariant behind
   * `caps.exactCas` for this one case (see storage-backend.test.ts) — an accepted, documented gap in the
   * test double, not in the adapter.
   */
  async applyBatch(batch: JournalBatch): Promise<boolean> {
    return this.writeTx(async (q) => {
      // Journal rows first, the runs' rows last — the lock order of every write path (`writeRecord`) —
      // and each run's row once, however many of the batch's records belong to it.
      const runs = new RunRowChanges();
      if (batch.claim) {
        const { key, value } = batch.claim;
        const p = parseJournalKey(key);
        const suspended = p?.kind === 'tool' && (value as ToolJournalRecord | undefined)?.status === 'suspended';
        if (!inserted1(await q(JOURNAL_INSERT, journalRow(key, value, p, suspended)))) return false; // claim lost → the whole batch is a no-op (nothing else applied)
        runs.noteWrite(key, value, undefined);
      }
      {
        const flat = flattenIncrs(batch.incrs ?? []);
        if (flat.length) await q(incrSql(flat.length / 3), flat);
      }
      for (const { key, value } of batch.puts ?? []) {
        const p = parseJournalKey(key);
        const suspended = p?.kind === 'tool' && (value as ToolJournalRecord | undefined)?.status === 'suspended';
        const prev = await this.writeRecord(q, key, value, p, suspended);
        runs.noteWrite(key, value, prev);
      }
      await this.writeRunRows(q, runs);
      return true;
    });
  }

  /** P1.6b: batch point-read — a single `WHERE key IN (...)` instead of N sequential `get` calls;
   *  order-preserving, `undefined` for misses (getMany contract, journal.ts). Dynamic `$N` placeholders
   *  (NOT `= ANY($1::text[])`) — pg-mem does not evaluate the array form correctly (verified
   *  experimentally: it returns zero rows even for genuine matches), while plain `IN ($1,$2,...)` works
   *  identically on both pg-mem and real Postgres. */
  async getMany<T = unknown>(keys: string[]): Promise<(T | undefined)[]> {
    if (keys.length === 0) return [];
    const placeholders = keys.map((_, i) => `$${i + 1}`).join(',');
    const r = await this.q(`SELECT key, value FROM gnl_run_journal WHERE key IN (${placeholders})`, keys);
    const byKey = new Map(r.rows.map((row: any) => [row.key as string, row.value as string]));
    return keys.map((k) => (byKey.has(k) ? deserialize<T>(byKey.get(k)!) : undefined));
  }

  /**
   * See `JournalReader.countRuns`. With a prefix, a range of the run id's "C"-collated index — the same
   * range `listRuns({ runIdPrefix })` reads, so the count and the listing agree byte for byte.
   */
  async countRuns(q?: { runIdPrefix?: string }): Promise<number> {
    const rg = q?.runIdPrefix ? pgRange('run_id', this.shape.collate, q.runIdPrefix, 1) : undefined;
    const r = await this.q(`SELECT COUNT(*) AS n FROM gnl_runs${rg ? ` WHERE ${rg.where}` : ''}`, rg?.params ?? []);
    return Number(r.rows[0]?.n ?? 0);
  }

  /**
   * See `JournalReader.listRunsChangedSince`: `gnl_runs` in `(updated_at, run_id)` order from the
   * position, over the existing `gnl_runs_updated (updated_at)` index — no new index, so no write pays
   * for one (`updated_at` changes on every write, which is why a second index on it is not free). The
   * position is the expanded form `updated_at >= a AND (updated_at > a OR run_id > b)`, not a row value:
   * the index bound is the first half, the run id decides only the rows of that one millisecond, and
   * pg-mem refuses row values. A reader polling from a recent `since` reads the rows changed since then
   * and nothing else.
   */
  async listRunsChangedSince(cursor?: string, opts?: { limit?: number; since?: number; runIdPrefix?: string }): Promise<{ items: RunChange[]; nextCursor?: string }> {
    const pos = decodeChangeCursor(cursor);
    const limit = opts?.limit ?? 200;
    const conds: string[] = [];
    const params: unknown[] = [];
    if (pos) {
      conds.push(`r.updated_at >= $1 AND (r.updated_at > $1 OR r.run_id > $2)`);
      params.push(pos.at, pos.runId);
    } else if (opts?.since !== undefined) {
      conds.push(`r.updated_at >= $1`);
      params.push(opts.since);
    }
    if (opts?.runIdPrefix) {
      const rg = pgRange('r.run_id', this.shape.collate, opts.runIdPrefix, params.length + 1);
      conds.push(rg.where);
      params.push(...rg.params);
    }
    const r = await this.q(
      `SELECT r.run_id, r.created_at, r.updated_at, r.model_steps, r.tool_calls, r.status, j.value AS input_val
       FROM gnl_runs r LEFT JOIN gnl_run_journal j ON j.key = r.run_id || ':input'${conds.length ? ` WHERE ${conds.join(' AND ')}` : ''}
       ORDER BY r.updated_at, r.run_id LIMIT $${params.length + 1}`,
      [...params, limit],
    );
    const items: RunChange[] = r.rows.map((x: any) => ({ ...pgRunSummary(x), updatedAt: Number(x.updated_at) }));
    const last = items[items.length - 1];
    return { items, ...(last ? { nextCursor: encodeChangeCursor({ at: last.updatedAt, runId: last.runId }) } : {}) };
  }

  /**
   * P1.6b: push-down status aggregate — one `GROUP BY status` over the column every listing reads, so
   * the counts and the listings cannot disagree about a run.
   */
  async countRunsByStatus(): Promise<Record<string, number>> {
    const r = await this.q(`SELECT status, COUNT(*) AS n FROM gnl_runs GROUP BY status`);
    const out: Record<string, number> = {};
    for (const row of r.rows) out[row.status] = (out[row.status] ?? 0) + Number(row.n);
    return out;
  }
}

/**
 * Serialise appends to one thread, for the length of the caller's transaction.
 *
 * TWO-KEY form, not one. `pg_advisory_xact_lock(bigint)` and `pg_advisory_xact_lock(int, int)` sit in
 * DIFFERENT lock namespaces, and the single-key space is already taken by the boot-DDL lock
 * (47110001), so a one-key `pg_advisory_xact_lock(hash)` could collide with schema creation. `pg_locks`
 * confirms the two-key form is disjoint: classid = THREAD_LOCK_NS, objsubid = 2.
 *
 * The hash is computed here rather than with Postgres's `hashtext`, which does not exist in pg-mem —
 * the default test double for this adapter.
 *
 * COLLISIONS ARE REAL, and an earlier version of this note claimed otherwise. "Zero collisions over
 * 200k ids" was measured on sequential dense strings; over ids in the shape this codebase actually
 * generates it is 3 in 200k, and the expected value for a 32-bit hash at that count is about 5. Nor is
 * the consequence merely a wait: two unrelated threads sharing a key serialise, and with the
 * `lock_timeout` below one of them can exceed it and fail — an unrelated conversation's turn dies.
 * Correctness is unaffected (MAX(seq) and the INSERT are keyed by `thread_id`, not by the hash), but
 * this is a rare availability cost, not free.
 *
 * There is NO try/catch here, deliberately. Catching a missing-function error INSIDE the transaction
 * does not degrade gracefully — Postgres marks the transaction ABORTED, so the very next statement
 * fails with 25P02 `current transaction is aborted` and the caller sees that instead of anything
 * useful. Measured. Whether this server has advisory locks at all is settled once, outside any
 * transaction, by `probeAdvisoryLocks` during `ensureReady`.
 */
/**
 * Said in one sentence, the way `connectionAdvice()` does it: what breaks, and what to do instead.
 */
const NO_TX_MSG =
  '@gnldev/durable: the pool given to PostgresStorage has no connect(), so nothing can be written in a '
  + 'transaction. This is not a degraded mode, it is an unusable one: appending a message batch would '
  + 'leave a tool call with no result, the per-thread append lock cannot be held, and every journal '
  + 'write that spans more than one statement — the replay entries, putIfAbsent, putIfMatch, '
  + 'applyBatch — depends on exactly the atomicity that is missing. Those refuse rather than write '
  + 'unserialised; the memory port is withdrawn outright (capabilities.memory = "none"). Single-'
  + 'statement writes still work, which is why this is reported rather than thrown at construction. '
  + 'Pass a real `pg` Pool, or a connectionString and let the adapter build one.';

const NO_LOCK_APPEND_MSG =
  '@gnldev/durable: this Postgres cannot take the per-thread append lock (no pg_advisory_xact_lock), '
  + 'so two concurrent turns on one thread would silently lose messages. Refusing to append rather '
  + 'than write unserialised. Route the memory port to another adapter, or use a Postgres that '
  + 'exposes pg_advisory_xact_lock(int, int).';

/**
 * Turns `55P03` into something an operator can act on.
 *
 * The raw text is `canceling statement due to lock timeout`, which names neither the thread nor the
 * writer that held it. The measured cause is not contention between ordinary turns — those queue in
 * milliseconds — but a single large explicit-`seq` write: importing a 20,000-row transcript holds the
 * lock for about six seconds, and a live turn on the same thread gives up at five. So the sentence
 * has to point at bulk writes, not at load.
 *
 * `code` is preserved and the original chained as `cause`, following `explain()` above: the code is
 * the only machine-readable signal a caller has for "this is worth retrying".
 */
function lockWaitAdvice(e: unknown, threadId: string, rows: number): unknown {
  if ((e as { code?: string })?.code !== '55P03') return e;
  const err = new Error(
    `@gnldev/durable: appending ${rows} message(s) to thread '${threadId}' timed out waiting for that `
    + `thread's append lock — another writer is holding it. The usual cause is a large explicit-seq `
    + `write on the same thread (a transcript import, or cloneThread): the lock is held for the whole `
    + `batch. Nothing was written, so the run can retry. Import large transcripts into a thread that is `
    + `not taking live turns, or split them into smaller batches.`,
    { cause: e },
  );
  (err as { code?: string }).code = '55P03';
  return err;
}

const THREAD_LOCK_NS = 47110002;

function hash32(s: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 0x01000193); }
  return h | 0;   // signed int32, which is what the two-key form takes
}

class PgMemoryStore implements MemoryStore {
  /**
   * `tx` as well as `q`: a message batch has to land all-or-nothing (see `appendMessages`). Before
   * this, the memory store had no way to open a transaction at all — it was handed only `q`, so every
   * write was its own autocommit on whichever pooled connection answered first.
   */
  constructor(private q: Q, private tx: <T>(fn: (q: Q) => Promise<T>, opts?: { atomic?: true }) => Promise<T>, private advisoryLocks: () => boolean) {}
  async upsertThread(rec: ThreadRecord): Promise<void> {
    await this.q(
      `INSERT INTO gnl_threads (id, resource_id, title, parent_thread_id, metadata, created_at, updated_at, deleted_at) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
       ON CONFLICT (id) DO UPDATE SET resource_id=EXCLUDED.resource_id, title=EXCLUDED.title, parent_thread_id=EXCLUDED.parent_thread_id, metadata=EXCLUDED.metadata, updated_at=EXCLUDED.updated_at, deleted_at=EXCLUDED.deleted_at`,
      [rec.id, rec.resourceId, rec.title ?? null, rec.parentThreadId ?? null, rec.metadata ? serialize(rec.metadata) : null, rec.createdAt, rec.updatedAt, rec.deletedAt ?? null],
    );
  }
  private toThread(x: any): ThreadRecord {
    return { id: x.id, resourceId: x.resource_id, title: x.title ?? undefined, parentThreadId: x.parent_thread_id ?? undefined, metadata: x.metadata ? deserialize(x.metadata) : undefined, createdAt: Number(x.created_at), updatedAt: Number(x.updated_at), deletedAt: x.deleted_at != null ? Number(x.deleted_at) : undefined };
  }
  async getThread(id: string): Promise<ThreadRecord | undefined> {
    const r = await this.q('SELECT * FROM gnl_threads WHERE id = $1 AND deleted_at IS NULL', [id]);
    return r.rows[0] ? this.toThread(r.rows[0]) : undefined;
  }
  async listThreads(q: { resourceId?: string } & ListQuery & MemoryPartitionOption): Promise<Page<ThreadRecord>> {
    const { start, limit } = offset(q);
    let n = 0;
    const part = memoryPartitionSql(memoryPartitionOf(q), 'id', () => `$${++n}`);
    const where = `deleted_at IS NULL AND ${part.cond}${q.resourceId != null ? ` AND resource_id = $${++n}` : ''}`;
    const base = [...part.params, ...(q.resourceId != null ? [q.resourceId] : [])];
    const total = Number((await this.q(`SELECT COUNT(*) AS n FROM gnl_threads WHERE ${where}`, base)).rows[0].n);
    const r = await this.q(`SELECT * FROM gnl_threads WHERE ${where} ORDER BY updated_at DESC, id LIMIT $${base.length + 1} OFFSET $${base.length + 2}`, [...base, limit, start]);
    return pageOf(r.rows.map((x) => this.toThread(x)), start, limit, total);
  }
  async deleteThread(id: string): Promise<void> {
    // Soft delete, and the row keeps nothing the person wrote: its title is often their first message.
    await this.q('UPDATE gnl_threads SET deleted_at = $1, title = NULL, metadata = NULL, parent_thread_id = NULL WHERE id = $2', [Date.now(), id]);
    await this.q('DELETE FROM gnl_messages WHERE thread_id = $1', [id]);
    await this.q('DELETE FROM gnl_working_memory WHERE scope_id = $1', [workingMemoryScope.thread(id)]);
    const legacy = legacyWorkingMemoryScope.thread(id);
    if (legacy !== undefined) await this.q('DELETE FROM gnl_working_memory WHERE scope_id = $1', [legacy]);
    await this.q('DELETE FROM gnl_observations WHERE thread_id = $1', [id]);
    // Batch markers too. A thread is soft-deleted while its messages are hard-deleted, and
    // `upsertThread` can bring the id back — a resurrected thread that kept its markers answers a
    // legitimate later batch with "already applied" and drops it in silence. Measured: 0 rows written
    // where 2 were expected.
    await this.q('DELETE FROM gnl_message_batches WHERE thread_id = $1', [id]);
  }
  /**
   * ONE TRANSACTION for the whole batch — the rows of an append land together or not at all.
   *
   * This used to be a bare loop of autocommit INSERTs, each potentially on a different pooled
   * connection, and that is the defect users actually saw. A batch is `[assistant(tool-call),
   * tool(tool-result)]`; when only the first row commits, the thread is left holding a tool call that
   * is never answered, and the AI SDK refuses to build a prompt from it — `MissingToolResultsError`,
   * surfaced as `HTTP 400 "Tool result is missing for tool call …"`. Every later turn on that thread
   * fails the same way until the orphan slides out of the memory window — measured at 5 consecutive
   * failures with the default `chat` preset (recentN 10), because a failed turn still write-aheads its
   * user message and so keeps the window moving. Self-healing, then, but at the cost of five real
   * errors and five junk messages left in the transcript; and only while nothing pulls the orphan back
   * into context, which recall can.
   *
   * Measured, 900 requests against real Postgres with the fix toggled on and off:
   *
   *     base    7 errors (0.78%)  |  7 threads left with an orphan call  |  96.4 req/s
   *     atomic  0 errors          |  0 orphans                           |  99.8 req/s
   *
   * So atomicity alone removes 100% of those failures, and costs nothing — it is fewer round trips,
   * not more, because the batch now travels on one pinned client instead of N pool checkouts.
   *
   * This is NOT the whole story. A separate defect — `AgentMemory.append` computing `seq` from an
   * unlocked read — still drops whole batches under concurrency (measured: 33% of messages). That
   * loss is silent and leaves the history self-consistent, which is why it produces no 400s and why
   * it needs its own fix. Atomicity is what stops a half-written batch from BREAKING a thread.
   *
   * Per-row INSERTs are kept deliberately. Collapsing them into one multi-row statement was measured
   * at 1.14x on this subsystem, which is ~11.9% of a request's round trips — a fraction of a percent
   * end to end — and `ON CONFLICT` under pg-mem (the default test double) has known fidelity gaps.
   * The atomicity comes from the transaction; the statement shape is not what was broken.
   */
  async appendMessagesOnce(threadId: string, rows: MessageAppend[], batchKey: string): Promise<boolean> {
    const assign = assertUniformSeq(threadId, rows);
    if (!this.advisoryLocks()) throw new Error(NO_LOCK_APPEND_MSG);
    return this.tx(async (q) => {
      await q(`SET LOCAL lock_timeout = '5s'`);
      await q('SELECT pg_advisory_xact_lock($1, $2)', [THREAD_LOCK_NS, hash32(threadId)]);
      // CLAIM FIRST, in the same transaction as the rows. Zero rows back means this batch already
      // landed, and the messages are not touched — which is the whole point: the identity cannot
      // survive a rollback that took the rows with it, and the rows cannot survive a rollback that
      // took the identity. `run.ts`'s two-phase marker existed only because those were separate
      // writes to separate stores.
      const claim = await q(
        `INSERT INTO gnl_message_batches (thread_id, batch_key, seq_from, seq_to, ts) VALUES ($1,$2,0,0,$3)
         ON CONFLICT (thread_id, batch_key) DO NOTHING RETURNING batch_key`,
        [threadId, batchKey, Date.now()],
      );
      if ((claim.rowCount ?? 0) === 0) return false;
      let next = 0;
      if (assign) {
        const r = await q('SELECT COALESCE(MAX(seq), -1) + 1 AS n FROM gnl_messages WHERE thread_id = $1', [threadId]);
        next = Number(r.rows[0].n);
      }
      const from = next;
      for (const r of rows) {
        const conflict = r.seq === undefined ? '' : ' ON CONFLICT (thread_id, seq) DO NOTHING';
        await q(
          `INSERT INTO gnl_messages (thread_id, seq, role, text, embedding, metadata, ts, message) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)${conflict}`,
          [threadId, r.seq ?? next++, r.role, r.text ?? null, r.embedding ? JSON.stringify(r.embedding) : null, r.metadata ? serialize(r.metadata) : null, r.ts, serialize(r.message)],
        );
      }
      await q('UPDATE gnl_message_batches SET seq_from = $1, seq_to = $2 WHERE thread_id = $3 AND batch_key = $4',
        [from, next, threadId, batchKey]);
      return true;
    }, { atomic: true }).catch((e: unknown) => { throw lockWaitAdvice(e, threadId, rows.length); });
  }

  async appendMessages(threadId: string, rows: MessageAppend[]): Promise<void> {
    if (rows.length === 0) return;
    const assign = assertUniformSeq(threadId, rows);
    // Second line of defence: the capability downgrade above should have stopped anyone getting here
    // without a usable lock, but a caller holding `storage.memory` directly bypasses that check.
    if (!this.advisoryLocks()) throw new Error(NO_LOCK_APPEND_MSG);
    await this.tx(async (q) => {
      // ALWAYS take the lock, not only when assigning. The explicit-seq path was measured racing:
      // importing a transcript (explicit positions, unlocked) alongside a live run (assigned
      // positions, locked) lost rows in 20 of 60 turns. The contract invites transcript import, so
      // leaving that path unserialised makes the documented use case the unsafe one. The lock costs a
      // single round trip on a connection that is already pinned.
      if (this.advisoryLocks()) {
        // BOUND THE WAIT, and bound it BELOW run.ts's MEM_APPEND_TTL_MS (60s). This is not tidiness —
        // an unbounded wait here reopens the very defect the lock closes, with no crash involved:
        //
        //   worker A takes the lock and its connection dies without closing (a TCP blackhole; the
        //   backend is not reaped for minutes under default keepalives) -> worker B's append queues on
        //   the lock -> 60s pass -> run.ts decides A's append marker is stale and lets a retry take it
        //   over -> the lock is finally released -> BOTH writes land.
        //
        // Measured exactly that, with no process ever crashing: the same user message twice in one
        // thread. Timing out instead surfaces 55P03 with nothing written, which fails the run and lets
        // it retry cleanly. 5s leaves a 12x margin under the TTL.
        //
        // IT CAN FIRE, and an earlier version of this note said it could not. That claim rested on one
        // axis only — concurrency, where the deepest contention measured was p99 336ms at 128 writers.
        // Batch SIZE was never measured, and it is the axis that reaches the limit: importing a
        // 20,000-row transcript holds this lock for about six seconds, so a live turn on the same
        // thread times out at five. On a managed Postgres at 1.5ms round trip, roughly 3,300 messages
        // is enough. Large imports belong on a thread that is not taking live turns.
        await q(`SET LOCAL lock_timeout = '5s'`);
        // ITS OWN STATEMENT. Folding the lock into the scalar subquery that reads MAX(seq) does not
        // work and was measured failing: under READ COMMITTED a statement's snapshot is taken when the
        // statement STARTS and the lock is acquired part-way through it, so MAX(seq) still reads the
        // pre-lock tail. 155 of 160 messages were lost that way.
        await q('SELECT pg_advisory_xact_lock($1, $2)', [THREAD_LOCK_NS, hash32(threadId)]);
      }
      let next = 0;
      if (assign) {
        const r = await q('SELECT COALESCE(MAX(seq), -1) + 1 AS n FROM gnl_messages WHERE thread_id = $1', [threadId]);
        next = Number(r.rows[0].n);
      }
      for (const r of rows) {
        // `ON CONFLICT DO NOTHING` ONLY for caller-supplied positions, where re-writing the same row
        // is the documented idempotent case. For positions this method just assigned under the lock, a
        // conflict is impossible unless something is wrong — and swallowing it would silently drop a
        // message, which is the defect this method exists to fix. Let it raise.
        const conflict = r.seq === undefined ? '' : ' ON CONFLICT (thread_id, seq) DO NOTHING';
        await q(
          `INSERT INTO gnl_messages (thread_id, seq, role, text, embedding, metadata, ts, message) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)${conflict}`,
          [threadId, r.seq ?? next++, r.role, r.text ?? null, r.embedding ? JSON.stringify(r.embedding) : null, r.metadata ? serialize(r.metadata) : null, r.ts, serialize(r.message)],
        );
      }
    }, { atomic: true }).catch((e: unknown) => { throw lockWaitAdvice(e, threadId, rows.length); });
  }
  private toMsg(x: any): MessageRecord {
    return { threadId: x.thread_id, seq: Number(x.seq), role: x.role, text: x.text ?? undefined, embedding: x.embedding ? JSON.parse(x.embedding) : undefined, metadata: x.metadata ? deserialize(x.metadata) : undefined, ts: Number(x.ts), message: deserialize(x.message) };
  }
  async getMessages(threadId: string, q?: ListQuery): Promise<Page<MessageRecord>> {
    const { start, limit } = offset(q);
    const total = Number((await this.q('SELECT COUNT(*) AS n FROM gnl_messages WHERE thread_id = $1', [threadId])).rows[0].n);
    const r = await this.q('SELECT * FROM gnl_messages WHERE thread_id = $1 ORDER BY seq LIMIT $2 OFFSET $3', [threadId, limit, start]);
    return pageOf(r.rows.map((x) => this.toMsg(x)), start, limit, total);
  }
  /**
   * FLOW-10: truncate a thread's tail — deletes every message with seq > afterSeq (afterSeq itself,
   * and everything before it, is kept). See MemoryStore.deleteMessagesAfter (storage.ts) for the full
   * contract. Same DELETE-then-rowCount pattern as PgRunJournal.deletePrefix above. Boundary cases fall
   * out of the WHERE clause naturally: unknown threadId or afterSeq >= the thread's max seq → the WHERE
   * matches no rows → 0; afterSeq below the thread's min seq → the WHERE matches every row for that thread.
   */
  async deleteMessagesAfter(threadId: string, afterSeq: number): Promise<number> {
    const r = await this.q('DELETE FROM gnl_messages WHERE thread_id = $1 AND seq > $2', [threadId, afterSeq]);
    // Markers for batches that ended past the cut go with them. Leaving them behind makes a later
    // batch reusing the same key look "already applied", and the regenerated turn is dropped in
    // silence — measured at 1 message written where 3 were expected, which is the exact class of loss
    // batch identity exists to prevent.
    await this.q('DELETE FROM gnl_message_batches WHERE thread_id = $1 AND seq_to > $2', [threadId, afterSeq]);
    return r.rowCount ?? 0;
  }
  async recall(threadId: string, query: number[], opts: RecallOptions): Promise<MessageRecord[]> {
    if (!hasNorm(query)) return [];
    let n = 1;
    const part = memoryPartitionSql(memoryPartitionOf(opts), 't.id', () => `$${++n}`);
    const r = opts.scope === 'resource' && opts.resourceId
      ? await this.q(`SELECT m.* FROM gnl_messages m JOIN gnl_threads t ON t.id = m.thread_id WHERE t.resource_id = $1 AND t.deleted_at IS NULL AND ${part.cond} ORDER BY m.thread_id, m.seq`, [opts.resourceId, ...part.params])
      : await this.q('SELECT * FROM gnl_messages WHERE thread_id = $1 ORDER BY seq', [threadId]);
    const byThread = new Map<string, MessageRecord[]>();
    for (const x of r.rows) { const m = this.toMsg(x); const a = byThread.get(m.threadId) ?? []; a.push(m); byThread.set(m.threadId, a); }
    const threshold = opts.threshold ?? 0;
    const cand: { m: MessageRecord; tid: string; idx: number; score: number }[] = [];
    for (const [tid, msgs] of byThread) msgs.forEach((m, idx) => {
      if (!hasNorm(m.embedding)) return;
      const score = cosineSimilarity(query, m.embedding);
      if (score > 0 && score >= threshold) cand.push({ m, tid, idx, score });
    });
    let scored = cand;
    if (opts.filter) scored = scored.filter((c) => matchFilter(c.m.metadata, opts.filter!));
    scored.sort((a, b) => b.score - a.score);
    const hits = scored.slice(0, opts.topK ?? 3);
    const range = normRange(opts.messageRange);
    const picked = new Map<string, MessageRecord>();
    for (const h of hits) {
      const msgs = byThread.get(h.tid)!;
      const lo = Math.max(0, h.idx - range.before), hi = Math.min(msgs.length - 1, h.idx + range.after);
      for (let i = lo; i <= hi; i++) picked.set(`${h.tid}:${msgs[i]!.seq}`, msgs[i]!);
    }
    // Provenance parity with sqlite-storage.ts: hits carry their similarity, neighbors stay unscored.
    for (const h of hits) picked.set(`${h.tid}:${h.m.seq}`, { ...h.m, score: h.score });
    return [...picked.values()].sort((a, b) => a.ts - b.ts || a.seq - b.seq);
  }
  async getWorkingMemory(scopeId: string): Promise<unknown> {
    const r = await this.q('SELECT data FROM gnl_working_memory WHERE scope_id = $1', [scopeId]);
    return r.rows[0] ? deserialize(r.rows[0].data) : undefined;
  }
  async setWorkingMemory(scopeId: string, data: unknown): Promise<void> {
    await this.q(`INSERT INTO gnl_working_memory (scope_id, data, updated_at) VALUES ($1,$2,$3) ON CONFLICT (scope_id) DO UPDATE SET data=EXCLUDED.data, updated_at=EXCLUDED.updated_at`, [scopeId, serialize(data), Date.now()]);
  }
  async deleteWorkingMemory(scopeId: string): Promise<boolean> {
    return (await this.q('DELETE FROM gnl_working_memory WHERE scope_id = $1 RETURNING scope_id', [scopeId])).rows.length > 0;
  }
  async getObservations(threadId: string): Promise<Observation[]> {
    const r = await this.q('SELECT obs FROM gnl_observations WHERE thread_id = $1', [threadId]);
    return r.rows[0] ? deserialize<Observation[]>(r.rows[0].obs) : [];
  }
  async putObservations(threadId: string, obs: Observation[]): Promise<void> {
    await this.q(`INSERT INTO gnl_observations (thread_id, obs) VALUES ($1,$2) ON CONFLICT (thread_id) DO UPDATE SET obs=EXCLUDED.obs`, [threadId, serialize(obs)]);
  }
}

/**
 * Fills `gnl_vectors.doc` for the rows that have none yet — every row, the first time a database meets
 * the column; afterwards only rows an older process wrote. In blocks, through the `doc` index.
 */
async function backfillVectorDocuments(q: (sql: string, p?: unknown[]) => Promise<{ rows: any[] }>): Promise<void> {
  for (;;) {
    const rows = (await q(`SELECT id, metadata FROM gnl_vectors WHERE doc IS NULL LIMIT 500`)).rows as { id: string; metadata: string | null }[];
    if (!rows.length) return;
    const params: unknown[] = [];
    const cases = rows.map((r) => {
      let doc: string | undefined;
      try { doc = r.metadata ? vectorDocumentOf(deserialize<Record<string, unknown>>(r.metadata)) : undefined; } catch { doc = undefined; }
      params.push(r.id, doc ?? '');
      return `WHEN $${params.length - 1} THEN $${params.length}`;
    });
    const ids = rows.map((r) => r.id);
    const at = params.length;
    params.push(...ids);
    await q(`UPDATE gnl_vectors SET doc = CASE id ${cases.join(' ')} END WHERE doc IS NULL AND id IN (${ids.map((_, i) => `$${at + i + 1}`).join(',')})`, params);
  }
}

class PgVectorStore implements VectorStore {
  readonly rootOutsideOrganizations = true;
  constructor(private q: Q, private tx: Tx) {}
  async upsert(items: VectorItem[]): Promise<void> {
    const batch = vectorWriteBatch(items);
    // One transaction (where the pool can give one): a batch refused half-way, by a writer that took
    // an id after the check, is rolled back rather than left half-written.
    await this.tx(async (q) => {
      const probe = async (id: string) =>
        (await q('SELECT namespace, owner, shared FROM gnl_vectors WHERE id = $1', [id])).rows[0] as { namespace: string | null; owner: string | null; shared: boolean | null } | undefined;
      for (const it of batch) assertSameVectorOwner(await probe(it.id), it);
      // Two statements, neither of which can overwrite a document of another owner: update only when
      // the labels match, otherwise insert only when the id is free. Neither landing means the id was
      // taken under other labels since the check. (One `ON CONFLICT … DO UPDATE … WHERE` would do it,
      // but not every Postgres speaker in use parses it.) `RETURNING` counts rows the same way on pg
      // and pg-mem; pg-mem's rowCount does not.
      for (const it of batch) {
        const labels = [it.namespace ?? null, it.owner ?? null, it.shared ? true : null];
        const updated = await q(
          // NULL-safe equality spelled with COALESCE: '' is never a namespace or an owner (vectorWriteBatch).
          `UPDATE gnl_vectors SET text=$2, embedding=$3, metadata=$4, doc=$8 WHERE id=$1 AND COALESCE(namespace, '') = COALESCE($5, '') AND COALESCE(owner, '') = COALESCE($6, '') AND COALESCE(shared, false) = COALESCE($7, false) RETURNING id`,
          [it.id, it.text, JSON.stringify(it.embedding), it.metadata ? serialize(it.metadata) : null, ...labels, vectorDocumentOf(it.metadata) ?? ''],
        );
        if (updated.rows.length > 0) continue;
        const inserted = await q(
          `INSERT INTO gnl_vectors (id, text, embedding, metadata, namespace, owner, shared, created_at, doc) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) ON CONFLICT (id) DO NOTHING RETURNING id`,
          [it.id, it.text, JSON.stringify(it.embedding), it.metadata ? serialize(it.metadata) : null, ...labels, Date.now(), vectorDocumentOf(it.metadata) ?? ''],
        );
        if (inserted.rows.length === 0) assertSameVectorOwner((await probe(it.id)) ?? { namespace: '\u0000' }, it);
      }
    });
  }
  async delete(where: VectorDeleteWhere): Promise<number> {
    const w = vectorDeletePlan(where);
    if (!w) return 0;
    const conds: string[] = [];
    const params: unknown[] = [];
    // `IN ($1,…)`, not `= ANY($1)`: pg-mem matches nothing with the array form (see getMany), so a
    // delete by id removed nothing there and did on a real server.
    const idIn = (ids: string[], at: number) => `id IN (${ids.map((_, i) => `$${at + i + 1}`).join(',')})`;
    if (w.ids) { conds.push(idIn(w.ids, params.length)); params.push(...w.ids); }
    if (w.owner !== undefined) { params.push(w.owner); conds.push(`owner = $${params.length}`); }
    if (w.namespace !== undefined) { params.push(w.namespace); conds.push(`namespace = $${params.length}`); }
    if (w.outsideOrganizations) conds.push(VECTOR_OUTSIDE_ORGANIZATIONS_SQL);
    if (!w.filter) return (await this.q(`DELETE FROM gnl_vectors WHERE ${conds.join(' AND ')} RETURNING id`, params)).rows.length;
    // Metadata is serialized, so the filter is read in code (vectorMetadataMatches) and the matching
    // rows deleted by id, in one transaction.
    const filter = w.filter;
    const doc = vectorFilterDocument(filter);
    if (doc !== undefined) { params.push(doc); conds.push(`(doc = $${params.length} OR doc IS NULL)`); }
    return this.tx(async (q) => {
      const rows = (await q(`SELECT id, metadata FROM gnl_vectors${conds.length ? ` WHERE ${conds.join(' AND ')}` : ''}`, params)).rows as { id: string; metadata: string | null }[];
      const ids = rows.filter((r) => vectorMetadataMatches(r.metadata ? deserialize<Record<string, unknown>>(r.metadata) : undefined, filter)).map((r) => r.id);
      return ids.length ? (await q(`DELETE FROM gnl_vectors WHERE ${idIn(ids, 0)} RETURNING id`, ids)).rows.length : 0;
    });
  }
  async query(embedding: number[], topK: number, opts?: VectorQueryOptions): Promise<VectorMatch[]> {
    // Filtered in SQL, so only eligible rows reach the ranking. Ranking the whole table and filtering
    // afterwards would tie a caller's result count to how many other namespaces exist: ask for 4, get
    // however many of the global top 4 were yours. Nothing errors, nothing leaks — recall just decays
    // as other organizations upload, and only a fixture with two organizations can see it.
    //
    // `IS NOT DISTINCT FROM` rather than `=`: `= NULL` is never true in SQL, so a query for the
    // un-namespaced partition would match nothing at all.
    const scope = vectorQueryScope(opts);
    if (scope.none) return [];
    const where: string[] = [];
    const params: unknown[] = [];
    // `=` is exact here: a namespace is never null on this path (undefined means "no filter" above).
    if (scope.namespace !== undefined) { params.push(scope.namespace); where.push(`namespace = $${params.length}`); }
    if (scope.outsideOrganizations) where.push(VECTOR_OUTSIDE_ORGANIZATIONS_SQL); // the root's partition (ADR-0001)
    if (scope.visibleTo !== undefined) { params.push(scope.visibleTo); where.push(`(shared IS TRUE OR owner = $${params.length})`); }
    // A filter naming a document reads that document's rows (and any row whose `doc` is not computed
    // yet) through the index; the whole filter is still applied in code below.
    const doc = vectorFilterDocument(opts?.filter);
    if (doc !== undefined) { params.push(doc); where.push(`(doc = $${params.length} OR doc IS NULL)`); }
    const r = await this.q(`SELECT id, text, embedding, metadata, namespace, owner, shared FROM gnl_vectors${where.length ? ` WHERE ${where.join(' AND ')}` : ''}`, params);
    return r.rows
      .map((x) => ({ id: x.id, text: x.text, metadata: x.metadata ? deserialize<Record<string, unknown>>(x.metadata) : undefined, ...(x.namespace != null ? { namespace: x.namespace as string } : {}), ...(x.owner != null ? { owner: x.owner as string } : {}), ...(x.shared ? { shared: true } : {}), score: cosineSimilarity(embedding, JSON.parse(x.embedding)) }))
      .filter((m) => vectorMetadataMatches(m.metadata, opts?.filter)) // before ranking, like every narrowing
      .sort((a, b) => b.score - a.score).slice(0, topK);
  }
}

/**
 * Numbers a namespace's committed unnumbered records ($1 = ns, $2 = at most this many) in append
 * order (`ord`; `(ts, id)` for rows older than it), after every number handed out so far — ONE statement (see `PgWorkStore.numberNew`).
 * `WHERE c > 0` keeps the counter row untouched (no lock, no write) when there is nothing to number,
 * which is every read of an idle log. The rows are joined back by `ctid` (a TID scan per row): joined
 * by `id`, a table without statistics yet — every fresh deployment — was planned as a nested loop over
 * both sides, 1.5 million comparisons and 333 ms to number 1 000 records, against 18 ms this way. A
 * row another reader numbered meanwhile has a new ctid, so the re-check skips it, as `seq = 0` would.
 */
const NUMBER_NEW_SQL = `WITH cand AS (
    SELECT ctid AS t, row_number() OVER (ORDER BY ord, ts, id) AS rn FROM gnl_work_log WHERE ns = $1 AND seq = 0 ORDER BY ord, ts, id LIMIT $2
  ), n AS (SELECT COUNT(*) AS c FROM cand),
  top AS (
    INSERT INTO gnl_work_seq (ns, seq) SELECT $1, c FROM n WHERE c > 0
    ON CONFLICT (ns) DO UPDATE SET seq = gnl_work_seq.seq + EXCLUDED.seq RETURNING seq
  )
  UPDATE gnl_work_log w SET seq = top.seq - n.c + cand.rn FROM cand, n, top
  WHERE w.ctid = cand.t AND w.ns = $1 AND w.seq = 0`;

class PgWorkStore implements WorkStore {
  /** `shape` is shared BY REFERENCE with the journal (see PrefixShape): the prefix comparison below
   *  needs the same collation clause the probe settled on, or a range scan can miss rows on a
   *  non-C collation — the exact failure the journal's deletePrefix already guards against. */
  constructor(private q: Q, private tx: Tx, private shape: PrefixShape) {}
  /** `false` once the engine has refused `NUMBER_NEW_SQL` (pg-mem: no data-modifying CTE, no window functions). */
  private cteDml = true;
  /** `true` once the database's default isolation has refused the numbering statement (40001): see `numberNew`. */
  private readCommitted = false;
  /**
   * 0.9's statement, unchanged: the record is written UNNUMBERED (`seq` 0) and numbered by the first
   * `list` that sees it. Numbering at append made every append to a namespace wait on that
   * namespace's counter row until commit — and the queue is ONE namespace for a whole deployment:
   * measured on a live server, 8 producers fell from 9 227 appends/s (0.9) to 2 846. It also left a
   * 0.9 process in a rolling deploy writing rows the new order put behind every cursor.
   */
  async append(ns: string, payload: unknown, id?: string): Promise<string> {
    const eid = id ?? `${ns}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`;
    await this.q(`INSERT INTO gnl_work_log (ns, id, payload, ts) VALUES ($1,$2,$3,$4) ON CONFLICT (ns, id) DO NOTHING`, [ns, eid, serialize(payload), Date.now()]);
    return eid;
  }
  /**
   * Numbers the namespace's committed unnumbered records after every number handed out so far
   * (`WorkStore.list`). What keeps a reader from passing a record: numbering takes the namespace's
   * counter row (`ON CONFLICT DO UPDATE` locks it until commit), so two numberings of one namespace
   * commit in the order of their numbers, and a record's number is visible only together with every
   * lower one. A record whose INSERT has not committed is invisible here and is numbered by a later
   * call, with a larger number. `w.seq = 0` is re-checked on the row's newest version, so a record
   * another reader numbered meanwhile is skipped (a gap, never a reuse). The lock is per namespace
   * and held only by readers that found something to number — writers never take it.
   */
  private async numberNew(ns: string, max: number): Promise<void> {
    if (this.cteDml) {
      try {
        if (this.readCommitted) await this.tx((q) => q(NUMBER_NEW_SQL, [ns, max]), { readCommitted: true });
        else await this.q(NUMBER_NEW_SQL, [ns, max]);
        return;
      } catch (e) {
        // 40001 (serialization failure): the database defaults to REPEATABLE READ or SERIALIZABLE, and
        // another reader numbered this namespace meanwhile. The statement is written for READ
        // COMMITTED — its lock on the counter row orders the numberings, and the re-check of `seq = 0`
        // reads the row's newest version — so it is run at that level from now on, starting with this
        // call. Measured before: 74 of 120 `list` calls threw under REPEATABLE READ. The failed
        // statement applied nothing, so running it again cannot number anything twice.
        // Not gated on the flag: a concurrent call on this store may have sent the plain statement before it was set.
        if ((e as { code?: unknown })?.code === '40001') {
          this.readCommitted = true;
          await this.tx((q) => q(NUMBER_NEW_SQL, [ns, max]), { readCommitted: true });
          return;
        }
        // pg-mem's own words for a data-modifying CTE and a window function; real Postgres has both.
        if (!/not supported|not implemented|failed to parse/i.test(String((e as Error)?.message ?? e))) throw e;
        this.cteDml = false;
      }
    }
    // The same in a transaction, for an engine without data-modifying CTEs (pg-mem). The counter row
    // is taken first, so the unnumbered rows are read under the lock the statement form holds.
    const pending = (await this.q('SELECT id FROM gnl_work_log WHERE ns = $1 AND seq = 0 LIMIT 1', [ns])).rows;
    if (!pending.length) return;
    await this.tx(async (q) => {
      await q('INSERT INTO gnl_work_seq (ns, seq) VALUES ($1, 0) ON CONFLICT (ns) DO UPDATE SET seq = gnl_work_seq.seq', [ns]);
      const ids = ((await q('SELECT id FROM gnl_work_log WHERE ns = $1 AND seq = 0 ORDER BY ord, ts, id LIMIT $2', [ns, max])).rows as { id: string }[]).map((r) => r.id);
      if (!ids.length) return;
      const top = Number(((await q('UPDATE gnl_work_seq SET seq = seq + $2 WHERE ns = $1 RETURNING seq', [ns, ids.length])).rows[0] as { seq: string | number }).seq);
      for (let i = 0; i < ids.length; i++) {
        await q('UPDATE gnl_work_log SET seq = $3 WHERE ns = $1 AND id = $2 AND seq = 0', [ns, ids[i], top - ids.length + 1 + i]);
      }
    }, { atomic: true });
  }
  /** Keyset on `(seq, ts, id)` from the cursor's position (`WorkStore.list`); one extra row says "more". */
  async list<T = unknown>(ns: string, q?: ListQuery): Promise<Page<LogRecord<T>>> {
    const limit = q?.limit ?? 50;
    await this.numberNew(ns, Math.max(NUMBER_BATCH, limit + 1));
    const after = decodeLogCursor(q?.cursor);
    const r = after
      // `(seq, ts, id) > ($2, $3, $4)` spelled out (pg-mem has no row comparison); the leading
      // `seq >= $2` is the same condition's index range, so the planner does not have to derive it.
      ? await this.q('SELECT id, payload, ts, seq FROM gnl_work_log WHERE ns = $1 AND seq > 0 AND seq >= $2 AND (seq > $2 OR ts > $3 OR (ts = $3 AND id > $4)) ORDER BY seq, ts, id LIMIT $5', [ns, after.seq, after.ts, after.id, limit + 1])
      : await this.q('SELECT id, payload, ts, seq FROM gnl_work_log WHERE ns = $1 AND seq > 0 ORDER BY seq, ts, id LIMIT $2', [ns, limit + 1]);
    const rows = r.rows.map((x) => ({ id: x.id as string, payload: x.payload as string, ts: Number(x.ts), seq: Number(x.seq) }));
    const more = rows.length > limit;
    if (more) rows.pop();
    const last = rows[rows.length - 1];
    return {
      items: rows.map((x) => ({ id: x.id, payload: deserialize<T>(x.payload), ts: x.ts })),
      nextCursor: more && last ? encodeLogCursor(last) : undefined,
    };
  }
  async get<T = unknown>(key: string): Promise<T | undefined> {
    const r = await this.q('SELECT value FROM gnl_work_kv WHERE key = $1', [key]);
    return r.rows[0] ? deserialize<T>(r.rows[0].value) : undefined;
  }
  async put(key: string, value: unknown): Promise<void> {
    await this.q(`INSERT INTO gnl_work_kv (key, value) VALUES ($1,$2) ON CONFLICT (key) DO UPDATE SET value=EXCLUDED.value`, [key, serialize(value)]);
  }
  async ackOnce(key: string): Promise<boolean> {
    const r = await this.q(`INSERT INTO gnl_work_kv (key, value) VALUES ($1,$2) ON CONFLICT (key) DO NOTHING RETURNING key`, [key, serialize(true)]);
    return inserted1(r);
  }
  /**
   * 8.2: SAME pattern as PgRunJournal.putIfMatch's `!p` branch (gnl_work_kv has NO derived index like
   * gnl_run_journal → no need to wrap it in a transaction/row-lock, a single UPDATE is enough). Stored
   * form is the same as SQLite: PLAIN serialize() TEXT — comparison via `WHERE key=$ AND value=serialize(expected)`.
   */
  async putIfMatch(key: string, expected: unknown, value: unknown): Promise<boolean> {
    const r = await this.q('UPDATE gnl_work_kv SET value = $1 WHERE key = $2 AND value = $3', [serialize(value), key, serialize(expected)]);
    return Number(r.rowCount ?? 0) === 1;
  }
  /** FAZ-9: both families, one prefix (see the sqlite note). */
  async deletePrefix(prefix: string): Promise<number> {
    const c = this.shape.collate;
    const lr = pgRange('ns', c, prefix, 1);
    const l = await this.q(`DELETE FROM gnl_work_log WHERE ${lr.where}`, lr.params);
    const kr = pgRange('key', c, prefix, 1);
    const k = await this.q(`DELETE FROM gnl_work_kv WHERE ${kr.where}`, kr.params);
    return Number(l.rowCount ?? 0) + Number(k.rowCount ?? 0);
  }
  /** Every log record whose ID starts with `idPrefix`, in every namespace (`WorkStore.deleteIdPrefix`).
   *  A byte range under the probed collation, like `deletePrefix`: literal (no LIKE, so `%`, `_` and
   *  `\` in an id are characters, not wildcards) and exact on a linguistic collation. One statement. */
  async deleteIdPrefix(idPrefix: string): Promise<number> {
    const r = pgRange('id', this.shape.collate, idPrefix, 1);
    return Number((await this.q(`DELETE FROM gnl_work_log WHERE ${r.where}`, r.params)).rowCount ?? 0);
  }
}

class PgCacheStore implements CacheStore {
  constructor(private q: Q) {}
  async get<T = unknown>(key: string): Promise<T | undefined> {
    const r = await this.q('SELECT value, expires_at FROM gnl_cache WHERE key = $1', [key]);
    const row = r.rows[0];
    if (!row) return undefined;
    if (row.expires_at != null && Number(row.expires_at) <= Date.now()) { await this.q('DELETE FROM gnl_cache WHERE key = $1', [key]); return undefined; }
    return deserialize<T>(row.value);
  }
  async set(key: string, value: unknown, opts?: { ttlMs?: number }): Promise<void> {
    const exp = opts?.ttlMs != null ? Date.now() + opts.ttlMs : null;
    await this.q(`INSERT INTO gnl_cache (key, value, expires_at) VALUES ($1,$2,$3) ON CONFLICT (key) DO UPDATE SET value=EXCLUDED.value, expires_at=EXCLUDED.expires_at`, [key, serialize(value), exp]);
  }
  async delete(key: string): Promise<void> { await this.q('DELETE FROM gnl_cache WHERE key = $1', [key]); }
}

class PgMetaStore implements MetaStore {
  constructor(private q: Q) {}
  async get(key: string): Promise<string | undefined> {
    const r = await this.q('SELECT v FROM gnl_meta WHERE k = $1', [key]);
    return r.rows[0]?.v;
  }
  async set(key: string, value: string): Promise<void> {
    await this.q(`INSERT INTO gnl_meta (k, v) VALUES ($1,$2) ON CONFLICT (k) DO UPDATE SET v=EXCLUDED.v`, [key, value]);
  }
}
