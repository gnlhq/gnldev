// The MySQL-family servers a test runs on, from the environment: GNL_MYSQL_URL (MySQL 8.4+) and
// GNL_MARIADB_URL (MariaDB 11+), each `mysql://user:password@localhost:port/database` naming a user that may
// create databases. Every store opened here gets a database of its own (`gnl_t_<pid>_<n>`), dropped when
// the importing file ends. Nothing is listed when neither variable is set.
//
// GNL_MONGO_URL names a MongoDB replica set (`mongodb://user:password@localhost:port/gnl?replicaSet=…` or
// `…?directConnection=true` for one local node) and a user that may create databases and users; each
// store opened on it gets a database of its own the same way. GNL_MONGO_STANDALONE_URL names a server
// that is NOT a replica set — what MongoStorage must refuse.
import { afterAll } from 'vitest';
import { createRequire } from 'node:module';
import { MysqlStorage } from '../src/mysql-storage.js';
import { MongoStorage } from '../src/mongo-storage.js';

type Admin = { query(sql: string): Promise<unknown>; end(): Promise<void> };
const mysql = () => createRequire(import.meta.url)('mysql2/promise') as { createConnection(uri: string): Promise<Admin> };

export const MYSQL_SERVERS: Array<{ name: string; url: string }> = [
  ...(process.env.GNL_MYSQL_URL ? [{ name: 'MySQL', url: process.env.GNL_MYSQL_URL }] : []),
  ...(process.env.GNL_MARIADB_URL ? [{ name: 'MariaDB', url: process.env.GNL_MARIADB_URL }] : []),
];

export const MONGO_URL = process.env.GNL_MONGO_URL;
export const MONGO_STANDALONE_URL = process.env.GNL_MONGO_STANDALONE_URL;

let n = 0;
const made: Array<() => Promise<void>> = [];
let registered = false;
/** The importing file's cleanup: every database made here, dropped. */
function registerCleanup(): void {
  if (registered) return;
  registered = true;
  afterAll(async () => {
    for (const drop of made.splice(0)) await drop();
  });
}

// Imported at a file's collection, so the hook is that file's.
if (MYSQL_SERVERS.length || MONGO_URL) registerCleanup();

/** A fresh, empty database on `url`'s server, its URL returned; dropped when the importing file ends. */
export async function freshDatabase(url: string): Promise<string> {
  const db = `gnl_t_${process.pid}_${Date.now().toString(36)}_${n++}`;
  const admin = await mysql().createConnection(url);
  try { await admin.query(`CREATE DATABASE \`${db}\``); } finally { await admin.end(); }
  made.push(async () => {
    const a = await mysql().createConnection(url);
    try { await a.query(`DROP DATABASE IF EXISTS \`${db}\``); } finally { await a.end(); }
  });
  const u = new URL(url);
  u.pathname = `/${db}`;
  return u.toString();
}

/**
 * `[name, make]` for each configured server, `make` opening a MysqlStorage on a fresh database — the
 * shape every backend list in this suite has; spread it into one.
 */
export function mysqlStores(label = ''): Array<[string, () => Promise<MysqlStorage>]> {
  return MYSQL_SERVERS.map(({ name, url }) => [`${name}${label}`, async () => new MysqlStorage({ connectionString: await freshDatabase(url) })]);
}

type MongoAdmin = { db(name: string): { dropDatabase(): Promise<unknown> }; close(): Promise<void> };
const mongo = () => createRequire(import.meta.url)('mongodb') as { MongoClient: new (url: string) => MongoAdmin };

/** `url` naming database `db` instead of its own. */
export function mongoUrlFor(url: string, db: string): string {
  const u = new URL(url);
  u.pathname = `/${db}`;
  return u.toString();
}

/** A fresh database name on the MongoDB server, its URL returned; dropped when the importing file ends. */
export function freshMongoDatabase(url = MONGO_URL!): string {
  const db = `gnl_t_${process.pid}_${Date.now().toString(36)}_${n++}`;
  made.push(async () => {
    const c = new (mongo().MongoClient)(url);
    try { await c.db(db).dropDatabase(); } finally { await c.close(); }
  });
  return mongoUrlFor(url, db);
}

/** `[name, make]` for the MongoDB server when GNL_MONGO_URL is set (see `mysqlStores`). */
export function mongoStores(label = ''): Array<[string, () => Promise<MongoStorage>]> {
  return MONGO_URL ? [[`MongoDB${label}`, async () => new MongoStorage({ connectionString: freshMongoDatabase() })]] : [];
}
