// @gnldev/durable/mysql — MySQL (8.4+) and MariaDB (11+) implementation of every store port, for a
// database several processes and hosts share. The same tables, the same derived run table and the same
// guarantees as PostgresStorage; `mysql2` is an optional peer dependency.
//
// What differs from Postgres, and why:
//  - Every key and compared value is BINARY (VARBINARY / LONGBLOB). A prefix range needs byte order, a
//    compare-and-set needs byte equality, and a primary key must not fold `'k'` into `'k '`: the
//    servers' `utf8mb4_bin` is a PAD SPACE collation on both, and the default collation is
//    case-insensitive. Measured before this was so: the conformance kit failed 11–12 of 27 scenarios
//    under the default collation, erasure among them (a delete took or missed the wrong rows).
//  - Sessions run at READ COMMITTED: every statement here is written for it, as on Postgres (a locked
//    read re-reads the newest version, and a read after a lock sees what committed before the lock).
//  - Named locks (`GET_LOCK`) stand for Postgres' advisory locks: the process lock held by a dedicated
//    session (`mysqlLiveness`), a thread's append lock, the boot lock. A named lock is server-wide, not
//    per database, so every name carries a hash of the database it guards.
//  - No `RETURNING`: a claim is a plain INSERT whose duplicate-key error (1062) is the lost race — in
//    InnoDB that error rolls back the statement, not the transaction — and the rows a deletion must
//    account for are read under their locks first.
//  - No triggers. On Postgres two guard triggers keep a run's person/thread columns true against a writer
//    that does not know them (an older version, plain SQL). No older version writes this store, and every
//    write of this version places or unplaces the columns in the transaction that writes the record — an
//    `:input` that names nobody it can read unplaces its run (NULL), which every lookup then reads and
//    decides from the record, as on Postgres. A row written by plain SQL is outside the contract here, as
//    there (Postgres' CE-4 bound).
import { createHash } from 'node:crypto';
import { requireOptionalPeer } from './optional-peer.js';
import { cosineSimilarity } from 'ai';
import { refuseUnknownNames } from '@gnldev/options';
import { leafSuffix, runRecordKey } from './run-id-grammar.js';
import { closeExecutorFor } from './executors.js';
import { unbindLiveness, livenessIdOf, LivenessUnavailableError, reconnectGraceOf, sessionSignals, proofWithin, HEARTBEAT_MS, type ProcessLiveness } from './process-liveness.js';
import { ROOT_EXEC_RECORDS, isScopeFact, scopeFactKeys, scopeFactsDroppedByAdoption, staysAtRoot, onAdoptionCollision, adoptionConflict } from './adoption.js';
import { prefixUpperBound, ENGINE_META_KEYS, assertOrgRegistered, isPlatformKey, orgPrefix, orgSpaceSql, prefixSql } from './organization.js';
import {
  assertUniformSeq, workingMemoryScope, legacyWorkingMemoryScope, assertOrganizationPartition, markWorkOf, memoryPartitionOf, memoryPartitionSql,
  NUMBER_BATCH, decodeLogCursor, encodeLogCursor, workKeyAdoption, workKeyAdoptCollision, matchFilter, vectorWriteBatch, assertSameVectorOwner, rankVectorMatches, assertVectorDimension,
  vectorDeletePlan, VECTOR_OUTSIDE_ORGANIZATIONS_SQL, vectorQueryScope, vectorMetadataMatches, vectorAdoptCollision, vectorDocumentOf, vectorFilterDocument,
  type MemoryPartitionOption,
} from './storage.js';
import type {
  AdoptIntoOrgResult, Storage, CapabilityMatrix, Page, ListQuery, RunJournal, MemoryStore, VectorStore, WorkStore, CacheStore, MetaStore,
  ThreadRecord, MessageRecord, MessageAppend, Observation, RecallOptions, VectorItem, VectorMatch, VectorQueryOptions, VectorDeleteWhere, LogRecord,
} from './storage.js';
import {
  runIdOfKey, parseJournalKey, outcomeStatusOf, runRelationsOf, relationsOfInput, ownerColumnOf, ownerOfRecord, OWNER_RECORD_LIKE, RunRowChanges,
  runStatusOf, runStatusCaseSql, storedOutcomeOf, runRecordOf, runsCutBy, compareKeys,
} from './journal.js';
import type { JournalBatch, JournalEntry, RunChange, RunRowChange, RunStatus, RunSummary, ToolJournalRecord } from './journal.js';
import { keysetRunPage, rangeOrder, runStatusSql, decodeChangeCursor, encodeChangeCursor, type RunRelationRead } from './run-cursor.js';
import { withBirth } from './run-identity.js';
import { serialize, deserialize } from './serialize.js';
import { tablesFromDDL, indexesFromDDL, type SchemaCheckResult, type SchemaMigrationResult, type MissingColumn } from './migrate.js';
import { MYSQL_STORAGE_NAMES, MYSQL_LIVENESS_NAMES, ADOPT_INTO_ORG_NAMES, COMPACT_NAMES, UPGRADE_NAMES } from './option-names.js';
import { runUpgrade, threadRecordsStep, relationsStep, verifyRelationsStep, runStatusStep, type UpgradeOptions, type UpgradeReport, type UpgradeStep } from './upgrade.js';
import { SCOPE_TABLES, adoptedColumns, assertNoRunsInFlight } from './model.js';

// ── the driver, as this file uses it ──────────────────────────────────────────────────────────────

type Header = { affectedRows?: number };
type RawResult = [unknown, unknown];
/** A connection of `mysql2/promise` (a pool's, or a dedicated one). */
interface MysqlConnection {
  query(sql: string, values?: unknown[]): Promise<RawResult>;
  release?(): void;
  destroy?(): void;
  end?(): Promise<void>;
  on?(event: string, fn: (...a: unknown[]) => void): unknown;
}
/** A `mysql2/promise` pool (`createPool`), or anything with its shape. */
export interface MysqlPool {
  query(sql: string, values?: unknown[]): Promise<RawResult>;
  getConnection(): Promise<MysqlConnection>;
  end(): Promise<void>;
  /** The callback pool underneath (`mysql2`): where a new connection is announced. */
  readonly pool?: { on?(event: 'connection', fn: (c: { query(sql: string): unknown }) => void): unknown; config?: { connectionLimit?: number; connectionConfig?: Record<string, unknown> } };
}
interface Driver {
  createPool(o: Record<string, unknown>): MysqlPool;
  createConnection(o: Record<string, unknown>): Promise<MysqlConnection>;
}
const driver = (): Driver => requireOptionalPeer<Driver>('mysql2/promise');

/** A statement's answer in one shape: the rows of a read, the affected (matched) rows of a write. */
type QueryResult = { rows: any[]; rowCount: number };
type Q = (sql: string, params?: unknown[]) => Promise<QueryResult>;

/**
 * `$N` placeholders (the form the shared SQL helpers and keysetRunPage build) as the driver's positional
 * `?`, each bound in the order it appears — `$1` written twice is bound twice.
 */
function bind(sql: string, params: readonly unknown[] = []): [string, unknown[]] {
  const out: unknown[] = [];
  const text = sql.replace(/\$(\d+)/g, (_, n: string) => { out.push(params[Number(n) - 1]); return '?'; });
  return [text, out];
}
async function run(c: Pick<MysqlConnection, 'query'>, sql: string, params?: readonly unknown[]): Promise<QueryResult> {
  const [text, values] = bind(sql, params);
  const [res] = await c.query(text, values);
  if (Array.isArray(res)) return { rows: res as any[], rowCount: res.length };
  return { rows: [], rowCount: Number((res as Header)?.affectedRows ?? 0) };
}

/** Every text column is binary; the driver hands it back as the UTF-8 string it was written as. */
const BINARY_TYPES = new Set(['VAR_STRING', 'STRING', 'BLOB', 'TINY_BLOB', 'MEDIUM_BLOB', 'LONG_BLOB', 'VARCHAR']);
function typeCast(field: { type: string; buffer(): Buffer | null }, next: () => unknown): unknown {
  if (BINARY_TYPES.has(field.type)) {
    const b = field.buffer();
    return b === null ? null : b.toString('utf8');
  }
  return next();
}
/**
 * Each session's settings, sent before its first statement: READ COMMITTED (see the head of the file) and
 * strict mode, so a value too long for its column is refused rather than cut — a cut key is another key.
 */
const SESSION_SETUP = [
  `SET SESSION sql_mode = 'STRICT_ALL_TABLES,NO_ENGINE_SUBSTITUTION,ERROR_FOR_DIVISION_BY_ZERO,NO_ZERO_DATE,NO_ZERO_IN_DATE'`,
  `SET SESSION TRANSACTION ISOLATION LEVEL READ COMMITTED`,
];
/** Driver options this store always sets: binary text back as strings, matched (not changed) rows counted. */
const CONNECTION_DEFAULTS = { typeCast, flags: ['FOUND_ROWS'], supportBigNumbers: true, bigNumberStrings: false, dateStrings: true };

/**
 * How long the server takes to end the session of a host that is cut off — a partition, not a crash —
 * and so free that process's lock and runs: TCP keepalive's time + interval x probes. MariaDB has its
 * own variables for it (`tcp_keepalive_*`, 0 = the operating system's); MySQL takes it from the server
 * host's operating system only, which no client can read. `seconds: null` is "not readable from here",
 * never a guess. Measured (raporlar 2026-10-18-mysql-impl): 10 / 5 / 3 freed the lock in ~25.6 s on both
 * servers; the Linux defaults (7200 / 75 / 9) still held it after 120 s.
 */
export type PartitionDetection = { seconds: number | null; source: 'server variables' | 'operating system' };
async function partitionDetectionOf(c: Pick<MysqlConnection, 'query'>): Promise<PartitionDetection> {
  const rows = (await run(c, `SHOW GLOBAL VARIABLES LIKE 'tcp\\_keepalive\\_%'`)).rows as Array<{ Variable_name: string; Value: string }>;
  const v = Object.fromEntries(rows.map((r) => [r.Variable_name.toLowerCase(), Number(r.Value)]));
  const [t, i, n] = [v.tcp_keepalive_time, v.tcp_keepalive_interval, v.tcp_keepalive_probes];
  if (t! > 0 && i! > 0 && n! > 0) return { seconds: t! + i! * n!, source: 'server variables' };
  return { seconds: null, source: 'operating system' };
}
/** Longer than this, read from the server, and the boot says so (Postgres' own: ~25 s). */
const PARTITION_WARN_S = 60;
const KEEPALIVE_SETTING = 'net.ipv4.tcp_keepalive_time=10, net.ipv4.tcp_keepalive_intvl=5, net.ipv4.tcp_keepalive_probes=3 (about 25 s)';
function keepaliveAdvice(seconds: number): string {
  return `@gnldev/durable: this MariaDB ends the session of a cut-off host after ${seconds} s (tcp_keepalive_time + tcp_keepalive_interval x tcp_keepalive_probes), `
    + `and until then that process's runs are held — never run twice, but not taken over either. Set tcp_keepalive_time=10, tcp_keepalive_interval=5, tcp_keepalive_probes=3 (about 25 s).`;
}
const KEEPALIVE_UNREADABLE = 'A process cut off from the server (a partition, not a crash) keeps its runs until the server ends its session, when TCP keepalive gives up. '
  + 'This server takes that from its host\'s operating system, which cannot be read by a client: set ' + KEEPALIVE_SETTING + ' on the server host '
  + '(the Linux default is over 2 h; on MariaDB the tcp_keepalive_* variables do the same). Not verified from here.';

const ER_DUP_ENTRY = 1062;
const ER_LOCK_DEADLOCK = 1213;
const errno = (e: unknown): number | undefined => (e as { errno?: number } | null)?.errno;

/** A named lock's name: server-wide, so it carries the database it guards (64 characters at most). */
const lockName = (kind: string, db: string, id: string): string => `gnl${kind}_${createHash('sha1').update(`${db}\u0000${id}`).digest('hex')}`;

// ── the schema ─────────────────────────────────────────────────────────────────────────────────────

const SCHEMA_VERSION = '1';
const RELATIONS_VERIFY_KEY = 'relations_verify';
/**
 * The tables, in Postgres' shape (PostgresStorage's DDL notes say why each column exists), sized for
 * InnoDB's 3072-byte index ceiling. A key longer than its column is REFUSED (strict mode), never cut.
 * `ord` is AUTO_INCREMENT, which InnoDB requires to lead an index — the KEY in the table body.
 * Secondary indexes are statements of their own, created when absent (MySQL has no CREATE INDEX IF NOT
 * EXISTS; `ensureReady` asks the catalog), written in the `IF NOT EXISTS` form `indexesFromDDL` reads.
 */
const TABLES = [
  `CREATE TABLE IF NOT EXISTS gnl_meta (k VARBINARY(1024) NOT NULL PRIMARY KEY, v LONGBLOB NOT NULL)`,
  `CREATE TABLE IF NOT EXISTS gnl_run_journal (\`key\` VARBINARY(3072) NOT NULL PRIMARY KEY, run_id VARBINARY(2048), kind VARBINARY(32), suspended TINYINT(1) NOT NULL DEFAULT 0, value LONGBLOB NOT NULL, created_at BIGINT NOT NULL, owner VARBINARY(1024), ord BIGINT NOT NULL AUTO_INCREMENT, KEY gnl_run_journal_ord (ord))`,
  `CREATE TABLE IF NOT EXISTS gnl_runs (run_id VARBINARY(2048) NOT NULL PRIMARY KEY, model_steps INT NOT NULL DEFAULT 0, tool_calls INT NOT NULL DEFAULT 0, suspended_count INT NOT NULL DEFAULT 0, outcome VARBINARY(32), status VARBINARY(32) NOT NULL, created_at BIGINT NOT NULL, updated_at BIGINT NOT NULL, thread_id VARBINARY(1000), resource_id VARBINARY(1000))`,
  `CREATE TABLE IF NOT EXISTS gnl_counters (\`key\` VARBINARY(2560) NOT NULL, field VARBINARY(512) NOT NULL, value DOUBLE NOT NULL, PRIMARY KEY (\`key\`, field))`,
  `CREATE TABLE IF NOT EXISTS gnl_threads (id VARBINARY(1024) NOT NULL PRIMARY KEY, resource_id VARBINARY(1024) NOT NULL, title LONGBLOB, parent_thread_id VARBINARY(1024), metadata LONGBLOB, created_at BIGINT NOT NULL, updated_at BIGINT NOT NULL, deleted_at BIGINT)`,
  `CREATE TABLE IF NOT EXISTS gnl_messages (thread_id VARBINARY(1024) NOT NULL, seq INT NOT NULL, role VARBINARY(64) NOT NULL, text LONGBLOB, embedding LONGBLOB, metadata LONGBLOB, ts BIGINT NOT NULL, message LONGBLOB NOT NULL, PRIMARY KEY (thread_id, seq))`,
  `CREATE TABLE IF NOT EXISTS gnl_working_memory (scope_id VARBINARY(3072) NOT NULL PRIMARY KEY, data LONGBLOB NOT NULL, updated_at BIGINT NOT NULL)`,
  `CREATE TABLE IF NOT EXISTS gnl_observations (thread_id VARBINARY(1024) NOT NULL PRIMARY KEY, obs LONGBLOB NOT NULL)`,
  `CREATE TABLE IF NOT EXISTS gnl_message_batches (thread_id VARBINARY(1024) NOT NULL, batch_key VARBINARY(2048) NOT NULL, seq_from INT NOT NULL, seq_to INT NOT NULL, ts BIGINT NOT NULL, PRIMARY KEY (thread_id, batch_key))`,
  `CREATE TABLE IF NOT EXISTS gnl_vectors (id VARBINARY(3072) NOT NULL PRIMARY KEY, text LONGBLOB NOT NULL, embedding LONGBLOB NOT NULL, metadata LONGBLOB, namespace VARBINARY(1024), owner VARBINARY(1024), shared TINYINT(1), created_at BIGINT NOT NULL, doc VARBINARY(3072))`,
  `CREATE TABLE IF NOT EXISTS gnl_work_log (ns VARBINARY(1024) NOT NULL, id VARBINARY(2048) NOT NULL, payload LONGBLOB NOT NULL, ts BIGINT NOT NULL, seq BIGINT NOT NULL DEFAULT 0, ord BIGINT NOT NULL AUTO_INCREMENT, PRIMARY KEY (ns, id), KEY gnl_work_log_ord (ord))`,
  `CREATE TABLE IF NOT EXISTS gnl_work_seq (ns VARBINARY(1024) NOT NULL PRIMARY KEY, seq BIGINT NOT NULL)`,
  `CREATE TABLE IF NOT EXISTS gnl_work_kv (\`key\` VARBINARY(3072) NOT NULL PRIMARY KEY, value LONGBLOB NOT NULL)`,
  `CREATE TABLE IF NOT EXISTS gnl_cache (\`key\` VARBINARY(3072) NOT NULL PRIMARY KEY, value LONGBLOB NOT NULL, expires_at BIGINT)`,
];
const INDEXES = [
  `CREATE INDEX IF NOT EXISTS gnl_run_journal_run ON gnl_run_journal (run_id, created_at)`,
  // The owner-record lookup (listOwnerRecords): owner, then key — both halves, placed and NULL.
  `CREATE INDEX IF NOT EXISTS gnl_run_journal_owner ON gnl_run_journal (owner, \`key\`(2000))`,
  `CREATE INDEX IF NOT EXISTS gnl_runs_updated ON gnl_runs (updated_at, run_id)`,
  `CREATE INDEX IF NOT EXISTS gnl_runs_created ON gnl_runs (created_at, run_id)`,
  // Postgres keeps the open runs in partial indexes; a status-led index serves the same reads here.
  `CREATE INDEX IF NOT EXISTS gnl_runs_status ON gnl_runs (status, created_at, run_id)`,
  `CREATE INDEX IF NOT EXISTS gnl_runs_resource ON gnl_runs (resource_id, created_at, run_id)`,
  `CREATE INDEX IF NOT EXISTS gnl_runs_thread ON gnl_runs (thread_id, created_at, run_id)`,
  `CREATE INDEX IF NOT EXISTS gnl_threads_res ON gnl_threads (resource_id, updated_at)`,
  `CREATE INDEX IF NOT EXISTS gnl_vectors_doc ON gnl_vectors (doc)`,
  `CREATE INDEX IF NOT EXISTS gnl_work_log_ns ON gnl_work_log (ns, ts)`,
  `CREATE INDEX IF NOT EXISTS gnl_work_log_seq ON gnl_work_log (ns, seq, ts, id(2000))`,
];
const DDL = [...TABLES, ...INDEXES];

/** The column names `tablesFromDDL` reads from these tables: backquotes off, the bodies' KEY lines out. */
function expectedTables(): Map<string, Map<string, string>> {
  const out = new Map<string, Map<string, string>>();
  for (const [table, cols] of tablesFromDDL(TABLES)) {
    const m = new Map<string, string>();
    for (const [name, def] of cols) if (!/^(KEY|INDEX|UNIQUE)$/i.test(name)) m.set(name.replace(/`/g, ''), def);
    out.set(table, m);
  }
  return out;
}

/** `col >= $n [AND col < $n+1]`, numbered from `from`; no upper bound for the empty prefix (every key). */
function myRange(col: string, prefix: string, from: number): { where: string; params: string[] } {
  const upper = prefixUpperBound(prefix);
  return upper === undefined
    ? { where: `${col} >= $${from}`, params: [prefix] }
    : { where: `${col} >= $${from} AND ${col} < $${from + 1}`, params: [prefix, upper] };
}
/** A column name as SQL: backquoted, since `key` is a reserved word. */
const col = (name: string): string => `\`${name}\``;

function offset(q?: ListQuery) { return { start: q?.cursor ? Number(q.cursor) || 0 : 0, limit: q?.limit ?? 50 }; }
function pageOf<T>(rows: T[], start: number, limit: number, total: number): Page<T> {
  const next = start + limit;
  return { items: rows, nextCursor: next < total ? String(next) : undefined };
}
function normRange(r?: number | { before: number; after: number }) {
  if (r == null) return { before: 0, after: 0 };
  return typeof r === 'number' ? { before: r, after: r } : r;
}
const hasNorm = (v?: number[] | null): v is number[] => !!v && v.some((x) => x !== 0);

/** One upsert for a set of counter increments, merged by (key, field) and in that order (the lock order). */
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
  for (const m of [...merged.values()].sort((a, b) => compareKeys(a.key, b.key) || compareKeys(a.field, b.field))) flat.push(m.key, m.field, m.delta);
  return flat;
}
function incrSql(rows: number): string {
  const values = Array.from({ length: rows }, (_, i) => `($${i * 3 + 1}, $${i * 3 + 2}, $${i * 3 + 3})`).join(', ');
  return `INSERT INTO gnl_counters (\`key\`, field, value) VALUES ${values} ON DUPLICATE KEY UPDATE value = value + VALUES(value)`;
}

/** The server refuses a connection beyond `max_connections` with 1040; its message names no remedy. */
function connectionAdvice(poolMax: number, serverMax: number): string {
  const safe = Math.max(1, Math.floor((serverMax - 10) / Math.max(1, poolMax)));
  return `@gnldev/durable: this process reserves up to ${poolMax} MySQL connections and the server allows ${serverMax}. `
    + `Keep (processes x pool size) under ${serverMax - 10} -- roughly ${safe} process(es) at this pool size. `
    + `Pass a smaller pool via new MysqlStorage({ pool }) if you run more.`;
}

/**
 * Said in one sentence: a pool that cannot hand out a connection cannot give a transaction, and every
 * journal write that spans more than one statement depends on one.
 */
const NO_TX_MSG = '@gnldev/durable: the pool given to MysqlStorage has no getConnection(), so nothing can be written in a transaction — '
  + 'putIfAbsent, putIfMatch, applyBatch and every message append depend on exactly that. Pass a `mysql2/promise` pool, or a connectionString.';

// ── the store ──────────────────────────────────────────────────────────────────────────────────────

export interface MysqlStorageOptions {
  /** `mysql://user:password@localhost:3306/database` — the database must exist and be named. */
  connectionString?: string;
  /** Or a `mysql2/promise` pool of your own (its connections are given this store's session settings when it announces them). */
  pool?: MysqlPool;
}

/** What `MysqlStorage` shares with its ports: the database name (lock namespaces), settled at boot. */
type Shared = { db: string };
/**
 * `Shared` once the boot has settled it. A lock name is built only after this resolves: built before the
 * boot (as a transaction's argument, before the transaction waits for it), `db` was still '' and a fresh
 * process's first append to a thread took another lock than every later append to it — the two were not
 * serialized. The memory store takes this, not `Shared`, so it cannot read the name unsettled.
 */
type Settled = () => Promise<Shared>;

export class MysqlStorage implements Storage {
  readonly name = 'mysql';
  readonly capabilities: CapabilityMatrix = { runs: 'full', memory: 'full', vectors: 'scan', work: 'full', cache: 'ttl' };
  readonly runs: RunJournal;
  readonly memory: MemoryStore;
  readonly vectors: VectorStore;
  readonly work: WorkStore;
  readonly cache: CacheStore;
  readonly meta: MetaStore;
  private readonly _pool: MysqlPool;
  private readonly connectionString?: string;
  private readonly shared: Shared = { db: '' };
  private ready?: Promise<void>;
  private connectionBudget?: { poolMax: number; serverMax: number };
  private ownLiveness?: Promise<ProcessLiveness>;
  /** The connection pool — for companion stores in the same database. */
  get pool(): MysqlPool { return this._pool; }

  constructor(opts: MysqlStorageOptions = {}) {
    refuseUnknownNames('MysqlStorage', opts, MYSQL_STORAGE_NAMES);
    if (!opts.pool && !opts.connectionString) throw new Error('@gnldev/durable: MysqlStorage needs a connectionString (mysql://user:password@localhost:3306/database) or a pool.');
    this.connectionString = opts.connectionString;
    this._pool = opts.pool ?? driver().createPool({ uri: opts.connectionString, ...CONNECTION_DEFAULTS, waitForConnections: true, connectionLimit: 10 });
    // Every connection the pool opens gets the session settings before its first statement: the driver
    // runs a connection's statements in order, so these are sent ahead of whatever asked for it.
    this._pool.pool?.on?.('connection', (c) => { for (const sql of SESSION_SETUP) c.query(sql); });
    const explain = (e: unknown): unknown => {
      if (errno(e) !== 1040 || !this.connectionBudget) return e;
      const err = new Error(`${String((e as Error).message)} -- ${connectionAdvice(this.connectionBudget.poolMax, this.connectionBudget.serverMax)}`, { cause: e });
      (err as { errno?: number }).errno = 1040;
      return err;
    };
    const q: Q = (sql, p) => this.ensureReady().then(() => run(this._pool, sql, p)).catch((e) => { throw explain(e); });
    const tx: Tx = async (fn, o) => {
      await this.ensureReady();
      if (typeof this._pool.getConnection !== 'function') throw new Error(NO_TX_MSG);
      const c = await this._pool.getConnection().catch((e: unknown) => { throw explain(e); });
      let destroy = false;
      let lock: string | undefined;
      try {
        if (o?.lock) {
          // A named lock is the session's, not the transaction's: taken before BEGIN, given back after
          // COMMIT or ROLLBACK, below. 0 is a timeout; NULL an error.
          const got = (await run(c, 'SELECT GET_LOCK($1, $2) AS ok', [o.lock.name, o.lock.timeoutS])).rows[0]?.ok;
          if (Number(got) !== 1) {
            const err = new Error(`@gnldev/durable: lock wait timeout on ${o.lock.what}`);
            (err as { code?: string }).code = 'LOCK_TIMEOUT';
            throw err;
          }
          lock = o.lock.name;
        }
        await run(c, 'START TRANSACTION');
        try {
          const out = await fn((s, p) => run(c, s, p));
          await run(c, 'COMMIT');
          return out;
        } catch (e) {
          try { await run(c, 'ROLLBACK'); } catch { destroy = true; }
          throw e;
        }
      } finally {
        if (lock !== undefined) { try { await run(c, 'SELECT RELEASE_LOCK($1)', [lock]); } catch { destroy = true; } }
        // A connection in an uncertain state (a failed rollback, a lock not given back) never returns to the pool.
        if (destroy) c.destroy?.(); else c.release?.();
      }
    };
    this.runs = new MyRunJournal(q, tx);
    Object.defineProperty(this.runs, 'processLiveness', { value: () => this.processLiveness(), enumerable: false, configurable: true });
    this.memory = new MyMemoryStore(q, tx, () => this.ensureReady().then(() => this.shared));
    this.vectors = new MyVectorStore(q, tx);
    this.work = new MyWorkStore(q, tx);
    markWorkOf(this);
    this.cache = new MyCacheStore(q);
    this.meta = new MyMetaStore(q);
  }

  /** This process's liveness on this database: a named lock held by a dedicated session (`mysqlLiveness`), made on first use, ended by `close()`. */
  processLiveness(): Promise<ProcessLiveness> {
    if (this.ownLiveness) return this.ownLiveness;
    const cfg = this._pool.pool?.config?.connectionConfig;
    if (!this.connectionString && !cfg) {
      return Promise.reject(new Error('@gnldev/durable: this MySQL pool does not say where it connects, so no process liveness can be made for it — pass `liveness: await mysqlLiveness({ connectionString })` to createGnl'));
    }
    const made = mysqlLiveness(this.connectionString ? { connectionString: this.connectionString } : { connection: cfg! });
    this.ownLiveness = made;
    made.catch(() => { if (this.ownLiveness === made) this.ownLiveness = undefined; });
    return made;
  }

  private ensureReady(): Promise<void> {
    if (this.ready) return this.ready;
    const booting = (async () => {
      const c = await this._pool.getConnection();
      let locked: string | undefined;
      try {
        for (const sql of SESSION_SETUP) await run(c, sql);
        const db = (await run(c, 'SELECT DATABASE() AS db')).rows[0]?.db as string | null;
        if (!db) throw new Error('@gnldev/durable: the MySQL connection names no database — put one in the connectionString (mysql://…/database).');
        this.shared.db = db;
        // Two processes booting a fresh database at once: the first creates the schema, the others wait
        // and find it there. A named lock for this database, given back in `finally`.
        locked = lockName('b', db, 'boot');
        await run(c, 'SELECT GET_LOCK($1, 60)', [locked]);
        for (const sql of TABLES) await run(c, sql);
        const have = new Set(((await run(c, `SELECT DISTINCT INDEX_NAME AS n FROM information_schema.STATISTICS WHERE TABLE_SCHEMA = DATABASE()`)).rows as { n: string }[]).map((x) => x.n));
        for (const [name, ix] of indexesFromDDL(INDEXES)) if (!have.has(name)) await run(c, ix.statement.replace(/IF NOT EXISTS /i, ''));
        await run(c, `INSERT INTO gnl_meta (k, v) VALUES ('schema_version', $1) ON DUPLICATE KEY UPDATE k = k`, [SCHEMA_VERSION]);
        try {
          const serverMax = Number((await run(c, `SELECT @@max_connections AS m`)).rows[0]?.m);
          const poolMax = Number(this._pool.pool?.config?.connectionLimit ?? 10);
          this.connectionBudget = { poolMax, serverMax };
          if (Number.isFinite(serverMax) && poolMax * 4 > serverMax - 10) console.warn(connectionAdvice(poolMax, serverMax));
        } catch { /* advice, not a gate */ }
        // Said only when read: a MariaDB whose own keepalive variables make a partition long. The
        // operating system's setting is out of a client's sight (durabilityReport says so).
        try {
          const pd = await partitionDetectionOf(c);
          if (pd.seconds !== null && pd.seconds > PARTITION_WARN_S) console.warn(keepaliveAdvice(pd.seconds));
        } catch { /* advice, not a gate */ }
      } finally {
        if (locked) await run(c, 'SELECT RELEASE_LOCK($1)', [locked]).catch(() => undefined);
        c.release?.();
      }
    })();
    this.ready = booting;
    // A rejected boot is not memoised: a transient failure (a restart, a failover) must not become permanent.
    booting.catch(() => { if (this.ready === booting) this.ready = undefined; });
    return booting;
  }
  async init(): Promise<void> { await this.ensureReady(); }
  async close(): Promise<void> {
    await closeExecutorFor(this.runs as unknown as Parameters<typeof closeExecutorFor>[0]);
    unbindLiveness(this.runs);
    const own = this.ownLiveness;
    this.ownLiveness = undefined;
    if (own) await (await own.catch(() => undefined))?.close();
    await this._pool.end();
  }

  /** The deployment's durability preconditions as this store can read them (see MyRunJournal.durabilityReport). */
  durabilityReport() { return (this.runs as MyRunJournal).durabilityReport(); }

  /** See `Storage.compact`: `OPTIMIZE TABLE` rebuilds each table and gives its free space back (InnoDB rebuilds online). */
  async compact(opts?: { full?: boolean }): Promise<{ reclaimedBytes: number }> {
    refuseUnknownNames('compact', opts, COMPACT_NAMES);
    await this.ensureReady();
    for (const t of ['gnl_run_journal', 'gnl_runs', 'gnl_messages', 'gnl_work_log', 'gnl_vectors']) await run(this._pool, `OPTIMIZE TABLE ${t}`);
    return { reclaimedBytes: -1 };
  }

  /** The DDL `ensureReady` runs (indexes in their `IF NOT EXISTS` form; the boot runs each one absent without it). */
  exportSchema(): string[] { return [...DDL]; }

  /** Read-only, against information_schema, without booting the store (see PostgresStorage.checkSchema). */
  async checkSchema(): Promise<SchemaCheckResult> {
    const expected = expectedTables();
    const live = new Map<string, Set<string>>();
    for (const r of (await run(this._pool, `SELECT TABLE_NAME AS t, COLUMN_NAME AS c FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE()`)).rows as { t: string; c: string }[]) {
      if (!r.t.startsWith('gnl_')) continue;
      if (!live.has(r.t)) live.set(r.t, new Set());
      live.get(r.t)!.add(r.c);
    }
    const missingTables: string[] = [];
    const missingColumns: MissingColumn[] = [];
    for (const [table, cols] of expected) {
      const have = live.get(table);
      if (!have) { missingTables.push(table); continue; }
      for (const c of cols.keys()) if (!have.has(c)) missingColumns.push({ table, column: c });
    }
    const unknownTables = [...live.keys()].filter((t) => !expected.has(t));
    const liveIndexes = new Set(((await run(this._pool, `SELECT DISTINCT INDEX_NAME AS n FROM information_schema.STATISTICS WHERE TABLE_SCHEMA = DATABASE()`)).rows as { n: string }[]).map((x) => x.n));
    const missingIndexes = [...indexesFromDDL(INDEXES).keys()].filter((n) => !liveIndexes.has(n));
    return { ok: missingTables.length === 0 && missingColumns.length === 0 && missingIndexes.length === 0, missingTables, missingColumns, unknownTables, missingIndexes };
  }

  /** The `schema` step: the tables, columns and indexes `checkSchema` finds missing (additive only). */
  private async applySchemaGap(opts?: { dryRun?: boolean }): Promise<SchemaMigrationResult> {
    const check = await this.checkSchema();
    const expected = expectedTables();
    const statements: string[] = [];
    for (const table of check.missingTables) for (const stmt of TABLES) if (new RegExp(`^CREATE TABLE IF NOT EXISTS ${table}\\b`, 'i').test(stmt)) statements.push(stmt);
    for (const { table, column } of check.missingColumns) {
      const def = expected.get(table)?.get(column);
      if (def) statements.push(`ALTER TABLE ${table} ADD COLUMN ${def}`);
    }
    const all = indexesFromDDL(INDEXES);
    for (const name of check.missingIndexes ?? []) {
      const ix = all.get(name);
      if (ix) statements.push(ix.statement.replace(/IF NOT EXISTS /i, ''));
    }
    if (opts?.dryRun) return { statements, dryRun: true };
    for (const stmt of statements) await run(this._pool, stmt);
    return { statements, dryRun: false };
  }

  /**
   * See `Storage.upgrade`. This store has no earlier version: `run-status` is never pending (no status
   * flags were ever written here), `schema` adds what a database created by a later release lacks, and
   * the record steps run as on every store.
   */
  async upgrade(opts?: UpgradeOptions): Promise<UpgradeReport> {
    refuseUnknownNames('MysqlStorage.upgrade', opts, UPGRADE_NAMES);
    return runUpgrade('MysqlStorage', [
      runStatusStep({ runStatusPending: async () => false, runStatusPlan: async () => [], migrateRunStatus: async () => ({ runs: 0 }) }),
      {
        name: 'schema',
        description: 'adds the tables, columns and indexes this version expects (additive: never drops or renames)',
        requires: ['run-status'],
        pending: async () => !(await this.checkSchema()).ok,
        plan: async () => ({ statements: (await this.applySchemaGap({ dryRun: true })).statements }),
        run: async () => ({ statements: (await this.applySchemaGap()).statements }),
      },
      this.booted(threadRecordsStep(this, ['schema'])),
      this.booted(relationsStep(this.runs as MyRunJournal, ['schema'])),
      this.booted(verifyRelationsStep(this.runs as MyRunJournal, ['schema'])),
    ], opts, () => this.holdsAStore());
  }
  private booted(step: UpgradeStep): UpgradeStep {
    const plan = step.plan;
    return {
      ...step,
      pending: async () => { await this.ensureReady(); return step.pending(); },
      ...(plan ? { plan: async () => { await this.ensureReady(); return plan.call(step); } } : {}),
      run: async () => { await this.ensureReady(); return step.run(); },
    };
  }
  private async holdsAStore(): Promise<boolean> {
    const tables = expectedTables();
    const r = await run(this._pool, `SELECT TABLE_NAME AS t FROM information_schema.TABLES WHERE TABLE_SCHEMA = DATABASE()`);
    return (r.rows as { t: string }[]).some((x) => tables.has(x.t));
  }

  /** See `Storage.adoptIntoOrg` and the Postgres twin: one transaction, the tables of `SCOPE_TABLES`. */
  async adoptIntoOrg(orgId: string, opts?: { dryRun?: boolean; allowUnregistered?: boolean; allowInFlight?: boolean }): Promise<AdoptIntoOrgResult> {
    refuseUnknownNames('adoptIntoOrg', opts, ADOPT_INTO_ORG_NAMES);
    const prefix = orgPrefix(orgId);
    const ns = prefix.slice(0, -1);
    const dryRun = opts?.dryRun === true;
    await this.ensureReady();
    await assertOrgRegistered(this.runs, orgId, opts?.allowUnregistered);
    await assertNoRunsInFlight(this.runs, opts?.allowInFlight);
    if (!dryRun) await (this.runs as unknown as { deletePrefix(p: string): Promise<number> }).deletePrefix(ROOT_EXEC_RECORDS);
    const c = await this._pool.getConnection();
    const q: Q = (sql, p) => run(c, sql, p);
    const moved: Record<string, number> = {};
    const skipped = new Set<string>();
    const resetPositions: string[] = [];
    let alreadyScoped = 0;
    const bump = (store: string, n: number) => { moved[store] = (moved[store] ?? 0) + n; };
    if (!dryRun) await q('START TRANSACTION');
    try {
      const clash = (await q(`SELECT a.id AS id FROM gnl_vectors a JOIN gnl_vectors b ON b.id = CONCAT($1, ':', a.id) WHERE a.namespace IS NULL LIMIT 1`, [ns])).rows[0] as { id: string } | undefined;
      if (clash) throw vectorAdoptCollision(clash.id);
      const space = (column: string, outside = false) => { let n = 0; return orgSpaceSql(col(column), () => `$${++n}`, { outside }); };
      const kvRoot = space('key', true);
      for (const { key, value } of (await q(`SELECT \`key\`, value FROM gnl_work_kv WHERE ${kvRoot.cond}`, kvRoot.params)).rows as { key: string; value: string }[]) {
        if (isPlatformKey(key)) continue;
        const orgHas = (await q('SELECT 1 AS x FROM gnl_work_kv WHERE `key` = $1', [prefix + key])).rows.length > 0;
        const d = workKeyAdoption(deserialize(value), orgHas);
        if (d === 'collision') throw workKeyAdoptCollision(prefix + key);
        if (d === 'reset-position') resetPositions.push(key);
      }
      const twins = async (table: string, column: string, match: string[] = [], pick: string[] = []) => {
        let n = 1;
        const out = orgSpaceSql(`a.${col(column)}`, () => `$${++n}`, { outside: true });
        const on = [`b.${col(column)} = CONCAT($1, a.${col(column)})`, ...match.map((m) => `b.${col(m)} = a.${col(m)}`)].join(' AND ');
        return (await q(`SELECT a.${col(column)} AS k${pick.map((p) => `, a.${col(p)} AS ${p}`).join('')} FROM ${table} a JOIN ${table} b ON ${on} WHERE ${out.cond}`,
          [prefix, ...out.params])).rows as Array<Record<string, any>>;
      };
      const conflicts: string[] = [];
      const summed: Array<{ k: string; field: string; value: number }> = [];
      const dropped = new Set<string>();
      for (const [table, column, kind] of adoptedColumns()) {
        const how = onAdoptionCollision(kind);
        if (how === 'sum') {
          for (const r of await twins(table, column, ['field'], ['field', 'value'])) if (!staysAtRoot(r.k)) summed.push({ k: r.k, field: r.field, value: Number(r.value) });
          continue;
        }
        for (const { k } of await twins(table, column)) {
          if (staysAtRoot(k)) continue;
          if (how === 'refuse') conflicts.push(prefix + k); else dropped.add(k);
        }
      }
      for (const r of await twins('gnl_work_log', 'ns', ['id'], ['id'])) if (!isPlatformKey(r.k)) conflicts.push(`${prefix}${r.k}/${r.id}`);
      if (conflicts.length) throw adoptionConflict(orgId, conflicts);
      if (!dryRun) {
        for (const k of resetPositions) await q('DELETE FROM gnl_work_kv WHERE `key` = $1', [k]);
        for (const { k, field, value } of summed) {
          await q('UPDATE gnl_counters SET value = value + $1 WHERE `key` = $2 AND field = $3', [value, prefix + k, field]);
          await q('DELETE FROM gnl_counters WHERE `key` = $1 AND field = $2', [k, field]);
        }
        for (const k of dropped) await q('DELETE FROM gnl_cache WHERE `key` = $1', [k]);
        bump('runs', summed.length);
      }
      const notCarried = new Set([...resetPositions, ...dropped]);
      if (!dryRun) {
        const held = new Set<string>();
        for (const k of scopeFactKeys(prefix)) if ((await q('SELECT 1 AS x FROM gnl_run_journal WHERE `key` = $1', [k])).rows.length) held.add(k);
        for (const k of scopeFactsDroppedByAdoption(prefix, held)) await q('DELETE FROM gnl_run_journal WHERE `key` = $1', [k]);
      }
      for (const [table, column, store, counted] of SCOPE_TABLES) {
        const inQ = space(column);
        if (counted) alreadyScoped += Number((await q(`SELECT COUNT(*) AS c FROM ${table} WHERE ${inQ.cond}`, inQ.params)).rows[0].c);
        const rootQ = space(column, true);
        const rows = (await q(`SELECT DISTINCT ${col(column)} AS k FROM ${table} WHERE ${col(column)} IS NOT NULL AND ${rootQ.cond}`, rootQ.params)).rows as { k: string }[];
        let n = 0;
        for (const { k } of rows) {
          if (isScopeFact(k)) continue;
          if (isPlatformKey(k)) { skipped.add(k.split(':')[0]!); continue; }
          if ((table === 'gnl_work_kv' || table === 'gnl_cache') && notCarried.has(k)) continue;
          if (counted) n += Number((await q(`SELECT COUNT(*) AS c FROM ${table} WHERE ${col(column)} = $1`, [k])).rows[0].c);
          if (dryRun) continue;
          if (table === 'gnl_work_log') await q('UPDATE gnl_work_log SET ns = $1, seq = 0 WHERE ns = $2', [prefix + k, k]);
          else await q(`UPDATE ${table} SET ${col(column)} = $1 WHERE ${col(column)} = $2`, [prefix + k, k]);
        }
        bump(store, n);
      }
      const metaRoot = space('k', true);
      const metaIn = space('k');
      const metaRows = (await q(`SELECT k FROM gnl_meta WHERE ${metaRoot.cond}`, metaRoot.params)).rows as { k: string }[];
      alreadyScoped += Number((await q(`SELECT COUNT(*) AS c FROM gnl_meta WHERE ${metaIn.cond}`, metaIn.params)).rows[0].c);
      let metaN = 0;
      for (const { k } of metaRows) {
        if (ENGINE_META_KEYS.includes(k)) continue;
        if (isPlatformKey(k)) { skipped.add(k.split(':')[0]!); continue; }
        metaN++;
        if (!dryRun) await q(`UPDATE gnl_meta SET k = $1 WHERE k = $2`, [prefix + k, k]);
      }
      bump('meta', metaN);
      const vecs = Number((await q(`SELECT COUNT(*) AS c FROM gnl_vectors WHERE namespace IS NULL`)).rows[0].c);
      alreadyScoped += Number((await q(`SELECT COUNT(*) AS c FROM gnl_vectors WHERE namespace IS NOT NULL`)).rows[0].c);
      if (!dryRun && vecs) await q(`UPDATE gnl_vectors SET namespace = $1, id = CONCAT($1, ':', id) WHERE namespace IS NULL`, [ns]);
      bump('vectors', vecs);
      if (!dryRun) await q('COMMIT');
    } catch (e) {
      if (!dryRun) await q('ROLLBACK').catch(() => {});
      throw e;
    } finally { c.release?.(); }
    return { orgId, dryRun, moved, alreadyScoped, skippedPlatformKeys: [...skipped].sort(), resetPositions: resetPositions.sort() };
  }
}

type TxOptions = { lock?: { name: string; timeoutS: number; what: string } };
type Tx = <T>(fn: (q: Q) => Promise<T>, opts?: TxOptions) => Promise<T>;

// ── the run journal ────────────────────────────────────────────────────────────────────────────────

/** Thrown inside `applyBatch`'s transaction when its claim is lost, so everything it wrote rolls back. */
const CLAIM_LOST = Symbol('claim lost');
const PLACE_PAGE = 1000;
const journalRow = (key: string, value: unknown, p: { runId: string; kind: string } | null, suspended: boolean): unknown[] =>
  [key, p?.runId ?? null, p?.kind ?? null, suspended ? 1 : 0, serialize(value), Date.now(), ownerColumnOf(key, value)];
const JOURNAL_UPSERT = `INSERT INTO gnl_run_journal (\`key\`, run_id, kind, suspended, value, created_at, owner) VALUES ($1,$2,$3,$4,$5,$6,$7)
  ON DUPLICATE KEY UPDATE value = VALUES(value), suspended = VALUES(suspended), owner = VALUES(owner)`;
const JOURNAL_INSERT = `INSERT INTO gnl_run_journal (\`key\`, run_id, kind, suspended, value, created_at, owner) VALUES ($1,$2,$3,$4,$5,$6,$7)`;
/** A plain INSERT whose duplicate-key error is the lost race: `true` when this write created the row. */
async function insertNew(q: Q, sql: string, params: unknown[]): Promise<boolean> {
  try { await q(sql, params); return true; } catch (e) { if (errno(e) === ER_DUP_ENTRY) return false; throw e; }
}
const INPUT_SUFFIX = leafSuffix('input');

function myRunSummary(x: any): RunSummary {
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
const and = (where: string, cond: string): string => (where ? `${where} AND ${cond}` : ` WHERE ${cond}`);
const INPUT_JOIN = (alias: string) => `LEFT JOIN gnl_run_journal j ON j.\`key\` = CONCAT(${alias}.run_id, '${INPUT_SUFFIX}')`;

class MyRunJournal implements RunJournal {
  constructor(private q: Q, private tx: Tx) { withBirth(this as never); }

  async get<T = unknown>(key: string): Promise<T | undefined> {
    const r = await this.q('SELECT value FROM gnl_run_journal WHERE `key` = $1', [key]);
    return r.rows[0] ? deserialize<T>(r.rows[0].value) : undefined;
  }
  async put(key: string, value: unknown): Promise<void> {
    const p = parseJournalKey(key);
    const suspended = p?.kind === 'tool' && (value as ToolJournalRecord | undefined)?.status === 'suspended';
    if (!p && !runIdOfKey(key, value) && outcomeStatusOf(key, value) === null && !key.endsWith(INPUT_SUFFIX)) {
      await this.q(JOURNAL_UPSERT, journalRow(key, value, p, suspended));
      return;
    }
    await this.writeTx(async (q) => {
      const prev = await this.writeRecord(q, key, value, p, suspended);
      await this.unplaceUnreadInput(q, key, value);
      await this.writeRunRows(q, new RunRowChanges().noteWrite(key, value, prev));
    });
  }
  async putIfAbsent(key: string, value: unknown): Promise<boolean> {
    const p = parseJournalKey(key);
    const suspended = p?.kind === 'tool' && (value as ToolJournalRecord | undefined)?.status === 'suspended';
    if (!p && !runIdOfKey(key, value) && outcomeStatusOf(key, value) === null && !key.endsWith(INPUT_SUFFIX)) {
      return insertNew(this.q, JOURNAL_INSERT, journalRow(key, value, p, suspended));
    }
    // The INSERT is the claim and its own lock: a concurrent claim of the same key waits for this
    // transaction and then meets the row (1062). Only the winner touches the run's row.
    return this.writeTx(async (q) => {
      const inserted = await insertNew(q, JOURNAL_INSERT, journalRow(key, value, p, suspended));
      if (inserted) {
        await this.unplaceUnreadInput(q, key, value);
        await this.writeRunRows(q, new RunRowChanges().noteWrite(key, value, undefined));
      }
      return inserted;
    });
  }
  /** Atomic conditional replace: a stored value compared byte for byte (binary columns); matched rows counted (FOUND_ROWS). */
  async putIfMatch(key: string, expected: unknown, value: unknown): Promise<boolean> {
    const p = parseJournalKey(key);
    const suspended = p?.kind === 'tool' && (value as ToolJournalRecord | undefined)?.status === 'suspended';
    const upd = (q: Q) => q('UPDATE gnl_run_journal SET value = $1, suspended = $2, owner = $5 WHERE `key` = $3 AND value = $4',
      [serialize(value), suspended ? 1 : 0, key, serialize(expected), ownerColumnOf(key, value)]);
    if (!p) {
      const oc = outcomeStatusOf(key, value);
      const placed = runRelationsOf(key, value) !== undefined;
      if (oc === null && !placed && !key.endsWith(INPUT_SUFFIX)) return (await upd(this.q)).rowCount === 1;
      return this.writeTx(async (q) => {
        const ok = (await upd(q)).rowCount === 1;
        if (ok) {
          await this.unplaceUnreadInput(q, key, value);
          await this.writeRunRows(q, new RunRowChanges().noteWrite(key, value, undefined));
        }
        return ok;
      });
    }
    // A run's record: counted from the row it replaces, read under that row's lock, the match in the
    // locked read's WHERE (at READ COMMITTED it reads the newest version, so a stale `expected` matches nothing).
    return this.writeTx(async (q) => {
      const prev = (await q('SELECT suspended FROM gnl_run_journal WHERE `key` = $1 AND value = $2 FOR UPDATE', [key, serialize(expected)])).rows[0] as { suspended: number } | undefined;
      if (!prev) return false;
      await upd(q);
      await this.writeRunRows(q, new RunRowChanges().noteWrite(key, value, { suspended: !!prev.suspended }));
      return true;
    });
  }

  /** In-engine atomic counter: one upsert, then this transaction's sums, read under the rows' locks. */
  async incrBy(key: string, fields: Record<string, number>): Promise<Record<string, number>> {
    const flat = flattenIncrs([{ key, fields }]);
    if (!flat.length) return {};
    const names = Object.keys(fields);
    return this.writeTx(async (q) => {
      await q(incrSql(flat.length / 3), flat);
      const r = await q(`SELECT field, value FROM gnl_counters WHERE \`key\` = $1 AND field IN (${names.map((_, i) => `$${i + 2}`).join(', ')})`, [key, ...names]);
      return Object.fromEntries(r.rows.map((row: any) => [row.field, Number(row.value)]));
    });
  }
  async getCounters(key: string): Promise<Record<string, number> | undefined> {
    const r = await this.q('SELECT field, value FROM gnl_counters WHERE `key` = $1', [key]);
    if (!r.rows.length) return undefined;
    return Object.fromEntries(r.rows.map((row: any) => [row.field, Number(row.value)]));
  }

  /**
   * The precondition of exactly-once — an acknowledged write is never lost — as this server is configured:
   * a commit flushed to disk (`innodb_flush_log_at_trx_commit = 1`, `sync_binlog = 1`). Whether a replica
   * acknowledges before the commit returns (semi-synchronous replication) is not read here: the report
   * says so instead of guessing.
   */
  async durabilityReport(): Promise<{ syncCommit: string; standbyNames: string; connectedStandbys: number; syncStandbys: number; safeForFailover: boolean; partitionDetection: PartitionDetection; notes: string[] }> {
    const r = (await this.q(`SELECT @@innodb_flush_log_at_trx_commit AS f, @@sync_binlog AS b`)).rows[0] ?? {};
    const partitionDetection = await partitionDetectionOf({ query: (sql: string, v?: unknown[]) => this.q(sql, v).then((x) => [x.rows, undefined] as RawResult) });
    const syncCommit = `innodb_flush_log_at_trx_commit=${r.f}, sync_binlog=${r.b}`;
    const notes: string[] = [];
    if (String(r.f) !== '1') notes.push(`innodb_flush_log_at_trx_commit=${r.f}: an acknowledged commit can be lost on a crash. Set it to 1.`);
    notes.push('Replication is not inspected by this store: for failover, use semi-synchronous replication (or a Group Replication / Galera cluster) so an acknowledged commit is on a replica before it returns.');
    if (partitionDetection.seconds === null) notes.push(KEEPALIVE_UNREADABLE);
    else if (partitionDetection.seconds > PARTITION_WARN_S) notes.push(keepaliveAdvice(partitionDetection.seconds));
    return { syncCommit, standbyNames: '', connectedStandbys: 0, syncStandbys: 0, safeForFailover: false, partitionDetection, notes };
  }

  async listStaleRuns(cutoffTs: number, opts?: { includeSuspended?: boolean }): Promise<string[]> {
    const r = await this.q(opts?.includeSuspended
      ? 'SELECT run_id FROM gnl_runs WHERE updated_at < $1'
      : 'SELECT run_id FROM gnl_runs WHERE updated_at < $1 AND suspended_count <= 0', [cutoffTs]);
    return r.rows.map((row: any) => row.run_id);
  }
  async readRunStats(runId: string): Promise<{ entries: number; bytes: number }> {
    const r = await this.q('SELECT COUNT(*) AS c, COALESCE(SUM(LENGTH(value)), 0) AS b FROM gnl_run_journal WHERE run_id = $1', [runId]);
    return { entries: Number(r.rows[0].c), bytes: Number(r.rows[0].b) };
  }
  /** The server's clock (epoch ms): one clock for every process and host. */
  async now(): Promise<number> {
    const r = await this.q('SELECT CAST(FLOOR(UNIX_TIMESTAMP(NOW(6)) * 1000) AS SIGNED) AS ms');
    return Number(r.rows[0].ms);
  }

  /** A write's transaction, run again when InnoDB rolled it back whole as a deadlock victim (1213). See PgRunJournal.writeTx for the lock order. */
  private async writeTx<T>(fn: (q: Q) => Promise<T>): Promise<T> {
    for (let attempt = 1; ; attempt++) {
      try { return await this.tx(fn); } catch (e) { if (errno(e) !== ER_LOCK_DEADLOCK || attempt >= 3) throw e; }
    }
  }
  /** Writes a record, returning the row it replaced (see PgRunJournal.writeRecord: the journal row's lock serializes two writers of one key). */
  private async writeRecord(q: Q, key: string, value: unknown, p: { runId: string; kind: string } | null, suspended: boolean): Promise<{ suspended: boolean } | undefined> {
    if (!p) { await q(JOURNAL_UPSERT, journalRow(key, value, p, suspended)); return undefined; }
    for (let attempt = 0; attempt < 3; attempt++) {
      const prev = (await q('SELECT suspended FROM gnl_run_journal WHERE `key` = $1 FOR UPDATE', [key])).rows[0] as { suspended: number } | undefined;
      if (prev) { await q(JOURNAL_UPSERT, journalRow(key, value, p, suspended)); return { suspended: !!prev.suspended }; }
      if (await insertNew(q, JOURNAL_INSERT, journalRow(key, value, p, suspended))) return undefined;
    }
    throw new Error(`@gnldev/durable: journal key ${JSON.stringify(key)} was deleted and written again by other writers three times while this write waited; nothing was written — retry the write.`);
  }
  /**
   * A run's `:input` written with a value this version cannot read as one (no version marker): the run is
   * unplaced (NULL person and thread), so every lookup reads it and decides from the record — what the
   * Postgres guard trigger RUN_UNPLACE does for a writer that does not know the columns. A readable
   * `:input` places the run in `writeRunRows`, in the same transaction.
   */
  private async unplaceUnreadInput(q: Q, key: string, value: unknown): Promise<void> {
    if (!key.endsWith(INPUT_SUFFIX) || runRelationsOf(key, value) !== undefined) return;
    await q('UPDATE gnl_runs SET resource_id = NULL, thread_id = NULL WHERE run_id = $1', [key.slice(0, -INPUT_SUFFIX.length)]);
  }
  /** The runs' rows for one transaction's writes: one upsert per run, in run-id order (see PgRunJournal.writeRunRows). */
  private async writeRunRows(q: Q, changes: RunRowChanges): Promise<void> {
    for (const [runId, c] of changes.entries()) await this.writeRunRow(q, runId, c);
  }
  private async writeRunRow(q: Q, runId: string, c: RunRowChange): Promise<void> {
    const now = Date.now();
    const outcome = storedOutcomeOf(c.outcome);
    const row: [string, unknown][] = [['run_id', runId], ['model_steps', c.models], ['tool_calls', c.tools],
      ['suspended_count', Math.max(0, c.suspendedDelta)], ['outcome', outcome], ['status', runStatusOf(Math.max(0, c.suspendedDelta), outcome)],
      ['created_at', now], ['updated_at', now]];
    const sets: string[] = [];
    if (c.relations) {
      row.push(['resource_id', c.relations.resourceId], ['thread_id', c.relations.threadId]);
      sets.push('resource_id = VALUES(resource_id)', 'thread_id = VALUES(thread_id)');
    }
    if (c.outcome) sets.push('outcome = VALUES(outcome)');
    const vals = row.map(([, v]) => v);
    const param = (v: unknown) => `$${vals.push(v)}`;
    const delta = param(c.suspendedDelta);
    // `status` FIRST: an ON DUPLICATE KEY UPDATE assigns left to right, and a later assignment reads the
    // values set before it — first, `suspended_count` and `outcome` are still the row's before this write.
    await q(
      `INSERT INTO gnl_runs (${row.map(([name]) => name).join(', ')}) VALUES (${row.map((_, i) => `$${i + 1}`).join(',')})
       ON DUPLICATE KEY UPDATE
         status = ${runStatusCaseSql(`suspended_count + ${delta} > 0`, c.outcome ? 'VALUES(outcome)' : 'outcome')},
         model_steps = model_steps + ${param(c.models)},
         tool_calls = tool_calls + ${param(c.tools)},
         suspended_count = suspended_count + ${delta},
         updated_at = ${param(now)}${sets.map((x) => `, ${x}`).join('')}`,
      vals,
    );
  }
  private async writeDeletedRunRows(q: Q, changes: RunRowChanges): Promise<void> {
    for (const [runId, c] of changes.entries()) {
      const outcome = c.outcomeGone ? 'NULL' : 'outcome';
      // `status` first, for the reason writeRunRow gives (a single-table UPDATE assigns left to right too).
      await q(
        `UPDATE gnl_runs SET status = ${runStatusCaseSql('suspended_count + $4 > 0', outcome)},
           model_steps = model_steps + $2, tool_calls = tool_calls + $3, suspended_count = suspended_count + $4, updated_at = $5`
          + `${c.outcomeGone ? ', outcome = NULL' : ''}${c.inputGone ? ', resource_id = NULL, thread_id = NULL' : ''} WHERE run_id = $1`,
        [runId, c.models, c.tools, c.suspendedDelta, Date.now()],
      );
      if (!(await this.hasRunRecords(q, runId))) await q('DELETE FROM gnl_runs WHERE run_id = $1', [runId]);
    }
  }
  private async hasRunRecords(q: Q, runId: string): Promise<boolean> {
    if ((await q('SELECT 1 AS x FROM gnl_run_journal WHERE run_id = $1 LIMIT 1', [runId])).rows.length) return true;
    const r = await q('SELECT `key`, value FROM gnl_run_journal WHERE `key` IN ($1, $2)', [runRecordKey(runId, 'input'), runRecordKey(runId, 'outcome')]);
    return r.rows.some((x: { key: string; value: string }) => runRecordOf(x.key, deserialize(x.value))?.runId === runId);
  }

  /** See `Journal.listOwnerRecords`: the placed half and the unplaced half over the owner index, each record decided from its value. */
  async listOwnerRecords(resourceId: string, opts?: { prefix?: string }): Promise<string[]> {
    const a = myRange('`key`', opts?.prefix ?? '', 2);
    const b = myRange('`key`', opts?.prefix ?? '', 2 + a.params.length);
    const r = await this.q(
      `(SELECT \`key\`, value FROM gnl_run_journal WHERE owner = $1 AND \`key\` LIKE '${OWNER_RECORD_LIKE}' AND ${a.where})
       UNION ALL
       (SELECT \`key\`, value FROM gnl_run_journal WHERE owner IS NULL AND \`key\` LIKE '${OWNER_RECORD_LIKE}' AND ${b.where})`,
      [resourceId, ...a.params, ...b.params],
    );
    return r.rows.filter((x: { key: string; value: string }) => ownerOfRecord(deserialize(x.value)) === resourceId).map((x: { key: string }) => x.key);
  }
  /** Nothing to verify: no writer of this store leaves a placement its record does not support (see the head of the file). */
  async requestRelationsVerify(): Promise<void> { /* see above */ }
  /** Runs or owner records the `relations` step can place: only rows a write left unplaced (an unreadable `:input`). */
  async relationsPending(): Promise<boolean> {
    if ((await this.q(`SELECT 1 AS x FROM gnl_runs r JOIN gnl_run_journal j ON j.\`key\` = CONCAT(r.run_id, '${INPUT_SUFFIX}') WHERE r.resource_id IS NULL LIMIT 1`)).rows.length) return true;
    for (let after = '';;) {
      const rows = await this.unplacedOwners(after);
      if (rows.some((x) => ownerColumnOf(x.key, deserialize(x.value)) !== null)) return true;
      if (rows.length < PLACE_PAGE) return false;
      after = rows[rows.length - 1]!.key;
    }
  }
  private async unplacedOwners(after: string): Promise<Array<{ key: string; value: string }>> {
    return (await this.q(`SELECT \`key\`, value FROM gnl_run_journal WHERE owner IS NULL AND \`key\` LIKE '${OWNER_RECORD_LIKE}' AND \`key\` > $1 ORDER BY \`key\` LIMIT $2`, [after, PLACE_PAGE])).rows as Array<{ key: string; value: string }>;
  }
  /** The `relations` step (see PgRunJournal.placeRelations): a page at a time, each read under share locks and placed in one statement. */
  async placeRelations(): Promise<{ runs: number; owners: number; analyzed: boolean }> {
    let runs = 0;
    let owners = 0;
    for (let after = { at: Number.MIN_SAFE_INTEGER, runId: '' };;) {
      const page = (await this.q(
        `SELECT r.run_id, r.created_at FROM gnl_runs r JOIN gnl_run_journal j ON j.\`key\` = CONCAT(r.run_id, '${INPUT_SUFFIX}')
         WHERE r.resource_id IS NULL AND (r.created_at, r.run_id) > ($1, $2) ORDER BY r.created_at, r.run_id LIMIT $3`,
        [after.at, after.runId, PLACE_PAGE],
      )).rows as Array<{ run_id: string; created_at: number }>;
      if (page.length) {
        runs += await this.writeTx(async (q) => {
          const keys = page.map((x) => `${x.run_id}${INPUT_SUFFIX}`);
          const read = (await q(`SELECT \`key\`, value FROM gnl_run_journal WHERE \`key\` IN (${keys.map((_, i) => `$${i + 1}`).join(', ')}) LOCK IN SHARE MODE`, keys)).rows as Array<{ key: string; value: string }>;
          let n = 0;
          for (const x of read) {
            const rel = relationsOfInput(deserialize(x.value));
            n += (await q('UPDATE gnl_runs SET resource_id = $1, thread_id = $2 WHERE run_id = $3 AND resource_id IS NULL', [rel.resourceId, rel.threadId, x.key.slice(0, -INPUT_SUFFIX.length)])).rowCount;
          }
          return n;
        });
      }
      if (page.length < PLACE_PAGE) break;
      const last = page[page.length - 1]!;
      after = { at: Number(last.created_at), runId: last.run_id };
    }
    for (let after = '';;) {
      const { got, last, placed } = await this.writeTx(async (q) => {
        const rows = (await q(`SELECT \`key\`, value FROM gnl_run_journal WHERE owner IS NULL AND \`key\` LIKE '${OWNER_RECORD_LIKE}' AND \`key\` > $1 ORDER BY \`key\` LIMIT $2 LOCK IN SHARE MODE`, [after, PLACE_PAGE])).rows as Array<{ key: string; value: string }>;
        let n = 0;
        for (const x of rows) {
          const o = ownerColumnOf(x.key, deserialize(x.value));
          if (o !== null) n += (await q('UPDATE gnl_run_journal SET owner = $1 WHERE `key` = $2 AND owner IS NULL', [o, x.key])).rowCount;
        }
        return { got: rows.length, last: rows[rows.length - 1]?.key, placed: n };
      });
      owners += placed;
      if (got < PLACE_PAGE || last === undefined) break;
      after = last;
    }
    const analyzed = runs + owners === 0 ? false
      : await this.q('ANALYZE TABLE gnl_runs').then(() => this.q('ANALYZE TABLE gnl_run_journal')).then(() => true, () => false);
    return { runs, owners, analyzed };
  }

  async readRange<T = unknown>(prefix: string, opts: { after?: string; limit: number; desc?: boolean }): Promise<Array<[string, T]>> {
    const rg = myRange('`key`', prefix, 1);
    const params: unknown[] = [...rg.params];
    let after = '';
    if (opts.after !== undefined) { params.push(opts.after); after = ` AND \`key\` ${opts.desc ? '<' : '>'} $${params.length}`; }
    params.push(opts.limit);
    const r = await this.q(`SELECT \`key\`, value FROM gnl_run_journal WHERE ${rg.where}${after} ORDER BY \`key\` ${opts.desc ? 'DESC' : 'ASC'} LIMIT $${params.length}`, params);
    return r.rows.map((row: any) => [row.key as string, deserialize<T>(row.value)]);
  }
  async listKeys(prefix: string, opts?: { limit?: number }): Promise<string[]> {
    const rg = myRange('`key`', prefix, 1);
    if (opts?.limit !== undefined) {
      const p = await this.q(`SELECT \`key\` FROM gnl_run_journal WHERE ${rg.where} LIMIT $${rg.params.length + 1}`, [...rg.params, opts.limit]);
      return p.rows.map((x) => x.key);
    }
    const r = await this.q(`SELECT \`key\` FROM gnl_run_journal WHERE ${rg.where} ORDER BY created_at, \`key\``, rg.params);
    return r.rows.map((x) => x.key);
  }
  /**
   * Retention/GDPR: every key under the prefix, and the derived runs kept true (see PgRunJournal.deletePrefix).
   * The cut-into runs' records are read under their locks, then deleted, then the rest of the range.
   */
  async deletePrefix(prefix: string): Promise<number> {
    const cut = runsCutBy(prefix);
    const jr = myRange('`key`', prefix, 1);
    const ownedParams = [...cut, ...cut.flatMap((id) => [runRecordKey(id, 'input'), runRecordKey(id, 'outcome')])];
    const rest = async (q: Q, notOwned = ''): Promise<number> => {
      const r = await q(`DELETE FROM gnl_run_journal WHERE ${jr.where}${notOwned}`, [...jr.params, ...(notOwned ? ownedParams : [])]);
      const rid = prefix.endsWith(':') ? prefix.slice(0, -1) : prefix;
      const rr = myRange('run_id', prefix, 2);
      await q(`DELETE FROM gnl_runs WHERE run_id = $1 OR (${rr.where})`, [rid, ...rr.params]);
      await q(`DELETE FROM gnl_counters WHERE ${jr.where}`, jr.params);
      return r.rowCount;
    };
    if (!cut.length) return rest(this.q);
    const at = jr.params.length;
    const idParams = cut.map((_, i) => `$${at + i + 1}`);
    const keyParams = cut.flatMap((_, i) => [`$${at + cut.length + 2 * i + 1}`, `$${at + cut.length + 2 * i + 2}`]);
    const owned = `(run_id IN (${idParams.join(', ')}) OR \`key\` IN (${keyParams.join(', ')}))`;
    const notOwned = ` AND (run_id IS NULL OR (${idParams.map((x) => `run_id <> ${x}`).join(' AND ')})) AND ${keyParams.map((x) => `\`key\` <> ${x}`).join(' AND ')}`;
    return this.writeTx(async (q) => {
      const own = (await q(`SELECT \`key\`, run_id, suspended FROM gnl_run_journal WHERE ${jr.where} AND ${owned} ORDER BY \`key\` FOR UPDATE`, [...jr.params, ...ownedParams])).rows as Array<{ key: string; run_id: string | null; suspended: number }>;
      if (own.length) await q(`DELETE FROM gnl_run_journal WHERE \`key\` IN (${own.map((_, i) => `$${i + 1}`).join(', ')})`, own.map((x) => x.key));
      const deleted = await rest(q, notOwned);
      const changes = new RunRowChanges();
      for (const row of own) {
        const owner = cut.find((id) => row.run_id === id || row.key === runRecordKey(id, 'input') || row.key === runRecordKey(id, 'outcome'));
        if (owner !== undefined) changes.noteDelete(owner, row.key, !!row.suspended);
      }
      await this.writeDeletedRunRows(q, changes);
      return own.length + deleted;
    });
  }
  async readRun(runId: string): Promise<JournalEntry[]> {
    const r = await this.q('SELECT `key`, kind, value, created_at FROM gnl_run_journal WHERE run_id = $1 ORDER BY ord, created_at, `key`', [runId]);
    return r.rows.map((x, seq) => ({ key: x.key, runId, kind: x.kind as JournalEntry['kind'], value: deserialize(x.value), seq, ts: Number(x.created_at) }));
  }
  /** The run list (see PgRunJournal.listRuns): a keyset page of `gnl_runs`, its `:input` joined in one statement. */
  async listRuns(q?: ListQuery): Promise<Page<RunSummary>> {
    const statusCond = runStatusSql(q);
    const atOf = async (runId: string) => {
      const r = await this.q('SELECT created_at FROM gnl_runs WHERE run_id = $1', [runId]);
      return r.rows[0] ? Number(r.rows[0].created_at) : undefined;
    };
    const runCols = 'r.run_id, r.created_at, r.model_steps, r.tool_calls, r.status';
    return keysetRunPage(q, statusCond, atOf, async (where, params, dir, take, skip, rel?: RunRelationRead) => {
      const n = params.length;
      const r = rel
        ? await this.q(
          `SELECT u.*, j.value AS input_val
           FROM ((SELECT ${runCols} FROM gnl_runs r${and(where, `r.${rel.column} = $${n + 1}`)} ${rangeOrder(rel.column, dir)} LIMIT $${n + 2})
                 UNION ALL
                 (SELECT ${runCols} FROM gnl_runs r${and(where, 'r.resource_id IS NULL')} ${rangeOrder('resource_id', dir)} LIMIT $${n + 2})) u
           ${INPUT_JOIN('u')}
           ORDER BY u.created_at ${dir}, u.run_id ${dir} LIMIT $${n + 3} OFFSET $${n + 4}`,
          [...params, rel.value, take + skip, take, skip],
        )
        : await this.q(
          `SELECT ${runCols}, j.value AS input_val FROM gnl_runs r ${INPUT_JOIN('r')}${where}
           ORDER BY r.created_at ${dir}, r.run_id ${dir} LIMIT $${n + 1} OFFSET $${n + 2}`,
          [...params, take, skip],
        );
      return r.rows.map((x: any) => ({ summary: myRunSummary(x), at: Number(x.created_at) }));
    }, (n) => `$${n}`, true, (prefix, from) => myRange('r.run_id', prefix, from));
  }
  /** Atomic batch — claim + counters + puts in one transaction, rows taken in the one lock order (see PgRunJournal.applyBatch). */
  async applyBatch(batch: JournalBatch): Promise<boolean> {
    const writes = [
      ...(batch.claim ? [{ ...batch.claim, claim: true }] : []),
      ...(batch.puts ?? []).map((w) => ({ ...w, claim: false })),
    ].sort((a, b) => compareKeys(a.key, b.key));
    const inputOf = (key: string) => (key.endsWith(INPUT_SUFFIX) && !parseJournalKey(key) ? key.slice(0, -INPUT_SUFFIX.length) : undefined);
    const inputs = new Map<string, typeof writes>();
    for (const w of writes) {
      const id = inputOf(w.key);
      if (id !== undefined) inputs.set(id, [...(inputs.get(id) ?? []), w]);
    }
    return this.writeTx(async (q) => {
      const runs = new RunRowChanges();
      const write = async ({ key, value, claim }: (typeof writes)[number]) => {
        const p = parseJournalKey(key);
        const suspended = p?.kind === 'tool' && (value as ToolJournalRecord | undefined)?.status === 'suspended';
        if (!claim) {
          runs.noteWrite(key, value, await this.writeRecord(q, key, value, p, suspended));
          await this.unplaceUnreadInput(q, key, value);
          return;
        }
        if (!(await insertNew(q, JOURNAL_INSERT, journalRow(key, value, p, suspended)))) throw CLAIM_LOST;
        runs.noteWrite(key, value, undefined);
        await this.unplaceUnreadInput(q, key, value);
      };
      for (const w of writes) if (inputOf(w.key) === undefined) await write(w);
      for (const id of [...new Set([...runs.entries().map(([runId]) => runId), ...inputs.keys()])].sort(compareKeys)) {
        for (const w of inputs.get(id) ?? []) await write(w);
        const c = runs.get(id);
        if (c) await this.writeRunRow(q, id, c);
      }
      const flat = flattenIncrs(batch.incrs ?? []);
      if (flat.length) await q(incrSql(flat.length / 3), flat);
      return true;
    }).catch((e: unknown) => { if (e === CLAIM_LOST) return false; throw e; });
  }
  async getMany<T = unknown>(keys: string[]): Promise<(T | undefined)[]> {
    if (keys.length === 0) return [];
    const r = await this.q(`SELECT \`key\`, value FROM gnl_run_journal WHERE \`key\` IN (${keys.map((_, i) => `$${i + 1}`).join(',')})`, keys);
    const byKey = new Map(r.rows.map((row: any) => [row.key as string, row.value as string]));
    return keys.map((k) => (byKey.has(k) ? deserialize<T>(byKey.get(k)!) : undefined));
  }
  async countRuns(q?: { runIdPrefix?: string }): Promise<number> {
    const rg = q?.runIdPrefix ? myRange('run_id', q.runIdPrefix, 1) : undefined;
    const r = await this.q(`SELECT COUNT(*) AS n FROM gnl_runs${rg ? ` WHERE ${rg.where}` : ''}`, rg?.params ?? []);
    return Number(r.rows[0]?.n ?? 0);
  }
  async listRunsChangedSince(cursor?: string, opts?: { limit?: number; since?: number; runIdPrefix?: string }): Promise<{ items: RunChange[]; nextCursor?: string }> {
    const pos = decodeChangeCursor(cursor);
    const limit = opts?.limit ?? 200;
    const conds: string[] = [];
    const params: unknown[] = [];
    if (pos) { conds.push('(r.updated_at, r.run_id) > ($1, $2)'); params.push(pos.at, pos.runId); }
    else if (opts?.since !== undefined) { conds.push('r.updated_at >= $1'); params.push(opts.since); }
    if (opts?.runIdPrefix) {
      const rg = myRange('r.run_id', opts.runIdPrefix, params.length + 1);
      conds.push(rg.where);
      params.push(...rg.params);
    }
    const r = await this.q(
      `SELECT r.run_id, r.created_at, r.updated_at, r.model_steps, r.tool_calls, r.status, j.value AS input_val
       FROM gnl_runs r ${INPUT_JOIN('r')}${conds.length ? ` WHERE ${conds.join(' AND ')}` : ''}
       ORDER BY r.updated_at, r.run_id LIMIT $${params.length + 1}`,
      [...params, limit],
    );
    const items: RunChange[] = r.rows.map((x: any) => ({ ...myRunSummary(x), updatedAt: Number(x.updated_at) }));
    const last = items[items.length - 1];
    return { items, ...(last ? { nextCursor: encodeChangeCursor({ at: last.updatedAt, runId: last.runId }) } : {}) };
  }
  async countRunsByStatus(): Promise<Record<string, number>> {
    const r = await this.q('SELECT status, COUNT(*) AS n FROM gnl_runs GROUP BY status');
    const out: Record<string, number> = {};
    for (const row of r.rows) out[row.status] = (out[row.status] ?? 0) + Number(row.n);
    return out;
  }
}

// ── memory ─────────────────────────────────────────────────────────────────────────────────────────

/**
 * A thread's append lock: a named lock (the Postgres store's `pg_advisory_xact_lock(ns, hash)`), waited
 * for 5 s — bounded below run.ts's 60 s append marker for the reason PgMemoryStore.appendMessages gives.
 */
const THREAD_LOCK_WAIT_S = 5;
function lockWaitAdvice(e: unknown, threadId: string, rows: number): unknown {
  if ((e as { code?: string })?.code !== 'LOCK_TIMEOUT') return e;
  const err = new Error(
    `@gnldev/durable: appending ${rows} message(s) to thread '${threadId}' timed out waiting for that thread's append lock — another writer is holding it. `
    + 'The usual cause is a large explicit-seq write on the same thread (a transcript import, or cloneThread): the lock is held for the whole batch. '
    + 'Nothing was written, so the run can retry. Import large transcripts into a thread that is not taking live turns, or split them into smaller batches.',
    { cause: e },
  );
  (err as { code?: string }).code = 'LOCK_TIMEOUT';
  return err;
}

class MyMemoryStore implements MemoryStore {
  constructor(private q: Q, private tx: Tx, private settled: Settled) {}
  private async lock(threadId: string): Promise<TxOptions> {
    const { db } = await this.settled();
    return { lock: { name: lockName('t', db, threadId), timeoutS: THREAD_LOCK_WAIT_S, what: `thread '${threadId}'` } };
  }
  async upsertThread(rec: ThreadRecord): Promise<void> {
    await this.q(
      `INSERT INTO gnl_threads (id, resource_id, title, parent_thread_id, metadata, created_at, updated_at, deleted_at) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
       ON DUPLICATE KEY UPDATE resource_id = VALUES(resource_id), title = VALUES(title), parent_thread_id = VALUES(parent_thread_id), metadata = VALUES(metadata), updated_at = VALUES(updated_at), deleted_at = VALUES(deleted_at)`,
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
  /** One transaction under the thread's lock — the lock every append takes (see PgMemoryStore.deleteThread). */
  async deleteThread(id: string): Promise<void> {
    await this.tx(async (q) => {
      await q('DELETE FROM gnl_threads WHERE id = $1', [id]);
      await q('DELETE FROM gnl_messages WHERE thread_id = $1', [id]);
      await q('DELETE FROM gnl_working_memory WHERE scope_id = $1', [workingMemoryScope.thread(id)]);
      const legacy = legacyWorkingMemoryScope.thread(id);
      if (legacy !== undefined) await q('DELETE FROM gnl_working_memory WHERE scope_id = $1', [legacy]);
      await q('DELETE FROM gnl_observations WHERE thread_id = $1', [id]);
      await q('DELETE FROM gnl_message_batches WHERE thread_id = $1', [id]);
    }, await this.lock(id));
  }
  /** One transaction under the thread's lock: the batch's marker claimed first, then its rows (see PgMemoryStore.appendMessagesOnce). */
  async appendMessagesOnce(threadId: string, rows: MessageAppend[], batchKey: string): Promise<boolean> {
    const assign = assertUniformSeq(threadId, rows);
    return this.tx(async (q) => {
      const claimed = await insertNew(q, 'INSERT INTO gnl_message_batches (thread_id, batch_key, seq_from, seq_to, ts) VALUES ($1,$2,0,0,$3)', [threadId, batchKey, Date.now()]);
      if (!claimed) return false;
      let next = 0;
      if (assign) next = Number((await q('SELECT COALESCE(MAX(seq), -1) + 1 AS n FROM gnl_messages WHERE thread_id = $1', [threadId])).rows[0].n);
      const from = next;
      for (const r of rows) await this.insertMessage(q, threadId, r, r.seq ?? next++);
      await q('UPDATE gnl_message_batches SET seq_from = $1, seq_to = $2 WHERE thread_id = $3 AND batch_key = $4', [from, next, threadId, batchKey]);
      return true;
    }, await this.lock(threadId)).catch((e: unknown) => { throw lockWaitAdvice(e, threadId, rows.length); });
  }
  /** One transaction under the thread's lock, for every append, explicit positions too (see PgMemoryStore.appendMessages). */
  async appendMessages(threadId: string, rows: MessageAppend[]): Promise<void> {
    if (rows.length === 0) return;
    const assign = assertUniformSeq(threadId, rows);
    await this.tx(async (q) => {
      let next = 0;
      if (assign) next = Number((await q('SELECT COALESCE(MAX(seq), -1) + 1 AS n FROM gnl_messages WHERE thread_id = $1', [threadId])).rows[0].n);
      for (const r of rows) await this.insertMessage(q, threadId, r, r.seq ?? next++);
    }, await this.lock(threadId)).catch((e: unknown) => { throw lockWaitAdvice(e, threadId, rows.length); });
  }
  /**
   * One message row. A caller-supplied position that is already written is the documented idempotent
   * case (Postgres: ON CONFLICT DO NOTHING); a position this store just assigned under the lock never
   * conflicts unless something is wrong, and then the error is raised, never swallowed.
   */
  private async insertMessage(q: Q, threadId: string, r: MessageAppend, seq: number): Promise<void> {
    const sql = 'INSERT INTO gnl_messages (thread_id, seq, role, text, embedding, metadata, ts, message) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)';
    const params = [threadId, seq, r.role, r.text ?? null, r.embedding ? JSON.stringify(r.embedding) : null, r.metadata ? serialize(r.metadata) : null, r.ts, serialize(r.message)];
    if (r.seq === undefined) await q(sql, params);
    else await insertNew(q, sql, params);
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
  async deleteMessagesAfter(threadId: string, afterSeq: number): Promise<number> {
    const r = await this.q('DELETE FROM gnl_messages WHERE thread_id = $1 AND seq > $2', [threadId, afterSeq]);
    await this.q('DELETE FROM gnl_message_batches WHERE thread_id = $1 AND seq_to > $2', [threadId, afterSeq]);
    return r.rowCount;
  }
  /** See `MemoryStore.retractBatch`: the batch's rows and its record, one transaction under the thread's lock. */
  async retractBatch(threadId: string, batchKey: string): Promise<number> {
    return this.tx(async (q) => {
      const b = (await q('SELECT seq_from, seq_to FROM gnl_message_batches WHERE thread_id = $1 AND batch_key = $2 FOR UPDATE', [threadId, batchKey])).rows[0];
      if (!b) return 0;
      await q('DELETE FROM gnl_message_batches WHERE thread_id = $1 AND batch_key = $2', [threadId, batchKey]);
      return (await q('DELETE FROM gnl_messages WHERE thread_id = $1 AND seq >= $2 AND seq < $3', [threadId, Number(b.seq_from), Number(b.seq_to)])).rowCount;
    }, await this.lock(threadId));
  }
  async deletePartition(partition: string): Promise<number> {
    assertOrganizationPartition(partition);
    return this.tx(async (q) => {
      let n = 0;
      for (const [table, column, store, counted] of SCOPE_TABLES) {
        if (store !== 'memory' || !counted) continue;
        let k = 0;
        const c = prefixSql(col(column), partition, () => `$${++k}`);
        n += (await q(`DELETE FROM ${table} WHERE ${c.cond}`, c.params)).rowCount;
      }
      return n;
    });
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
    for (const h of hits) picked.set(`${h.tid}:${h.m.seq}`, { ...h.m, score: h.score });
    return [...picked.values()].sort((a, b) => a.ts - b.ts || a.seq - b.seq);
  }
  async getWorkingMemory(scopeId: string): Promise<unknown> {
    const r = await this.q('SELECT data FROM gnl_working_memory WHERE scope_id = $1', [scopeId]);
    return r.rows[0] ? deserialize(r.rows[0].data) : undefined;
  }
  async setWorkingMemory(scopeId: string, data: unknown): Promise<void> {
    await this.q('INSERT INTO gnl_working_memory (scope_id, data, updated_at) VALUES ($1,$2,$3) ON DUPLICATE KEY UPDATE data = VALUES(data), updated_at = VALUES(updated_at)', [scopeId, serialize(data), Date.now()]);
  }
  async deleteWorkingMemory(scopeId: string): Promise<boolean> {
    return (await this.q('DELETE FROM gnl_working_memory WHERE scope_id = $1', [scopeId])).rowCount > 0;
  }
  async getObservations(threadId: string): Promise<Observation[]> {
    const r = await this.q('SELECT obs FROM gnl_observations WHERE thread_id = $1', [threadId]);
    return r.rows[0] ? deserialize<Observation[]>(r.rows[0].obs) : [];
  }
  async putObservations(threadId: string, obs: Observation[]): Promise<void> {
    await this.q('INSERT INTO gnl_observations (thread_id, obs) VALUES ($1,$2) ON DUPLICATE KEY UPDATE obs = VALUES(obs)', [threadId, serialize(obs)]);
  }
}

// ── vectors ────────────────────────────────────────────────────────────────────────────────────────

class MyVectorStore implements VectorStore {
  readonly rootOutsideOrganizations = true;
  constructor(private q: Q, private tx: Tx) {}
  /** The length of the vectors held (`assertVectorDimension`), from any one row; `undefined` when there are none. */
  private async dimension(q: Q): Promise<number | undefined> {
    const row = (await q('SELECT embedding FROM gnl_vectors LIMIT 1')).rows[0] as { embedding: string } | undefined;
    return row ? (JSON.parse(row.embedding) as number[]).length : undefined;
  }
  /** One transaction; neither statement can overwrite another owner's document (see PgVectorStore.upsert). */
  async upsert(items: VectorItem[]): Promise<void> {
    const batch = vectorWriteBatch(items);
    await this.tx(async (q) => {
      if (batch[0]) assertVectorDimension(await this.dimension(q), batch[0].embedding.length, 'write');
      const probe = async (id: string) => {
        const row = (await q('SELECT namespace, owner, shared FROM gnl_vectors WHERE id = $1', [id])).rows[0] as { namespace: string | null; owner: string | null; shared: number | null } | undefined;
        return row ? { namespace: row.namespace, owner: row.owner, shared: row.shared == null ? null : !!row.shared } : undefined;
      };
      for (const it of batch) assertSameVectorOwner(await probe(it.id), it);
      for (const it of batch) {
        const labels = [it.namespace ?? null, it.owner ?? null, it.shared ? 1 : null];
        const updated = await q(
          `UPDATE gnl_vectors SET text = $2, embedding = $3, metadata = $4, doc = $8 WHERE id = $1 AND COALESCE(namespace, '') = COALESCE($5, '') AND COALESCE(owner, '') = COALESCE($6, '') AND COALESCE(shared, 0) = COALESCE($7, 0)`,
          [it.id, it.text, JSON.stringify(it.embedding), it.metadata ? serialize(it.metadata) : null, ...labels, vectorDocumentOf(it.metadata) ?? ''],
        );
        if (updated.rowCount > 0) continue;
        const inserted = await insertNew(q,
          'INSERT INTO gnl_vectors (id, text, embedding, metadata, namespace, owner, shared, created_at, doc) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)',
          [it.id, it.text, JSON.stringify(it.embedding), it.metadata ? serialize(it.metadata) : null, ...labels, Date.now(), vectorDocumentOf(it.metadata) ?? '']);
        if (!inserted) assertSameVectorOwner((await probe(it.id)) ?? { namespace: '\u0000' }, it);
      }
    });
  }
  async delete(where: VectorDeleteWhere): Promise<number> {
    const w = vectorDeletePlan(where);
    if (!w) return 0;
    const conds: string[] = [];
    const params: unknown[] = [];
    const idIn = (ids: string[], at: number) => `id IN (${ids.map((_, i) => `$${at + i + 1}`).join(',')})`;
    if (w.ids) { conds.push(idIn(w.ids, params.length)); params.push(...w.ids); }
    if (w.owner !== undefined) { params.push(w.owner); conds.push(`owner = $${params.length}`); }
    if (w.namespace !== undefined) { params.push(w.namespace); conds.push(`namespace = $${params.length}`); }
    if (w.outsideOrganizations) conds.push(VECTOR_OUTSIDE_ORGANIZATIONS_SQL);
    if (!w.filter) return (await this.q(`DELETE FROM gnl_vectors WHERE ${conds.join(' AND ')}`, params)).rowCount;
    const filter = w.filter;
    const doc = vectorFilterDocument(filter);
    if (doc !== undefined) { params.push(doc); conds.push(`(doc = $${params.length} OR doc IS NULL)`); }
    return this.tx(async (q) => {
      const rows = (await q(`SELECT id, metadata FROM gnl_vectors${conds.length ? ` WHERE ${conds.join(' AND ')}` : ''} FOR UPDATE`, params)).rows as { id: string; metadata: string | null }[];
      const ids = rows.filter((r) => vectorMetadataMatches(r.metadata ? deserialize<Record<string, unknown>>(r.metadata) : undefined, filter)).map((r) => r.id);
      return ids.length ? (await q(`DELETE FROM gnl_vectors WHERE ${idIn(ids, 0)}`, ids)).rowCount : 0;
    });
  }
  async query(embedding: number[], topK: number, opts?: VectorQueryOptions): Promise<VectorMatch[]> {
    const scope = vectorQueryScope(opts);
    assertVectorDimension(await this.dimension(this.q), embedding.length, 'query');
    if (scope.none) return [];
    const where: string[] = [];
    const params: unknown[] = [];
    if (scope.namespace !== undefined) { params.push(scope.namespace); where.push(`namespace = $${params.length}`); }
    if (scope.outsideOrganizations) where.push(VECTOR_OUTSIDE_ORGANIZATIONS_SQL);
    if (scope.visibleTo !== undefined) { params.push(scope.visibleTo); where.push(`(shared = 1 OR owner = $${params.length})`); }
    const doc = vectorFilterDocument(opts?.filter);
    if (doc !== undefined) { params.push(doc); where.push(`(doc = $${params.length} OR doc IS NULL)`); }
    const r = await this.q(`SELECT id, text, embedding, metadata, namespace, owner, shared FROM gnl_vectors${where.length ? ` WHERE ${where.join(' AND ')}` : ''}`, params);
    return rankVectorMatches(r.rows
      .map((x) => ({ id: x.id, text: x.text, metadata: x.metadata ? deserialize<Record<string, unknown>>(x.metadata) : undefined, ...(x.namespace != null ? { namespace: x.namespace as string } : {}), ...(x.owner != null ? { owner: x.owner as string } : {}), ...(x.shared ? { shared: true } : {}), score: cosineSimilarity(embedding, JSON.parse(x.embedding)) }))
      .filter((m) => vectorMetadataMatches(m.metadata, opts?.filter)), topK); // filtered before ranking
  }
}

// ── work ───────────────────────────────────────────────────────────────────────────────────────────

class MyWorkStore implements WorkStore {
  constructor(private q: Q, private tx: Tx) {}
  /** Written UNNUMBERED (`seq` 0) and numbered by the first `list` that sees it (see PgWorkStore.append). */
  async append(ns: string, payload: unknown, id?: string): Promise<string> {
    const eid = id ?? `${ns}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`;
    await insertNew(this.q, 'INSERT INTO gnl_work_log (ns, id, payload, ts) VALUES ($1,$2,$3,$4)', [ns, eid, serialize(payload), Date.now()]);
    return eid;
  }
  /**
   * Numbers the namespace's committed unnumbered records after every number handed out so far (see
   * PgWorkStore.numberNew): the namespace's counter row is taken first and held to the commit, so two
   * numberings commit in the order of their numbers; the rows are read under that lock at READ COMMITTED
   * (a record whose INSERT has not committed is numbered by a later call, with a larger number), and each
   * is numbered only while still unnumbered.
   */
  private async numberNew(ns: string, max: number): Promise<void> {
    const pending = (await this.q('SELECT id FROM gnl_work_log WHERE ns = $1 AND seq = 0 LIMIT 1', [ns])).rows;
    if (!pending.length) return;
    await this.tx(async (q) => {
      await q('INSERT INTO gnl_work_seq (ns, seq) VALUES ($1, 0) ON DUPLICATE KEY UPDATE seq = seq', [ns]);
      await q('SELECT seq FROM gnl_work_seq WHERE ns = $1 FOR UPDATE', [ns]);
      const ids = ((await q('SELECT id FROM gnl_work_log WHERE ns = $1 AND seq = 0 ORDER BY ord, ts, id LIMIT $2', [ns, max])).rows as { id: string }[]).map((r) => r.id);
      if (!ids.length) return;
      await q('UPDATE gnl_work_seq SET seq = seq + $2 WHERE ns = $1', [ns, ids.length]);
      const top = Number(((await q('SELECT seq FROM gnl_work_seq WHERE ns = $1', [ns])).rows[0] as { seq: number }).seq);
      const params: unknown[] = [ns];
      const cases = ids.map((id, i) => { params.push(id, top - ids.length + 1 + i); return `WHEN $${params.length - 1} THEN $${params.length}`; });
      const at = params.length;
      params.push(...ids);
      await q(`UPDATE gnl_work_log SET seq = CASE id ${cases.join(' ')} END WHERE ns = $1 AND seq = 0 AND id IN (${ids.map((_, i) => `$${at + i + 1}`).join(', ')})`, params);
    });
  }
  async list<T = unknown>(ns: string, q?: ListQuery): Promise<Page<LogRecord<T>>> {
    const limit = q?.limit ?? 50;
    await this.numberNew(ns, Math.max(NUMBER_BATCH, limit + 1));
    const after = decodeLogCursor(q?.cursor);
    const r = after
      ? await this.q('SELECT id, payload, ts, seq FROM gnl_work_log WHERE ns = $1 AND seq > 0 AND (seq, ts, id) > ($2, $3, $4) ORDER BY seq, ts, id LIMIT $5', [ns, after.seq, after.ts, after.id, limit + 1])
      : await this.q('SELECT id, payload, ts, seq FROM gnl_work_log WHERE ns = $1 AND seq > 0 ORDER BY seq, ts, id LIMIT $2', [ns, limit + 1]);
    const rows = r.rows.map((x) => ({ id: x.id as string, payload: x.payload as string, ts: Number(x.ts), seq: Number(x.seq) }));
    const more = rows.length > limit;
    if (more) rows.pop();
    const last = rows[rows.length - 1];
    return { items: rows.map((x) => ({ id: x.id, payload: deserialize<T>(x.payload), ts: x.ts })), nextCursor: more && last ? encodeLogCursor(last) : undefined };
  }
  async get<T = unknown>(key: string): Promise<T | undefined> {
    const r = await this.q('SELECT value FROM gnl_work_kv WHERE `key` = $1', [key]);
    return r.rows[0] ? deserialize<T>(r.rows[0].value) : undefined;
  }
  async put(key: string, value: unknown): Promise<void> {
    await this.q('INSERT INTO gnl_work_kv (`key`, value) VALUES ($1,$2) ON DUPLICATE KEY UPDATE value = VALUES(value)', [key, serialize(value)]);
  }
  async ackOnce(key: string): Promise<boolean> {
    return insertNew(this.q, 'INSERT INTO gnl_work_kv (`key`, value) VALUES ($1,$2)', [key, serialize(true)]);
  }
  async putIfMatch(key: string, expected: unknown, value: unknown): Promise<boolean> {
    return (await this.q('UPDATE gnl_work_kv SET value = $1 WHERE `key` = $2 AND value = $3', [serialize(value), key, serialize(expected)])).rowCount === 1;
  }
  async deletePrefix(prefix: string): Promise<number> {
    const lr = myRange('ns', prefix, 1);
    const l = await this.q(`DELETE FROM gnl_work_log WHERE ${lr.where}`, lr.params);
    const kr = myRange('`key`', prefix, 1);
    const k = await this.q(`DELETE FROM gnl_work_kv WHERE ${kr.where}`, kr.params);
    return l.rowCount + k.rowCount;
  }
  async deleteIdPrefix(idPrefix: string): Promise<number> {
    const r = myRange('id', idPrefix, 1);
    return (await this.q(`DELETE FROM gnl_work_log WHERE ${r.where}`, r.params)).rowCount;
  }
}

class MyCacheStore implements CacheStore {
  constructor(private q: Q) {}
  async get<T = unknown>(key: string): Promise<T | undefined> {
    const r = await this.q('SELECT value, expires_at FROM gnl_cache WHERE `key` = $1', [key]);
    const row = r.rows[0];
    if (!row) return undefined;
    if (row.expires_at != null && Number(row.expires_at) <= Date.now()) { await this.q('DELETE FROM gnl_cache WHERE `key` = $1', [key]); return undefined; }
    return deserialize<T>(row.value);
  }
  async set(key: string, value: unknown, opts?: { ttlMs?: number }): Promise<void> {
    const exp = opts?.ttlMs != null ? Date.now() + opts.ttlMs : null;
    await this.q('INSERT INTO gnl_cache (`key`, value, expires_at) VALUES ($1,$2,$3) ON DUPLICATE KEY UPDATE value = VALUES(value), expires_at = VALUES(expires_at)', [key, serialize(value), exp]);
  }
  async delete(key: string): Promise<void> { await this.q('DELETE FROM gnl_cache WHERE `key` = $1', [key]); }
  async deletePrefix(prefix: string): Promise<number> { return deleteWithPrefix(this.q, 'gnl_cache', 'key', prefix); }
}

class MyMetaStore implements MetaStore {
  constructor(private q: Q) {}
  async get(key: string): Promise<string | undefined> {
    const r = await this.q('SELECT v FROM gnl_meta WHERE k = $1', [key]);
    return r.rows[0]?.v;
  }
  async set(key: string, value: string): Promise<void> {
    await this.q('INSERT INTO gnl_meta (k, v) VALUES ($1,$2) ON DUPLICATE KEY UPDATE v = VALUES(v)', [key, value]);
  }
  async deletePrefix(prefix: string): Promise<number> { return deleteWithPrefix(this.q, 'gnl_meta', 'k', prefix); }
}

/** A literal prefix delete (`prefixSql`: characters compared exactly, no LIKE); an empty prefix deletes nothing. */
async function deleteWithPrefix(q: Q, table: string, column: string, prefix: string): Promise<number> {
  if (prefix === '') return 0;
  let k = 0;
  const c = prefixSql(col(column), prefix, () => `$${++k}`);
  return (await q(`DELETE FROM ${table} WHERE ${c.cond}`, c.params)).rowCount;
}

// ── process liveness ───────────────────────────────────────────────────────────────────────────────

export interface MysqlLivenessOptions {
  /** The database URL (the lock is named for this database). */
  connectionString?: string;
  /** Or a `mysql2` connection config (host, port, user, password, database, ssl). */
  connection?: Record<string, unknown>;
  /** A name for this process — the prefix of its liveness id (see `postgresLiveness`). */
  id?: string;
  /** How often this process proves its own lock (and how stale a proof `confirm()` accepts); a proof not answered within one more is a lost session. Default 1 s. */
  heartbeatMs?: number;
  /** How long a holder's lock must be gone before it reads as dead, and a live process has to take it back (see `postgresLiveness`). Default 5 s, at least 4 × `heartbeatMs`. */
  reconnectGraceMs?: number;
}

/** The connection fields a liveness session takes from a pool's config: where to connect, never how many. */
const MY_CONNECTION_FIELDS = new Set(['host', 'port', 'user', 'password', 'database', 'ssl', 'socketPath']);

/**
 * A process lock on a MySQL or MariaDB deployment: a named lock (`GET_LOCK`) held by one dedicated session
 * for the life of the process, as `postgresLiveness` holds an advisory lock. The server keeps it while the
 * session lives — through a freeze (a frozen process's kernel still answers on its socket; the server's
 * idle timeout, `wait_timeout`, 8 h by default, is the bound) — and frees it the moment the session ends
 * (exit, crash: measured ~0.15 s). A PARTITIONED host's session ends only when the server's TCP keepalive
 * gives up: the server host's net.ipv4.tcp_keepalive_* (or MariaDB's tcp_keepalive_* variables) — measured
 * ~25.6 s at 10 / 5 / 3, still held after 120 s at the Linux defaults (over 2 h). Until then that host's
 * runs are held, never run twice. This session's own keepalive (below) does not shorten the server's
 * detection (measured); it lets this process notice a dead server. See `PartitionDetection`.
 */
export async function mysqlLiveness(opts: MysqlLivenessOptions): Promise<ProcessLiveness> {
  refuseUnknownNames('mysqlLiveness', opts, MYSQL_LIVENESS_NAMES);
  const heartbeatMs = opts.heartbeatMs ?? HEARTBEAT_MS;
  if (!(heartbeatMs > 0 && heartbeatMs <= 60_000)) throw new Error(`@gnldev/durable: mysqlLiveness heartbeatMs must be between 1 and 60000 ms; got ${heartbeatMs}`);
  const reconnectGraceMs = reconnectGraceOf('mysqlLiveness', opts.reconnectGraceMs, heartbeatMs);
  if (!opts.connectionString && !opts.connection) throw new Error('@gnldev/durable: mysqlLiveness needs a connectionString or a connection config');
  const fields = opts.connection ? Object.fromEntries(Object.entries(opts.connection).filter(([k]) => MY_CONNECTION_FIELDS.has(k))) : {};
  const config = { ...fields, ...(opts.connectionString ? { uri: opts.connectionString } : {}), ...CONNECTION_DEFAULTS, enableKeepAlive: true, keepAliveInitialDelay: 5_000 };
  let session: { c: MysqlConnection; name: string; db: string } | undefined;
  const open = async (sid: string): Promise<{ c: MysqlConnection; name: string; db: string }> => {
    const c = await driver().createConnection(config);
    c.on?.('error', () => { if (session?.c === c) lost(); });
    c.on?.('end', () => { if (session?.c === c) lost(); });
    try {
      const db = (await run(c, 'SELECT DATABASE() AS db')).rows[0]?.db as string | null;
      if (!db) throw new Error('@gnldev/durable: the MySQL liveness connection names no database');
      const name = lockName('p', db, sid);
      const got = (await run(c, 'SELECT GET_LOCK($1, 0) AS ok', [name])).rows[0]?.ok;
      if (Number(got) !== 1) throw new Error(`@gnldev/durable: the process lock for id '${sid}' is already held by another session — two processes share one liveness id.`);
      return { c, name, db };
    } catch (e) {
      await c.end?.().catch(() => undefined);
      throw e;
    }
  };
  const id = livenessIdOf(opts.id);
  session = await open(id);
  const db = session.db;
  let healthy = true;
  let closed = false;
  let provenAt = performance.now();
  let reopening: Promise<void> | undefined;
  const signals = sessionSignals(reconnectGraceMs);
  /** The session is gone, the process is not: it takes its lock back under the SAME id (see postgresLiveness). */
  function lost(): void {
    healthy = false;
    const was = session;
    session = undefined;
    // Destroyed, not ended: a session lost silently never answers the goodbye `end()` waits for.
    was?.c.destroy?.();
    if (closed || reopening) return;
    reopening = (async () => {
      for (let wait = 50; !closed; wait = Math.min(wait * 2, 1_000)) {
        try {
          const s2 = await open(id);
          if (closed) { await s2.c.end?.().catch(() => undefined); return; }
          session = s2;
          provenAt = performance.now();
          healthy = true;
          signals.proven();
          return;
        } catch {
          await new Promise((r) => setTimeout(r, wait).unref?.());
        }
      }
    })().finally(() => { reopening = undefined; });
  }
  const q = async (sql: string, p?: unknown[]): Promise<QueryResult> => {
    const cur = session;
    if (!healthy || !cur) throw new LivenessUnavailableError();
    try { return await run(cur.c, sql, p); } catch { if (session === cur) lost(); throw new LivenessUnavailableError(); }
  };
  let proving: Promise<boolean> | undefined;
  /** One proof at a time, answered within a heartbeat or the session is lost (`proofWithin`). */
  const holdsOwn = (): Promise<boolean> => proving ??= (async () => {
    const cur = session;
    if (!healthy || !cur) return false;
    const held = await proofWithin((async () => Number((await q('SELECT IS_USED_LOCK($1) = CONNECTION_ID() AS ok', [cur.name])).rows[0]?.ok) === 1)(), heartbeatMs);
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
    async isAlive(other) {
      if (other === id) return healthy;
      return (await q('SELECT IS_USED_LOCK($1) AS c', [lockName('p', db, other)])).rows[0]?.c != null;
    },
    async confirm(maxAgeMs = heartbeatMs) {
      if (!healthy) return false;
      if (performance.now() - provenAt < maxAgeMs) return true;
      return holdsOwn();
    },
    async close() {
      if (closed) return;
      closed = true;
      clearInterval(beat);
      signals.close();
      healthy = false;
      const cur = session;
      session = undefined;
      // Given back before the session ends, so no reader can meet it held by a session on its way out.
      // A session lost silently answers neither, so both together wait a heartbeat at most, then it is destroyed.
      if (cur) {
        const ended = await proofWithin((async () => { await run(cur.c, 'SELECT RELEASE_LOCK($1)', [cur.name]); await cur.c.end?.(); return true; })(), heartbeatMs);
        if (!ended) cur.c.destroy?.();
      }
    },
  };
}
