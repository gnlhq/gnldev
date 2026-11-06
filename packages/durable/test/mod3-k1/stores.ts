// mod3 k1 — the stores the liveness scenarios run on, one fresh database each, behind one small surface.
// A store is reached by an env URL (like the rest of the real-backend suite); Sqlite and libSQL need none:
//   GNL_PG_URL    postgres://…            a schema per scenario
//   GNL_MYSQL_URL mysql://root:…@localhost/db  a database per scenario
//   GNL_MONGO_URL mongodb://host:port/db?replicaSet=…|directConnection=true   a database per scenario
// The classes come in as `Mods`, so a child process (which runs the sources) and a test (which runs the
// build) each bring their own and never mix two copies of the library.
import { createRequire } from 'node:module';
import { mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ProcessLiveness } from '../../src/process-liveness.js';

export type Kind = 'sqlite' | 'libsql' | 'postgres' | 'mysql' | 'mongo';

export interface Mods {
  SqliteStorage: new (path: string, opts?: { liveness?: ProcessLiveness }) => any;
  LibsqlStorage: new (path: string, opts?: { liveness?: ProcessLiveness }) => any;
  PostgresStorage: new (opts: { connectionString: string; liveness?: ProcessLiveness | Promise<ProcessLiveness> }) => any;
  MysqlStorage: new (opts: { connectionString: string; liveness?: ProcessLiveness | Promise<ProcessLiveness> }) => any;
  MongoStorage: new (opts: { connectionString: string; database?: string; liveness?: ProcessLiveness | Promise<ProcessLiveness> }) => any;
  sqliteLiveness: (path: string) => ProcessLiveness;
  postgresLiveness: (opts: { connectionString: string }) => Promise<ProcessLiveness>;
  mysqlLiveness: (opts: { connectionString: string }) => Promise<ProcessLiveness>;
  mongoLiveness: (opts: { connectionString: string; database?: string }) => Promise<ProcessLiveness>;
}

/** Where one scenario's database is: JSON, so a child process can open the same one. */
export interface Conn { kind: Kind; path?: string; url?: string; database?: string }

const req = createRequire(createRequire(import.meta.url).resolve('@gnldev/durable/package.json'));
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const URLS: Record<Kind, string | undefined> = {
  sqlite: 'file', libsql: 'file', postgres: process.env.GNL_PG_URL, mysql: process.env.GNL_MYSQL_URL, mongo: process.env.GNL_MONGO_URL,
};
function libsqlInstalled(): boolean {
  try { req.resolve('libsql'); return true; } catch { return false; }
}
/** The stores this run can reach: Sqlite always, the others when their URL (and driver) is there. */
export function kinds(): Kind[] {
  return (['sqlite', 'libsql', 'postgres', 'mysql', 'mongo'] as Kind[]).filter((k) => URLS[k] !== undefined && (k !== 'libsql' || libsqlInstalled()));
}

/** A store's `liveness` for this database, made the way a user makes one (the store's own fallback is the same call). */
export function makeLiveness(m: Mods, c: Conn): Promise<ProcessLiveness> {
  switch (c.kind) {
    case 'sqlite': case 'libsql': return Promise.resolve(m.sqliteLiveness(c.path!));
    case 'postgres': return m.postgresLiveness({ connectionString: c.url! });
    case 'mysql': return m.mysqlLiveness({ connectionString: c.url! });
    case 'mongo': return m.mongoLiveness({ connectionString: c.url!, database: c.database! });
  }
}

/** The store of `c`, with `liveness` when one is given (`new XStorage({ …, liveness })`). */
export function openStore(m: Mods, c: Conn, liveness?: ProcessLiveness): any {
  const l = liveness ? { liveness } : {};
  switch (c.kind) {
    case 'sqlite': return new m.SqliteStorage(c.path!, l);
    case 'libsql': return new m.LibsqlStorage(c.path!, l);
    case 'postgres': return new m.PostgresStorage({ connectionString: c.url!, ...l });
    case 'mysql': return new m.MysqlStorage({ connectionString: c.url!, ...l });
    case 'mongo': return new m.MongoStorage({ connectionString: c.url!, database: c.database!, ...l });
  }
}

export interface Fresh {
  conn: Conn;
  /** Process-liveness sessions this database holds right now, as the server (or the lock directory) shows them. */
  sessions(): Promise<number>;
  dispose(): Promise<void>;
}

const rand = () => `${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`;

/**
 * A fresh, empty database on `kind`. `scope` names the test file: MongoDB keeps the files of every collection
 * and index of a database open, and a database created and dropped per scenario exhausted the server's file
 * handles (1,024 in the stock container) within one file — so a scope has ONE database there, emptied between
 * scenarios (scenarios of one file run one after another).
 */
export async function freshDatabase(kind: Kind, scope = 'default'): Promise<Fresh> {
  if (kind === 'sqlite' || kind === 'libsql') {
    const dir = mkdtempSync(join(tmpdir(), 'k1s-'));
    const path = join(dir, 'k1.db');
    return {
      conn: { kind, path },
      // Each held session is a lock file in the database's lock directory (`<dev>-<ino>.gnl-procs`).
      async sessions() {
        await sleep(100);
        return readdirSync(dir).filter((f) => f.endsWith('.gnl-procs')).flatMap((d) => readdirSync(join(dir, d))).filter((f) => f.endsWith('.lock')).length;
      },
      async dispose() { rmSync(dir, { recursive: true, force: true }); },
    };
  }
  if (kind === 'postgres') {
    const pg = req('pg');
    const admin = new pg.Client({ connectionString: URLS.postgres });
    await admin.connect();
    const schema = `k1s_${rand()}`;
    await admin.query(`CREATE SCHEMA ${schema}`);
    const u = new URL(URLS.postgres!);
    u.searchParams.set('options', `-c search_path=${schema}`);
    // Every session of this scenario carries the schema's name: the count sees only them.
    u.searchParams.set('application_name', schema);
    return {
      conn: { kind, url: u.toString() },
      async sessions() {
        await sleep(300);
        return (await admin.query(
          `SELECT 1 FROM pg_locks l JOIN pg_stat_activity a ON a.pid = l.pid
             WHERE a.application_name = $1 AND l.locktype = 'advisory' AND l.objsubid = 1 AND l.granted`, [schema])).rows.length;
      },
      async dispose() { await admin.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`); await admin.end(); },
    };
  }
  if (kind === 'mysql') {
    const mysql = req('mysql2/promise');
    const admin = await mysql.createConnection(URLS.mysql);
    const db = `k1s_${rand()}`;
    await admin.query(`CREATE DATABASE ${db}`);
    const u = new URL(URLS.mysql!);
    u.pathname = `/${db}`;
    const held = async (): Promise<number> => {
      const [rows] = await admin.query(`SELECT COUNT(*) AS n FROM performance_schema.metadata_locks WHERE OBJECT_TYPE = 'USER LEVEL LOCK' AND OBJECT_NAME LIKE 'gnlp\\_%'`);
      return Number(rows[0].n);
    };
    const before = await held();
    return {
      conn: { kind, url: u.toString() },
      // A process lock is a named lock (`gnlp_<hash of the database and the id>`); the server shows every
      // database's, so what was held before this scenario is taken off.
      async sessions() {
        await sleep(300);
        return (await held()) - before;
      },
      async dispose() { await admin.query(`DROP DATABASE IF EXISTS ${db}`); await admin.end(); },
    };
  }
  const { MongoClient } = req('mongodb');
  const database = `k1s_${scope}`;
  const probe = new MongoClient(URLS.mongo);
  // A process liveness is a connection named for it: a uuid, as the server's operations list shows (the
  // server shows every database's, so what was held before this scenario is taken off).
  const held = async (): Promise<number> => {
    const ops = await probe.db('admin').aggregate([{ $currentOp: { allUsers: true, idleConnections: true } }]).toArray();
    return new Set(ops.map((o: { appName?: string }) => o.appName).filter((n: string | undefined) => /^[0-9a-f]{8}-[0-9a-f]{4}-/.test(n ?? ''))).size;
  };
  const before = await held();
  const empty = async () => {
    const db = probe.db(database);
    for (const { name } of await db.listCollections({}, { nameOnly: true }).toArray()) await db.collection(name).deleteMany({});
  };
  await empty();
  return {
    conn: { kind, url: URLS.mongo, database },
    async sessions() {
      await sleep(300);
      return (await held()) - before;
    },
    async dispose() { await empty().catch(() => undefined); await probe.close(); },
  };
}

