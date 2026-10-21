// @gnldev/durable/mongo — MongoDB implementation of every store port, for a database several processes
// and hosts share: a REPLICA SET (one node is enough). The same records, the same derived run documents
// and the same guarantees as PostgresStorage; `mongodb` is an optional peer dependency.
//
// What differs from Postgres, and why:
//  - A replica set or nothing. A claimed batch, a run's record with its run document, a thread's append
//    and an erasure that cuts into a run are each one multi-document transaction, and a standalone
//    server refuses every transaction while it takes single writes — a store on one would keep half of
//    each promise. The store and its process liveness ask the server first and refuse a standalone (and a
//    sharded cluster, whose routers do not show one another's connections) before anything is written.
//  - Transactions are snapshot reads with first-writer-wins: a transaction that writes a document another
//    one changed after its snapshot is refused (WriteConflict) and run again whole, from a new snapshot.
//    That stands for Postgres' row locks: a record and the row it replaces, a claim and its loser, a run
//    document two writers move, are each decided by the conflict, never by a read that can be stale.
//    A write that meets a document committed after its snapshot (a duplicate key) runs again the same way.
//  - Named locks have no twin, so a lock is a document every holder writes first in its transaction
//    (`gnl_locks`): a thread's append lock is the write that makes two appenders conflict, and the loser
//    waits by running again — bounded at 5 s, below run.ts's 60 s append marker, as on the SQL stores.
//  - Keys are string `_id`s, compared without a collation: by their UTF-8 bytes, the order a prefix range
//    needs (`prefixUpperBound`). Values are stored serialized, so a compare-and-set is equality on that text.
//  - The first-write order of records (`ord`) comes from one counter document, taken outside the
//    transaction as a Postgres sequence is: a number is never handed out twice, and a rolled-back write
//    leaves a gap.
//  - A process's liveness is a connection named for it (`appName`), held by a dedicated client for the
//    life of the process; another process asks the server whether that connection exists (`$currentOp`).
//    See `mongoLiveness` for what a user must be allowed to see, and for how long a cut-off host's
//    connection outlives it (the server's TCP keepalive).
//  - Vectors are scanned (the community server has no vector index): every query reads its scope's
//    documents and ranks them here. Fine for thousands of documents; use a vector database at scale.
import { requireOptionalPeer } from './optional-peer.js';
import { cosineSimilarity } from 'ai';
import { refuseUnknownNames } from '@gnldev/options';
import { leafSuffix, runRecordKey } from './run-id-grammar.js';
import { closeExecutorFor } from './executors.js';
import { unbindLiveness, livenessIdOf, LivenessUnavailableError, reconnectGraceOf, sessionSignals, proofWithin, HEARTBEAT_MS, type ProcessLiveness } from './process-liveness.js';
import { ROOT_EXEC_RECORDS, isScopeFact, scopeFactKeys, scopeFactsDroppedByAdoption, staysAtRoot, onAdoptionCollision, adoptionConflict } from './adoption.js';
import { prefixUpperBound, ENGINE_META_KEYS, assertOrgRegistered, isPlatformKey, orgPrefix, ORG_KEY_PREFIX } from './organization.js';
import {
  assertUniformSeq, workingMemoryScope, legacyWorkingMemoryScope, assertOrganizationPartition, markWorkOf, memoryPartitionOf,
  NUMBER_BATCH, decodeLogCursor, encodeLogCursor, workKeyAdoption, workKeyAdoptCollision, matchFilter, vectorWriteBatch, assertSameVectorOwner, rankVectorMatches, assertVectorDimension,
  vectorDeletePlan, vectorQueryScope, vectorMetadataMatches, vectorAdoptCollision, vectorDocumentOf, vectorFilterDocument,
  type MemoryPartition, type MemoryPartitionOption,
} from './storage.js';
import type {
  AdoptIntoOrgResult, Storage, CapabilityMatrix, Page, ListQuery, RunJournal, MemoryStore, VectorStore, WorkStore, CacheStore, MetaStore,
  ThreadRecord, MessageRecord, MessageAppend, Observation, RecallOptions, VectorItem, VectorMatch, VectorQueryOptions, VectorDeleteWhere, LogRecord,
} from './storage.js';
import {
  runIdOfKey, parseJournalKey, outcomeStatusOf, runRelationsOf, relationsOfInput, ownerColumnOf, ownerOfRecord, isOwnerRecordKey, RunRowChanges,
  RUN_STATUS_PRECEDENCE, storedOutcomeOf, runRecordOf, runsCutBy, compareKeys,
} from './journal.js';
import type { JournalBatch, JournalEntry, RunChange, RunRowChange, RunStatus, RunSummary, ToolJournalRecord } from './journal.js';
import { decodeRunCursor, encodeRunCursor, matchesRunFilter, OPEN_RUN_STATUSES, decodeChangeCursor, encodeChangeCursor, type RunFilter, type RunOrder } from './run-cursor.js';
import { withBirth } from './run-identity.js';
import { serialize, deserialize } from './serialize.js';
import type { SchemaCheckResult, SchemaMigrationResult } from './migrate.js';
import { MONGO_STORAGE_NAMES, MONGO_LIVENESS_NAMES, ADOPT_INTO_ORG_NAMES, UPGRADE_NAMES } from './option-names.js';
import { runUpgrade, threadRecordsStep, relationsStep, verifyRelationsStep, runStatusStep, type UpgradeOptions, type UpgradeReport, type UpgradeStep } from './upgrade.js';
import { SCOPE_TABLES, adoptedColumns, assertNoRunsInFlight } from './model.js';

// ── the driver, as this file uses it ──────────────────────────────────────────────────────────────

/* eslint-disable @typescript-eslint/no-explicit-any */
type Any = any;
type Session = Any;
type Coll = Any;
type Doc = Record<string, any>;
interface Driver {
  MongoClient: new (url: string, opts?: Record<string, unknown>) => Any;
  Double: new (n: number) => unknown;
}
const driver = (): Driver => requireOptionalPeer<Driver>('mongodb');

/** A database of the `mongodb` driver (`MongoClient.db()`), as far as a companion store needs it. */
export interface MongoDatabase {
  readonly databaseName: string;
  collection(name: string): Any;
  command(command: Record<string, unknown>): Promise<Any>;
}

const DUP_KEY = 11000;
const UNAUTHORIZED = 13;
const NAMESPACE_EXISTS = 48;
const isDup = (e: unknown): boolean => (e as { code?: number } | null)?.code === DUP_KEY;
const codeOf = (e: unknown): number | undefined => (e as { code?: number } | null)?.code;
const hasLabel = (e: unknown, label: string): boolean => typeof (e as Any)?.hasErrorLabel === 'function' && (e as Any).hasErrorLabel(label);

/**
 * The database a connection string names (`mongodb://…/<database>?…`), or `override`. MongoDB defaults an
 * unnamed one to `test`, which is no place to put a deployment's records by accident: one must be named.
 */
function databaseOf(url: string, override: string | undefined, who: string): string {
  if (override !== undefined) {
    if (!override) throw new Error(`@gnldev/durable: ${who} was given an empty database name`);
    return override;
  }
  const m = /^mongodb(?:\+srv)?:\/\/[^/?]*\/([^?]*)/.exec(url);
  const name = m?.[1] ? decodeURIComponent(m[1]) : '';
  if (!name) throw new Error(`@gnldev/durable: ${who} needs a database — name it in the connection string (mongodb://…/<database>?…) or pass \`database\`.`);
  return name;
}

/**
 * The deployment a server says it is in (`hello`): a replica set member is the one kind this store runs
 * on. Asked before the first write — of the store's client and of the liveness client, each its own
 * connection — so a refused deployment holds nothing of ours.
 */
function refuseTopology(hello: Doc, who: string): void {
  if (hello.msg === 'isdbgrid') {
    throw new Error(`@gnldev/durable: ${who} reached a sharded cluster's router (mongos). This store runs on a replica set: `
      + 'its process liveness asks the server for another process\'s connection, and a router does not show the connections other routers hold. Connect to a replica set.');
  }
  if (!hello.setName) {
    throw new Error(`@gnldev/durable: ${who} reached a standalone MongoDB server, and this store needs a replica set (a single node is enough): `
      + 'a claimed batch, a record with its run document, and a thread\'s append are each one multi-document transaction, which a standalone refuses. '
      + 'Start mongod with --replSet <name> and run rs.initiate() once. Nothing was written.');
  }
}

const TRANSIENT = 'TransientTransactionError';
const UNKNOWN_COMMIT = 'UnknownTransactionCommitResult';
/** Thrown by a transaction's body that met a document committed after its snapshot: run it again. */
const RETRY = Symbol('retry');
/** How long a write keeps running again after conflicts before it gives up (the SQL stores' lock waits). */
const TX_BUDGET_MS = 60_000;
const TX_OPTIONS = { readConcern: { level: 'snapshot' }, writeConcern: { w: 'majority' }, readPreference: 'primary' };

type TxOptions = { budgetMs?: number; lock?: string };
type Tx = <T>(fn: (s: Session) => Promise<T>, opts?: TxOptions) => Promise<T>;

/**
 * Runs `fn` in one transaction, again from a new snapshot each time it conflicts (see the head of the
 * file), until it commits or `budgetMs` has passed. A commit whose result is unknown (a network error on
 * the way back) is committed again: the server answers the same commit once. `fn` may run several times,
 * so everything it decides it decides from what it reads inside.
 */
async function transact<T>(client: Any, fn: (s: Session) => Promise<T>, o: TxOptions = {}): Promise<T> {
  const budget = o.budgetMs ?? TX_BUDGET_MS;
  const t0 = performance.now();
  const s = client.startSession();
  const again = (e: unknown) => (e === RETRY || hasLabel(e, TRANSIENT));
  try {
    for (let attempt = 0; ; attempt++) {
      s.startTransaction(TX_OPTIONS);
      let out: T;
      try {
        out = await fn(s);
      } catch (e) {
        await s.abortTransaction().catch(() => undefined);
        if (!again(e)) throw e;
        if (performance.now() - t0 >= budget) throw contended(e, o);
        await pause(attempt);
        continue;
      }
      let rerun = false;
      for (;;) {
        try { await s.commitTransaction(); return out; } catch (e) {
          if (hasLabel(e, UNKNOWN_COMMIT) && performance.now() - t0 < budget) continue;
          if (hasLabel(e, TRANSIENT) && performance.now() - t0 < budget) { rerun = true; break; }
          throw e;
        }
      }
      if (rerun) await pause(attempt);
    }
  } finally { await s.endSession().catch(() => undefined); }
}
const pause = (attempt: number) => new Promise((r) => setTimeout(r, Math.random() * Math.min(50, 1 + attempt * 3)));
/** What a write that kept conflicting past its budget is told. */
function contended(e: unknown, o: TxOptions): unknown {
  if (o.lock !== undefined) {
    const err = new Error(`@gnldev/durable: lock wait timeout on ${o.lock}`, { cause: e === RETRY ? undefined : e });
    (err as { code?: string }).code = 'LOCK_TIMEOUT';
    return err;
  }
  if (e !== RETRY) return e;
  return new Error('@gnldev/durable: a write met documents written again by other writers each time it ran, for 60 s; nothing was written — retry the write.');
}

/** A value as a pipeline update writes it: literally, never read as an expression (`$…` strings). */
const lit = (v: unknown) => ({ $literal: v });
/** `_id`/field within `prefix`'s range; every string for the empty prefix. */
function range(prefix: string): Doc {
  const upper = prefixUpperBound(prefix);
  return upper === undefined ? { $gte: '' } : { $gte: prefix, $lt: upper };
}
/** `field` starts with `prefix`. */
const within = (field: string, prefix: string): Doc => ({ [field]: range(prefix) });
/** `field` is a string that does not start with `prefix` (a null or absent `field` is not matched). */
function outside(field: string, prefix: string): Doc {
  const upper = prefixUpperBound(prefix);
  return upper === undefined ? { [field]: { $in: [] } } : { $or: [{ [field]: { $type: 'string', $lt: prefix } }, { [field]: { $gte: upper } }] };
}
/** Outside the organizations' space: the root's (`orgSpaceSql({ outside: true })`). */
const atRoot = (field: string): Doc => outside(field, ORG_KEY_PREFIX);
const all = (...conds: Doc[]): Doc => {
  const cs = conds.filter((c) => Object.keys(c).length > 0);
  return cs.length === 0 ? {} : cs.length === 1 ? cs[0]! : { $and: cs };
};

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

/** A set of counter increments, merged by (key, field). */
function mergeIncrs(incrs: ReadonlyArray<{ key: string; fields: Record<string, number> }>): Array<{ key: string; field: string; delta: number }> {
  const merged = new Map<string, { key: string; field: string; delta: number }>();
  for (const { key, fields } of incrs) {
    for (const [field, delta] of Object.entries(fields)) {
      const id = `${key}\u0000${field}`;
      const prev = merged.get(id);
      if (prev) prev.delta += delta;
      else merged.set(id, { key, field, delta });
    }
  }
  return [...merged.values()].sort((a, b) => compareKeys(a.key, b.key) || compareKeys(a.field, b.field));
}

/**
 * How long the server takes to end the connection of a host that is cut off — a partition, not a crash —
 * and so free that process's runs: TCP keepalive's time + interval x probes on the SERVER's host, which
 * no client can read. `seconds` is therefore always `null` here: said, never guessed.
 */
export type PartitionDetection = { seconds: number | null; source: 'operating system' };
const KEEPALIVE_SETTING = 'net.ipv4.tcp_keepalive_time=10, net.ipv4.tcp_keepalive_intvl=5, net.ipv4.tcp_keepalive_probes=3';
const KEEPALIVE_UNREADABLE = 'A process cut off from the server (a partition, not a crash) keeps its runs until the server ends its connection, when TCP keepalive gives up. '
  + `The server takes that from its host's operating system, which cannot be read by a client: set ${KEEPALIVE_SETTING} on the server host `
  + '(measured: its runs taken over in 13–14 s). mongod lowers a longer idle time to 300 s on its own connections, so with the Linux defaults '
  + 'a cut-off process holds its runs for about 5.5 minutes (measured: 334 s) — never run twice, but not taken over either. Not verified from here.';

/** Who a process may see (`mongoLiveness`): every user's connections, or only its own user's. */
export type ConnectionVisibility = 'every user' | 'this user';

// ── the schema ─────────────────────────────────────────────────────────────────────────────────────

const SCHEMA_VERSION = '1';
/**
 * The collections, in the SQL stores' shape (one per table; PostgresStorage's DDL notes say why each field
 * exists). Created at boot — a transaction may not create one under a concurrent writer — with the
 * indexes each read needs. `gnl_seq` holds the record-order counters, `gnl_locks` the lock documents,
 * `gnl_liveness_users` the users that opened a process liveness here (see `mongoLiveness`).
 */
const COLLECTIONS = [
  'gnl_meta', 'gnl_run_journal', 'gnl_runs', 'gnl_counters', 'gnl_threads', 'gnl_messages', 'gnl_working_memory', 'gnl_observations',
  'gnl_message_batches', 'gnl_vectors', 'gnl_work_log', 'gnl_work_seq', 'gnl_work_kv', 'gnl_cache', 'gnl_seq', 'gnl_locks',
] as const;
type Name = (typeof COLLECTIONS)[number];
/** Collections a process makes on its own (not at boot), known so `checkSchema` does not list them as foreign. */
const OTHER_COLLECTIONS = ['gnl_liveness_users'];
const INDEXES: ReadonlyArray<{ coll: Name; name: string; key: Doc; unique?: boolean; partialFilterExpression?: Doc }> = [
  // A run's records in first-write order (readRun); only rows of a run carry `run`.
  { coll: 'gnl_run_journal', name: 'gnl_run_journal_run', key: { run: 1, ord: 1 }, partialFilterExpression: { run: { $type: 'string' } } },
  // The owner-record lookup (listOwnerRecords): owner records only, placed and unplaced, by owner then key.
  { coll: 'gnl_run_journal', name: 'gnl_run_journal_owner', key: { owner: 1, _id: 1 }, partialFilterExpression: { orec: true } },
  { coll: 'gnl_runs', name: 'gnl_runs_updated', key: { updated_at: 1, _id: 1 } },
  { coll: 'gnl_runs', name: 'gnl_runs_created', key: { created_at: 1, _id: 1 } },
  { coll: 'gnl_runs', name: 'gnl_runs_status', key: { status: 1, created_at: 1, _id: 1 } },
  { coll: 'gnl_runs', name: 'gnl_runs_resource', key: { resource_id: 1, created_at: 1, _id: 1 } },
  { coll: 'gnl_runs', name: 'gnl_runs_thread', key: { thread_id: 1, created_at: 1, _id: 1 } },
  { coll: 'gnl_counters', name: 'gnl_counters_key', key: { k: 1 } },
  { coll: 'gnl_threads', name: 'gnl_threads_res', key: { resource_id: 1, updated_at: -1 } },
  { coll: 'gnl_messages', name: 'gnl_messages_seq', key: { thread_id: 1, seq: 1 }, unique: true },
  { coll: 'gnl_message_batches', name: 'gnl_message_batches_key', key: { thread_id: 1, batch_key: 1 }, unique: true },
  { coll: 'gnl_vectors', name: 'gnl_vectors_doc', key: { doc: 1 } },
  { coll: 'gnl_vectors', name: 'gnl_vectors_ns', key: { namespace: 1 } },
  { coll: 'gnl_work_log', name: 'gnl_work_log_id', key: { ns: 1, id: 1 }, unique: true },
  { coll: 'gnl_work_log', name: 'gnl_work_log_seq', key: { ns: 1, seq: 1, ts: 1, id: 1 } },
  { coll: 'gnl_work_log', name: 'gnl_work_log_new', key: { ns: 1, seq: 1, ord: 1 } },
  { coll: 'gnl_work_log', name: 'gnl_work_log_ids', key: { id: 1 } },
];

/** The field a SQL table's column is in here — the names `SCOPE_TABLES` and `adoptedColumns` speak. */
const FIELD: Record<string, Record<string, string>> = {
  gnl_run_journal: { key: '_id', run_id: 'run' },
  gnl_runs: { run_id: '_id' },
  gnl_counters: { key: 'k', field: '_id.f', value: 'n' },
  gnl_threads: { id: '_id', parent_thread_id: 'parent_thread_id' },
  gnl_messages: { thread_id: 'thread_id' },
  gnl_working_memory: { scope_id: '_id' },
  gnl_observations: { thread_id: '_id' },
  gnl_message_batches: { thread_id: 'thread_id' },
  gnl_work_log: { ns: 'ns', id: 'id' },
  gnl_work_kv: { key: '_id' },
  gnl_cache: { key: '_id' },
  gnl_meta: { k: '_id' },
};
function fieldOf(table: string, column: string): string {
  const f = FIELD[table]?.[column];
  if (f === undefined) throw new Error(`@gnldev/durable: MongoStorage has no field for ${table}.${column} — the adoption model names a column this store does not know`);
  return f;
}
const pick = (d: Doc, path: string): any => path.split('.').reduce((x: any, k) => (x == null ? undefined : x[k]), d);

/** The collections of one database, by name. */
type Colls = Record<Name, Coll> & { db: Any };

// ── the store ──────────────────────────────────────────────────────────────────────────────────────

export interface MongoStorageOptions {
  /**
   * `mongodb://user:password@localhost:27017/database?replicaSet=rs0` — a replica set (one node is enough;
   * `directConnection=true` for a single local node). The database must be named, here or in `database`.
   */
  connectionString: string;
  /** The database, when the connection string names none (or another one, e.g. the users' `authSource`). */
  database?: string;
}

export class MongoStorage implements Storage {
  readonly name = 'mongo';
  readonly capabilities: CapabilityMatrix = { runs: 'full', memory: 'full', vectors: 'scan', work: 'full', cache: 'ttl' };
  readonly runs: RunJournal;
  readonly memory: MemoryStore;
  readonly vectors: VectorStore;
  readonly work: WorkStore;
  readonly cache: CacheStore;
  readonly meta: MetaStore;
  private readonly client: Any;
  private readonly connectionString: string;
  private readonly dbName: string;
  private ready?: Promise<Colls>;
  private ownLiveness?: Promise<MongoProcessLiveness>;
  /** The database — for companion stores beside this one. */
  get db(): MongoDatabase { return this.client.db(this.dbName); }

  constructor(opts: MongoStorageOptions) {
    refuseUnknownNames('MongoStorage', opts, MONGO_STORAGE_NAMES);
    if (!opts?.connectionString) throw new Error('@gnldev/durable: MongoStorage needs a connectionString (mongodb://user:password@localhost:27017/database?replicaSet=rs0).');
    this.connectionString = opts.connectionString;
    this.dbName = databaseOf(opts.connectionString, opts.database, 'MongoStorage');
    this.client = new (driver().MongoClient)(opts.connectionString);
    const boot = () => this.ensureReady();
    const tx: Tx = async (fn, o) => { await this.ensureReady(); return transact(this.client, fn, o); };
    const nextOrd = async (name: string): Promise<number> => {
      const c = await boot();
      const r = await c.gnl_seq.findOneAndUpdate({ _id: name }, { $inc: { n: 1 } }, { upsert: true, returnDocument: 'after' });
      return Number(r.n);
    };
    this.runs = new MoRunJournal(boot, tx, nextOrd, () => driver().Double);
    Object.defineProperty(this.runs, 'processLiveness', { value: () => this.processLiveness(), enumerable: false, configurable: true });
    this.memory = new MoMemoryStore(boot, tx);
    this.vectors = new MoVectorStore(boot, tx);
    this.work = new MoWorkStore(boot, tx, nextOrd);
    markWorkOf(this);
    this.cache = new MoCacheStore(boot);
    this.meta = new MoMetaStore(boot);
  }

  /** This process's liveness on this database: a connection named for it (`mongoLiveness`), made on first use, ended by `close()`. */
  processLiveness(): Promise<MongoProcessLiveness> {
    if (this.ownLiveness) return this.ownLiveness;
    const made = mongoLiveness({ connectionString: this.connectionString, database: this.dbName });
    this.ownLiveness = made;
    made.catch(() => { if (this.ownLiveness === made) this.ownLiveness = undefined; });
    return made;
  }

  private ensureReady(): Promise<Colls> {
    if (this.ready) return this.ready;
    const booting = (async () => {
      refuseTopology(await this.client.db('admin').command({ hello: 1 }), 'MongoStorage');
      const db = this.client.db(this.dbName);
      // Two processes booting a fresh database at once: each creates what is absent, and the other's
      // "already exists" is the same answer.
      const have = new Set((await db.listCollections({}, { nameOnly: true }).toArray()).map((x: Doc) => x.name as string));
      for (const name of COLLECTIONS) if (!have.has(name)) await db.createCollection(name).catch((e: unknown) => { if (codeOf(e) !== NAMESPACE_EXISTS) throw e; });
      for (const ix of INDEXES) await db.collection(ix.coll).createIndex(ix.key, indexOptions(ix));
      await db.collection('gnl_meta').updateOne({ _id: 'schema_version' }, { $setOnInsert: { v: SCHEMA_VERSION } }, { upsert: true });
      return Object.assign(Object.fromEntries(COLLECTIONS.map((n) => [n, db.collection(n)])), { db }) as Colls;
    })();
    this.ready = booting;
    // A rejected boot is not memoised: a transient failure (a restart, an election) must not become permanent.
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
    await this.client.close();
  }

  /**
   * The deployment's durability preconditions as this store can read them: the replica set and its
   * members, the write concern a commit waits for (`majority`, set by this store on every transaction),
   * and what it cannot read — the server host's TCP keepalive, and, until this process opens its liveness,
   * whose connections it can see.
   */
  async durabilityReport(): Promise<{
    syncCommit: string; standbyNames: string; connectedStandbys: number; syncStandbys: number; safeForFailover: boolean;
    replicaSet: string; members: number; partitionDetection: PartitionDetection; connectionVisibility: string; notes: string[];
  }> {
    const hello = await this.client.db('admin').command({ hello: 1 });
    refuseTopology(hello, 'MongoStorage');
    const hosts: string[] = [...(hello.hosts ?? []), ...(hello.passives ?? [])];
    const members = hosts.length;
    const others = hosts.filter((h) => h !== hello.me);
    const notes: string[] = [];
    let defaultWrite = 'unknown';
    try {
      const rw = await this.client.db('admin').command({ getDefaultRWConcern: 1 });
      defaultWrite = JSON.stringify(rw.defaultWriteConcern ?? {});
    } catch { notes.push('The deployment\'s default write concern is not readable by this user. This store writes every transaction with w: "majority"; its single writes use the default.'); }
    if (members < 3) notes.push(`This replica set has ${members === 1 ? 'one server' : `${members} members`}: an acknowledged write lives on ${members === 1 ? 'that server only, and is lost with its disk' : 'too few members to survive the loss of one with a majority left'}. Run three members for failover.`);
    notes.push(KEEPALIVE_UNREADABLE);
    const own = this.ownLiveness ? await this.ownLiveness.catch(() => undefined) : undefined;
    const connectionVisibility = own ? own.visibility : 'not checked: this process has not opened its liveness';
    return {
      syncCommit: `transactions: w=majority; default write concern: ${defaultWrite}`, standbyNames: others.join(','), connectedStandbys: others.length,
      syncStandbys: Math.max(0, Math.ceil((members + 1) / 2) - 1), safeForFailover: members >= 3,
      replicaSet: String(hello.setName), members, partitionDetection: { seconds: null, source: 'operating system' }, connectionVisibility, notes,
    };
  }

  /** The collections and indexes `ensureReady` creates, one line each. */
  exportSchema(): string[] {
    return [...COLLECTIONS.map((c) => `db.createCollection(${JSON.stringify(c)})`),
      ...INDEXES.map((ix) => `db.${ix.coll}.createIndex(${JSON.stringify(ix.key)}, ${JSON.stringify(indexOptions(ix))})`)];
  }

  /** Read-only: the collections and indexes this version expects that the database lacks. */
  async checkSchema(): Promise<SchemaCheckResult> {
    const db = this.client.db(this.dbName);
    const live = new Set<string>((await db.listCollections({}, { nameOnly: true }).toArray()).map((x: Doc) => x.name as string));
    const missingTables = COLLECTIONS.filter((c) => !live.has(c));
    const known = new Set<string>([...COLLECTIONS, ...OTHER_COLLECTIONS]);
    const unknownTables = [...live].filter((t) => t.startsWith('gnl_') && !known.has(t));
    const missingIndexes: string[] = [];
    for (const coll of COLLECTIONS) {
      if (!live.has(coll)) { for (const ix of INDEXES) if (ix.coll === coll) missingIndexes.push(ix.name); continue; }
      const names = new Set((await db.collection(coll).listIndexes().toArray()).map((x: Doc) => x.name as string));
      for (const ix of INDEXES) if (ix.coll === coll && !names.has(ix.name)) missingIndexes.push(ix.name);
    }
    return { ok: missingTables.length === 0 && missingIndexes.length === 0, missingTables, missingColumns: [], unknownTables, missingIndexes };
  }

  /** The `schema` step: the collections and indexes `checkSchema` finds missing (additive only). */
  private async applySchemaGap(opts?: { dryRun?: boolean }): Promise<SchemaMigrationResult> {
    const check = await this.checkSchema();
    const statements = [
      ...check.missingTables.map((c) => `db.createCollection(${JSON.stringify(c)})`),
      ...INDEXES.filter((ix) => check.missingIndexes?.includes(ix.name)).map((ix) => `db.${ix.coll}.createIndex(${JSON.stringify(ix.key)}, ${JSON.stringify(indexOptions(ix))})`),
    ];
    if (opts?.dryRun) return { statements, dryRun: true };
    const db = this.client.db(this.dbName);
    for (const c of check.missingTables) await db.createCollection(c).catch((e: unknown) => { if (codeOf(e) !== NAMESPACE_EXISTS) throw e; });
    for (const ix of INDEXES) if (check.missingIndexes?.includes(ix.name)) await db.collection(ix.coll).createIndex(ix.key, indexOptions(ix));
    return { statements, dryRun: false };
  }

  /**
   * See `Storage.upgrade`. This store has no earlier version: `run-status` is never pending (no status
   * flags were ever written here), `schema` adds what a database created by a later release lacks, and
   * the record steps run as on every store.
   */
  async upgrade(opts?: UpgradeOptions): Promise<UpgradeReport> {
    refuseUnknownNames('MongoStorage.upgrade', opts, UPGRADE_NAMES);
    return runUpgrade('MongoStorage', [
      runStatusStep({ runStatusPending: async () => false, runStatusPlan: async () => [], migrateRunStatus: async () => ({ runs: 0 }) }),
      {
        name: 'schema',
        description: 'adds the collections and indexes this version expects (additive: never drops or renames)',
        requires: ['run-status'],
        pending: async () => !(await this.checkSchema()).ok,
        plan: async () => ({ statements: (await this.applySchemaGap({ dryRun: true })).statements }),
        run: async () => ({ statements: (await this.applySchemaGap()).statements }),
      },
      this.booted(threadRecordsStep(this, ['schema'])),
      this.booted(relationsStep(this.runs as MoRunJournal, ['schema'])),
      this.booted(verifyRelationsStep(this.runs as MoRunJournal, ['schema'])),
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
    const live = await this.client.db(this.dbName).listCollections({}, { nameOnly: true }).toArray();
    return live.some((x: Doc) => (COLLECTIONS as readonly string[]).includes(x.name));
  }

  /**
   * See `Storage.adoptIntoOrg` and the SQL twins: one transaction over the collections of `SCOPE_TABLES`.
   * A document's `_id` cannot change, so a moved one is written under its new id and the old one deleted.
   * A transaction lives at most 60 s by the server's default (`transactionLifetimeLimitSeconds`): a store
   * too large to move in that is refused whole, never half moved.
   */
  async adoptIntoOrg(orgId: string, opts?: { dryRun?: boolean; allowUnregistered?: boolean; allowInFlight?: boolean }): Promise<AdoptIntoOrgResult> {
    refuseUnknownNames('adoptIntoOrg', opts, ADOPT_INTO_ORG_NAMES);
    const prefix = orgPrefix(orgId);
    const ns = prefix.slice(0, -1);
    const dryRun = opts?.dryRun === true;
    const c = await this.ensureReady();
    await assertOrgRegistered(this.runs, orgId, opts?.allowUnregistered);
    await assertNoRunsInFlight(this.runs, opts?.allowInFlight);
    if (!dryRun) await (this.runs as unknown as { deletePrefix(p: string): Promise<number> }).deletePrefix(ROOT_EXEC_RECORDS);
    const body = async (s: Session | undefined): Promise<AdoptIntoOrgResult> => {
      const o = s ? { session: s } : {};
      const moved: Record<string, number> = {};
      const skipped = new Set<string>();
      const resetPositions: string[] = [];
      let alreadyScoped = 0;
      const bump = (store: string, n: number) => { moved[store] = (moved[store] ?? 0) + n; };
      const rootVectors = await c.gnl_vectors.find({ namespace: null }, { ...o, projection: { _id: 1 } }).toArray();
      for (const chunk of chunks(rootVectors.map((d: Doc) => d._id as string))) {
        const clash = await c.gnl_vectors.findOne({ _id: { $in: chunk.map((id) => `${ns}:${id}`) } }, { ...o, projection: { _id: 1 } });
        if (clash) throw vectorAdoptCollision(String(clash._id).slice(ns.length + 1));
      }
      for (const d of await c.gnl_work_kv.find(atRoot('_id'), o).toArray()) {
        const key = String(d._id);
        if (isPlatformKey(key)) continue;
        const orgHas = (await c.gnl_work_kv.countDocuments({ _id: prefix + key }, { ...o, limit: 1 })) > 0;
        const decision = workKeyAdoption(deserialize(d.v), orgHas);
        if (decision === 'collision') throw workKeyAdoptCollision(prefix + key);
        if (decision === 'reset-position') resetPositions.push(key);
      }
      /** Root documents whose organization twin exists: the value of `column`, and the `pick`ed fields. */
      const twins = async (table: string, column: string, match: string[] = [], picks: string[] = []): Promise<Array<Record<string, any>>> => {
        const coll = c[table as Name];
        const field = fieldOf(table, column);
        const mfields = match.map((m) => fieldOf(table, m));
        const out: Array<Record<string, any>> = [];
        const root = await coll.find(atRoot(field), o).toArray();
        for (const chunk of chunks(root as Doc[])) {
          const want = chunk.map((d) => ({ [field]: prefix + pick(d, field), ...Object.fromEntries(mfields.map((m) => [m, pick(d, m)])) }));
          const found = new Set((await coll.find({ $or: want }, o).toArray()).map((d: Doc) => JSON.stringify([pick(d, field), ...mfields.map((m) => pick(d, m))])));
          for (const d of chunk) {
            if (!found.has(JSON.stringify([prefix + pick(d, field), ...mfields.map((m) => pick(d, m))]))) continue;
            out.push({ k: pick(d, field), ...Object.fromEntries(picks.map((p) => [p, pick(d, fieldOf(table, p))])) });
          }
        }
        return [...new Map(out.map((x) => [JSON.stringify(x), x])).values()];
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
        for (const k of resetPositions) await c.gnl_work_kv.deleteOne({ _id: k }, o);
        for (const { k, field, value } of summed) {
          await c.gnl_counters.updateOne({ _id: { k: prefix + k, f: field } }, { $inc: { n: value } }, o);
          await c.gnl_counters.deleteOne({ _id: { k, f: field } }, o);
        }
        for (const k of dropped) await c.gnl_cache.deleteOne({ _id: k }, o);
        bump('runs', summed.length);
      }
      const notCarried = new Set([...resetPositions, ...dropped]);
      if (!dryRun) {
        const held = new Set<string>();
        for (const k of scopeFactKeys(prefix)) if (await c.gnl_run_journal.countDocuments({ _id: k }, { ...o, limit: 1 })) held.add(k);
        for (const k of scopeFactsDroppedByAdoption(prefix, held)) await c.gnl_run_journal.deleteOne({ _id: k }, o);
      }
      for (const [table, column, store, counted] of SCOPE_TABLES) {
        const coll = c[table as Name];
        const field = fieldOf(table, column);
        if (counted) alreadyScoped += await coll.countDocuments(within(field, ORG_KEY_PREFIX), o);
        const values: string[] = (await coll.distinct(field, atRoot(field), o)).filter((v: unknown) => typeof v === 'string');
        let n = 0;
        for (const k of values) {
          if (isScopeFact(k)) continue;
          if (isPlatformKey(k)) { skipped.add(k.split(':')[0]!); continue; }
          if ((table === 'gnl_work_kv' || table === 'gnl_cache') && notCarried.has(k)) continue;
          if (counted) n += await coll.countDocuments({ [field]: k }, o);
          if (dryRun) continue;
          if (table === 'gnl_work_log') await coll.updateMany({ ns: k }, { $set: { ns: prefix + k, seq: 0 } }, o);
          else await moveValue(coll, field, k, prefix + k, o);
        }
        bump(store, n);
      }
      const metaRows = await c.gnl_meta.find(atRoot('_id'), { ...o, projection: { _id: 1 } }).toArray();
      alreadyScoped += await c.gnl_meta.countDocuments(within('_id', ORG_KEY_PREFIX), o);
      let metaN = 0;
      for (const { _id } of metaRows as Doc[]) {
        const k = String(_id);
        if (ENGINE_META_KEYS.includes(k)) continue;
        if (isPlatformKey(k)) { skipped.add(k.split(':')[0]!); continue; }
        metaN++;
        if (!dryRun) await moveValue(c.gnl_meta, '_id', k, prefix + k, o);
      }
      bump('meta', metaN);
      alreadyScoped += await c.gnl_vectors.countDocuments({ namespace: { $ne: null } }, o);
      const vecs = rootVectors.length;
      if (!dryRun) {
        for (const { _id } of rootVectors as Doc[]) {
          const d = await c.gnl_vectors.findOne({ _id }, o);
          await c.gnl_vectors.insertOne({ ...d, _id: `${ns}:${String(_id)}`, namespace: ns }, o);
          await c.gnl_vectors.deleteOne({ _id }, o);
        }
      }
      bump('vectors', vecs);
      return { orgId, dryRun, moved, alreadyScoped, skippedPlatformKeys: [...skipped].sort(), resetPositions: resetPositions.sort() };
    };
    return dryRun ? body(undefined) : transact(this.client, body);
  }
}

function indexOptions(ix: (typeof INDEXES)[number]): Doc {
  return { name: ix.name, ...(ix.unique ? { unique: true } : {}), ...(ix.partialFilterExpression ? { partialFilterExpression: ix.partialFilterExpression } : {}) };
}
function chunks<T>(xs: T[], size = 500): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < xs.length; i += size) out.push(xs.slice(i, i + size));
  return out;
}
/** Every document whose `field` is `from` gets `to` there; an `_id` (or a counter's key) by writing the document again under it. */
async function moveValue(coll: Coll, field: string, from: string, to: string, o: Doc): Promise<void> {
  if (field === '_id') {
    const d = await coll.findOne({ _id: from }, o);
    if (!d) return;
    await coll.insertOne({ ...d, _id: to }, o);
    await coll.deleteOne({ _id: from }, o);
    return;
  }
  if (field === 'k') {
    for (const d of await coll.find({ k: from }, o).toArray()) await coll.insertOne({ ...d, _id: { k: to, f: d._id.f }, k: to }, o);
    await coll.deleteMany({ k: from }, o);
    return;
  }
  await coll.updateMany({ [field]: from }, { $set: { [field]: to } }, o);
}

// ── the run journal ────────────────────────────────────────────────────────────────────────────────

/** Thrown inside a transaction when its claim is lost, so everything it wrote rolls back. */
const CLAIM_LOST = Symbol('claim lost');
const PLACE_PAGE = 1000;
const INPUT_SUFFIX = leafSuffix('input');

/** A new journal document. `ts` is the first writer's clock (`created_at`); `ord` the first-write position. */
function journalDoc(key: string, value: unknown, p: { runId: string; kind: string } | null, suspended: boolean, ord: number): Doc {
  return { _id: key, run: p?.runId ?? null, kind: p?.kind ?? null, suspended, v: serialize(value), ts: Date.now(), owner: ownerColumnOf(key, value), orec: isOwnerRecordKey(key), ord };
}
/** The fields a write replaces on an existing journal document (its `ts` and `ord` stay the first write's). */
function journalSet(key: string, value: unknown, suspended: boolean): Doc {
  return { v: serialize(value), suspended, owner: ownerColumnOf(key, value) };
}
/** An upsert of a journal document as one pipeline: replaced fields, and the first write's `ts`/`ord` kept. */
function journalUpsert(key: string, value: unknown, p: { runId: string; kind: string } | null, suspended: boolean, ord: number): Doc[] {
  const d = journalDoc(key, value, p, suspended, ord);
  return [{ $set: {
    run: lit(d.run), kind: lit(d.kind), suspended: lit(d.suspended), v: lit(d.v), owner: lit(d.owner), orec: lit(d.orec),
    ord: { $ifNull: ['$ord', lit(ord)] }, ts: { $ifNull: ['$ts', lit(d.ts)] },
  } }];
}

/** `runStatusOf` as an aggregation expression over the run document's own fields, from RUN_STATUS_PRECEDENCE. */
const STATUS_EXPR = {
  $switch: {
    branches: RUN_STATUS_PRECEDENCE.map((r) => ({ case: r.when === 'suspended' ? { $gt: ['$suspended_count', 0] } : { $eq: ['$outcome', r.status] }, then: r.status })),
    default: 'completed',
  },
};

function moRunSummary(x: Doc, inputVal: string | undefined): RunSummary {
  const input = inputVal ? deserialize<{ threadId?: string; agent?: string; resourceId?: string; workKey?: string; parentRunId?: string }>(inputVal) : undefined;
  return {
    runId: x._id, status: x.status as RunStatus, modelSteps: Number(x.model_steps), toolCalls: Number(x.tool_calls),
    ...(input?.threadId ? { threadId: input.threadId } : {}),
    ...(input?.agent ? { agent: input.agent } : {}),
    ...(input?.resourceId ? { resourceId: input.resourceId } : {}),
    ...(input?.workKey ? { workKey: input.workKey } : {}),
    ...(input?.parentRunId ? { parentRunId: input.parentRunId } : {}),
  };
}

/** A status filter over `gnl_runs.status` (`runStatusSql`): the statuses it admits; an unknown one admits none. */
function statusFilter(q: { status?: RunStatus; statuses?: readonly RunStatus[] } | undefined): Doc {
  const known = (s: RunStatus): boolean => s === 'completed' || OPEN_RUN_STATUSES.includes(s);
  const conds: Doc[] = [];
  if (q?.status) conds.push({ status: { $in: [q.status].filter(known) } });
  if (q?.statuses) conds.push({ status: { $in: [...new Set(q.statuses)].filter(known) } });
  return all(...conds);
}

class MoRunJournal implements RunJournal {
  constructor(
    private readonly boot: () => Promise<Colls>,
    private readonly tx: Tx,
    private readonly nextOrd: (name: string) => Promise<number>,
    private readonly double: () => Driver['Double'],
  ) { withBirth(this as never); }

  async get<T = unknown>(key: string): Promise<T | undefined> {
    const c = await this.boot();
    const d = await c.gnl_run_journal.findOne({ _id: key }, { projection: { v: 1 } });
    return d ? deserialize<T>(d.v) : undefined;
  }
  async put(key: string, value: unknown): Promise<void> {
    const p = parseJournalKey(key);
    const suspended = p?.kind === 'tool' && (value as ToolJournalRecord | undefined)?.status === 'suspended';
    if (!p && !runIdOfKey(key, value) && outcomeStatusOf(key, value) === null && !key.endsWith(INPUT_SUFFIX)) {
      const c = await this.boot();
      await c.gnl_run_journal.updateOne({ _id: key }, journalUpsert(key, value, p, suspended, await this.nextOrd('journal')), { upsert: true });
      return;
    }
    await this.tx(async (s) => {
      const prev = await this.writeRecord(s, key, value, p, suspended);
      await this.unplaceUnreadInput(s, key, value);
      await this.writeRunRows(s, new RunRowChanges().noteWrite(key, value, prev));
    });
  }
  async putIfAbsent(key: string, value: unknown): Promise<boolean> {
    const p = parseJournalKey(key);
    const suspended = p?.kind === 'tool' && (value as ToolJournalRecord | undefined)?.status === 'suspended';
    const c = await this.boot();
    if (!p && !runIdOfKey(key, value) && outcomeStatusOf(key, value) === null && !key.endsWith(INPUT_SUFFIX)) {
      try { await c.gnl_run_journal.insertOne(journalDoc(key, value, p, suspended, await this.nextOrd('journal'))); return true; } catch (e) { if (isDup(e)) return false; throw e; }
    }
    // The insert is the claim: a concurrent claim of the same key conflicts with it and runs again, then
    // meets the document (a duplicate key). Only the winner touches the run's document.
    return this.tx(async (s) => {
      await this.insertClaim(s, key, value, p, suspended);
      await this.unplaceUnreadInput(s, key, value);
      await this.writeRunRows(s, new RunRowChanges().noteWrite(key, value, undefined));
      return true;
    }).catch((e: unknown) => { if (e === CLAIM_LOST) return false; throw e; });
  }
  /** Atomic conditional replace: the stored serialized value compared for equality. */
  async putIfMatch(key: string, expected: unknown, value: unknown): Promise<boolean> {
    const p = parseJournalKey(key);
    const suspended = p?.kind === 'tool' && (value as ToolJournalRecord | undefined)?.status === 'suspended';
    const c = await this.boot();
    const match = { _id: key, v: serialize(expected) };
    const set = { $set: journalSet(key, value, suspended) };
    if (!p) {
      const oc = outcomeStatusOf(key, value);
      const placed = runRelationsOf(key, value) !== undefined;
      if (oc === null && !placed && !key.endsWith(INPUT_SUFFIX)) return (await c.gnl_run_journal.updateOne(match, set)).matchedCount === 1;
      return this.tx(async (s) => {
        const ok = (await c.gnl_run_journal.updateOne(match, set, { session: s })).matchedCount === 1;
        if (ok) {
          await this.unplaceUnreadInput(s, key, value);
          await this.writeRunRows(s, new RunRowChanges().noteWrite(key, value, undefined));
        }
        return ok;
      });
    }
    // A run's record: counted from the document it replaces, read in the snapshot the replacement is
    // checked against (a change committed since makes the write conflict and the whole read run again).
    return this.tx(async (s) => {
      const prev = await c.gnl_run_journal.findOne(match, { session: s, projection: { suspended: 1 } });
      if (!prev) return false;
      await c.gnl_run_journal.updateOne({ _id: key }, set, { session: s });
      await this.writeRunRows(s, new RunRowChanges().noteWrite(key, value, { suspended: !!prev.suspended }));
      return true;
    });
  }

  /** In-engine atomic counters: one document per (key, field), `$inc`'d; several fields in one transaction. */
  async incrBy(key: string, fields: Record<string, number>): Promise<Record<string, number>> {
    const merged = mergeIncrs([{ key, fields }]);
    if (!merged.length) return {};
    const c = await this.boot();
    const Double = this.double();
    const bump = (s: Session | undefined, m: (typeof merged)[number]) => c.gnl_counters.findOneAndUpdate(
      { _id: { k: m.key, f: m.field } }, { $inc: { n: new Double(m.delta) }, $set: { k: m.key } }, { upsert: true, returnDocument: 'after', ...(s ? { session: s } : {}) });
    if (merged.length === 1) {
      const r = await bump(undefined, merged[0]!);
      return { [merged[0]!.field]: Number(r.n) };
    }
    return this.tx(async (s) => {
      const out: Record<string, number> = {};
      for (const m of merged) out[m.field] = Number((await bump(s, m)).n);
      return out;
    });
  }
  async getCounters(key: string): Promise<Record<string, number> | undefined> {
    const c = await this.boot();
    const rows = await c.gnl_counters.find({ k: key }).toArray();
    if (!rows.length) return undefined;
    return Object.fromEntries(rows.map((r: Doc) => [String(r._id.f), Number(r.n)]));
  }

  async listStaleRuns(cutoffTs: number, opts?: { includeSuspended?: boolean }): Promise<string[]> {
    const c = await this.boot();
    const q = opts?.includeSuspended ? { updated_at: { $lt: cutoffTs } } : { updated_at: { $lt: cutoffTs }, suspended_count: { $lte: 0 } };
    return (await c.gnl_runs.find(q, { projection: { _id: 1 } }).toArray()).map((d: Doc) => String(d._id));
  }
  async readRunStats(runId: string): Promise<{ entries: number; bytes: number }> {
    const c = await this.boot();
    const r = await c.gnl_run_journal.aggregate([{ $match: { run: runId } }, { $group: { _id: null, c: { $sum: 1 }, b: { $sum: { $strLenBytes: '$v' } } } }]).toArray();
    return { entries: Number(r[0]?.c ?? 0), bytes: Number(r[0]?.b ?? 0) };
  }
  /** The server's clock (epoch ms): one clock for every process and host. */
  async now(): Promise<number> {
    const c = await this.boot();
    return (await c.db.admin().command({ hello: 1 })).localTime.getTime();
  }

  /** The claim's insert in transaction `s`: a duplicate is the lost race (CLAIM_LOST rolls the rest back). */
  private async insertClaim(s: Session, key: string, value: unknown, p: { runId: string; kind: string } | null, suspended: boolean): Promise<void> {
    const c = await this.boot();
    const ord = await this.nextOrd('journal');
    try { await c.gnl_run_journal.insertOne(journalDoc(key, value, p, suspended, ord), { session: s }); } catch (e) { if (isDup(e)) throw CLAIM_LOST; throw e; }
  }
  /** Writes a record in transaction `s`, returning the document it replaced (`undefined`: a new one). */
  private async writeRecord(s: Session, key: string, value: unknown, p: { runId: string; kind: string } | null, suspended: boolean): Promise<{ suspended: boolean } | undefined> {
    const c = await this.boot();
    if (!p) {
      await c.gnl_run_journal.updateOne({ _id: key }, journalUpsert(key, value, p, suspended, await this.nextOrd('journal')), { upsert: true, session: s });
      return undefined;
    }
    const prev = await c.gnl_run_journal.findOne({ _id: key }, { session: s, projection: { suspended: 1 } });
    if (prev) {
      await c.gnl_run_journal.updateOne({ _id: key }, { $set: journalSet(key, value, suspended) }, { session: s });
      return { suspended: !!prev.suspended };
    }
    // Absent from this snapshot. A writer that inserted it since makes this insert a duplicate: the
    // transaction runs again and reads that document as the one it replaces.
    try { await c.gnl_run_journal.insertOne(journalDoc(key, value, p, suspended, await this.nextOrd('journal')), { session: s }); } catch (e) { if (isDup(e)) throw RETRY; throw e; }
    return undefined;
  }
  /**
   * A run's `:input` written with a value this version cannot read as one (no version marker): the run is
   * unplaced (null person and thread), so every lookup reads it and decides from the record — what the
   * Postgres guard trigger RUN_UNPLACE does. A readable `:input` places the run in `writeRunRows`.
   */
  private async unplaceUnreadInput(s: Session, key: string, value: unknown): Promise<void> {
    if (!key.endsWith(INPUT_SUFFIX) || runRelationsOf(key, value) !== undefined) return;
    const c = await this.boot();
    await c.gnl_runs.updateOne({ _id: key.slice(0, -INPUT_SUFFIX.length) }, { $set: { resource_id: null, thread_id: null } }, { session: s });
  }
  /** The runs' documents for one transaction's writes: one upsert per run, in run-id order. */
  private async writeRunRows(s: Session, changes: RunRowChanges): Promise<void> {
    for (const [runId, ch] of changes.entries()) await this.writeRunRow(s, runId, ch);
  }
  /**
   * One run document, as one pipeline update: counters added to (or set from) what the document holds,
   * the outcome and relations this write carries, and the status computed from the result — the
   * document's own counter, which only the server knows at that moment.
   */
  private async writeRunRow(s: Session, runId: string, ch: RunRowChange): Promise<void> {
    const c = await this.boot();
    const now = Date.now();
    const set: Doc = {
      model_steps: { $add: [{ $ifNull: ['$model_steps', 0] }, ch.models] },
      tool_calls: { $add: [{ $ifNull: ['$tool_calls', 0] }, ch.tools] },
      suspended_count: { $cond: [{ $eq: [{ $type: '$suspended_count' }, 'missing'] }, Math.max(0, ch.suspendedDelta), { $add: ['$suspended_count', ch.suspendedDelta] }] },
      outcome: ch.outcome ? lit(storedOutcomeOf(ch.outcome)) : { $ifNull: ['$outcome', null] },
      created_at: { $ifNull: ['$created_at', now] },
      updated_at: now,
      resource_id: ch.relations ? lit(ch.relations.resourceId) : { $ifNull: ['$resource_id', null] },
      thread_id: ch.relations ? lit(ch.relations.threadId) : { $ifNull: ['$thread_id', null] },
    };
    await c.gnl_runs.updateOne({ _id: runId }, [{ $set: set }, { $set: { status: STATUS_EXPR } }], { upsert: true, session: s });
  }
  private async writeDeletedRunRows(s: Session, changes: RunRowChanges): Promise<void> {
    const c = await this.boot();
    for (const [runId, ch] of changes.entries()) {
      await c.gnl_runs.updateOne({ _id: runId }, [{ $set: {
        model_steps: { $add: ['$model_steps', ch.models] }, tool_calls: { $add: ['$tool_calls', ch.tools] }, suspended_count: { $add: ['$suspended_count', ch.suspendedDelta] },
        updated_at: Date.now(),
        ...(ch.outcomeGone ? { outcome: null } : {}),
        ...(ch.inputGone ? { resource_id: null, thread_id: null } : {}),
      } }, { $set: { status: STATUS_EXPR } }], { session: s });
      if (!(await this.hasRunRecords(s, runId))) await c.gnl_runs.deleteOne({ _id: runId }, { session: s });
    }
  }
  private async hasRunRecords(s: Session, runId: string): Promise<boolean> {
    const c = await this.boot();
    if (await c.gnl_run_journal.findOne({ run: runId }, { session: s, projection: { _id: 1 } })) return true;
    const docs = await c.gnl_run_journal.find({ _id: { $in: [runRecordKey(runId, 'input'), runRecordKey(runId, 'outcome')] } }, { session: s }).toArray();
    return docs.some((x: Doc) => runRecordOf(String(x._id), deserialize(x.v))?.runId === runId);
  }

  /** See `Journal.listOwnerRecords`: the placed half and the unplaced half over the owner index, each record decided from its value. */
  async listOwnerRecords(resourceId: string, opts?: { prefix?: string }): Promise<string[]> {
    const c = await this.boot();
    const docs = await c.gnl_run_journal.find({ orec: true, owner: { $in: [resourceId, null] }, _id: range(opts?.prefix ?? '') }, { projection: { v: 1 } }).toArray();
    return docs.filter((x: Doc) => ownerOfRecord(deserialize(x.v)) === resourceId).map((x: Doc) => String(x._id));
  }
  /** Nothing to verify: no writer of this store leaves a placement its record does not support (see the head of the file). */
  async requestRelationsVerify(): Promise<void> { /* see above */ }
  /** Runs or owner records the `relations` step can place: only documents a write left unplaced (an unreadable `:input`). */
  async relationsPending(): Promise<boolean> {
    const c = await this.boot();
    for (let after = '';;) {
      const page = await c.gnl_runs.find({ resource_id: null, _id: { $gt: after } }, { projection: { _id: 1 } }).sort({ _id: 1 }).limit(PLACE_PAGE).toArray();
      if (page.length && await c.gnl_run_journal.findOne({ _id: { $in: page.map((r: Doc) => `${r._id}${INPUT_SUFFIX}`) } }, { projection: { _id: 1 } })) return true;
      if (page.length < PLACE_PAGE) break;
      after = String(page[page.length - 1]._id);
    }
    for (let after = '';;) {
      const rows = await this.unplacedOwners(after);
      if (rows.some((x) => ownerColumnOf(String(x._id), deserialize(x.v)) !== null)) return true;
      if (rows.length < PLACE_PAGE) return false;
      after = String(rows[rows.length - 1]!._id);
    }
  }
  private async unplacedOwners(after: string, s?: Session): Promise<Doc[]> {
    const c = await this.boot();
    return c.gnl_run_journal.find({ orec: true, owner: null, _id: { $gt: after } }, { projection: { v: 1 }, ...(s ? { session: s } : {}) }).sort({ _id: 1 }).limit(PLACE_PAGE).toArray();
  }
  /** The `relations` step: a page at a time, each read and placed in one transaction. */
  async placeRelations(): Promise<{ runs: number; owners: number; analyzed: boolean }> {
    const c = await this.boot();
    let runs = 0;
    let owners = 0;
    for (let after = '';;) {
      const page = await c.gnl_runs.find({ resource_id: null, _id: { $gt: after } }, { projection: { _id: 1 } }).sort({ _id: 1 }).limit(PLACE_PAGE).toArray();
      if (page.length) {
        runs += await this.tx(async (s) => {
          const read = await c.gnl_run_journal.find({ _id: { $in: page.map((r: Doc) => `${r._id}${INPUT_SUFFIX}`) } }, { session: s }).toArray();
          let n = 0;
          for (const x of read as Doc[]) {
            const rel = relationsOfInput(deserialize(x.v));
            n += (await c.gnl_runs.updateOne({ _id: String(x._id).slice(0, -INPUT_SUFFIX.length), resource_id: null }, { $set: { resource_id: rel.resourceId, thread_id: rel.threadId } }, { session: s })).modifiedCount;
          }
          return n;
        });
      }
      if (page.length < PLACE_PAGE) break;
      after = String(page[page.length - 1]._id);
    }
    for (let after = '';;) {
      const { got, last, placed } = await this.tx(async (s) => {
        const rows = await this.unplacedOwners(after, s);
        let n = 0;
        for (const x of rows) {
          const o = ownerColumnOf(String(x._id), deserialize(x.v));
          if (o !== null) n += (await c.gnl_run_journal.updateOne({ _id: x._id, owner: null }, { $set: { owner: o } }, { session: s })).modifiedCount;
        }
        return { got: rows.length, last: rows[rows.length - 1]?._id as string | undefined, placed: n };
      });
      owners += placed;
      if (got < PLACE_PAGE || last === undefined) break;
      after = last;
    }
    return { runs, owners, analyzed: false };
  }

  async readRange<T = unknown>(prefix: string, opts: { after?: string; limit: number; desc?: boolean }): Promise<Array<[string, T]>> {
    const c = await this.boot();
    const id: Doc = { ...range(prefix) };
    if (opts.after !== undefined) {
      if (opts.desc) id.$lt = id.$lt === undefined || compareKeys(opts.after, id.$lt) < 0 ? opts.after : id.$lt;
      else id.$gt = opts.after;
    }
    const docs = await c.gnl_run_journal.find({ _id: id }, { projection: { v: 1 } }).sort({ _id: opts.desc ? -1 : 1 }).limit(opts.limit).toArray();
    return docs.map((d: Doc) => [String(d._id), deserialize<T>(d.v)]);
  }
  async listKeys(prefix: string, opts?: { limit?: number }): Promise<string[]> {
    const c = await this.boot();
    if (opts?.limit !== undefined) {
      return (await c.gnl_run_journal.find({ _id: range(prefix) }, { projection: { _id: 1 } }).limit(opts.limit).toArray()).map((d: Doc) => String(d._id));
    }
    // `_id` breaks ties: two records of one millisecond come back in one order on every read.
    return (await c.gnl_run_journal.find({ _id: range(prefix) }, { projection: { _id: 1, ts: 1 } }).sort({ ts: 1, _id: 1 }).toArray()).map((d: Doc) => String(d._id));
  }
  /**
   * Retention/GDPR: every key under the prefix, and the derived runs kept true (see PgRunJournal.deletePrefix).
   * Runs the prefix cuts into have their removed records read in the transaction that deletes them; a
   * prefix that cuts into none is deleted collection by collection, as the SQL stores delete it.
   */
  async deletePrefix(prefix: string): Promise<number> {
    const c = await this.boot();
    const cut = runsCutBy(prefix);
    const rid = prefix.endsWith(':') ? prefix.slice(0, -1) : prefix;
    const rest = async (o: Doc, notOwned: Doc = {}): Promise<number> => {
      const r = await c.gnl_run_journal.deleteMany(all({ _id: range(prefix) }, notOwned), o);
      await c.gnl_runs.deleteMany({ $or: [{ _id: rid }, { _id: range(prefix) }] }, o);
      await c.gnl_counters.deleteMany({ k: range(prefix) }, o);
      return r.deletedCount;
    };
    if (!cut.length) return rest({});
    const ownedKeys = cut.flatMap((id) => [runRecordKey(id, 'input'), runRecordKey(id, 'outcome')]);
    const owned = { $or: [{ run: { $in: cut } }, { _id: { $in: ownedKeys } }] };
    return this.tx(async (s) => {
      const own = await c.gnl_run_journal.find(all({ _id: range(prefix) }, owned), { session: s, projection: { run: 1, suspended: 1 } }).sort({ _id: 1 }).toArray() as Doc[];
      if (own.length) await c.gnl_run_journal.deleteMany({ _id: { $in: own.map((x) => x._id) } }, { session: s });
      const deleted = await rest({ session: s }, { $nor: [owned] });
      const changes = new RunRowChanges();
      for (const row of own) {
        const key = String(row._id);
        const runId = cut.find((id) => row.run === id || key === runRecordKey(id, 'input') || key === runRecordKey(id, 'outcome'));
        if (runId !== undefined) changes.noteDelete(runId, key, !!row.suspended);
      }
      await this.writeDeletedRunRows(s, changes);
      return own.length + deleted;
    });
  }
  async readRun(runId: string): Promise<JournalEntry[]> {
    const c = await this.boot();
    const docs = await c.gnl_run_journal.find({ run: runId }).sort({ ord: 1, ts: 1, _id: 1 }).toArray();
    return docs.map((x: Doc, seq: number) => ({ key: String(x._id), runId, kind: x.kind as JournalEntry['kind'], value: deserialize(x.v), seq, ts: Number(x.ts) }));
  }
  /** Summaries for run documents, each with its `:input` read in one query. */
  private async summaries(docs: Doc[]): Promise<RunSummary[]> {
    if (!docs.length) return [];
    const c = await this.boot();
    const inputs = await c.gnl_run_journal.find({ _id: { $in: docs.map((d) => `${d._id}${INPUT_SUFFIX}`) } }, { projection: { v: 1 } }).toArray();
    const byKey = new Map<string, string>(inputs.map((d: Doc) => [String(d._id), d.v as string]));
    return docs.map((d) => moRunSummary(d, byKey.get(`${d._id}${INPUT_SUFFIX}`)));
  }
  /**
   * The run list (see `keysetRunPage`, whose rules this follows over a collection): a keyset page of
   * `gnl_runs` on `(created_at, _id)`, never an offset. A filter with no field of its own (agent, workKey,
   * topLevel) is decided per run from its `:input`, on runs read forward in chunks until the page is full.
   * A person or thread filter reads the runs placed under that value AND every run not placed yet
   * (`resource_id: null`), each then decided from its record — an unplaced run is still a run.
   */
  async listRuns(q?: ListQuery): Promise<Page<RunSummary>> {
    const c = await this.boot();
    const f: RunFilter & { limit?: number; cursor?: string; order?: RunOrder } = q ?? {};
    const limit = f.limit ?? 50;
    const desc = f.order === 'desc';
    const pos = decodeRunCursor(f.cursor);
    const unindexed = !!(f.agent || f.resourceId || f.threadId || f.workKey || f.topLevel);
    const rel = f.resourceId ? { field: 'resource_id', value: f.resourceId } : f.threadId ? { field: 'thread_id', value: f.threadId } : undefined;
    const atOf = async (runId: string) => {
      const d = await c.gnl_runs.findOne({ _id: runId }, { projection: { created_at: 1 } });
      return d ? Number(d.created_at) : undefined;
    };
    let after: { at: number; runId: string; inclusive?: boolean } | undefined;
    let skip = 0;
    if (pos) {
      const at = pos.at ?? (await atOf(pos.runId));
      const nextAt = at === undefined && pos.next !== undefined ? await atOf(pos.next) : undefined;
      if (at !== undefined) after = { at: Number(at), runId: pos.runId };
      else if (nextAt !== undefined) after = { at: nextAt, runId: pos.next!, inclusive: true };
      else skip = pos.seen;
    }
    const take = unindexed ? Math.max(limit + 1, 200) : limit + 1;
    let skipRows = unindexed ? 0 : skip;
    let skipMatches = unindexed ? skip : 0;
    const base = all(statusFilter(f), f.runIdPrefix ? { _id: range(f.runIdPrefix) } : {}, rel ? { [rel.field]: { $in: [rel.value, null] } } : {});
    const out: Array<{ summary: RunSummary; at: number }> = [];
    for (;;) {
      const [cmp, cmpEq] = desc ? ['$lt', '$lte'] : ['$gt', '$gte'];
      // `created_at` bounds the index read; the run id decides only among the runs of that millisecond.
      const position = after ? { created_at: { [cmpEq]: after.at }, $or: [{ created_at: { [cmp]: after.at } }, { _id: { [after.inclusive ? cmpEq : cmp]: after.runId } }] } : {};
      const dir = desc ? -1 : 1;
      const docs = await c.gnl_runs.find(all(base, position)).sort({ created_at: dir, _id: dir }).skip(skipRows).limit(take).toArray() as Doc[];
      skipRows = 0;
      const sums = await this.summaries(docs);
      for (let i = 0; i < docs.length; i++) {
        const row = { summary: sums[i]!, at: Number(docs[i]!.created_at) };
        after = { at: row.at, runId: row.summary.runId };
        if (unindexed && !matchesRunFilter(row.summary, f)) continue;
        if (skipMatches > 0) { skipMatches--; continue; }
        out.push(row);
        if (out.length > limit) break;
      }
      if (out.length > limit || docs.length < take) break;
    }
    const items = out.slice(0, limit);
    const last = items[items.length - 1];
    return {
      items: items.map((r) => ({ ...r.summary, createdAt: r.at })),
      ...(out.length > limit && last ? { nextCursor: encodeRunCursor({ runId: last.summary.runId, at: last.at, next: out[limit]!.summary.runId, seen: (pos?.seen ?? 0) + items.length }) } : {}),
    };
  }
  /** Atomic batch — claim + puts + counters in one transaction. */
  async applyBatch(batch: JournalBatch): Promise<boolean> {
    const puts = [...(batch.puts ?? [])].sort((a, b) => compareKeys(a.key, b.key));
    const incrs = mergeIncrs(batch.incrs ?? []);
    const c = await this.boot();
    const Double = this.double();
    return this.tx(async (s) => {
      const runs = new RunRowChanges();
      if (batch.claim) {
        const { key, value } = batch.claim;
        const p = parseJournalKey(key);
        await this.insertClaim(s, key, value, p, p?.kind === 'tool' && (value as ToolJournalRecord | undefined)?.status === 'suspended');
        runs.noteWrite(key, value, undefined);
        await this.unplaceUnreadInput(s, key, value);
      }
      for (const { key, value } of puts) {
        const p = parseJournalKey(key);
        const suspended = p?.kind === 'tool' && (value as ToolJournalRecord | undefined)?.status === 'suspended';
        runs.noteWrite(key, value, await this.writeRecord(s, key, value, p, suspended));
        await this.unplaceUnreadInput(s, key, value);
      }
      await this.writeRunRows(s, runs);
      for (const m of incrs) await c.gnl_counters.updateOne({ _id: { k: m.key, f: m.field } }, { $inc: { n: new Double(m.delta) }, $set: { k: m.key } }, { upsert: true, session: s });
      return true;
    }).catch((e: unknown) => { if (e === CLAIM_LOST) return false; throw e; });
  }
  async getMany<T = unknown>(keys: string[]): Promise<(T | undefined)[]> {
    if (keys.length === 0) return [];
    const c = await this.boot();
    const docs = await c.gnl_run_journal.find({ _id: { $in: keys } }, { projection: { v: 1 } }).toArray();
    const byKey = new Map<string, string>(docs.map((d: Doc) => [String(d._id), d.v as string]));
    return keys.map((k) => (byKey.has(k) ? deserialize<T>(byKey.get(k)!) : undefined));
  }
  async countRuns(q?: { runIdPrefix?: string }): Promise<number> {
    const c = await this.boot();
    return c.gnl_runs.countDocuments(q?.runIdPrefix ? { _id: range(q.runIdPrefix) } : {});
  }
  async listRunsChangedSince(cursor?: string, opts?: { limit?: number; since?: number; runIdPrefix?: string }): Promise<{ items: RunChange[]; nextCursor?: string }> {
    const c = await this.boot();
    const pos = decodeChangeCursor(cursor);
    const limit = opts?.limit ?? 200;
    const position = pos ? { updated_at: { $gte: pos.at }, $or: [{ updated_at: { $gt: pos.at } }, { _id: { $gt: pos.runId } }] }
      : opts?.since !== undefined ? { updated_at: { $gte: opts.since } } : {};
    const docs = await c.gnl_runs.find(all(position, opts?.runIdPrefix ? { _id: range(opts.runIdPrefix) } : {})).sort({ updated_at: 1, _id: 1 }).limit(limit).toArray() as Doc[];
    const sums = await this.summaries(docs);
    const items: RunChange[] = sums.map((x, i) => ({ ...x, updatedAt: Number(docs[i]!.updated_at) }));
    const last = items[items.length - 1];
    return { items, ...(last ? { nextCursor: encodeChangeCursor({ at: last.updatedAt, runId: last.runId }) } : {}) };
  }
  async countRunsByStatus(): Promise<Record<string, number>> {
    const c = await this.boot();
    const rows = await c.gnl_runs.aggregate([{ $group: { _id: '$status', n: { $sum: 1 } } }]).toArray();
    const out: Record<string, number> = {};
    for (const r of rows as Doc[]) out[String(r._id)] = (out[String(r._id)] ?? 0) + Number(r.n);
    return out;
  }
}

// ── memory ─────────────────────────────────────────────────────────────────────────────────────────

/**
 * A thread's append lock: the thread's lock document, written first by every append (and by the thread's
 * deletion) in its transaction, so two of them conflict and the later one runs again. Bounded at 5 s —
 * below run.ts's 60 s append marker, for the reason PgMemoryStore.appendMessages gives.
 */
const THREAD_LOCK_WAIT_MS = 5_000;
const threadLock = (threadId: string) => `t:${threadId}`;
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
/** A memory partition as a condition on thread-id field `field` (`memoryPartitionSql`). */
function partitionOf(p: MemoryPartition, field: string): Doc {
  return p.kind === 'root' ? atRoot(field) : within(field, p.prefix);
}

class MoMemoryStore implements MemoryStore {
  constructor(private readonly boot: () => Promise<Colls>, private readonly tx: Tx) {}
  private async lock(s: Session, threadId: string): Promise<void> {
    const c = await this.boot();
    await c.gnl_locks.updateOne({ _id: threadLock(threadId) }, { $inc: { n: 1 } }, { upsert: true, session: s });
  }
  private lockOpts(threadId: string): TxOptions { return { budgetMs: THREAD_LOCK_WAIT_MS, lock: `thread '${threadId}'` }; }
  async upsertThread(rec: ThreadRecord): Promise<void> {
    const c = await this.boot();
    await c.gnl_threads.updateOne({ _id: rec.id }, {
      $set: { resource_id: rec.resourceId, title: rec.title ?? null, parent_thread_id: rec.parentThreadId ?? null, metadata: rec.metadata ? serialize(rec.metadata) : null, updated_at: rec.updatedAt, deleted_at: rec.deletedAt ?? null },
      $setOnInsert: { created_at: rec.createdAt },
    }, { upsert: true });
  }
  private toThread(x: Doc): ThreadRecord {
    return { id: String(x._id), resourceId: x.resource_id, title: x.title ?? undefined, parentThreadId: x.parent_thread_id ?? undefined, metadata: x.metadata ? deserialize(x.metadata) : undefined, createdAt: Number(x.created_at), updatedAt: Number(x.updated_at), deletedAt: x.deleted_at != null ? Number(x.deleted_at) : undefined };
  }
  async getThread(id: string): Promise<ThreadRecord | undefined> {
    const c = await this.boot();
    const d = await c.gnl_threads.findOne({ _id: id, deleted_at: null });
    return d ? this.toThread(d) : undefined;
  }
  async listThreads(q: { resourceId?: string } & ListQuery & MemoryPartitionOption): Promise<Page<ThreadRecord>> {
    const c = await this.boot();
    const { start, limit } = offset(q);
    const where = all({ deleted_at: null }, partitionOf(memoryPartitionOf(q), '_id'), q.resourceId != null ? { resource_id: q.resourceId } : {});
    const total = await c.gnl_threads.countDocuments(where);
    const docs = await c.gnl_threads.find(where).sort({ updated_at: -1, _id: 1 }).skip(start).limit(limit).toArray();
    return pageOf(docs.map((x: Doc) => this.toThread(x)), start, limit, total);
  }
  /** One transaction under the thread's lock — the lock every append takes (see PgMemoryStore.deleteThread). */
  async deleteThread(id: string): Promise<void> {
    const c = await this.boot();
    await this.tx(async (s) => {
      await this.lock(s, id);
      const o = { session: s };
      await c.gnl_threads.deleteOne({ _id: id }, o);
      await c.gnl_messages.deleteMany({ thread_id: id }, o);
      await c.gnl_working_memory.deleteOne({ _id: workingMemoryScope.thread(id) }, o);
      const legacy = legacyWorkingMemoryScope.thread(id);
      if (legacy !== undefined) await c.gnl_working_memory.deleteOne({ _id: legacy }, o);
      await c.gnl_observations.deleteOne({ _id: id }, o);
      await c.gnl_message_batches.deleteMany({ thread_id: id }, o);
      await c.gnl_locks.deleteOne({ _id: threadLock(id) }, o);
    }, { lock: `thread '${id}'` });
  }
  /** The next position on a thread, read under its lock. */
  private async nextSeq(s: Session, threadId: string): Promise<number> {
    const c = await this.boot();
    const top = await c.gnl_messages.find({ thread_id: threadId }, { session: s, projection: { seq: 1 } }).sort({ seq: -1 }).limit(1).toArray();
    return top.length ? Number(top[0].seq) + 1 : 0;
  }
  /**
   * The rows of one append, positioned: assigned from `next`, or the caller's. A caller-supplied position
   * already written is the documented idempotent case (Postgres: ON CONFLICT DO NOTHING) and is left out;
   * read under the lock, so no other append can write one meanwhile.
   */
  private async positioned(s: Session, threadId: string, rows: MessageAppend[], next: number): Promise<{ docs: Doc[]; next: number }> {
    const c = await this.boot();
    const explicit = rows.filter((r) => r.seq !== undefined).map((r) => r.seq!);
    const taken = new Set<number>(explicit.length
      ? (await c.gnl_messages.find({ thread_id: threadId, seq: { $in: explicit } }, { session: s, projection: { seq: 1 } }).toArray()).map((d: Doc) => Number(d.seq))
      : []);
    const docs: Doc[] = [];
    for (const r of rows) {
      const seq = r.seq ?? next++;
      if (r.seq !== undefined && taken.has(seq)) continue;
      taken.add(seq);
      docs.push({ thread_id: threadId, seq, role: r.role, text: r.text ?? null, embedding: r.embedding ?? null, metadata: r.metadata ? serialize(r.metadata) : null, ts: r.ts, message: serialize(r.message) });
    }
    return { docs, next };
  }
  /** One transaction under the thread's lock: the batch's marker read first, then its rows (see PgMemoryStore.appendMessagesOnce). */
  async appendMessagesOnce(threadId: string, rows: MessageAppend[], batchKey: string): Promise<boolean> {
    const assign = assertUniformSeq(threadId, rows);
    const c = await this.boot();
    return this.tx(async (s) => {
      await this.lock(s, threadId);
      if (await c.gnl_message_batches.findOne({ thread_id: threadId, batch_key: batchKey }, { session: s, projection: { _id: 1 } })) return false;
      const from = assign ? await this.nextSeq(s, threadId) : 0;
      const { docs, next } = await this.positioned(s, threadId, rows, from);
      if (docs.length) await c.gnl_messages.insertMany(docs, { session: s });
      await c.gnl_message_batches.insertOne({ thread_id: threadId, batch_key: batchKey, seq_from: from, seq_to: next, ts: Date.now() }, { session: s });
      return true;
    }, this.lockOpts(threadId)).catch((e: unknown) => { throw lockWaitAdvice(e, threadId, rows.length); });
  }
  /** One transaction under the thread's lock, for every append, explicit positions too (see PgMemoryStore.appendMessages). */
  async appendMessages(threadId: string, rows: MessageAppend[]): Promise<void> {
    if (rows.length === 0) return;
    const assign = assertUniformSeq(threadId, rows);
    const c = await this.boot();
    await this.tx(async (s) => {
      await this.lock(s, threadId);
      const { docs } = await this.positioned(s, threadId, rows, assign ? await this.nextSeq(s, threadId) : 0);
      if (docs.length) await c.gnl_messages.insertMany(docs, { session: s });
    }, this.lockOpts(threadId)).catch((e: unknown) => { throw lockWaitAdvice(e, threadId, rows.length); });
  }
  private toMsg(x: Doc): MessageRecord {
    return { threadId: x.thread_id, seq: Number(x.seq), role: x.role, text: x.text ?? undefined, embedding: x.embedding ?? undefined, metadata: x.metadata ? deserialize(x.metadata) : undefined, ts: Number(x.ts), message: deserialize(x.message) };
  }
  async getMessages(threadId: string, q?: ListQuery): Promise<Page<MessageRecord>> {
    const c = await this.boot();
    const { start, limit } = offset(q);
    const total = await c.gnl_messages.countDocuments({ thread_id: threadId });
    const docs = await c.gnl_messages.find({ thread_id: threadId }).sort({ seq: 1 }).skip(start).limit(limit).toArray();
    return pageOf(docs.map((x: Doc) => this.toMsg(x)), start, limit, total);
  }
  async deleteMessagesAfter(threadId: string, afterSeq: number): Promise<number> {
    const c = await this.boot();
    const r = await c.gnl_messages.deleteMany({ thread_id: threadId, seq: { $gt: afterSeq } });
    await c.gnl_message_batches.deleteMany({ thread_id: threadId, seq_to: { $gt: afterSeq } });
    return r.deletedCount;
  }
  /** See `MemoryStore.retractBatch`: the batch's rows and its record, one transaction under the thread's lock. */
  async retractBatch(threadId: string, batchKey: string): Promise<number> {
    const c = await this.boot();
    return this.tx(async (s) => {
      await this.lock(s, threadId);
      const b = await c.gnl_message_batches.findOne({ thread_id: threadId, batch_key: batchKey }, { session: s });
      if (!b) return 0;
      await c.gnl_message_batches.deleteOne({ _id: b._id }, { session: s });
      return (await c.gnl_messages.deleteMany({ thread_id: threadId, seq: { $gte: Number(b.seq_from), $lt: Number(b.seq_to) } }, { session: s })).deletedCount;
    }, { lock: `thread '${threadId}'` });
  }
  async deletePartition(partition: string): Promise<number> {
    assertOrganizationPartition(partition);
    const c = await this.boot();
    return this.tx(async (s) => {
      let n = 0;
      for (const [table, column, store, counted] of SCOPE_TABLES) {
        if (store !== 'memory' || !counted) continue;
        n += (await c[table as Name].deleteMany(within(fieldOf(table, column), partition), { session: s })).deletedCount;
      }
      await c.gnl_locks.deleteMany(within('_id', threadLock(partition)), { session: s });
      return n;
    });
  }
  async recall(threadId: string, query: number[], opts: RecallOptions): Promise<MessageRecord[]> {
    if (!hasNorm(query)) return [];
    const c = await this.boot();
    let docs: Doc[];
    if (opts.scope === 'resource' && opts.resourceId) {
      const threads = await c.gnl_threads.find(all({ resource_id: opts.resourceId, deleted_at: null }, partitionOf(memoryPartitionOf(opts), '_id')), { projection: { _id: 1 } }).toArray();
      docs = threads.length ? await c.gnl_messages.find({ thread_id: { $in: threads.map((t: Doc) => t._id) } }).sort({ thread_id: 1, seq: 1 }).toArray() : [];
    } else {
      docs = await c.gnl_messages.find({ thread_id: threadId }).sort({ seq: 1 }).toArray();
    }
    const byThread = new Map<string, MessageRecord[]>();
    for (const x of docs) { const m = this.toMsg(x); const a = byThread.get(m.threadId) ?? []; a.push(m); byThread.set(m.threadId, a); }
    const threshold = opts.threshold ?? 0;
    const cand: { m: MessageRecord; tid: string; idx: number; score: number }[] = [];
    for (const [tid, msgs] of byThread) msgs.forEach((m, idx) => {
      if (!hasNorm(m.embedding)) return;
      const score = cosineSimilarity(query, m.embedding);
      if (score > 0 && score >= threshold) cand.push({ m, tid, idx, score });
    });
    let scored = cand;
    if (opts.filter) scored = scored.filter((x) => matchFilter(x.m.metadata, opts.filter!));
    scored.sort((a, b) => b.score - a.score);
    const hits = scored.slice(0, opts.topK ?? 3);
    const r = normRange(opts.messageRange);
    const picked = new Map<string, MessageRecord>();
    for (const h of hits) {
      const msgs = byThread.get(h.tid)!;
      const lo = Math.max(0, h.idx - r.before), hi = Math.min(msgs.length - 1, h.idx + r.after);
      for (let i = lo; i <= hi; i++) picked.set(`${h.tid}:${msgs[i]!.seq}`, msgs[i]!);
    }
    for (const h of hits) picked.set(`${h.tid}:${h.m.seq}`, { ...h.m, score: h.score });
    return [...picked.values()].sort((a, b) => a.ts - b.ts || a.seq - b.seq);
  }
  async getWorkingMemory(scopeId: string): Promise<unknown> {
    const c = await this.boot();
    const d = await c.gnl_working_memory.findOne({ _id: scopeId });
    return d ? deserialize(d.data) : undefined;
  }
  async setWorkingMemory(scopeId: string, data: unknown): Promise<void> {
    const c = await this.boot();
    await c.gnl_working_memory.updateOne({ _id: scopeId }, { $set: { data: serialize(data), updated_at: Date.now() } }, { upsert: true });
  }
  async deleteWorkingMemory(scopeId: string): Promise<boolean> {
    const c = await this.boot();
    return (await c.gnl_working_memory.deleteOne({ _id: scopeId })).deletedCount > 0;
  }
  async getObservations(threadId: string): Promise<Observation[]> {
    const c = await this.boot();
    const d = await c.gnl_observations.findOne({ _id: threadId });
    return d ? deserialize<Observation[]>(d.obs) : [];
  }
  async putObservations(threadId: string, obs: Observation[]): Promise<void> {
    const c = await this.boot();
    await c.gnl_observations.updateOne({ _id: threadId }, { $set: { obs: serialize(obs) } }, { upsert: true });
  }
}

// ── vectors ────────────────────────────────────────────────────────────────────────────────────────

/** Outside the organizations' space, for a vector's namespace: none, or one that is not an organization's. */
const VECTOR_OUTSIDE_ORGANIZATIONS: Doc = { $or: [{ namespace: null }, atRoot('namespace')] };

class MoVectorStore implements VectorStore {
  readonly rootOutsideOrganizations = true;
  constructor(private readonly boot: () => Promise<Colls>, private readonly tx: Tx) {}
  /** The length of the vectors held (`assertVectorDimension`), from any one document; `undefined` when there are none. */
  private async dimension(s?: Session): Promise<number | undefined> {
    const c = await this.boot();
    const d = await c.gnl_vectors.findOne({}, { projection: { embedding: 1 }, ...(s ? { session: s } : {}) });
    return d ? (d.embedding as number[]).length : undefined;
  }
  /** One transaction: each document read in its snapshot, its owner checked, then written (see PgVectorStore.upsert). */
  async upsert(items: VectorItem[]): Promise<void> {
    const batch = vectorWriteBatch(items);
    if (!batch.length) return;
    const c = await this.boot();
    await this.tx(async (s) => {
      assertVectorDimension(await this.dimension(s), batch[0]!.embedding.length, 'write');
      const held = new Map<string, Doc>();
      for (const it of batch) {
        const d = await c.gnl_vectors.findOne({ _id: it.id }, { session: s, projection: { namespace: 1, owner: 1, shared: 1 } });
        if (d) held.set(it.id, d);
        assertSameVectorOwner(d ? { namespace: d.namespace, owner: d.owner, shared: d.shared } : undefined, it);
      }
      for (const it of batch) {
        const fields = { text: it.text, embedding: it.embedding, metadata: it.metadata ? serialize(it.metadata) : null, doc: vectorDocumentOf(it.metadata) ?? '' };
        if (held.has(it.id)) { await c.gnl_vectors.updateOne({ _id: it.id }, { $set: fields }, { session: s }); continue; }
        // Absent from this snapshot: a writer that inserted it since makes this a duplicate, and the
        // transaction runs again, reading that document's owner.
        try {
          await c.gnl_vectors.insertOne({ _id: it.id, ...fields, namespace: it.namespace ?? null, owner: it.owner ?? null, shared: it.shared ? true : null, created_at: Date.now() }, { session: s });
        } catch (e) { if (isDup(e)) throw RETRY; throw e; }
      }
    });
  }
  async delete(where: VectorDeleteWhere): Promise<number> {
    const w = vectorDeletePlan(where);
    if (!w) return 0;
    const c = await this.boot();
    const conds: Doc[] = [];
    if (w.ids) conds.push({ _id: { $in: w.ids } });
    if (w.owner !== undefined) conds.push({ owner: w.owner });
    if (w.namespace !== undefined) conds.push({ namespace: w.namespace });
    if (w.outsideOrganizations) conds.push(VECTOR_OUTSIDE_ORGANIZATIONS);
    if (!w.filter) return (await c.gnl_vectors.deleteMany(all(...conds))).deletedCount;
    const filter = w.filter;
    const doc = vectorFilterDocument(filter);
    if (doc !== undefined) conds.push({ doc: { $in: [doc, null] } });
    return this.tx(async (s) => {
      const rows = await c.gnl_vectors.find(all(...conds), { session: s, projection: { metadata: 1 } }).toArray();
      const ids = rows.filter((r: Doc) => vectorMetadataMatches(r.metadata ? deserialize<Record<string, unknown>>(r.metadata) : undefined, filter)).map((r: Doc) => r._id);
      return ids.length ? (await c.gnl_vectors.deleteMany({ _id: { $in: ids } }, { session: s })).deletedCount : 0;
    });
  }
  async query(embedding: number[], topK: number, opts?: VectorQueryOptions): Promise<VectorMatch[]> {
    const scope = vectorQueryScope(opts);
    assertVectorDimension(await this.dimension(), embedding.length, 'query');
    if (scope.none) return [];
    const c = await this.boot();
    const conds: Doc[] = [];
    if (scope.namespace !== undefined) conds.push({ namespace: scope.namespace });
    if (scope.outsideOrganizations) conds.push(VECTOR_OUTSIDE_ORGANIZATIONS);
    if (scope.visibleTo !== undefined) conds.push({ $or: [{ shared: true }, { owner: scope.visibleTo }] });
    const doc = vectorFilterDocument(opts?.filter);
    if (doc !== undefined) conds.push({ doc: { $in: [doc, null] } });
    const rows = await c.gnl_vectors.find(all(...conds)).toArray() as Doc[];
    return rankVectorMatches(rows
      .map((x) => ({ id: String(x._id), text: x.text, metadata: x.metadata ? deserialize<Record<string, unknown>>(x.metadata) : undefined, ...(x.namespace != null ? { namespace: x.namespace as string } : {}), ...(x.owner != null ? { owner: x.owner as string } : {}), ...(x.shared ? { shared: true } : {}), score: cosineSimilarity(embedding, x.embedding) }))
      .filter((m) => vectorMetadataMatches(m.metadata, opts?.filter)), topK); // filtered before ranking
  }
}

// ── work ───────────────────────────────────────────────────────────────────────────────────────────

class MoWorkStore implements WorkStore {
  constructor(private readonly boot: () => Promise<Colls>, private readonly tx: Tx, private readonly nextOrd: (name: string) => Promise<number>) {}
  /** Written UNNUMBERED (`seq` 0) and numbered by the first `list` that sees it (see PgWorkStore.append). */
  async append(ns: string, payload: unknown, id?: string): Promise<string> {
    const c = await this.boot();
    const eid = id ?? `${ns}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`;
    try { await c.gnl_work_log.insertOne({ ns, id: eid, payload: serialize(payload), ts: Date.now(), seq: 0, ord: await this.nextOrd('work') }); } catch (e) { if (!isDup(e)) throw e; }
    return eid;
  }
  /**
   * Numbers the namespace's unnumbered records after every number handed out so far (see
   * PgWorkStore.numberNew): the namespace's counter document is written first, so two numberings conflict
   * and the later one runs again from a snapshot that holds the first's numbers; a record appended after
   * the snapshot is numbered by a later call, with a larger number; each is numbered only while unnumbered.
   */
  private async numberNew(ns: string, max: number): Promise<void> {
    const c = await this.boot();
    if (!(await c.gnl_work_log.findOne({ ns, seq: 0 }, { projection: { _id: 1 } }))) return;
    await this.tx(async (s) => {
      const o = { session: s };
      const top = Number((await c.gnl_work_seq.findOneAndUpdate({ _id: ns }, { $inc: { lk: 1 }, $setOnInsert: { seq: 0 } }, { upsert: true, returnDocument: 'after', ...o })).seq ?? 0);
      const rows = await c.gnl_work_log.find({ ns, seq: 0 }, { ...o, projection: { id: 1 } }).sort({ ord: 1, ts: 1, id: 1 }).limit(max).toArray() as Doc[];
      if (!rows.length) return;
      await c.gnl_work_seq.updateOne({ _id: ns }, { $inc: { seq: rows.length } }, o);
      await c.gnl_work_log.bulkWrite(rows.map((r, i) => ({ updateOne: { filter: { _id: r._id, seq: 0 }, update: { $set: { seq: top + 1 + i } } } })), o);
    });
  }
  async list<T = unknown>(ns: string, q?: ListQuery): Promise<Page<LogRecord<T>>> {
    const c = await this.boot();
    const limit = q?.limit ?? 50;
    await this.numberNew(ns, Math.max(NUMBER_BATCH, limit + 1));
    const after = decodeLogCursor(q?.cursor);
    const position = after
      ? { $or: [{ seq: { $gt: after.seq } }, { seq: after.seq, ts: { $gt: after.ts } }, { seq: after.seq, ts: after.ts, id: { $gt: after.id } }] }
      : {};
    const docs = await c.gnl_work_log.find(all({ ns, seq: { $gt: 0 } }, position), { projection: { id: 1, payload: 1, ts: 1, seq: 1 } }).sort({ seq: 1, ts: 1, id: 1 }).limit(limit + 1).toArray();
    const rows = docs.map((x: Doc) => ({ id: String(x.id), payload: x.payload as string, ts: Number(x.ts), seq: Number(x.seq) }));
    const more = rows.length > limit;
    if (more) rows.pop();
    const last = rows[rows.length - 1];
    return { items: rows.map((x: { id: string; payload: string; ts: number }) => ({ id: x.id, payload: deserialize<T>(x.payload), ts: x.ts })), nextCursor: more && last ? encodeLogCursor(last) : undefined };
  }
  async get<T = unknown>(key: string): Promise<T | undefined> {
    const c = await this.boot();
    const d = await c.gnl_work_kv.findOne({ _id: key });
    return d ? deserialize<T>(d.v) : undefined;
  }
  async put(key: string, value: unknown): Promise<void> {
    const c = await this.boot();
    await c.gnl_work_kv.updateOne({ _id: key }, { $set: { v: serialize(value) } }, { upsert: true });
  }
  async ackOnce(key: string): Promise<boolean> {
    const c = await this.boot();
    try { await c.gnl_work_kv.insertOne({ _id: key, v: serialize(true) }); return true; } catch (e) { if (isDup(e)) return false; throw e; }
  }
  async putIfMatch(key: string, expected: unknown, value: unknown): Promise<boolean> {
    const c = await this.boot();
    return (await c.gnl_work_kv.updateOne({ _id: key, v: serialize(expected) }, { $set: { v: serialize(value) } })).matchedCount === 1;
  }
  async deletePrefix(prefix: string): Promise<number> {
    const c = await this.boot();
    const l = await c.gnl_work_log.deleteMany(within('ns', prefix));
    const k = await c.gnl_work_kv.deleteMany(within('_id', prefix));
    return l.deletedCount + k.deletedCount;
  }
  async deleteIdPrefix(idPrefix: string): Promise<number> {
    const c = await this.boot();
    return (await c.gnl_work_log.deleteMany(within('id', idPrefix))).deletedCount;
  }
}

class MoCacheStore implements CacheStore {
  constructor(private readonly boot: () => Promise<Colls>) {}
  async get<T = unknown>(key: string): Promise<T | undefined> {
    const c = await this.boot();
    const d = await c.gnl_cache.findOne({ _id: key });
    if (!d) return undefined;
    if (d.expires_at != null && Number(d.expires_at) <= Date.now()) { await c.gnl_cache.deleteOne({ _id: key }); return undefined; }
    return deserialize<T>(d.v);
  }
  async set(key: string, value: unknown, opts?: { ttlMs?: number }): Promise<void> {
    const c = await this.boot();
    await c.gnl_cache.updateOne({ _id: key }, { $set: { v: serialize(value), expires_at: opts?.ttlMs != null ? Date.now() + opts.ttlMs : null } }, { upsert: true });
  }
  async delete(key: string): Promise<void> { const c = await this.boot(); await c.gnl_cache.deleteOne({ _id: key }); }
  /** A literal prefix delete; an empty prefix deletes nothing. */
  async deletePrefix(prefix: string): Promise<number> {
    if (prefix === '') return 0;
    const c = await this.boot();
    return (await c.gnl_cache.deleteMany(within('_id', prefix))).deletedCount;
  }
}

class MoMetaStore implements MetaStore {
  constructor(private readonly boot: () => Promise<Colls>) {}
  async get(key: string): Promise<string | undefined> {
    const c = await this.boot();
    return (await c.gnl_meta.findOne({ _id: key }))?.v;
  }
  async set(key: string, value: string): Promise<void> {
    const c = await this.boot();
    await c.gnl_meta.updateOne({ _id: key }, { $set: { v: value } }, { upsert: true });
  }
  /** A literal prefix delete; an empty prefix deletes nothing. */
  async deletePrefix(prefix: string): Promise<number> {
    if (prefix === '') return 0;
    const c = await this.boot();
    return (await c.gnl_meta.deleteMany(within('_id', prefix))).deletedCount;
  }
}

// ── process liveness ───────────────────────────────────────────────────────────────────────────────

export interface MongoLivenessOptions {
  /** The replica set's connection string (see `MongoStorageOptions.connectionString`). */
  connectionString: string;
  /** The database the users register in (see below), when the connection string names none. */
  database?: string;
  /** A name for this process — the prefix of its liveness id (see `postgresLiveness`). */
  id?: string;
  /** How often this process proves its own connection (and how stale a proof `confirm()` accepts); a proof not answered within one more is a lost connection. Default 1 s. */
  heartbeatMs?: number;
  /** How long a holder's connection must be gone before it reads as dead, and a live process has to open it again (see `postgresLiveness`). Default 5 s, at least 4 × `heartbeatMs`. */
  reconnectGraceMs?: number;
}

/** A process liveness on MongoDB, and which connections it can see. */
export interface MongoProcessLiveness extends ProcessLiveness {
  readonly visibility: ConnectionVisibility;
}

/** The register of the users that opened a liveness on a database, and whether each sees every user. */
const LIVENESS_USERS = 'gnl_liveness_users';
const appNameMax = 100;

/**
 * A process lock on a MongoDB replica set: a dedicated client whose one connection is named for the
 * process (`appName`), held for the life of the process. Another process asks the server whether a
 * connection of that name exists (`$currentOp` with idle connections). The server holds the connection
 * while its TCP session lives — through a freeze (a frozen process's kernel still answers on its socket)
 * — and drops it the moment the process exits or crashes (its kernel closes the socket). A PARTITIONED
 * host's connection ends only when the server's TCP keepalive gives up: the server host's
 * net.ipv4.tcp_keepalive_* — measured 13–14 s at 10 / 5 / 3. mongod lowers a longer idle time to 300 s
 * on its connections, so the Linux defaults leave a cut-off process holding its runs for ~5.5 minutes
 * (measured: 334 s): never run twice, but not taken over either. A client cannot read the setting (see
 * `durabilityReport`).
 *
 * WHO MAY SEE WHOM. A connection is visible to another user only with the `inprog` action (the
 * `clusterMonitor` role). Without it, MongoDB 8.0 shows a user its own other connections and 8.3 only the
 * connection that asks. A process that cannot see a live holder would read it as dead and run its call
 * a second time — so before it is handed out this liveness looks for its own connection from a second
 * connection, and refuses when it cannot see it; and it registers its user in `gnl_liveness_users`,
 * refusing to run beside another user when either of the two sees only its own.
 *
 * When the driver closes the connection (a network error, a failover, a pool clear) the process is not
 * gone: it opens a connection under the SAME name again, and the others read it as dead only once no
 * connection of that name has been seen for `reconnectGraceMs` (see `postgresLiveness`). `confirm()` is
 * false until it is back.
 */
export async function mongoLiveness(opts: MongoLivenessOptions): Promise<MongoProcessLiveness> {
  refuseUnknownNames('mongoLiveness', opts, MONGO_LIVENESS_NAMES);
  const heartbeatMs = opts.heartbeatMs ?? HEARTBEAT_MS;
  if (!(heartbeatMs > 0 && heartbeatMs <= 60_000)) throw new Error(`@gnldev/durable: mongoLiveness heartbeatMs must be between 1 and 60000 ms; got ${heartbeatMs}`);
  const reconnectGraceMs = reconnectGraceOf('mongoLiveness', opts.reconnectGraceMs, heartbeatMs);
  if (!opts?.connectionString) throw new Error('@gnldev/durable: mongoLiveness needs a connectionString');
  if (opts.id !== undefined && opts.id.length > appNameMax - 40) throw new Error(`@gnldev/durable: mongoLiveness id must be at most ${appNameMax - 40} characters (it names the connection); got ${opts.id.length}`);
  const url = opts.connectionString;
  const dbName = databaseOf(url, opts.database, 'mongoLiveness');
  const { MongoClient } = driver();
  type Held = { client: Any; id: string; visibility: ConnectionVisibility; broken: boolean };
  let held: Held | undefined;
  const open = async (sid: string): Promise<Held> => {
    const client = new MongoClient(url, { appName: sid, maxPoolSize: 1, minPoolSize: 1, serverSelectionTimeoutMS: 10_000, retryReads: false, retryWrites: false });
    const h: Held = { client, id: sid, visibility: 'every user', broken: false };
    let created = 0;
    // Any sign that the one connection is not the one it was: the id is no longer this process's.
    const gone = () => { h.broken = true; if (held === h) lost(); };
    client.on('connectionCreated', () => { if (++created > 1) gone(); });
    client.on('connectionClosed', gone);
    client.on('connectionPoolCleared', gone);
    try {
      refuseTopology(await client.db('admin').command({ hello: 1 }), 'mongoLiveness');
      h.visibility = await checkVisibility(url, dbName, sid);
      if (h.broken) throw new Error('@gnldev/durable: the MongoDB liveness connection was replaced while it opened');
      return h;
    } catch (e) {
      await client.close().catch(() => undefined);
      throw e;
    }
  };
  const id = livenessIdOf(opts.id);
  held = await open(id);
  // The visibility last held: kept while a lost connection is replaced (`confirm()` is false meanwhile).
  let visibility = held.visibility;
  let healthy = true;
  let closed = false;
  let provenAt = performance.now();
  let reopening: Promise<void> | undefined;
  const signals = sessionSignals(reconnectGraceMs);
  /** The connection is gone, the process is not: it opens one under the SAME name again (see postgresLiveness). */
  function lost(): void {
    healthy = false;
    const was = held;
    held = undefined;
    void was?.client.close().catch(() => undefined);
    if (closed || reopening) return;
    reopening = (async () => {
      for (let wait = 50; !closed; wait = Math.min(wait * 2, 1_000)) {
        try {
          const next = await open(id);
          if (closed) { await next.client.close().catch(() => undefined); return; }
          held = next;
          visibility = next.visibility;
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
  const current = (): Held => {
    const h = held;
    if (!healthy || !h || h.broken) throw new LivenessUnavailableError();
    return h;
  };
  let proving: Promise<boolean> | undefined;
  /** One proof at a time, answered within a heartbeat or the connection is lost (`proofWithin`). */
  const holdsOwn = (): Promise<boolean> => proving ??= (async () => {
    const h = held;
    if (!healthy || !h || h.broken) return false;
    const ok = await proofWithin(h.client.db('admin').command({ ping: 1 }).then(() => true), heartbeatMs);
    if (h.broken || held !== h) return false;
    if (ok) { provenAt = performance.now(); signals.proven(); } else lost();
    return ok;
  })().finally(() => { proving = undefined; });
  const beat = setInterval(() => { void holdsOwn(); }, heartbeatMs);
  beat.unref?.();
  return {
    id,
    reconnectGraceMs,
    sessionSignal: signals.signal,
    get visibility() { return visibility; },
    async isAlive(other) {
      const h = current();
      if (other === h.id) return true;
      try {
        return (await connectionsNamed(h.client, other, h.visibility === 'every user')) > 0;
      } catch {
        if (held === h) lost();
        throw new LivenessUnavailableError();
      }
    },
    async confirm(maxAgeMs = heartbeatMs) {
      if (!healthy || !held || held.broken) return false;
      if (performance.now() - provenAt < maxAgeMs) return true;
      return holdsOwn();
    },
    async close() {
      if (closed) return;
      closed = true;
      clearInterval(beat);
      signals.close();
      healthy = false;
      const h = held;
      held = undefined;
      // A connection lost silently never answers the goodbye: a heartbeat at most, then on.
      if (h) await proofWithin(h.client.close().then(() => true), heartbeatMs);
      await goneFromServer(url, id, visibility === 'every user');
    },
  };
}

/**
 * Returns once the server holds no connection named `appName`, as another connection sees it. The server
 * drops a closed connection from `$currentOp` a moment after the client closes it: measured with 12
 * processes closing at once, a closed liveness still read alive right after its close in 252 of 1,200
 * closes (raporlar/2026-10-19-mongo-close). Gives up when the server cannot be asked (it then holds no
 * connection anyone can see) or after `CLOSE_SETTLE_MS` (the others then read it alive a while longer:
 * a later takeover, never a second holder).
 */
async function goneFromServer(url: string, appName: string, allUsers: boolean): Promise<void> {
  const probe = new (driver().MongoClient)(url, { maxPoolSize: 1, serverSelectionTimeoutMS: 2_000 });
  try {
    const until = performance.now() + CLOSE_SETTLE_MS;
    while ((await connectionsNamed(probe, appName, allUsers)) > 0 && performance.now() < until) {
      await new Promise((r) => setTimeout(r, 5));
    }
  } catch { /* the server cannot be asked */ } finally {
    await probe.close().catch(() => undefined);
  }
}
const CLOSE_SETTLE_MS = 10_000;

/** How many connections named `appName` the server holds, as `client` can see them. */
async function connectionsNamed(client: Any, appName: string, allUsers: boolean): Promise<number> {
  const r = await client.db('admin').aggregate([{ $currentOp: { allUsers, idleConnections: true } }, { $match: { appName } }, { $limit: 1 }]).toArray();
  return r.length;
}

/**
 * Whether this process can see other processes' connections, answered from a second connection: it must
 * find the liveness connection `appName`. With the `inprog` action it sees every user's; without it,
 * only its own user's (where the server shows those at all). Then the register: this user is recorded,
 * and refused beside any other user when either of the two cannot see the other's connections. A refused
 * user's new entry is taken back.
 */
async function checkVisibility(url: string, dbName: string, appName: string): Promise<ConnectionVisibility> {
  const probe = new (driver().MongoClient)(url, { maxPoolSize: 1, serverSelectionTimeoutMS: 10_000 });
  try {
    let visibility: ConnectionVisibility = 'every user';
    let seen: number;
    try { seen = await connectionsNamed(probe, appName, true); } catch (e) {
      if (codeOf(e) !== UNAUTHORIZED) throw e;
      visibility = 'this user';
      seen = await connectionsNamed(probe, appName, false);
    }
    const status = await probe.db(dbName).command({ connectionStatus: 1 });
    const u = status?.authInfo?.authenticatedUsers?.[0] as { user: string; db: string } | undefined;
    const me = u ? `${u.db}.${u.user}` : '';
    if (!seen) {
      throw new Error(`@gnldev/durable: this process cannot see its own liveness connection from another connection, so it cannot see other processes' connections either: `
        + `user '${me || '(none)'}' lacks the inprog action, and this server shows such a user only the connection that asks. A process that cannot see a live holder `
        + 'would read it as dead and run its call a second time. Grant the user the clusterMonitor role (db.grantRolesToUser(user, [{ role: "clusterMonitor", db: "admin" }])). '
        + 'Refused before this process took anything.');
    }
    const users = probe.db(dbName).collection(LIVENESS_USERS);
    const r = await users.updateOne({ _id: me }, { $set: { seesAll: visibility === 'every user', at: new Date() } }, { upsert: true });
    const others = (await users.find({ _id: { $ne: me } }).toArray()) as Doc[];
    const blind = others.filter((o) => visibility !== 'every user' || !o.seesAll);
    if (blind.length) {
      if (r.upsertedCount) await users.deleteOne({ _id: me }).catch(() => undefined);
      const names = blind.map((o) => `'${o._id || '(none)'}'${o.seesAll ? '' : ' (sees only its own connections)'}`).join(', ');
      throw new Error(`@gnldev/durable: user '${me || '(none)'}'${visibility === 'every user' ? '' : ' (which sees only its own connections)'} would run beside ${names} on database '${dbName}', `
        + 'and one of them cannot see the other\'s connections: it would read the other\'s live calls as abandoned and run them a second time. '
        + 'Grant the clusterMonitor role to every user that runs processes here, or run them all as one user. '
        + `A user that no longer runs here is removed from the register with db.${LIVENESS_USERS}.deleteOne({ _id: '<user>' }). Refused before this process took anything.`);
    }
    return visibility;
  } finally { await probe.close().catch(() => undefined); }
}
