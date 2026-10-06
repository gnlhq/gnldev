// @gnldev/durable/redis — Redis implementation of RunJournal + WorkStore + CacheStore + MetaStore.
// Ports where Redis is STRONG: KV + atomic CAS (SET NX) + native TTL (SET PX) + queue/log.
// SAME serialization (serialize.ts / superjson) and SAME contracts (Page/ListQuery,
// exactly-once CAS, readRun ORDER BY created_at,key) as Sqlite/Postgres. Injectable client + lazy `createRequire`
// pattern (identical to PostgresStorage.pool and rag/PostgresVectorStore): `ioredis` is an OPTIONAL peer dependency;
// it's only loaded when `client` is not provided → the bundler can't see it statically, a fake RedisLike is given in tests.
//
// CAPABILITY DECISION (honest matrix — see storage.ts CapabilityMatrix):
//   runs='full', work='full', cache='ttl', memory='none', vectors='none'.
// Redis (WITHOUT the RediSearch/RedisJSON modules) is weak for queryable memory + vector recall:
//   recall (MemoryStore) needs vector similarity; doing that brute-force in Redis would require pulling
// ALL messages into the app (no index) → contrary to the point of deploying Redis (memory pressure). The Sqlite
//   adapter solves recall via a table scan and offers memory='full', but that's node-local; Redis is a
//   networked cache/queue store. So the memory/vectors ports are NOT PROVIDED (undefined) and capability='none' →
//   overridden to sqlite/postgres/pgvector via composite() (storage.ts composite philosophy). runs+meta+work+cache
//   are provided locally; Redis is typically used in a composite as a cache/work override or as the
//   runs+work+cache default.
import { createRequire } from 'node:module';
import { runIdOfKey, parseJournalKey, deriveRunStatus } from './journal.js';
import { pageRunsFromArray } from './run-cursor.js';
import { stableStringify } from './hash.js';
import { ENGINE_META_KEYS, assertNoRunsInFlight, assertOrgRegistered, isPlatformKey, orgPrefix, isOrganizationKey } from './organization.js';
import type { JournalBatch, JournalEntry, RunSummary, ToolJournalRecord } from './journal.js';
import { serialize, deserialize } from './serialize.js';
import { ReplicationNotAcknowledgedError } from './errors.js';
import type { AdoptIntoOrgResult,
  Storage, CapabilityMatrix, Page, ListQuery,
  RunJournal, WorkStore, CacheStore, MetaStore, LogRecord,
} from './storage.js';
import { NUMBER_BATCH, decodeLogCursor, encodeLogCursor, compareLogPosition, workKeyAdoption, workKeyAdoptCollision } from './storage.js';
import { refuseUnknownNames } from '@gnldev/options';
import { REDIS_STORAGE_NAMES, ADOPT_INTO_ORG_NAMES } from './option-names.js';

const SCHEMA_VERSION = '1';

/** Minimal ioredis surface — injectable for test/custom setup (same pattern as PostgresStorage.pool). */
export interface RedisLike {
  get(key: string): Promise<string | null>;
  /** ioredis variadic SET: `set(k,v,'NX')` · `set(k,v,'PX',ms)` · `set(k,v,'PX',ms,'NX')` → 'OK' | null. */
  set(key: string, value: string, ...args: (string | number)[]): Promise<string | null>;
  del(...keys: string[]): Promise<number>;
  /** `scan(cursor,'MATCH',pattern,'COUNT',n)` → [nextCursor, keys]. */
  scan(cursor: string | number, ...args: (string | number)[]): Promise<[string, string[]]>;
  /** OPTIONAL bulk GET (available in ioredis). If absent, bulkGet() falls back to sequential get — custom clients don't break. */
  mget?(...keys: string[]): Promise<(string | null)[]>;
  /** OPTIONAL atomic hash-field increment (H8a counters) — available in ioredis. */
  hincrbyfloat?(key: string, field: string, delta: number): Promise<string>;
  /** OPTIONAL hash read (H8a counters). */
  hgetall?(key: string): Promise<Record<string, string>>;
  /** OPTIONAL Lua eval (available in ioredis) — for H1 putIfMatch CAS. Falls back to best-effort if absent. */
  eval?(script: string, numKeys: number, ...args: (string | number)[]): Promise<unknown>;
  /** OPTIONAL TIME (available in ioredis) — `[seconds, microseconds]` for H2 now(). Falls back to Date.now if absent. */
  time?(): Promise<[string, string]>;
  /** OPTIONAL STRLEN (available in ioredis) — for H8c readRunStats, measures length WITHOUT transferring
   *  the value content. Falls back to the MGET fallback in readRunStats if absent (see readRunStats comment). */
  strlen?(key: string): Promise<number>;
  /** OPTIONAL ZSET add (available in ioredis) — H8b last-activity index: score=epoch ms, member=runId. */
  zadd?(key: string, score: number, member: string): Promise<number>;
  /** OPTIONAL ZSET range query (same contract as ioredis ZRANGEBYSCORE — `'-inf'`/`'+inf'`/
   *  `'(x'` (exclusive upper bound) are supported) → member list in ASCENDING score order. */
  zrangebyscore?(key: string, min: number | string, max: number | string): Promise<string[]>;
  /** OPTIONAL ZSET member removal (available in ioredis) — used by H8b deletePrefix to drop a dead run's summary from the ZSET. */
  zrem?(key: string, ...members: string[]): Promise<number>;
  /** OPTIONAL ZSET range by member (available in ioredis) — with `zadd`, the key index (KeyIndex) that
   *  lists a prefix without walking the database. Absent → the adapter lists by SCAN, as before. */
  zrangebylex?(key: string, min: string, max: string, ...args: (string | number)[]): Promise<string[]>;
  /** OPTIONAL ZSET removal by member range (available in ioredis) — the key index's half of a prefix delete. */
  zremrangebylex?(key: string, min: string, max: string): Promise<number>;
  /** OPTIONAL pipeline/transaction (SAME shape as ioredis multi() — ChainableCommander) — to fold the
   *  +1 round-trip (separate ZADD call) that the H8b touch ZSET adds to put/putIfAbsent/putIfMatch into
   *  the SAME round-trip as the SET (or CAS). If absent (or zadd is absent), the existing separate-call
   *  behavior (documented, see touch() JSDoc) is PRESERVED. */
  multi?(): RedisPipeline;
  quit?(): Promise<unknown>;
  /** OPTIONAL INFO (available in ioredis) — used ONLY for the one-time async-replication advisory
   *  check in RedisRunJournal (see `checkReplicationOnce`). Absent on custom/legacy clients → the
   *  check silently no-ops (fail-open, advisory only). */
  info?(section?: string): Promise<string>;
  /** OPTIONAL native Redis WAIT (available in ioredis) — `WAIT numreplicas timeout` blocks until
   *  `numreplicas` replicas have acknowledged all writes issued by this connection so far, or until
   *  `timeout` ms elapse, returning the number that actually acknowledged. See
   * RedisStorageOptions.waitReplicas (Task 2 — opt-in strong replication guarantee). Absent on
   *  custom/legacy clients → the check silently no-ops (fail-open). */
  wait?(numreplicas: number, timeout: number): Promise<number>;
}

/** Minimal ChainableCommander subset returned by RedisLike.multi() — only the three commands
 *  (SET/ZADD/EVAL) + exec that RedisRunJournal uses. ioredis's real ChainableCommander is much
 *  broader (every Redis command) but we only type the surface this task needs — consistent with
 *  the injectable client pattern (like RedisLike itself). exec() result matches the ioredis
 *  contract EXACTLY: order matches the commands one-to-one, each element is `[err, result]`. */
export interface RedisPipeline {
  set(key: string, value: string, ...args: (string | number)[]): RedisPipeline;
  zadd(key: string, score: number, member: string): RedisPipeline;
  eval(script: string, numKeys: number, ...args: (string | number)[]): RedisPipeline;
  exec(): Promise<Array<[Error | null, unknown]> | null>;
}

export interface RedisStorageOptions {
  /** ioredis connection string (if `client` is not given, an ioredis is set up from this). */
  connectionString?: string;
  /** Bring your own ioredis (or compatible) client (test/custom setup); if given, `ioredis` is not imported. */
  client?: RedisLike;
  /** Namespace prefixed to all keys (default 'gnl:'). For multi-instance/isolation. */
  keyPrefix?: string;
  /** the core-hardening review: Redis replication is ALWAYS asynchronous — a claim (SET NX) acknowledged by
   *  the primary can be lost on the replica promoted during failover → exactly-once may be VIOLATED.
   * When `true` (default), RunJournal does a ONE-TIME, fire-and-forget `INFO replication` check on the
   *  first putIfAbsent/putIfMatch call and console.warn's ONCE if replicas are attached. Set `false` to
   *  silence the advisory (e.g. single-node dev, or the risk is already knowingly accepted). */
  replicationWarning?: boolean;
  /**
   * If given, EVERY SUCCESSFUL claim (putIfAbsent/putIfMatch returning `true` — i.e. this
   * call genuinely wrote a NEW record, not a no-op loss) is followed by a native Redis `WAIT
   * replicas timeoutMs` call, requiring at least `replicas` replicas to have acknowledged the write
   * before the claim is considered final. Default: `undefined` — BYTE-FOR-BYTE unchanged behavior (no
   * WAIT call, no extra latency on the claim path).
   *   onTimeout ('warn', default): fewer than `replicas` acknowledged in time → logs ONCE per
   * RedisRunJournal instance and lets the (already-happened) claim stand.
   *   onTimeout: 'throw': raises `ReplicationNotAcknowledgedError` instead — the claim already wrote
   *     the record (WAIT cannot undo a write), this only surfaces the ack shortfall as a hard error so
   *     the caller can decide how to react (e.g. treat this attempt as untrusted, alert, retry policy).
   * FAIL-OPEN: if the client doesn't implement `wait` (custom/legacy `RedisLike`) or the WAIT call
   * itself throws (network hiccup), this is swallowed SILENTLY — WAIT is an extra assurance layer, it
   * must never turn a genuinely successful claim into a thrown error for an UNRELATED reason.
   */
  waitReplicas?: { replicas: number; timeoutMs: number; onTimeout?: 'throw' | 'warn' };
}

// Per-store sub-namespaces — kept separate so SCANs don't collect each other's keys.
const RJ = 'rj:';     // RunJournal entries (value envelope)
const CTR = 'ctr:';   // incrBy/getCounters counter hashes (H8a) — own sub-namespace, swept by deletePrefix
const WL = 'wl:';     // WorkStore append-log
const WK = 'wk:';     // WorkStore KV + ack markers
// WorkStore per-namespace sequence (`WorkStore.list`). Its own space so no `wl:`/`wk:` sweep deletes
// it: a counter that restarts after an erasure would number new records BEHIND a persisted cursor.
const WSEQ = 'wseq:';
const CACHE = 'cache:';
const META = 'meta:';
// H8b: per-run last-activity ZSET — a SINGLE key (score=last write epoch ms, member=runId).
// The Redis counterpart of gnl_runs.updated_at: RjEnv.t PRESERVES created_at (unchanged on put) → that
// field is INSUFFICIENT for measuring "last activity" (if a tool is upserted suspended→succeeded, `t`
// stays fixed, and a resumed run would INCORRECTLY look stale). So a separate index is needed, updated
// on every model/tool write — RJT.
const RJT = 'rjt:activity';

// ── Common helpers ─────────────────────────────────────────────────────────
function offset(q?: ListQuery) { return { start: q?.cursor ? Number(q.cursor) || 0 : 0, limit: q?.limit ?? 50 }; }
function pageOf<T>(all: T[], start: number, limit: number): Page<T> {
  const next = start + limit;
  return { items: all.slice(start, start + limit), nextCursor: next < all.length ? String(next) : undefined };
}
/**
 * Escape Redis glob (MATCH) meta-characters → a dynamic prefix/id matches literally.
 *
 * Apply it to the WHOLE pattern up to the trailing `*`, not just to the caller-supplied tail. The
 * fixed part carries `keyPrefix`, which is caller input too (`new RedisStorage({ keyPrefix })`), and
 * it was going into SCAN raw at nine of the ten call sites. MEASURED on Redis 7 with
 * `keyPrefix: 'X[a]:'` next to a store using `Xa:` — `listKeys('')` returned `['un:model:0']`:
 *   · `X[a]:rj:*` is a character class, so it matched the NEIGHBOUR's keys (a cross-store read), and
 *   · it did NOT match this store's OWN keys, whose text contains the three literal characters
 *     `[a]` where the class matches exactly one — the store was blind to itself, and
 *   · the neighbour's key was then sliced at THIS prefix's (longer) length, so the adapter returned
 *     a journal key that exists in no store at all.
 * Low severity — an operator has to choose such a prefix — but it is a silent cross-store read, and
 * the character-wise escape makes it impossible rather than unlikely: globEscape is a no-op on every
 * prefix that has no glob character in it, so nothing else moves.
 * Pinned: durable/test/integration-real.test.ts (real Redis, `[a]`) and, without Docker,
 * events/test/log-namespace.test.ts (`*`, because fake-redis.ts's glob has no character classes).
 *
 * Only the MATCH pattern is escaped. SCAN returns REAL keys, so every `k.slice(this.ns().length)`
 * below must keep using the UNESCAPED length — escaping the slice offset would break them all.
 */
function globEscape(s: string): string {
  return s.replace(/[\\*?[\]]/g, (c) => '\\' + c);
}
/**
 * Escapes a WorkStore NAMESPACE before it is joined into a Redis key with `:`.
 *
 * `WorkStore.list(ns)` is defined on the port as "the records appended under exactly this ns" — a
 * whole-value match, which is what the other three adapters do (InMemory keys a Map by ns;
 * SQLite/Postgres run `WHERE ns = ?`). This adapter has no ns column: it stores a record at
 * `<pfx>wl:<ns>:<id>` and reads a namespace back with a `SCAN MATCH <pfx>wl:<ns>:*` PREFIX scan. With
 * `:` unescaped that join is not injective, and MEASURED on a real Redis 7 it broke the contract in
 * both directions:
 *
 *   READ  ns 'evt:orders' scanned `wl:evt:orders:*`, which also matches every record of the SEPARATE
 *         namespace 'evt:orders:eu' → a consumer of topic `orders` was handed `orders:eu`'s events.
 *   WRITE append(ns='evt:inv:eu', id='x') and append(ns='evt:inv', id='eu:x') both address
 *         `wl:evt:inv:eu:x`. append is `SET NX`, first-write-wins → the second record was NEVER
 *         WRITTEN while `append` still returned its id. Silent loss, with no error and no trace.
 *
 * Escaping `:` (the delimiter) and `%` (the escape character itself, so the mapping is injective)
 * makes the escaped ns colon-free, so the FIRST `:` after the `wl:` prefix is always the ns/id
 * boundary: one ns ↔ one key space, and no ns's scan prefix can be another ns's scan prefix.
 *
 * Same escape SHAPE as @gnldev/events' `enc` (`%3A`/`%25`) — one ontology. Deliberately a SECOND
 * IMPLEMENTATION, not a shared symbol: the two escapes sit at different layers and have to be able to
 * fail independently (events escapes the topic so it does not depend on a store property it cannot
 * observe; this escapes the ns so EVERY WorkStore caller is safe, not just that package). Importing
 * one from the other would make deleting either silently reconfigure the other, which is the opposite
 * of the defence in depth. Each layer is pinned on its own — see events/test/log-namespace.test.ts,
 * which asserts the `%` half separately at the adapter and at the package.
 *
 * COST: every `wl:` key whose ns contains `:` or `%` moves (`wl:evt:orders:e1` → `wl:evt%3Aorders:e1`).
 * Nothing is published, so no live store holds one, and the cost is zero TODAY for that reason alone —
 * NOT because the moved set is small. It is not: `@gnldev/events` puts a `:` in every namespace it
 * uses (`evt:<topic>`), and under an organization-scoped store EVERY ns is rewritten to `org:<id>:<ns>`
 * (org-storage.ts `scopedWork`), so even the queue's plain `qjob` reaches this adapter as
 * `org:acme:qjob` and moves to `wl:org%3Aacme%3Aqjob:<id>`. Only an UNSCOPED store's colon-free
 * namespaces are byte-identical. On a live deployment (a managed host's managed store is the first one that
 * will have real data in it) the old log records would be invisible to `list` and would have to be
 * renamed. The KV/ack half (`wk:`) is a whole-key GET/SET and is NOT affected.
 */
function encNs(ns: string): string {
  return ns.replace(/%/g, '%25').replace(/:/g, '%3A');
}
/** `encNs` undone (adoptIntoOrg reads a namespace back out of a key). */
function decNs(enc: string): string {
  return enc.replace(/%3A/g, ':').replace(/%25/g, '%');
}
/** Collect all matching keys by rolling SCAN forward until cursor '0' (NOT KEYS → doesn't block in prod).
 * Redis SCAN's guarantee is at-least-once: the same key CAN come back MULTIPLE TIMES during a rehash →
 *  dedupe with a Set (otherwise readRun produces duplicate entries, listRuns produces double counts). */
async function scanAll(client: RedisLike, match: string, limit?: number): Promise<string[]> {
  const out = new Set<string>();
  let cursor: string | number = '0';
  do {
    const [next, keys] = await client.scan(cursor, 'MATCH', match, 'COUNT', 1000);
    for (const k of keys) out.add(k);
    cursor = next;
    // A bounded probe (listKeys `limit`) stops at the first SCAN page that has enough.
    if (limit !== undefined && out.size >= limit) return [...out].slice(0, limit);
  } while (cursor !== '0');
  return [...out];
}
function cmpStr(a: string, b: string): number { return a < b ? -1 : a > b ? 1 : 0; }

const IDX = 'idx:';         // KeyIndex sorted sets, one per key space
const IDX_STATE = 'idxstate'; // whether this store reads through its key indexes: 'on' | 'pending'
/** The largest code point: `[p` to `[p` + this, compared as UTF-8 bytes, spans every key that starts with p. */
const LEX_TOP = '\u{10FFFF}';
const INDEX_FILL_LUA = `-- gnl:index-fill
for i=1,#ARGV do redis.call('ZADD',KEYS[1],0,ARGV[i]) end return #ARGV`;
const INDEX_FILL_CHUNK = 500;

/**
 * Whether this store's reads go through its key indexes (KeyIndex), decided once per store and kept in
 * `<pfx>idxstate`. A version before the indexes writes keys they do not hold, so they can be trusted only
 * when no such writer remains:
 *   - a store with no run or work-log key yet when this version first touches it is new: 'on';
 *   - a store holding such keys was written by an earlier version, which may still be running (a rolling
 *     upgrade): 'pending' — reads stay SCANs, which see every key, and a warning names the way out:
 *     once every process runs this version, `RedisStorage.rebuildKeyIndex()` adds the existing keys and
 *     turns the indexes on, for every process sharing the store.
 * Not supported: starting a NEW store with an earlier version's processes writing beside this one.
 */
class IndexGate {
  private state?: Promise<'on' | 'pending'>;
  private warned = false;
  constructor(private client: RedisLike, private pfx: string, private spaces: string[]) {}
  private get stateKey(): string { return this.pfx + IDX_STATE; }
  /** Called before this process's first indexed write too, so its own keys never make a store look old. */
  ready(): Promise<'on' | 'pending'> {
    return (this.state ??= (async () => {
      const known = await this.client.get(this.stateKey);
      if (known === 'on' || known === 'pending') return known;
      const old = await this.holdsData();
      await this.client.set(this.stateKey, old ? 'pending' : 'on', 'NX');
      return ((await this.client.get(this.stateKey)) as 'on' | 'pending' | null) ?? (old ? 'pending' : 'on');
    })());
  }
  /** Reads may use the indexes. While pending, the stored state is read again, so a switch elsewhere is seen. */
  async on(): Promise<boolean> {
    if ((await this.ready()) === 'on') return true;
    if ((await this.client.get(this.stateKey)) === 'on') { this.state = Promise.resolve('on'); return true; }
    if (!this.warned) {
      this.warned = true;
      console.warn(
        `@gnldev/durable redis: this store ('${this.pfx}') holds keys an earlier version wrote, so it lists them by SCAN, ` +
          'which walks the whole Redis database. Once every process sharing it runs this version, call ' +
          '`storage.rebuildKeyIndex()` once to list through the key index instead.',
      );
    }
    return false;
  }
  async switchOn(indexes: KeyIndex[]): Promise<Record<string, number>> {
    const out: Record<string, number> = {};
    for (const i of indexes) out[i.space] = await i.rebuild();
    await this.client.set(this.stateKey, 'on');
    this.state = Promise.resolve('on');
    return out;
  }
  /** Whether any run or work-log key exists — one SCAN that stops at the first. */
  private async holdsData(): Promise<boolean> {
    const bases = this.spaces.map((sp) => this.pfx + sp);
    let cursor: string | number = '0';
    do {
      const [next, keys] = await this.client.scan(cursor, 'MATCH', globEscape(this.pfx) + '*', 'COUNT', 1000);
      if (keys.some((k) => bases.some((b) => k.startsWith(b)))) return true;
      cursor = next;
    } while (String(cursor) !== '0');
    return false;
  }
}

/**
 * Lists one key space by prefix without walking the database. SCAN MATCH visits every key the Redis
 * database holds, this store's or not: measured on a 10-call run, 44 ms with the database to itself,
 * 270 ms beside 100 000 other keys and 2983 ms beside 1 000 000; a queue's 10 jobs 78 ms → 6318 ms; and
 * a run among the application's own 300 000 old keys 53 → 1338 ms. The index is one sorted set per key
 * space, every member scored 0, so members sort by their bytes and a prefix is one ZRANGEBYLEX.
 *
 * Invariant: every key of the space that exists is a member. A write adds its member in the same
 * transaction (MULTI or script) or, on a client without one, BEFORE the key is written; a delete removes
 * members after. So a member may outlive its key (a crash between the two steps), never the reverse —
 * readers that fetch values skip a missing one. Whether reads may trust it is the IndexGate's call.
 */
class KeyIndex {
  constructor(private client: RedisLike, private pfx: string, readonly space: string, private gate: IndexGate) {}
  get key(): string { return this.pfx + IDX + this.space; }
  private get base(): string { return this.pfx + this.space; }
  member(full: string): string { return full.slice(this.base.length); }
  /** The index needs both commands; without them every read is a SCAN, as before. */
  get usable(): boolean { return !!(this.client.zadd && this.client.zrangebylex); }
  /** Before this process's first write: the store's state is decided before its own keys exist. */
  async beforeWrite(): Promise<void> { if (this.usable) await this.gate.ready(); }
  /** For a client without MULTI: called before the key is written. */
  async add(full: string): Promise<void> {
    if (this.usable) await this.client.zadd!(this.key, 0, this.member(full));
  }
  /** One member, removed after its key was deleted. */
  async drop(full: string): Promise<void> {
    if (this.usable && this.client.zrem) await this.client.zrem(this.key, this.member(full));
  }
  /** Full keys of the space that start with `prefix` (members whose key may be gone included). */
  async keys(prefix: string, limit?: number): Promise<string[]> {
    if (!this.usable || !(await this.gate.on())) return scanAll(this.client, globEscape(this.base + prefix) + '*', limit);
    const page = limit !== undefined ? ['LIMIT', 0, limit] : [];
    const members = prefix
      ? await this.client.zrangebylex!(this.key, `[${prefix}`, `[${prefix}${LEX_TOP}`, ...page)
      : await this.client.zrangebylex!(this.key, '-', '+', ...page);
    return members.map((m) => this.base + m);
  }
  /** Members under `prefix`, removed after their keys were deleted. */
  async remove(prefix: string): Promise<void> {
    if (!this.usable) return;
    if (this.client.zremrangebylex) {
      await (prefix ? this.client.zremrangebylex(this.key, `[${prefix}`, `[${prefix}${LEX_TOP}`) : this.client.zremrangebylex(this.key, '-', '+'));
      return;
    }
    const gone = await scanAll(this.client, globEscape(this.base + prefix) + '*');
    if (gone.length && this.client.zrem) await this.client.zrem(this.key, ...gone.map((k) => this.member(k)));
  }
  /** Adds every key of the space that exists (one SCAN). */
  async rebuild(): Promise<number> {
    if (!this.usable) return 0;
    const keys = await scanAll(this.client, globEscape(this.base) + '*');
    for (let i = 0; i < keys.length; i += INDEX_FILL_CHUNK) {
      const chunk = keys.slice(i, i + INDEX_FILL_CHUNK).map((k) => this.member(k));
      if (this.client.eval) await this.client.eval(INDEX_FILL_LUA, 1, this.key, ...chunk);
      else for (const m of chunk) await this.client.zadd!(this.key, 0, m);
    }
    return keys.length;
  }
}

// N+1 efficiency fix: instead of a sequential GET per key after SCAN, use a SINGLE (or a few chunked)
// round-trip if the client supports `mget`. The returned array's ORDER matches `keys` one-to-one (mget
// contract) → the caller can match by index. For very large key lists, split into MGET_CHUNK-sized
// chunks to avoid a single MGET blocking Redis / hitting command-size limits.
const MGET_CHUNK = 500;
/** Keys per DEL in a paged delete: the same bound as MGET_CHUNK, for the same reason. */
const DEL_CHUNK = 500;
async function bulkGet(client: RedisLike, keys: string[]): Promise<(string | null)[]> {
  if (keys.length === 0) return [];
  if (!client.mget) {
    // Fallback: no mget → existing sequential GET (custom/legacy RedisLike clients don't break).
    const out: (string | null)[] = [];
    for (const k of keys) out.push(await client.get(k));
    return out;
  }
  if (keys.length <= MGET_CHUNK) return client.mget(...keys);
  const out: (string | null)[] = [];
  for (let i = 0; i < keys.length; i += MGET_CHUNK) {
    out.push(...(await client.mget(...keys.slice(i, i + MGET_CHUNK))));
  }
  return out;
}

// ── RunJournal ──────────────────────────────────────────────────────────────────
// Value envelope: value + derived meta (runId/kind/suspended/createdAt) in a single key → readRun/listRuns
// are resolved via SCAN + JS-side grouping without maintaining a secondary index (Redis has no secondary
// index; listRuns is an admin/observability path, NOT a hot path). The superjson envelope preserves the
// type of the nested value.
interface RjEnv { v: unknown; r: string | null; k: 'model' | 'tool' | null; s: boolean; t: number }
function rjEnv(value: unknown, p: { runId: string; kind: 'model' | 'tool' } | null, s: boolean, t: number): RjEnv {
  return { v: value, r: p?.runId ?? null, k: p?.kind ?? null, s, t };
}
function isSuspended(p: { kind: string } | null, value: unknown): boolean {
  return p?.kind === 'tool' && (value as ToolJournalRecord | undefined)?.status === 'suspended';
}

// H1 CAS Lua script: if GET==ARGV[1] then SET ARGV[2] → 1, else 0. The Redis script runs atomically →
// this closes the race window between putIfMatch's JS-side comparison and the SET.
/** HINCRBYFLOAT over ARGV's field/delta pairs, atomically; returns the new values in order. */
/** KEYS = [hash, index?], ARGV = field/delta pairs, then the hash's index member when KEYS[2] is given. */
const INCR_FIELDS_LUA = `-- gnl:incr-fields
local n=#ARGV
if KEYS[2] then redis.call('ZADD',KEYS[2],0,ARGV[n]) n=n-1 end
local out={} for i=1,n,2 do out[#out+1]=redis.call('HINCRBYFLOAT',KEYS[1],ARGV[i],ARGV[i+1]) end return out`;
const CAS_LUA = `if redis.call('GET',KEYS[1])==ARGV[1] then redis.call('SET',KEYS[1],ARGV[2]) return 1 else return 0 end`;

/**
 * A work-log record's value is 0.9's record — `serialize({ id, payload, ts })`, which always starts
 * `{"json":{"id":` — with its number inserted as the first field, `"seq":<n>,`. This version writes it
 * numbered (WORK_APPEND_LUA); a 0.9 process writes it bare and the next `list` numbers it. Both forms
 * are a plain superjson record, so a 0.9 reader parses every value (it ignores the extra field); the
 * first cut of sequences wrote `<seq>|<record>` and a 0.9 reader threw a SyntaxError on every record.
 * The superjson `meta` paths are keyed by name, so a field added in front moves none.
 */
const REC_HEAD = '{"json":{';
const NUMBERED_HEAD = '{"json":{"seq":';

/**
 * Numbers work-log records that have no number yet (`WorkStore.list`), in the order given: KEYS[1] =
 * the namespace's counter, KEYS[2..] = records. A record already numbered (by another reader) or gone
 * is skipped. One script, so a number and its record appear together and in counter order.
 */
const WORK_NUMBER_LUA = `-- gnl:work-number
local n=0
for i=2,#KEYS do
  local v=redis.call('GET',KEYS[i])
  if v and string.sub(v,1,${REC_HEAD.length})=='${REC_HEAD}' and string.sub(v,1,${NUMBERED_HEAD.length})~='${NUMBERED_HEAD}' then
    local s=redis.call('INCR',KEYS[1])
    redis.call('SET',KEYS[i],'${NUMBERED_HEAD}'..s..','..string.sub(v,${REC_HEAD.length + 1}))
    n=n+1
  end
end
return n`;

/**
 * `WorkStore.append` as one script: an existing id is left alone (first write wins, no number spent);
 * otherwise the namespace's next number is taken and the record written with it, in the numbered form
 * above. One script, so no reader can see n+1 before n exists — and records keep their append order,
 * which `(ts, id)` does not (two appends in one millisecond would be ordered by their random ids).
 * KEYS[1] = counter, KEYS[2] = record, ARGV[1] = the bare record.
 */
const WORK_APPEND_LUA = `-- gnl:work-append
if redis.call('EXISTS',KEYS[2])==1 then return 0 end
local s=redis.call('INCR',KEYS[1])
if KEYS[3] then redis.call('ZADD',KEYS[3],0,ARGV[2]) end
redis.call('SET',KEYS[2],'${NUMBERED_HEAD}'..s..','..string.sub(ARGV[1],${REC_HEAD.length + 1}))
return s`;

/** A stored work-log value: its record, and its number (0 = not numbered yet). */
function readWorkValue<T>(v: string): LogRecord<T> & { seq: number } {
  const rec = deserialize<LogRecord<T> & { seq?: unknown }>(v);
  return { id: rec.id, payload: rec.payload, ts: rec.ts, seq: typeof rec.seq === 'number' ? rec.seq : 0 };
}

/** `value` numbered `seq` — the string WORK_NUMBER_LUA writes, for a client without `eval`. */
function numberedValue(value: string, seq: number): string | undefined {
  if (!value.startsWith(REC_HEAD) || value.startsWith(NUMBERED_HEAD)) return undefined;
  return `${NUMBERED_HEAD}${seq},${value.slice(REC_HEAD.length)}`;
}

/**
 * P1.6b applyBatch Lua script: claim (putIfAbsent semantics) + HINCRBYFLOAT counters + SET puts, as ONE
 * atomic server-side script — claim key EXISTS → return 0 (nothing else runs); otherwise SET the claim,
 * apply every counter increment, SET every put, return 1. The whole batch is encoded as a SINGLE JSON
 * descriptor in ARGV[1] (cjson.decode, available in stock Redis) rather than a dynamic KEYS/ARGV layout —
 * the batch's shape (how many incrs/puts, how many fields per incr) is variable per call, and JSON keeps
 * both the real-Redis script and the fake-client mimic (fake-redis.ts) simple. All key names inside the
 * descriptor are ALREADY fully-prefixed by the caller (RedisRunJournal.applyBatch) — same envelope
 * (`rjEnv`) as put()/putIfAbsent() for run-journal keys, plain values for counter/put keys outside that
 * namespace — so this script never needs to know about prefixes itself.
 */
const APPLY_BATCH_LUA = `
local desc = cjson.decode(ARGV[1])
if desc.claim then
  if redis.call('EXISTS', desc.claim.key) == 1 then return 0 end
  redis.call('SET', desc.claim.key, desc.claim.value)
end
for _, incr in ipairs(desc.incrs or {}) do
  for field, delta in pairs(incr.fields) do
    redis.call('HINCRBYFLOAT', incr.key, field, delta)
  end
end
for _, p in ipairs(desc.puts or {}) do
  redis.call('SET', p.key, p.value)
end
for _, z in ipairs(desc.zadds or {}) do
  redis.call('ZADD', z.key, z.score, z.member)
end
return 1
`;

class RedisRunJournal implements RunJournal {
  /**
   * H8b (optional fast path — known limitation fix): assigned in the constructor only if the client
   * supports `zadd`+`zrangebyscore`; OTHERWISE the field stays UNDEFINED. Deliberate choice: it
   * would be WRONG to ALWAYS define the method and return an empty array on an unsupported client —
   * sweepRuns (retention.ts) does feature-detection via `typeof journal.listStaleRuns === 'function'`;
   * if the method exists but incorrectly returns empty, sweepRuns thinks "there are no stale runs" and
   * SILENTLY skips retention (it never falls back to the real O(full-DB) scan fallback) → that would be
   * WORSE behavior than not defining the method at all. So the method's PRESENCE (or absence) is
   * controlled based on capability.
   *
   * KNOWN LIMITATION (documented risk): the ZSET is only populated by put/putIfAbsent/putIfMatch calls
   * made AFTER this code is deployed. Runs written BEFORE the upgrade and never touched AGAIN never
   * enter the ZSET → the fast-path listStaleRuns will never see them as "stale" (sweepRuns's fast path
   * won't clean up these old runs). If needed, a one-time backfill script (SCANning existing
   * `rj:*:model:*`/`rj:*:tool:*` keys and ZADDing them) could be run; that is out of scope for this task.
   */
  listStaleRuns?: (cutoffTs: number, opts?: { includeSuspended?: boolean }) => Promise<string[]>;

  /**
   * P1.6b (optional — SAME conditional-presence idiom as `listStaleRuns` above): assigned in the
   * constructor ONLY if the client supports `eval` (the atomic batch script needs server-side Lua);
   * otherwise the field stays UNDEFINED (recordRunMetrics/callers fall back to the sequential
   * claim→incrBy path, which is correct — just without the atomicity closing the crash window).
   * NOT implemented: `countRunsByStatus` — Redis has no cheap indexed status aggregate here (the
   * `rj:` keyspace has no secondary index by status, only a brute-force SCAN would produce it, which is
   * exactly the O(all runs) cost this capability exists to AVOID) — left undefined rather than faked with
   * a full scan; callers fall back to `listRuns`.
   */
  applyBatch?: (batch: JournalBatch) => Promise<boolean>;

  /** the core-hardening review advisory (see `checkReplicationOnce`) — flips true after the first check attempt
   *  (whether or not it warned) so it only ever runs ONCE per RedisRunJournal instance. */
  private replicationChecked = false;
  /** Task 2: flips true after the first `waitReplicas` ack-shortfall WARNING (onTimeout:'warn', the
   *  default) — like `replicationChecked` above, this keeps the console quiet after the first hit
   *  instead of warning on every claim in a degraded cluster. Does NOT gate 'throw' mode (every
   *  shortfall there raises — the caller asked to be told every time). */
  private waitReplicasWarned = false;

  constructor(
    private client: RedisLike,
    private pfx: string,
    private replicationWarning = true,
    private waitReplicas?: { replicas: number; timeoutMs: number; onTimeout?: 'throw' | 'warn' },
    gate: IndexGate = new IndexGate(client, pfx, [RJ, WL, CTR]),
  ) {
    this.index = new KeyIndex(client, pfx, RJ, gate);
    this.counters = new KeyIndex(client, pfx, CTR, gate);
    if (client.eval) {
      this.applyBatch = async (batch: JournalBatch): Promise<boolean> => {
        const desc: { claim?: { key: string; value: string }; incrs?: { key: string; fields: Record<string, number> }[]; puts?: { key: string; value: string }[]; zadds?: { key: string; score: number; member: string }[] } = {};
        // H8b parity: run-shaped keys written through applyBatch must ALSO touch the activity ZSET
        // (put/putIfAbsent do — see touch()); otherwise listStaleRuns would treat a run written only via
        // applyBatch as never-active and sweep it as stale. Collected here, applied inside the SAME Lua unit.
        const zadds: { key: string; score: number; member: string }[] = [];
        const now = Date.now();
        const touchOf = (key: string, p: ReturnType<typeof parseJournalKey>, value: unknown) => {
          const owner = p?.runId ?? runIdOfKey(key, value);
          if (owner && client.zadd) zadds.push({ key: this.activityKey(), score: now, member: owner });
        };
        const indexOf = (key: string) => { if (this.index.usable) zadds.push({ key: this.index.key, score: 0, member: key }); };
        if (batch.claim) {
          const p = parseJournalKey(batch.claim.key);
          desc.claim = { key: this.full(batch.claim.key), value: serialize(rjEnv(batch.claim.value, p, isSuspended(p, batch.claim.value), now)) };
          touchOf(batch.claim.key, p, batch.claim.value);
          indexOf(batch.claim.key);
        }
        if (batch.incrs?.length) {
          desc.incrs = batch.incrs.map(({ key, fields }) => ({ key: this.pfx + CTR + key, fields }));
          if (this.counters.usable) for (const { key } of batch.incrs) zadds.push({ key: this.counters.key, score: 0, member: key });
        }
        if (batch.puts?.length) {
          desc.puts = batch.puts.map(({ key, value }) => {
            const p = parseJournalKey(key);
            touchOf(key, p, value);
            indexOf(key);
            return { key: this.full(key), value: serialize(rjEnv(value, p, isSuspended(p, value), now)) };
          });
        }
        if (zadds.length) desc.zadds = zadds;
        await this.index.beforeWrite();
        const res = await client.eval!(APPLY_BATCH_LUA, 0, JSON.stringify(desc));
        return Number(res) === 1;
      };
    }
    if (client.zadd && client.zrangebyscore) {
      this.listStaleRuns = async (cutoffTs, opts) => {
        // Score comes back in ASCENDING order (ioredis ZRANGEBYSCORE) → min='-inf', max=`(cutoffTs`
        // (EXCLUSIVE upper bound) = "updated_at < cutoffTs" (identical semantics to sqlite/pg).
        const candidates = await client.zrangebyscore!(this.activityKey(), '-inf', `(${cutoffTs}`);
        if (opts?.includeSuspended) return candidates;
        // Safe side: suspended runs are EXCLUDED by default. Suspended detection is only done for
        // CANDIDATE runs (NOT a full-keyspace scan — only that run's own keys, see isRunSuspended)
        // → cost stays O(stale-candidate-count × entries-per-run).
        const out: string[] = [];
        for (const runId of candidates) {
          if (!(await this.isRunSuspended(runId))) out.push(runId);
        }
        return out;
      };
    }
  }
  /** Lists this journal's keys by prefix (KeyIndex). */
  readonly index: KeyIndex;
  /** The counter hashes (incrBy), by prefix — what deletePrefix erases with the keys. */
  readonly counters: KeyIndex;
  private ns = () => this.pfx + RJ;
  private full(key: string) { return this.ns() + key; }
  /** A write and its index member in one MULTI (KeyIndex) — undefined when the client cannot. */
  private indexedWrite(key: string): RedisPipeline | undefined {
    return this.index.usable && this.client.multi ? this.client.multi().zadd(this.index.key, 0, key) : undefined;
  }
  private activityKey(): string { return this.pfx + RJT; }
  /** H8b helper: does this run have a tool record that is CURRENTLY suspended? Only that run's OWN
   *  keys are scanned (unlike listRuns's full-keyspace scan) — listStaleRuns only calls this for
   *  stale CANDIDATES, so it does NOT incur full-keyspace cost. */
  private async isRunSuspended(runId: string): Promise<boolean> {
    const keys = await this.index.keys(runId + ':');
    const values = await bulkGet(this.client, keys);
    for (const s of values) {
      if (s == null) continue;
      const e = deserialize<RjEnv>(s);
      if (e.r === runId && e.k === 'tool' && e.s) return true;
    }
    return false;
  }
  /** H8b: refreshes the run's last-activity ZSET score whenever a model/tool key is written. Cost:
   *  +1 round-trip per write (ZADD) — ADDED to put()'s existing GET+SET, putIfAbsent's SET NX,
   *  or putIfMatch's GET+(eval|SET). O(1) constant cost, in the same spirit as sqlite/pg's
   *  touchRunDelta upsert that runs on every write. NO-OP (skipped) if client.zadd is absent →
   *  listStaleRuns is already left undefined in that case, so this call adds no cost at all.
   *  `this.now()` is used (NOT Date.now()) — with H2 server-time support this stays independent of
   *  worker wall-clock skew (in tests the fake clock also flows through here via `client.time()`).
   * PIPELINE (audit fix): if the client ALSO supports `multi()`, this +1 RTT is folded into the SAME
   *  round-trip as put/putIfAbsent/putIfMatch's write command (SET / SET NX / eval) — see `canPipe()`
   *  and the pipeline branches inside those three methods. `touch()` itself is only used on the
   *  separate-call path for clients without pipelining (no multi support); its behavior is UNCHANGED. */
  private async touch(owner: string | null): Promise<void> {
    if (owner && this.client.zadd) await this.client.zadd(this.activityKey(), await this.now(), owner);
  }
  /** Is pipelining (sending SET/eval + ZADD in a single round-trip) possible? The run key (`p`) must
   * EXIST and the client must support BOTH `multi()` and `zadd` — if either is missing, the
   *  separate-call (touch()) path is used. */
  private canPipe(owner: string | null): owner is string {
    return !!(owner && this.client.multi && this.client.zadd);
  }

  /**
   * the core-hardening review (Known limitation — made VOCAL, same rationale as journal.ts claim()'s
   * putIfAbsent-fallback warning): Redis replication is ALWAYS asynchronous — a claim (SET NX)
   * acknowledged by the primary can be LOST on the replica promoted during failover → another worker
   * can win the SAME claim → exactly-once may be VIOLATED. Nothing checked or surfaced this before —
   * a silent risk in a correctness product. This does a ONE-TIME (per instance), FIRE-AND-FORGET
   * `INFO replication` probe on the first putIfAbsent/putIfMatch call: it is NEVER awaited by the
   * caller (must never delay or be able to break the claim path) and any error (client doesn't
   * implement `info`, network failure, parse miss) is swallowed SILENTLY — fail-open, this is an
   * advisory only, not a gate. Silenced entirely via `replicationWarning: false`.
   */
  private checkReplicationOnce(): void {
    if (this.replicationChecked || !this.replicationWarning || !this.client.info) return;
    this.replicationChecked = true; // flip BEFORE the async call resolves → never re-entered, even under concurrent claims
    void this.client
      .info('replication')
      .then((info) => {
        const m = /connected_slaves:(\d+)/.exec(info);
        if (m && Number(m[1]) > 0) {
          console.warn(
            '@gnldev/durable redis: replicas are fed asynchronously — on failover, an acknowledged claim ' +
              '(SET NX) can be lost on the promoted replica, so exactly-once may be VIOLATED ' +
              '(see the core-hardening review). Configure WAIT / min-replicas-to-write, or knowingly accept ' +
              'the risk (silence this warning via `replicationWarning: false`).',
          );
        }
      })
      .catch(() => {}); // fail-open: the advisory must never break the claim path
  }

  /**
   * Task 2 (opt-in strong replication guarantee): AWAITED (unlike `checkReplicationOnce` above, which is
   * fire-and-forget advisory) — called AFTER a claim already succeeded (putIfAbsent/putIfMatch about to
   * return `true`), so it can only ever ADD a delay or a thrown ack-shortfall error, never change
   * whether the write happened. No-op if `waitReplicas` wasn't configured, or the client doesn't
   * implement `wait` (fail-open — see RedisStorageOptions.waitReplicas JSDoc).
   */
  private async waitForReplicas(): Promise<void> {
    if (!this.waitReplicas || !this.client.wait) return;
    const { replicas, timeoutMs, onTimeout = 'warn' } = this.waitReplicas;
    let acked: number;
    try {
      acked = await this.client.wait(replicas, timeoutMs);
    } catch {
      return; // fail-open: WAIT itself errored (unsupported/network) — never fail an already-successful claim
    }
    if (acked >= replicas) return;
    const message =
      `@gnldev/durable redis: WAIT requested ${replicas} replica ack(s) within ${timeoutMs}ms, only ${acked} ` +
      'acknowledged — the claim already happened, but on failover it may be LOST on a replica that never ' +
      'caught up (see the core-hardening review).';
    if (onTimeout === 'throw') {
      throw new ReplicationNotAcknowledgedError(message, { requested: replicas, acknowledged: acked, timeoutMs });
    }
    if (!this.waitReplicasWarned) {
      this.waitReplicasWarned = true;
      console.warn(`${message} Configure onTimeout: 'throw' to fail loudly instead, or raise timeoutMs / lower replicas.`);
    }
  }

  async get<T = unknown>(key: string): Promise<T | undefined> {
    const s = await this.client.get(this.full(key));
    return s == null ? undefined : (deserialize<RjEnv>(s).v as T);
  }
  /** P1.6b: batch point-read — reuses `bulkGet` (the SAME N+1 fix readRun/listRuns already rely on),
   *  order-preserving, `undefined` for misses (getMany contract, journal.ts); decodes the SAME RjEnv
   *  envelope as `get`. */
  async getMany<T = unknown>(keys: string[]): Promise<(T | undefined)[]> {
    if (keys.length === 0) return [];
    const values = await bulkGet(this.client, keys.map((k) => this.full(k)));
    return values.map((s) => (s == null ? undefined : (deserialize<RjEnv>(s).v as T)));
  }
  async put(key: string, value: unknown): Promise<void> {
    await this.index.beforeWrite();
    const p = parseJournalKey(key);
    // The ACTIVITY index must cover every run-scoped key, not just replayable entries: a run that died
    // before its first model step has only `:input` + a claim marker, and leaving those out of the ZSET
    // made it permanently invisible to listStaleRuns → sweepRuns never reached it.
    const owner = p?.runId ?? runIdOfKey(key, value);
    const full = this.full(key);
    // Preserve created_at (sqlite ON CONFLICT DO UPDATE doesn't update created_at) → readRun order stays stable.
    // DELIBERATE 2-RTT (GET+SET) — NOT OPTIMIZED with bulkGet: put() operates on a single key,
    // there's no bulk read; the N+1 problem was in multi-key reads after SCAN (readRun/listRuns/list).
    // Alternatives that would improve atomicity (Lua script CAS / separate created_at key) were NOT
    // IMPLEMENTED — see the core-hardening review (Recommendations) — this task's scope is only N+1 GET efficiency.
    const prev = await this.client.get(full);
    const t = prev != null ? deserialize<RjEnv>(prev).t : Date.now();
    const payload = serialize(rjEnv(value, p, isSuspended(p, value), t));
    // PIPELINE (audit fix — H8b touch +1 RTT): touch() is already UNCONDITIONAL here (it would run on
    // every put whenever p exists) → sending SET+ZADD in the SAME round-trip does NOT CHANGE behavior
    // (both would run in every case; it just drops from 2 RTT to 1 RTT). If canPipe() is false
    // (client.multi/zadd absent), the separate-call path below (old behavior, documented) runs UNCHANGED.
    const tx = this.indexedWrite(key);
    if (tx) {
      tx.set(full, payload);
      if (owner && this.client.zadd) tx.zadd(this.activityKey(), await this.now(), owner);
      await tx.exec();
      return;
    }
    await this.index.add(full);
    if (this.canPipe(owner)) {
      await this.client.multi!().set(full, payload).zadd(this.activityKey(), await this.now(), owner).exec();
      return;
    }
    await this.client.set(full, payload);
    await this.touch(owner);
  }
  /** REQUIRED (exactly-once): ATOMIC CAS via SET NX — no get-then-set. First writer gets 'OK', later ones get null. */
  async putIfAbsent(key: string, value: unknown): Promise<boolean> {
    this.checkReplicationOnce(); // fire-and-forget — never awaited, never delays the claim
    await this.index.beforeWrite();
    const p = parseJournalKey(key);
    // The ACTIVITY index must cover every run-scoped key, not just replayable entries: a run that died
    // before its first model step has only `:input` + a claim marker, and leaving those out of the ZSET
    // made it permanently invisible to listStaleRuns → sweepRuns never reached it.
    const owner = p?.runId ?? runIdOfKey(key, value);
    const full = this.full(key);
    const payload = serialize(rjEnv(value, p, isSuspended(p, value), Date.now()));
    const tx = this.indexedWrite(key);
    if (tx) {
      // The member is added whether or not SET NX wins: if it loses, the key exists and is a member already.
      tx.set(full, payload, 'NX');
      if (owner && this.client.zadd) tx.zadd(this.activityKey(), await this.now(), owner);
      const results = await tx.exec();
      const ok = results?.[1]?.[1] === 'OK';
      if (ok) await this.waitForReplicas();
      return ok;
    }
    await this.index.add(full);
    if (this.canPipe(owner)) {
      // PIPELINE — DOCUMENTED BEHAVIOR DIFFERENCE (in the SAFE DIRECTION): commands in a pipeline can't
      // be conditioned on each other's RESULT (without Lua) → the ZADD runs even if SET NX LOSES (the
      // key already existed) — a deviation from the original "touch only if OK" behavior. The deviation
      // is in the SAFE direction: marking activity earlier/more than warranted only DELAYS when
      // listStaleRuns triggers (it NEVER LEADS TO early/false-positive deletion — see the "safe side"
      // principle at the top of the file) and it DOES reflect the fact that the losing worker was ALSO
      // attempting to write to this run at that moment. The round-trip count does NOT get WORSE: on a
      // win it drops from 2→1 RTT, on a loss it was already 1 RTT (the ZADD rides in the same packet).
      const results = await this.client.multi!().set(full, payload, 'NX').zadd(this.activityKey(), await this.now(), owner).exec();
      const ok = results?.[0]?.[1] === 'OK';
      if (ok) await this.waitForReplicas(); // Task 2: only after a GENUINE new claim (NX won)
      return ok;
    }
    const res = await this.client.set(full, payload, 'NX');
    const ok = res === 'OK';
    if (ok) {
      await this.touch(owner);
      await this.waitForReplicas(); // Task 2: only after a GENUINE new claim (NX won)
    }
    return ok;
  }
  /**
   * H1: atomic conditional replace (expired run-lock takeover, see journal.ts JSDoc).
   * The STORED FORM is the RjEnv envelope (v + derived meta, including `t`=createdAt) — the caller's
   * `expected` is only the inner value (`v`), and the envelope has `t` → a byte-for-byte serialize match
   * is IMPOSSIBLE. Hence the pattern: (1) raw GET, (2) JS-side env.v ↔ expected stableStringify
   * comparison, (3) if it matches, run the Lua CAS with the RAW OLD STRING (ARGV[1] = the raw we read)
   * → the GET↔SET TOCTOU window is closed inside Lua (atomic server-side). The new value is wrapped
   * with rjEnv, `t` is PRESERVED (readRun order stays stable — same as put()'s created_at preservation behavior).
   */
  async putIfMatch(key: string, expected: unknown, value: unknown): Promise<boolean> {
    this.checkReplicationOnce(); // fire-and-forget — never awaited, never delays the claim
    const full = this.full(key);
    const raw = await this.client.get(full);
    if (raw == null) return false; // key absent → no match
    const env = deserialize<RjEnv>(raw);
    if (stableStringify(env.v) !== stableStringify(expected)) return false; // safe side: don't touch
    const p = parseJournalKey(key);
    // The ACTIVITY index must cover every run-scoped key, not just replayable entries: a run that died
    // before its first model step has only `:input` + a claim marker, and leaving those out of the ZSET
    // made it permanently invisible to listStaleRuns → sweepRuns never reached it.
    const owner = p?.runId ?? runIdOfKey(key, value);
    const next = serialize(rjEnv(value, p, isSuspended(p, value), env.t)); // t is preserved
    if (this.client.eval) {
      if (this.canPipe(owner)) {
        // PIPELINE — same "safe-direction deviation" (see putIfAbsent comment): eval (CAS) + ZADD go in
        // the SAME round-trip; the ZADD runs even if the CAS loses (safe direction: late cleanup, never early).
        const results = await this.client.multi!().eval(CAS_LUA, 1, full, raw, next).zadd(this.activityKey(), await this.now(), owner).exec();
        const ok = Number(results?.[0]?.[1]) === 1;
        if (ok) await this.waitForReplicas(); // Task 2: only after a GENUINE takeover (CAS won)
        return ok;
      }
      const res = await this.client.eval(CAS_LUA, 1, full, raw, next);
      const ok = Number(res) === 1;
      if (ok) {
        await this.touch(owner); // a resume/takeover is ALSO "last activity" — prevents stale-false-positives
        await this.waitForReplicas(); // Task 2: only after a GENUINE takeover (CAS won)
      }
      return ok;
    }
    // custom client without eval: best-effort compare-then-set (equivalent to the old get→put behavior;
    // documented risk, the core-hardening review — a real ioredis always goes through the atomic eval path).
    if (this.canPipe(owner)) {
      // touch() is already UNCONDITIONAL here (the best-effort branch always returns true) → the
      // pipeline behavior is IDENTICAL, just 2 RTT → 1 RTT.
      await this.client.multi!().set(full, next).zadd(this.activityKey(), await this.now(), owner).exec();
      await this.waitForReplicas(); // Task 2: this branch always writes (best-effort, no CAS) → always a genuine write
      return true;
    }
    await this.client.set(full, next);
    await this.touch(owner);
    await this.waitForReplicas(); // Task 2: this branch always writes (best-effort, no CAS) → always a genuine write
    return true;
  }
  /** H8a: engine-internal atomic counter via HINCRBYFLOAT (if the client supports it; otherwise the
   *  method is considered undefined — budget.ts falls back to the legacy path). Key lives in its own
   *  sub-namespace (ctr:). */
  async incrBy(key: string, fields: Record<string, number>): Promise<Record<string, number>> {
    if (!this.client.hincrbyfloat) throw new Error('@gnldev/durable redis: client does not support hincrbyfloat');
    const entries = Object.entries(fields);
    const after: Record<string, number> = {};
    const hash = this.pfx + CTR + key;
    await this.counters.beforeWrite();
    if (this.client.eval && (entries.length > 1 || this.counters.usable)) {
      // Several fields move together (a finished call's count and its seat — limits.ts): one script, so
      // no reader sees one moved without the other; the hash's index member rides in it (KeyIndex).
      const values = this.counters.usable
        ? await this.client.eval(INCR_FIELDS_LUA, 2, hash, this.counters.key, ...entries.flat(), this.counters.member(hash))
        : await this.client.eval(INCR_FIELDS_LUA, 1, hash, ...entries.flat());
      if (!Array.isArray(values) || values.length !== entries.length) {
        throw new Error(`@gnldev/durable redis: incrBy's script returned ${JSON.stringify(values)}, not one value per field — the client's eval must run Lua as Redis does`);
      }
      entries.forEach(([f], i) => { after[f] = Number(values[i]); });
      return after;
    }
    await this.counters.add(hash);
    for (const [f, d] of entries) after[f] = Number(await this.client.hincrbyfloat(hash, f, d));
    return after;
  }
  async getCounters(key: string): Promise<Record<string, number> | undefined> {
    if (!this.client.hgetall) return undefined;
    const h = await this.client.hgetall(this.pfx + CTR + key);
    const entries = Object.entries(h ?? {});
    if (!entries.length) return undefined;
    return Object.fromEntries(entries.map(([f, v]) => [f, Number(v)]));
  }

  /** H2: Redis server time (TIME → sec+µs) as epoch ms. Falls back to Date.now if `time` is absent. */
  async now(): Promise<number> {
    if (!this.client.time) return Date.now();
    const [sec, usec] = await this.client.time();
    return Number(sec) * 1000 + Math.floor(Number(usec) / 1000);
  }
  async listKeys(prefix: string, opts?: { limit?: number }): Promise<string[]> {
    const keys = await this.index.keys(prefix, opts?.limit);
    const cut = this.ns().length;
    return keys.map((k) => k.slice(cut));
  }
  /** Retention/GDPR: PERMANENTLY delete keys starting with the prefix (parity with sqlite/pg deletePrefix).
   * H8b parity: sqlite/pg's deletePrefix(`<runId>:`) call also drops the gnl_runs summary row
   *  (see sqlite-storage.ts/postgres-storage.ts deletePrefix) — the equivalent here is ZREMming the
   * ZSET member: otherwise the purged run's dead member stays in the ZSET FOREVER → every subsequent
   *  listStaleRuns call thinks it's "stale" AGAIN and re-triggers purgeRun (harmless but unnecessary —
   *  deletePrefix already returns 0) AND the ZSET grows like a leak. `rid` may not always be a real
   *  runId (e.g. `mem-appended:<runId>` or `net:<runId>:` prefixes also pass through here) — in that
   *  case ZREM deletes a non-matching member (no-op, a harmless extra round-trip). */
  async deletePrefix(prefix: string): Promise<number> {
    const keys = await this.index.keys(prefix);
    let n = 0;
    for (let i = 0; i < keys.length; i += DEL_CHUNK) n += await this.client.del(...keys.slice(i, i + DEL_CHUNK));
    await this.index.remove(prefix); // after the keys: a member may outlive its key, never the reverse
    if (this.client.zrem) {
      const rid = prefix.endsWith(':') ? prefix.slice(0, -1) : prefix;
      await this.client.zrem(this.activityKey(), rid);
    }
    // Counters (incrBy/H8a) live in the `ctr:` sub-namespace (`<pfx>ctr:<key>` hashes), OUTSIDE the
    // `rj:` namespace scanned above — but they are keys too per the deletePrefix contract (journal.ts):
    // an org purge (GDPR) must not leave `org:<id>:__usage__` behind, and rebuildMetrics's wipe must
    // not keep stale `__metrics__:` counters. Not included in the return count (parity with sqlite/pg,
    // which don't count the gnl_counters rows either).
    const ctrKeys = await this.counters.keys(prefix);
    for (let i = 0; i < ctrKeys.length; i += DEL_CHUNK) await this.client.del(...ctrKeys.slice(i, i + DEL_CHUNK));
    await this.counters.remove(prefix);
    return n;
  }
  /**
   * H8c (known limitation fix): CHEAP stats for a run — COUNT + total size, measured WITHOUT transferring
   * the VALUES (where possible). loadReplayCache (journal.ts) uses this as a RAM guard rail: it checks
   * the journal's size before pulling it entirely into memory; the bulk cache is skipped if over the threshold.
   * Measurement path:
   * if the client supports STRLEN: only the length is queried (the value CONTENT does NOT CROSS the
   *    network). Cost: 1 round-trip per key — but SCAN is already LIMITED to `<runId>:*` (as many as
   *    this run's entries, NOT the WHOLE keyspace) → typically small (as many as a run's model/tool step count).
   * if STRLEN is absent (custom/legacy client — documented fallback): values are transferred via MGET
   *    (there's a bandwidth cost) but ONLY for this run's keys — again NOT a full-keyspace scan, using
   *    the same path as the bulkGet from the N+1 efficiency fix.
   */
  async readRunStats(runId: string): Promise<{ entries: number; bytes: number }> {
    const keys = await this.index.keys(runId + ':');
    const cut = this.ns().length;
    // As in readRun, only this run's model/tool entries are counted (input/proc/cfg are EXCLUDED) —
    // here, WITHOUT fetching the value, filtering is done via parseJournalKey on the key TEXT itself.
    const relevant = keys.filter((k) => {
      const p = parseJournalKey(k.slice(cut));
      return p != null && p.runId === runId;
    });
    if (relevant.length === 0) return { entries: 0, bytes: 0 };
    // A member whose key is gone (KeyIndex) is not an entry: STRLEN answers 0 for it, MGET null.
    if (this.client.strlen) {
      let bytes = 0;
      let entries = 0;
      for (const k of relevant) { const n = await this.client.strlen(k); if (n > 0) { bytes += n; entries++; } }
      return { entries, bytes };
    }
    const values = await bulkGet(this.client, relevant);
    let bytes = 0;
    let entries = 0;
    for (const v of values) if (v != null) { bytes += v.length; entries++; }
    return { entries, bytes };
  }
  async readRun(runId: string): Promise<JournalEntry[]> {
    const keys = await this.index.keys(runId + ':');
    const cut = this.ns().length;
    const values = await bulkGet(this.client, keys);
    const entries: JournalEntry[] = [];
    for (let i = 0; i < keys.length; i++) {
      const s = values[i];
      if (s == null) continue;
      const e = deserialize<RjEnv>(s);
      if (e.k == null || e.r !== runId) continue; // only this run's model/tool entries
      entries.push({ key: keys[i]!.slice(cut), runId, kind: e.k, value: e.v, seq: 0, ts: e.t });
    }
    // Decision #4 (journal.ts): created_at ASCENDING, `key` tie-break on equality → deterministic (same as sqlite/pg).
    entries.sort((a, b) => (a.ts! - b.ts!) || cmpStr(a.key, b.key));
    entries.forEach((e, i) => { e.seq = i; });
    return entries;
  }
  async listRuns(q?: ListQuery): Promise<Page<RunSummary>> {
    // Brute-force: scan all rj: entries, summarize per run. Even if the same key is written twice (UPSERT)
    // it's a SINGLE Redis key → NOT DOUBLE-COUNTED (same result as sqlite touchRun's recompute semantics).
    const keys = await this.index.keys('');
    const values = await bulkGet(this.client, keys);
    const cut = this.ns().length;
    const byRun = new Map<string, { m: number; t: number; s: boolean; c0: number }>();
    // AUDIT (threadId first-class): `:input` keys are not visible to parseJournalKey → the r/k fields
    // in the RjEnv envelope they're written under are null (rjEnv(value, p=null, ...)). So runId is
    // derived NOT from the ENVELOPE but from the raw key text itself (the `<runId>:input` suffix) —
    // since SCAN already fetches ALL rj: keys in one pass (keys/values above), this is NOT a SEPARATE
    // round-trip, it's part of the same scan.
    const threadIds = new Map<string, string>();
    const outcomes = new Map<string, 'failed' | 'running' | 'canceled'>();
    const agents = new Map<string, string>();
    const resourceIds = new Map<string, string>();
    const workKeys = new Map<string, string>();
    const parentRunIds = new Map<string, string>();
    for (let i = 0; i < keys.length; i++) {
      const s = values[i];
      if (s == null) continue;
      const e = deserialize<RjEnv>(s);
      if (e.r != null && e.k != null) {
        const cur = byRun.get(e.r) ?? { m: 0, t: 0, s: false, c0: e.t };
        if (e.k === 'model') cur.m++; else { cur.t++; if (e.s) cur.s = true; }
        if (e.t < cur.c0) cur.c0 = e.t;
        byRun.set(e.r, cur);
        continue;
      }
      const rawKey = keys[i]!.slice(cut);
      if (rawKey.endsWith(':input')) {
        const runId = rawKey.slice(0, -':input'.length);
        const inp = e.v as { threadId?: string; agent?: string; resourceId?: string; workKey?: string; parentRunId?: string } | undefined;
        if (inp?.threadId) threadIds.set(runId, inp.threadId);
        if (inp?.agent) agents.set(runId, inp.agent);
        if (inp?.resourceId) resourceIds.set(runId, inp.resourceId);
        if (inp?.workKey) workKeys.set(runId, inp.workKey);
        if (inp?.parentRunId) parentRunIds.set(runId, inp.parentRunId);
      }
      // A run whose keys are ALL non-entry ones (it died before its first model step: `:input` plus a
      // claim marker) has nothing in the envelope's r/k fields, so it never reached byRun above and was
      // absent from every listing — and therefore from sweepRuns too, leaving its persisted prompt
      // outside the retention window. Register it from the key text, with genuinely zero counts.
      const owner = runIdOfKey(rawKey, e.v);
      if (owner) {
        const cur = byRun.get(owner);
        if (!cur) byRun.set(owner, { m: 0, t: 0, s: false, c0: e.t });
        else if (e.t < cur.c0) cur.c0 = e.t;
      }
      // The run's recorded outcome, from the same scan — Redis has no column to index, so it is read
      // from the decoded value rather than matched as text (an error MESSAGE routinely contains the
      // word 'failed'; the record's own status field does not lie).
      if (rawKey.endsWith(':outcome')) {
        const runId = rawKey.slice(0, -':outcome'.length);
        const st = (e.v as { status?: string } | undefined)?.status;
        if (st === 'failed' || st === 'running' || st === 'canceled') outcomes.set(runId, st);
        // The write-ahead can be a run's FIRST key (killed before `:input` landed) — and so can a
        // cancel, which an operator may order against a run that has not started yet. Either way the
        // run exists, so it still lists, with genuinely zero counts.
        if ((st === 'failed' || st === 'running' || st === 'canceled' || st === 'completed') && !byRun.has(runId)) {
          byRun.set(runId, { m: 0, t: 0, s: false, c0: e.t });
        }
      }
    }
    // P0.3 filters: listRuns is ALREADY a full brute-force SCAN here (Redis has no
    // secondary index by status/agent — same "no cheap indexed status aggregate" limitation documented
    // on countRunsByStatus above) — so status/agent filtering costs nothing EXTRA beyond the scan this
    // path already pays; the only requirement is applying it BEFORE the offset/limit slice (pageOf),
    // never after.
    let all = [...byRun.entries()]
      .sort(([ra, va], [rb, vb]) => (va.c0 - vb.c0) || cmpStr(ra, rb))
      .map(([runId, v]): RunSummary => {
        const threadId = threadIds.get(runId);
        const agent = agents.get(runId);
        const resourceId = resourceIds.get(runId);
        const workKey = workKeys.get(runId);
        const parentRunId = parentRunIds.get(runId);
        return {
          runId, status: deriveRunStatus(v.s, outcomes.has(runId) ? { status: outcomes.get(runId)! } : null), modelSteps: v.m, toolCalls: v.t,
          ...(threadId ? { threadId } : {}),
          ...(agent ? { agent } : {}),
          ...(resourceId ? { resourceId } : {}),
          ...(workKey ? { workKey } : {}),
          ...(parentRunId ? { parentRunId } : {}),
        };
      });
    if (q?.status) all = all.filter((r) => r.status === q.status);
    if (q?.agent) all = all.filter((r) => r.agent === q.agent);
    if (q?.resourceId) all = all.filter((r) => r.resourceId === q.resourceId);
    if (q?.workKey) all = all.filter((r) => r.workKey === q.workKey);
    if (q?.topLevel) all = all.filter((r) => !r.parentRunId);
    // Paged by run, not by row number (run-cursor.ts): the same cursor every run listing hands out.
    return pageRunsFromArray(all, q);
  }
}

// ── WorkStore (append-log + KV + CAS ack) ─────────────────────────────────────
class RedisWorkStore implements WorkStore {
  /** Lists the log by namespace (KeyIndex); KV keys are read whole and need none. */
  readonly log: KeyIndex;
  constructor(private client: RedisLike, private pfx: string, gate: IndexGate = new IndexGate(client, pfx, [RJ, WL, CTR])) {
    this.log = new KeyIndex(client, pfx, WL, gate);
  }
  /** See `encNs`: the ns is escaped so the ns→key mapping is injective (`list` is an exact match). */
  private logNs = (ns: string) => `${this.pfx}${WL}${encNs(ns)}:`;
  private kvKey = (key: string) => `${this.pfx}${WK}${key}`;

  private seqKey = (ns: string) => `${this.pfx}${WSEQ}${encNs(ns)}`;

  /**
   * Idempotent (the same (ns,id) is written once, first write wins) and numbered at write
   * (WORK_APPEND_LUA) in a form a 0.9 reader still parses. A record written by a 0.9 process in a rolling
   * deploy carries no number; the first `list` that sees it numbers it (`_number`). Without `eval` the
   * counter and the record are separate round trips, so two processes appending to one namespace can
   * take numbers in one order and land in the other — a reader may then pass a record that appears a
   * moment later behind it. The same documented best-effort as `putIfMatch` without `eval`; ioredis and
   * node-redis both have it.
   */
  async append(ns: string, payload: unknown, id?: string): Promise<string> {
    const eid = id ?? `${ns}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`;
    const rec = serialize({ id: eid, payload, ts: Date.now() });
    const key = this.logNs(ns) + eid;
    await this.log.beforeWrite();
    if (this.client.eval) {
      // The record's index member is added in the same script (KeyIndex).
      if (this.log.usable) await this.client.eval(WORK_APPEND_LUA, 3, this.seqKey(ns), key, this.log.key, rec, this.log.member(key));
      else await this.client.eval(WORK_APPEND_LUA, 2, this.seqKey(ns), key, rec);
      return eid;
    }
    if ((await this.client.get(key)) !== null) return eid;
    await this.log.add(key);
    const seq = Number((await this.client.get(this.seqKey(ns))) ?? 0) + 1;
    await this.client.set(this.seqKey(ns), String(seq));
    await this.client.set(key, numberedValue(rec, seq)!, 'NX');
    return eid;
  }

  /** Every record of `ns` with its key, and the namespace's counter as read BEFORE the scan. */
  private async readLog<T>(ns: string): Promise<{ top: number; rows: Array<LogRecord<T> & { seq: number; key: string; raw: string }> }> {
    // The counter first. SCAN is not a snapshot: a key created during it may be missed while a later
    // one is returned. A record numbered at or below `top` was numbered — so it existed — before the
    // scan began, and SCAN returns every key present for its whole duration; one above `top` may have
    // a lower-numbered neighbour this scan missed, so it waits for the next read.
    const top = Number((await this.client.get(this.seqKey(ns))) ?? 0);
    // TWO escapes, in this order, doing two different jobs. `encNs` (inside logNs) makes the pattern
    // address exactly ONE namespace; globEscape then stops a `*`/`?`/`[` in the key text from
    // widening the match. This line used to run only the second one, on the raw `ns` — which is why
    // `evt:orders` still matched `evt:orders:eu`'s records: a glob escape cannot fix a delimiter
    // ambiguity, `:` is not a glob metacharacter. globEscape covers the WHOLE pattern including the
    // caller's `keyPrefix` — here and, since this round, at the other nine SCAN sites too (they used
    // to escape only their variable tail; see globEscape). See `encNs`.
    // The index holds every record that exists when the read starts (KeyIndex: a record and its member
    // are written in one script), so the same reasoning holds for it as for SCAN.
    const keys = await this.log.keys(`${encNs(ns)}:`);
    const values = await bulkGet(this.client, keys);
    const rows: Array<LogRecord<T> & { seq: number; key: string; raw: string }> = [];
    values.forEach((raw, i) => { if (raw != null) rows.push({ ...readWorkValue<T>(raw), key: keys[i]!, raw }); });
    return { top, rows };
  }

  /**
   * Numbers `rows` (unnumbered records, in the order to number them) after every number handed out so
   * far. Without `eval` the counter and each record are separate round trips: two readers numbering at
   * once can then give one record two numbers in turn or take numbers out of order, so a reader may
   * pass a record — the same documented best-effort as `putIfMatch` without `eval`; ioredis and
   * node-redis both have it. @internal — also used by adoptIntoOrg.
   */
  async _number(ns: string, rows: Array<{ key: string; raw: string }>): Promise<void> {
    for (let i = 0; i < rows.length; i += NUMBER_BATCH) {
      const chunk = rows.slice(i, i + NUMBER_BATCH);
      if (this.client.eval) {
        await this.client.eval(WORK_NUMBER_LUA, chunk.length + 1, this.seqKey(ns), ...chunk.map((r) => r.key));
        continue;
      }
      for (const r of chunk) {
        const seq = Number((await this.client.get(this.seqKey(ns))) ?? 0) + 1;
        const v = numberedValue(r.raw, seq);
        if (v === undefined) continue;
        await this.client.set(this.seqKey(ns), String(seq));
        await this.client.set(r.key, v);
      }
    }
  }

  /**
   * Keyset on the store-assigned number (`WorkStore.list`). This version numbers a record AT APPEND
   * (the Lua script), so its records are in append order. A record a 0.9 process wrote is a bare SET
   * with no number, and Redis keeps no insertion order for keys, so such records are numbered here in
   * PRODUCER-CLOCK order (`ts`, then `id`) — where SQLite and Postgres use the order they were inserted
   * in. Either way each is numbered above every number handed out so far, so it never lands behind a
   * persisted cursor; what differs is only the order among the 0.9 records of one read.
   */
  async list<T = unknown>(ns: string, q?: ListQuery): Promise<Page<LogRecord<T>>> {
    let log = await this.readLog<T>(ns);
    const fresh = log.rows.filter((r) => r.seq === 0).sort(compareLogPosition);
    if (fresh.length) {
      // Numbered, then read again: this read's own numbers are above the `top` it started from.
      await this._number(ns, fresh);
      log = await this.readLog<T>(ns);
    }
    // Keyset on the store-assigned number, not the producer's clock (`WorkStore.list`).
    const rows = log.rows.filter((r) => r.seq > 0 && r.seq <= log.top).sort(compareLogPosition);
    const after = decodeLogCursor(q?.cursor);
    const from = after ? rows.filter((r) => compareLogPosition(r, after) > 0) : rows;
    const limit = q?.limit ?? 50;
    const page = from.slice(0, limit);
    const last = page[page.length - 1];
    return {
      items: page.map((r) => ({ id: r.id, payload: r.payload, ts: r.ts })),
      nextCursor: from.length > limit && last ? encodeLogCursor(last) : undefined,
    };
  }
  async get<T = unknown>(key: string): Promise<T | undefined> {
    const s = await this.client.get(this.kvKey(key));
    return s == null ? undefined : deserialize<T>(s);
  }
  async put(key: string, value: unknown): Promise<void> {
    await this.client.set(this.kvKey(key), serialize(value));
  }
  /** Exactly-once ack: ATOMIC via SET NX — the first call is true, subsequent ones are false. */
  async ackOnce(key: string): Promise<boolean> {
    const res = await this.client.set(this.kvKey(key), serialize(true), 'NX');
    return res === 'OK';
  }
  /**
   * FAZ-9: both families, one prefix — with a wrinkle the other adapters do not have. Log namespaces
   * are stored ENCODED (`encNs`: ':' → '%3A'), KV keys are stored raw, so the same logical prefix
   * needs two different patterns. Encoding the prefix the same way the namespace was encoded is what
   * keeps them aligned: 'org:acme:' encodes to 'org%3Aacme%3A', and an encoded namespace starts with
   * that exactly when its plain form starts with the plain prefix.
   */
  async deletePrefix(prefix: string): Promise<number> {
    const logKeys = await this.log.keys(encNs(prefix));
    const kvKeys = await scanAll(this.client, globEscape(`${this.pfx}${WK}${prefix}`) + '*');
    const all = [...new Set([...logKeys, ...kvKeys])];
    let n = 0;
    for (let i = 0; i < all.length; i += DEL_CHUNK) n += await this.client.del(...all.slice(i, i + DEL_CHUNK));
    await this.log.remove(encNs(prefix));
    return n;
  }
  /**
   * Every log record whose ID starts with `idPrefix`, in every namespace (`WorkStore.deleteIdPrefix`).
   *
   * A record lives at `<pfx>wl:<encNs(ns)>:<id>`, and `encNs` leaves no `:` in the namespace, so the
   * first `:` after `wl:` is where the id begins. The SCAN pattern only narrows (`*` also spans a `:`,
   * so `wl:*:<prefix>*` can match an id that merely CONTAINS the prefix after a colon); the key text is
   * then checked exactly, so the prefix is literal. Both halves are glob-escaped: an id or a keyPrefix
   * holding `*`, `?`, `[` or `\` is text, not a pattern.
   *
   * Bounded: deleted page by page as SCAN returns them (a key present for the whole scan is returned
   * at least once; one returned twice is deleted once and counted once, as DEL counts what it removed).
   */
  async deleteIdPrefix(idPrefix: string): Promise<number> {
    const base = `${this.pfx}${WL}`;
    const isMine = (k: string) => {
      const rest = k.slice(base.length);
      const colon = rest.indexOf(':');
      return k.startsWith(base) && colon >= 0 && rest.slice(colon + 1).startsWith(idPrefix);
    };
    if (this.log.usable) {
      // The log's own members, not the database: an id prefix can sit under any namespace.
      const mine = (await this.log.keys('')).filter(isMine);
      let deleted = 0;
      for (let i = 0; i < mine.length; i += DEL_CHUNK) {
        const chunk = mine.slice(i, i + DEL_CHUNK);
        deleted += await this.client.del(...chunk);
        if (this.client.zrem) await this.client.zrem(this.log.key, ...chunk.map((k) => this.log.member(k)));
      }
      return deleted;
    }
    const match = `${globEscape(base)}*:${globEscape(idPrefix)}*`;
    let n = 0;
    let cursor: string | number = '0';
    do {
      const [next, keys] = await this.client.scan(cursor, 'MATCH', match, 'COUNT', 1000);
      const mine = keys.filter((k) => {
        const rest = k.slice(base.length);
        const colon = rest.indexOf(':');
        return k.startsWith(base) && colon >= 0 && rest.slice(colon + 1).startsWith(idPrefix);
      });
      for (let i = 0; i < mine.length; i += DEL_CHUNK) n += await this.client.del(...mine.slice(i, i + DEL_CHUNK));
      cursor = next;
    } while (String(cursor) !== '0');
    return n;
  }
  /**
   * 8.2: uses RunJournal's Lua CAS (CAS_LUA, defined in the same module — shared with RedisRunJournal) —
   * but WorkStore has NO RjEnv envelope (put() writes plain `serialize(value)`) → unlike RunJournal, no
   * pre-GET is needed: `expected`'s serialized form is passed directly as Lua's ARGV[1], the
   * GET==ARGV[1] check + SET happen in A SINGLE round-trip (a genuinely atomic CAS, NO TOCTOU window). On
   * custom clients that don't support `eval`, it falls back to best-effort get→compare→set (documented risk).
   */
  async putIfMatch(key: string, expected: unknown, value: unknown): Promise<boolean> {
    const full = this.kvKey(key);
    const expectedRaw = serialize(expected);
    const nextRaw = serialize(value);
    if (this.client.eval) {
      const res = await this.client.eval(CAS_LUA, 1, full, expectedRaw, nextRaw);
      return Number(res) === 1;
    }
    const raw = await this.client.get(full);
    if (raw == null || raw !== expectedRaw) return false;
    await this.client.set(full, nextRaw);
    return true;
  }
}

// ── CacheStore (Redis NATIVE TTL) ─────────────────────────────────────────────
class RedisCacheStore implements CacheStore {
  constructor(private client: RedisLike, private pfx: string) {}
  private ck = (key: string) => `${this.pfx}${CACHE}${key}`;

  async get<T = unknown>(key: string): Promise<T | undefined> {
    // Redis itself drops the expired key → an expiry check in get is NOT NEEDED (native TTL).
    const s = await this.client.get(this.ck(key));
    return s == null ? undefined : deserialize<T>(s);
  }
  async set(key: string, value: unknown, opts?: { ttlMs?: number }): Promise<void> {
    const s = serialize(value);
    if (opts?.ttlMs != null) {
      // ttlMs<=0 → Redis PX requires a positive value; immediate "expired" = delete the key (same result as sqlite/pg semantics).
      if (opts.ttlMs <= 0) { await this.client.del(this.ck(key)); return; }
      await this.client.set(this.ck(key), s, 'PX', Math.ceil(opts.ttlMs));
      return;
    }
    await this.client.set(this.ck(key), s);
  }
  async delete(key: string): Promise<void> { await this.client.del(this.ck(key)); }
}

// ── MetaStore (plain string KV — schema_version/capability persistence) ──────────
class RedisMetaStore implements MetaStore {
  constructor(private client: RedisLike, private pfx: string) {}
  private mk = (key: string) => `${this.pfx}${META}${key}`;
  async get(key: string): Promise<string | undefined> {
    const s = await this.client.get(this.mk(key));
    return s == null ? undefined : s;
  }
  async set(key: string, value: string): Promise<void> { await this.client.set(this.mk(key), value); }
}

export class RedisStorage implements Storage {
  readonly name = 'redis';
  readonly capabilities: CapabilityMatrix = { runs: 'full', memory: 'none', vectors: 'none', work: 'full', cache: 'ttl' };
  private client: RedisLike;
  /** The key prefix every sub-store shares — kept so `adoptIntoOrg` can scan the same keyspace. */
  private readonly pfx: string;
  /** Whether reads go through the key indexes (IndexGate). */
  private readonly indexGate: IndexGate;
  readonly runs: RunJournal;
  readonly work: WorkStore;
  readonly cache: CacheStore;
  readonly meta: MetaStore;
  // memory/vectors: NOT PROVIDED (undefined) — capability='none', overridden via composite() (see comment above).

  constructor(opts: RedisStorageOptions = {}) {
    refuseUnknownNames('RedisStorage', opts, REDIS_STORAGE_NAMES);
    const pfx = opts.keyPrefix ?? 'gnl:';
    this.pfx = pfx;
    if (opts.client) {
      this.client = opts.client;
    } else {
      const mod = createRequire(import.meta.url)('ioredis') as any;
      const Redis = (mod.default ?? mod) as new (c?: any) => RedisLike;
      this.client = new Redis(opts.connectionString ?? undefined);
    }
    // SAY WHAT HAPPENED WHEN THE CONNECTION DROPS, in this engine's voice.
    //
    // `ioredis` already keeps a lost connection from killing the process — measured: 200 writes in
    // flight, the server dropped every client, the process lived and all 200 landed after the
    // automatic reconnect. So unlike the Postgres pool, nothing here is broken.
    //
    // What the operator saw was `[ioredis] Unhandled error event: Error: write EPIPE` — a library
    // saying nobody is listening, about a component they did not choose directly and in a vocabulary
    // that does not mention their agent, their run, or whether anything was lost. The Postgres path
    // explains itself in one sentence; this one left a stack-shaped string. Attaching a listener both
    // silences that warning and replaces it with something a reader can act on.
    //
    // Only when nothing is listening yet: a caller who passed their own client and their own handler
    // keeps theirs, exactly as on the Postgres side.
    const c = this.client as unknown as { on?: (e: string, f: (err: Error) => void) => void; listenerCount?: (e: string) => number };
    if (c.on && c.listenerCount?.('error') === 0) {
      c.on('error', (err: Error) => {
        console.error(
          `@gnldev/durable: redis connection error — ${err.message}. ioredis reconnects on its own and ` +
            'replays what it had queued; commands that were already in flight reject at their call ' +
            'sites. Logged rather than rethrown, so a reconnect does not end the process.',
        );
      });
    }
    this.indexGate = new IndexGate(this.client, pfx, [RJ, WL, CTR]);
    this.runs = new RedisRunJournal(this.client, pfx, opts.replicationWarning ?? true, opts.waitReplicas, this.indexGate);
    this.work = new RedisWorkStore(this.client, pfx, this.indexGate);
    this.cache = new RedisCacheStore(this.client, pfx);
    this.meta = new RedisMetaStore(this.client, pfx);
  }
  /** Redis is schemaless → no table setup; write schema_version idempotently (parity with sqlite/pg meta). */
  /**
   * Adds every existing run and work-log key to the key indexes and lists through them from now on, for
   * every process sharing this store. Call it once after upgrading a store an earlier version wrote, when
   * no process of that version remains (see IndexGate); calling it again is harmless. Returns how many
   * keys each index holds.
   */
  async rebuildKeyIndex(): Promise<{ runs: number; work: number }> {
    const runs = this.runs as RedisRunJournal;
    const n = await this.indexGate.switchOn([runs.index, runs.counters, (this.work as RedisWorkStore).log]);
    return { runs: (n[RJ] ?? 0) + (n[CTR] ?? 0), work: n[WL] ?? 0 };
  }

  /**
   * See `Storage.adoptIntoOrg`.
   *
   * TWO HONEST LIMITS, both reported in the result rather than hidden:
   *
   * NOT ATOMIC. `RedisLike` has no MULTI/EXEC, so this is a sequence of individual writes. If it fails
   * partway the store is half-migrated. It is idempotent, so the remedy is to run it again — but stop
   * writers first, and prefer taking a snapshot.
   *
   * `cache:` is NOT migrated. Rewriting a key means reading and re-setting it, which drops its TTL, and
   * a cache entry that outlives its expiry is worse than a cold cache. Cache is derived data: it
   * refills. Reported under `skippedPlatformKeys` as `cache:` so the decision is visible.
   */
  async adoptIntoOrg(orgId: string, opts?: { dryRun?: boolean; allowUnregistered?: boolean; allowInFlight?: boolean }): Promise<AdoptIntoOrgResult> {
    refuseUnknownNames('adoptIntoOrg', opts, ADOPT_INTO_ORG_NAMES);
    const prefix = orgPrefix(orgId);
    await assertOrgRegistered(this.runs, orgId, opts?.allowUnregistered);
    await assertNoRunsInFlight(this.runs, opts?.allowInFlight);
    const dryRun = opts?.dryRun === true;
    const moved: Record<string, number> = {};
    const skipped = new Set<string>(['cache:']);
    let alreadyScoped = 0;

    const scanAll = async (pattern: string): Promise<string[]> => {
      const out: string[] = [];
      let cursor: string | number = 0;
      do {
        const [next, keys] = await this.client.scan(cursor, 'MATCH', pattern, 'COUNT', 1000);
        out.push(...keys);
        cursor = next;
      } while (String(cursor) !== '0');
      return out;
    };

    // Work-store keys by `workKeyAdoption`, decided before anything moves (logs included): a read
    // position is dropped rather than carried — it used to overwrite the organization's own cursor
    // here, stranding its pending records behind it — and any other key the organization already
    // holds refuses the adoption, as the SQL stores' primary key does.
    const wkBase = this.pfx + WK;
    const resetPositions: string[] = [];
    for (const k of await scanAll(globEscape(wkBase) + '*')) {
      const bare = k.slice(wkBase.length);
      if (isOrganizationKey(bare) || isPlatformKey(bare)) continue;
      const v = await this.client.get(k);
      if (v === null) continue;
      const d = workKeyAdoption(deserialize(v), (await this.client.get(wkBase + prefix + bare)) !== null);
      if (d === 'collision') throw workKeyAdoptCollision(prefix + bare);
      if (d === 'reset-position') resetPositions.push(bare);
    }

    // Work LOGS first, and checked before anything moves. They were not moved at all before: the
    // organization's reader never saw an adopted log, and the root records sat outside every org.
    // A record moves to the organization's namespace UNNUMBERED (0.9's bare form), so the next `list`
    // numbers it after everything that log already holds — after any cursor its consumer persisted
    // (`WorkStore.list`). An id the organization's log already has refuses the adoption before any
    // write, as the SQL stores' primary key does; `set NX` would silently drop one of the two.
    const wlBase = this.pfx + WL;
    const logMoves = new Map<string, Array<{ src: string; dst: string }>>(); // by the organization's namespace
    let logN = 0;
    for (const k of await scanAll(globEscape(wlBase) + '*')) {
      const rest = k.slice(wlBase.length);
      const colon = rest.indexOf(':');
      if (colon < 0) continue;
      const logNs = decNs(rest.slice(0, colon));
      if (isOrganizationKey(logNs)) { alreadyScoped++; continue; }
      if (isPlatformKey(logNs)) { skipped.add(logNs.split(':')[0]!); continue; }
      logN++;
      const to = prefix + logNs;
      logMoves.set(to, [...(logMoves.get(to) ?? []), { src: k, dst: `${wlBase}${encNs(to)}:${rest.slice(colon + 1)}` }]);
    }
    if (!dryRun) {
      for (const moves of logMoves.values()) {
        for (const { dst } of moves) {
          if ((await this.client.get(dst)) !== null) {
            throw new Error(`@gnldev/durable: adoptIntoOrg would move a work-log record onto '${dst}', which the organization's log already holds. Nothing was moved.`);
          }
        }
      }
      // Every refusal is behind us: the first write of the adoption.
      for (const bare of resetPositions) await this.client.del(wkBase + bare);
      for (const [to, moves] of logMoves) {
        const recs: Array<LogRecord & { seq: number; key: string; raw: string }> = [];
        for (const { src, dst } of moves) {
          const v = await this.client.get(src);
          if (v === null) continue;
          const rec = readWorkValue(v);
          recs.push({ ...rec, key: dst, raw: serialize({ id: rec.id, payload: rec.payload, ts: rec.ts }) });
        }
        // In their old order, written bare and numbered after the organization's last number.
        recs.sort(compareLogPosition);
        const log = (this.work as RedisWorkStore).log;
        for (const r of recs) { await log.add(r.key); await this.client.set(r.key, r.raw); }
        await (this.work as RedisWorkStore)._number(to, recs);
        for (const { src } of moves) { await this.client.del(src); await log.drop(src); }
      }
    }
    moved.work = logN;

    // [redis sub-namespace, store name, is it a hash]
    const SPACES: Array<[string, string, boolean]> = [[RJ, 'runs', false], [CTR, 'runs', true], [WK, 'work', false], [META, 'meta', false]];
    const runsJ = this.runs as RedisRunJournal;
    const indexOf = (space: string): KeyIndex | undefined => (space === RJ ? runsJ.index : space === CTR ? runsJ.counters : undefined);
    for (const [space, store, isHash] of SPACES) {
      const index = indexOf(space);
      const full = this.pfx + space;
      const keys = await scanAll(globEscape(full) + '*');
      let n = 0;
      for (const k of keys) {
        const bare = k.slice(full.length);
        if (space === WK && resetPositions.includes(bare)) continue; // dropped above (under dryRun, still listed)
        if (isOrganizationKey(bare)) { alreadyScoped++; continue; }
        if (isPlatformKey(bare) || (space === META && ENGINE_META_KEYS.includes(bare))) { skipped.add(bare.split(':')[0]!); continue; }
        n++;
        if (dryRun) continue;
        const dst = full + prefix + bare;
        if (isHash) {
          if (!this.client.hgetall || !this.client.hincrbyfloat) { skipped.add(space); n--; continue; }
          const fields = await this.client.hgetall(k);
          await index?.add(dst);
          for (const [f, v] of Object.entries(fields)) await this.client.hincrbyfloat(dst, f, Number(v));
        } else {
          const v = await this.client.get(k);
          if (v !== null) {
            await index?.add(dst);
            await this.client.set(dst, v);
          }
        }
        await this.client.del(k);
        await index?.drop(k);
      }
      moved[store] = (moved[store] ?? 0) + n;
    }
    moved.cache = 0;
    // The vector port does not exist on this engine (capabilities.vectors === 'none'), so it is absent
    // from the report rather than reported as zero — see AdoptIntoOrgResult.
    return { orgId, dryRun, moved, alreadyScoped, skippedPlatformKeys: [...skipped].sort(), resetPositions: resetPositions.sort() };
  }

  async init(): Promise<void> {
    if ((await this.meta.get('schema_version')) == null) await this.meta.set('schema_version', SCHEMA_VERSION);
  }
  async close(): Promise<void> { if (this.client.quit) await this.client.quit(); }
}
