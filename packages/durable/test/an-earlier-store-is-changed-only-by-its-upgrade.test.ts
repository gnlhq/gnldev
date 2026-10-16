// What the upgrade promises about WHEN a store changes, on a store an earlier version wrote:
//
//   W1 opening it, asking any of its ports, `init`, a dry run (`gnl upgrade --list`) and an `upgrade`
//      call that is refused change nothing — the refusal says "nothing was read or written", and so it
//      is. Its schema changes only in an upgrade step that runs (Sqlite used to bring every other table
//      up to date in its constructor, refused or not, dry run or not);
//   W2 a refused store says one thing — the refusal — and not, before it, advice about a store it
//      will not serve ("Answers stay complete…");
//   W3 after `upgrade()` the store is a new store's: the same tables, columns, indexes and triggers —
//      on Sqlite too, whose run table no longer keeps a `status` default an upgraded file alone had, so
//      a write that names no status is refused there as it is on a new file and on Postgres;
//   W4 a step named alone is refused with EVERY step it waits on (the prerequisites of prerequisites),
//      and the command the refusal suggests runs;
//   W5 a store with nothing in it has nothing to upgrade, and asking creates nothing;
//   W6 the step that drops columns is reached through `upgrade()` only — not a public method a caller
//      can run past `upgrade()`'s order and refusals.
//
// The earlier store is 0.10.0's, as its Sqlite file holds its schema (SQLITE_0100 — read out of a file
// the published @gnldev/durable@0.10.0 created), with rows as 0.10.0 writes them. Postgres runs where it
// can: pg-mem always, a real server with GNL_PG_URL. packages/upgrade-tests opens files the real 0.10.0
// wrote (test/from-0.10.0).
import { describe, it, expect, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRequire } from 'node:module';
import { newDb } from 'pg-mem';
import pg from 'pg';
import { InMemoryStorage, toJournal, admitThreadRun, user, type Storage } from '../src/index.js';
import { SqliteStorage } from '../src/sqlite-storage.js';
import { PostgresStorage } from '../src/postgres-storage.js';
import { runUpgrade, RELATIONS_PENDING_ADVICE, type UpgradeStep } from '../src/upgrade.js';
import { serialize } from '../src/serialize.js';

const { DatabaseSync } = createRequire(import.meta.url)('node:sqlite') as { DatabaseSync: new (path: string) => any };
const PG_URL = process.env.GNL_PG_URL;

const ends: Array<() => Promise<void> | void> = [];
afterEach(async () => { vi.restoreAllMocks(); for (const e of ends.splice(0).reverse()) await e(); });

/** The schema of a Sqlite file @gnldev/durable@0.10.0 creates, as `sqlite_master` holds it. */
const SQLITE_0100 = `
CREATE TABLE gnl_meta (k TEXT PRIMARY KEY, v TEXT NOT NULL);
CREATE TABLE gnl_run_journal (
  key TEXT PRIMARY KEY, run_id TEXT, kind TEXT, suspended INTEGER NOT NULL DEFAULT 0,
  value TEXT NOT NULL, created_at INTEGER NOT NULL
);
CREATE INDEX gnl_run_journal_run ON gnl_run_journal (run_id, created_at);
CREATE TABLE gnl_runs (
  run_id TEXT PRIMARY KEY, model_steps INTEGER NOT NULL DEFAULT 0, tool_calls INTEGER NOT NULL DEFAULT 0,
  suspended INTEGER NOT NULL DEFAULT 0, suspended_count INTEGER NOT NULL DEFAULT 0, failed INTEGER NOT NULL DEFAULT 0, running INTEGER NOT NULL DEFAULT 0, canceled INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
);
CREATE INDEX gnl_runs_created ON gnl_runs (created_at, run_id);
CREATE INDEX gnl_runs_updated ON gnl_runs (updated_at);
CREATE TABLE gnl_counters (key TEXT NOT NULL, field TEXT NOT NULL, value REAL NOT NULL, PRIMARY KEY (key, field));
CREATE TABLE gnl_threads (
  id TEXT PRIMARY KEY, resource_id TEXT NOT NULL, title TEXT, parent_thread_id TEXT,
  metadata TEXT, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, deleted_at INTEGER
);
CREATE INDEX gnl_threads_res ON gnl_threads (resource_id, updated_at);
CREATE TABLE gnl_messages (
  thread_id TEXT NOT NULL, seq INTEGER NOT NULL, role TEXT NOT NULL, text TEXT,
  embedding TEXT, metadata TEXT, ts INTEGER NOT NULL, message TEXT NOT NULL,
  PRIMARY KEY (thread_id, seq)
);
CREATE TABLE gnl_working_memory (scope_id TEXT PRIMARY KEY, data TEXT NOT NULL, updated_at INTEGER NOT NULL);
CREATE TABLE gnl_observations (thread_id TEXT PRIMARY KEY, obs TEXT NOT NULL);
CREATE TABLE gnl_message_batches (thread_id TEXT NOT NULL, batch_key TEXT NOT NULL, seq_from INTEGER NOT NULL, seq_to INTEGER NOT NULL, ts INTEGER NOT NULL, PRIMARY KEY (thread_id, batch_key));
CREATE TABLE gnl_vectors (id TEXT PRIMARY KEY, text TEXT NOT NULL, embedding TEXT NOT NULL, metadata TEXT, namespace TEXT, owner TEXT, shared INTEGER, created_at INTEGER NOT NULL);
CREATE INDEX gnl_vectors_doc ON gnl_vectors ((CASE WHEN json_valid(metadata) THEN json_extract(metadata, '$.json.__gnlDoc') END));
CREATE TABLE gnl_work_log (ns TEXT NOT NULL, id TEXT NOT NULL, payload TEXT NOT NULL, ts INTEGER NOT NULL, seq INTEGER NOT NULL DEFAULT 0, PRIMARY KEY (ns, id));
CREATE INDEX gnl_work_log_ns ON gnl_work_log (ns, ts);
CREATE TABLE gnl_work_seq (ns TEXT PRIMARY KEY, seq INTEGER NOT NULL);
CREATE TABLE gnl_work_kv (key TEXT PRIMARY KEY, value TEXT NOT NULL);
CREATE TABLE gnl_cache (key TEXT PRIMARY KEY, value TEXT NOT NULL, expires_at INTEGER);
CREATE INDEX gnl_work_log_seq ON gnl_work_log (ns, seq, ts, id);
CREATE TRIGGER gnl_work_log_number AFTER INSERT ON gnl_work_log WHEN NEW.seq = 0
BEGIN
  INSERT OR IGNORE INTO gnl_work_seq (ns, seq) VALUES (NEW.ns, 0);
  UPDATE gnl_work_seq SET seq = seq + 1 WHERE ns = NEW.ns;
  UPDATE gnl_work_log SET seq = (SELECT seq FROM gnl_work_seq WHERE ns = NEW.ns) WHERE rowid = NEW.rowid;
END;
INSERT INTO gnl_meta (k, v) VALUES ('schema_version', '1');
`;

/** Three runs as 0.10.0 writes them (its `:input` row carries no run id): ayse's completed one on t1, a suspended and a failed one on t2. */
const RUNS_0100: Array<{ id: string; thread: string; who: string; suspended: number; failed: number }> = [
  { id: 'r1', thread: 't1', who: 'ayse', suspended: 0, failed: 0 },
  { id: 'r2', thread: 't2', who: 'bora', suspended: 1, failed: 0 },
  { id: 'r3', thread: 't2', who: 'bora', suspended: 0, failed: 1 },
];

function sqlite0100(): { file: string; dir: string } {
  const dir = mkdtempSync(join(tmpdir(), 'gnl-0100-'));
  const file = join(dir, 'runs.db');
  const db = new DatabaseSync(file);
  db.exec('PRAGMA journal_mode = WAL');
  db.exec(SQLITE_0100);
  RUNS_0100.forEach((r, i) => {
    const at = 1000 + i * 10;
    db.prepare(`INSERT INTO gnl_run_journal (key, run_id, kind, suspended, value, created_at) VALUES (?, NULL, NULL, 0, ?, ?)`)
      .run(`${r.id}:input`, serialize({ _v: 1, threadId: r.thread, resourceId: r.who }), at);
    db.prepare(`INSERT INTO gnl_run_journal (key, run_id, kind, suspended, value, created_at) VALUES (?, ?, 'model', 0, ?, ?)`)
      .run(`${r.id}:model:0`, r.id, serialize({ text: 'x' }), at + 1);
    db.prepare(`INSERT INTO gnl_runs (run_id, model_steps, suspended, suspended_count, failed, created_at, updated_at) VALUES (?, 1, ?, ?, ?, ?, ?)`)
      .run(r.id, r.suspended, r.suspended, r.failed, at, at + 1);
  });
  db.close();
  ends.push(() => rmSync(dir, { recursive: true, force: true }));
  return { file, dir };
}

/** Everything a Sqlite file holds: every schema object's text, every table's columns, every row. */
function sqliteSnapshot(file: string): string {
  const db = new DatabaseSync(file);
  try {
    const objects = db.prepare(`SELECT type, name, tbl_name, sql FROM sqlite_master ORDER BY type, name`).all() as Array<{ type: string; name: string }>;
    const tables = objects.filter((o) => o.type === 'table').map((o) => o.name);
    return JSON.stringify({
      objects,
      tables: Object.fromEntries(tables.map((t) => [t, {
        columns: db.prepare(`PRAGMA table_info("${t}")`).all(),
        rows: db.prepare(`SELECT * FROM "${t}" ORDER BY 1`).all(),
      }])),
    });
  } finally {
    db.close();
  }
}

/** The shape of a Sqlite file's schema, without the text of each statement: what a store has, by name. */
function sqliteShape(file: string): Record<string, unknown> {
  const db = new DatabaseSync(file);
  try {
    const objects = db.prepare(`SELECT type, name, tbl_name FROM sqlite_master WHERE name NOT LIKE 'sqlite_%' ORDER BY type, name`).all() as Array<{ type: string; name: string }>;
    return {
      objects: objects.map((o) => `${o.type} ${o.name}`),
      columns: Object.fromEntries(objects.filter((o) => o.type === 'table').map((o) => [o.name,
        (db.prepare(`PRAGMA table_info("${o.name}")`).all() as Array<Record<string, unknown>>).map((c) => `${c.name} ${c.type}${c.notnull ? ' NOT NULL' : ''}${c.dflt_value != null ? ` DEFAULT ${c.dflt_value}` : ''}`).sort()])),
    };
  } finally {
    db.close();
  }
}

/** Every call a refused store must refuse — one per port, and `init`. */
async function askEveryPort(s: Storage): Promise<string[]> {
  const asked: Array<[string, () => Promise<unknown>]> = [
    ['init', async () => s.init?.()],
    ['runs.get', () => toJournal(s.runs).get('r1:input')],
    ['runs.put', () => toJournal(s.runs).put('probe:model:0', { text: 'x' })],
    ['runs.listRuns', () => s.runs.listRuns()],
    ['memory.getThread', async () => s.memory?.getThread('t1')],
    ['work.get', async () => s.work?.get('k')],
    ['cache.get', async () => s.cache?.get('k')],
    ['meta.get', async () => (s.meta as { get?(k: string): Promise<unknown> } | undefined)?.get?.('k')],
  ];
  const answered: string[] = [];
  for (const [name, f] of asked) {
    const e = await f().then(() => undefined, (x: Error) => x);
    if (!e || !/format of an earlier version/.test(e.message)) answered.push(`${name}: ${e?.message ?? 'answered'}`);
  }
  return answered;
}

const refusal = /format of an earlier version/;

describe('W1/W2 — Sqlite: a 0.10.0 file is changed only by an upgrade step that runs', () => {
  it('opening it, every port, init, a dry run and a refused `only` leave every byte of its schema and rows as they were — and the refusal alone is said', async () => {
    const { file } = sqlite0100();
    const before = sqliteSnapshot(file);
    const warned: string[] = [];
    vi.spyOn(console, 'warn').mockImplementation((...a: unknown[]) => { warned.push(a.join(' ')); });
    const s = new SqliteStorage(file);
    expect(await askEveryPort(s)).toEqual([]);
    const dry = await s.upgrade({ dryRun: true });
    expect(dry.steps.find((x) => x.name === 'run-status')).toMatchObject({ pending: true, ran: false });
    expect(dry.steps.find((x) => x.name === 'schema')).toMatchObject({ pending: true, ran: false, detail: { after: ['run-status'] } });
    await expect(s.upgrade({ only: ['schema'] })).rejects.toThrow(/'schema' needs 'run-status' first/);
    await s.close();
    expect(sqliteSnapshot(file)).toEqual(before);
    expect(warned.filter((w) => w === RELATIONS_PENDING_ADVICE)).toEqual([]);
  });

  it('the refusal names the shortest stop: run-status and schema, then the rest while this version serves', async () => {
    const { file } = sqlite0100();
    const s = new SqliteStorage(file);
    const e = await s.runs.listRuns().then(() => undefined, (x: Error) => x);
    expect(e?.message).toMatch(/Nothing was read or written/);
    expect(e?.message).toMatch(/gnl upgrade --only run-status,schema/);
    await s.close();
  });

  it('W3: after upgrade() the file is a new file — same tables, columns, indexes, triggers — and refuses a write that names no status, as a new file does', async () => {
    const { file, dir } = sqlite0100();
    const s = new SqliteStorage(file);
    const ran = await s.upgrade();
    expect(ran.steps.filter((x) => x.ran).map((x) => x.name)).toEqual(['run-status', 'schema', 'thread-records', 'relations']);
    expect(Object.fromEntries((await s.runs.listRuns()).items.map((r) => [r.runId, r.status]))).toEqual({ r1: 'completed', r2: 'suspended', r3: 'failed' });
    await s.close();
    const fresh = new SqliteStorage(join(dir, 'fresh.db'));
    await fresh.close();
    expect(sqliteShape(file)).toEqual(sqliteShape(join(dir, 'fresh.db')));
    for (const f of [file, join(dir, 'fresh.db')]) {
      const db = new DatabaseSync(f);
      try {
        expect(() => db.prepare(`INSERT INTO gnl_runs (run_id, created_at, updated_at) VALUES ('raw', 1, 1)`).run(), f).toThrow(/NOT NULL constraint failed: gnl_runs.status/);
      } finally {
        db.close();
      }
    }
    const again = new SqliteStorage(file);
    expect((await again.upgrade({ dryRun: true })).steps.filter((x) => x.pending).map((x) => x.name)).toEqual([]);
    await again.close();
  });

  it('a process that opened the file refused serves it once another has upgraded it — this version\'s schema at work for its writes', async () => {
    const { file } = sqlite0100();
    const early = new SqliteStorage(file);
    await expect(early.runs.listRuns()).rejects.toThrow(refusal);
    const other = new SqliteStorage(file);
    await other.upgrade();
    await other.close();
    await early.runs.put('r1:model:1', { text: 'y' });
    expect((await early.runs.readRun('r1')).map((e) => e.key)).toEqual(['r1:model:0', 'r1:model:1']); // 0.10.0 wrote `:input` with no run id
    const db = new DatabaseSync(file);
    try {
      expect(db.prepare(`SELECT ord FROM gnl_run_journal WHERE key = 'r1:model:1'`).get().ord).toBeGreaterThan(0); // numbered by this version's trigger
    } finally {
      db.close();
    }
    await early.close();
  });

  it('W4: a step named alone is refused with every step it waits on, and the command it suggests runs', async () => {
    const { file } = sqlite0100();
    const s = new SqliteStorage(file);
    const e = await s.upgrade({ only: ['thread-records'] }).then(() => undefined, (x: Error) => x);
    expect(e?.message).toMatch(/'thread-records' needs 'run-status' and 'schema' first, which are still pending/);
    expect(e?.message).toContain("only: ['run-status', 'schema', 'thread-records']");
    expect(e?.message).toContain('gnl upgrade --only run-status,schema,thread-records');
    const suggested = /only: \[([^\]]*)\]/.exec(e!.message)![1]!.split(', ').map((x) => x.replace(/'/g, '')) as never;
    const ran = await s.upgrade({ only: suggested });
    expect(ran.steps.filter((x) => x.ran).map((x) => x.name)).toEqual(['run-status', 'schema', 'thread-records']);
    await s.close();
  });
});

// ── Postgres ───────────────────────────────────────────────────────────────────────────────────────
interface PgStore { make(): PostgresStorage; sql(text: string): Promise<any[]>; real: boolean }

function pgMem(): PgStore {
  const db = newDb();
  const { Pool } = db.adapters.createPg();
  const pool = new Pool();
  return { make: () => new PostgresStorage({ pool }), sql: async (t) => (await pool.query(t)).rows, real: false };
}

async function realPg(): Promise<PgStore> {
  const admin = new pg.Client({ connectionString: PG_URL });
  await admin.connect();
  const name = `cpm_w_${process.pid}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`;
  await admin.query(`CREATE DATABASE ${name}`);
  const u = new URL(PG_URL!); u.pathname = `/${name}`;
  const pools: pg.Pool[] = [];
  const pool = () => { const p = new pg.Pool({ connectionString: u.toString(), max: 2 }); p.on('error', () => {}); pools.push(p); return p; };
  const raw = pool();
  ends.push(async () => { for (const p of pools) await p.end().catch(() => {}); await admin.query(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`); await admin.end(); });
  return { make: () => new PostgresStorage({ pool: pool() }), sql: async (t) => (await raw.query(t)).rows, real: true };
}

const PG: Array<[string, () => Promise<PgStore>]> = [['pg-mem', async () => pgMem()]];
if (PG_URL) PG.push(['real', realPg]);

/** A real Postgres's catalog for the store's tables: columns, indexes, triggers, and the rows in each. */
async function pgSnapshot(b: PgStore): Promise<string> {
  const tables = (await b.sql(`SELECT table_name AS t FROM information_schema.tables WHERE table_schema = current_schema() AND table_name LIKE 'gnl%' ORDER BY 1`)).map((r) => r.t as string);
  const out: Record<string, unknown> = {
    columns: await b.sql(`SELECT table_name, column_name, data_type, is_nullable, column_default FROM information_schema.columns WHERE table_schema = current_schema() ORDER BY 1, 2`),
    indexes: await b.sql(`SELECT indexname, indexdef FROM pg_indexes WHERE schemaname = current_schema() ORDER BY 1`),
    triggers: await b.sql(`SELECT tgname FROM pg_trigger WHERE NOT tgisinternal ORDER BY 1`),
  };
  for (const t of tables) out[t] = await b.sql(`SELECT * FROM ${t} ORDER BY 1`);
  return JSON.stringify(out);
}

for (const [name, make] of PG) {
  describe(`W1/W4/W5 — Postgres (${name})`, () => {
    it('W5: a database with no store has nothing to upgrade, and neither a dry run nor upgrade() creates one', async () => {
      const b = await make();
      const s = b.make();
      const dry = await s.upgrade({ dryRun: true });
      expect(dry.steps.filter((x) => x.pending).map((x) => x.name)).toEqual([]);
      const ran = await s.upgrade();
      expect(ran.steps.filter((x) => x.ran || x.pending).map((x) => x.name)).toEqual([]);
      expect(await b.sql(`SELECT table_name FROM information_schema.tables WHERE table_name LIKE 'gnl%'`)).toEqual([]);
      // Its first boot creates it as this version's, with nothing left to upgrade.
      await s.init();
      expect((await s.upgrade({ dryRun: true })).steps.filter((x) => x.pending).map((x) => x.name)).toEqual([]);
    });

    it.runIf(name === 'real')('W1: a store in 0.10\'s run format is not changed by opening it, a dry run or a refused `only`', async () => {
      const b = await make();
      const boot = b.make();
      await boot.init();
      await toJournal(boot.runs).put('r1:model:0', { text: 'x' });
      for (const sql of [
        `ALTER TABLE gnl_runs ADD COLUMN suspended BOOLEAN NOT NULL DEFAULT false, ADD COLUMN failed BOOLEAN NOT NULL DEFAULT false, ADD COLUMN running BOOLEAN NOT NULL DEFAULT false, ADD COLUMN canceled BOOLEAN NOT NULL DEFAULT false`,
        `DROP INDEX gnl_runs_open`, `DROP INDEX gnl_runs_status`, `ALTER TABLE gnl_runs DROP COLUMN status, DROP COLUMN outcome`,
      ]) await b.sql(sql);
      const before = await pgSnapshot(b);
      const s = b.make();
      expect(await askEveryPort(s)).toEqual([]);
      expect((await s.upgrade({ dryRun: true })).steps.find((x) => x.name === 'run-status')?.pending).toBe(true);
      await expect(s.upgrade({ only: ['relations'] })).rejects.toThrow(/'relations' needs 'run-status' and 'schema' first[\s\S]*only: \['run-status', 'schema', 'relations'\]/);
      expect(await pgSnapshot(b)).toEqual(before);
    });
  });
}

describe('W5 — a store with nothing to upgrade says so', () => {
  const stores: Array<[string, () => Storage]> = [
    ['InMemory', () => new InMemoryStorage()],
    ['Sqlite', () => {
      const dir = mkdtempSync(join(tmpdir(), 'gnl-w5-'));
      ends.push(() => rmSync(dir, { recursive: true, force: true }));
      return new SqliteStorage(join(dir, 'runs.db'));
    }],
  ];
  for (const [name, make] of stores) {
    it(`${name}: new, and after this version's first run on a thread — nothing pending`, async () => {
      const s = make();
      await s.init?.();
      expect((await s.upgrade!({ dryRun: true })).steps.filter((x) => x.pending).map((x) => x.name)).toEqual([]);
      const j = toJournal(s.runs);
      await admitThreadRun(j, undefined, 't1', user('ayse'));
      await j.put('r1:input', { _v: 1, threadId: 't1', resourceId: 'ayse' });
      await j.put('r1:model:0', { text: 'x' });
      expect((await s.upgrade!({ dryRun: true })).steps.filter((x) => x.pending).map((x) => x.name)).toEqual([]);
      await s.close?.();
    });
  }
});

describe('W4 — the refusal names the whole chain, in the store\'s order', () => {
  const step = (name: string, requires?: string[], isPending = true): UpgradeStep => ({
    name: name as never, description: name, ...(requires ? { requires: requires as never } : {}),
    pending: async () => isPending, run: async () => ({}),
  });
  it('d waits on c, c on b, b on a: naming d alone names a, b and c', async () => {
    const steps = [step('run-status'), step('schema', ['run-status']), step('thread-records', ['schema']), step('relations', ['thread-records'])];
    await expect(runUpgrade('X', steps, { only: ['relations'] })).rejects.toThrow(
      "'relations' needs 'run-status' and 'schema' and 'thread-records' first, which are still pending. Run them together — upgrade({ only: ['run-status', 'schema', 'thread-records', 'relations'] })",
    );
    // A prerequisite already done is not named; one named by the caller is not named again.
    const partly = [step('run-status', undefined, false), step('schema', ['run-status']), step('thread-records', ['schema']), step('relations', ['thread-records'])];
    await expect(runUpgrade('X', partly, { only: ['schema', 'relations'] })).rejects.toThrow(
      "'relations' needs 'thread-records' first, which is still pending. Run them together — upgrade({ only: ['schema', 'thread-records', 'relations'] })",
    );
  });
});

describe('W6 — the run-status step is reached through upgrade() only', () => {
  it('neither adapter declares migrateRunStatus, runStatusPending or runStatusPlan as something a caller can call', () => {
    for (const f of ['sqlite-storage.d.ts', 'postgres-storage.d.ts']) {
      const dts = readFileSync(new URL(`../dist/${f}`, import.meta.url), 'utf8');
      for (const m of ['migrateRunStatus', 'runStatusPending', 'runStatusPlan']) {
        const declared = dts.split('\n').filter((l) => new RegExp(`^\\s*(private |protected |public )?(async )?${m}\\b`).test(l)).map((l) => l.trim());
        expect(declared.length, `${f}: ${m}`).toBe(1);
        expect(declared.every((l) => l === `private ${m};`), `${f}: ${declared.join(' | ')}`).toBe(true);
      }
    }
  });
});
