// The MySQL-family servers a test runs on, from the environment: GNL_MYSQL_URL (MySQL 8.4+) and
// GNL_MARIADB_URL (MariaDB 11+), each `mysql://user:password@localhost:port/database` naming a user that may
// create databases. Every store opened here gets a database of its own (`gnl_t_<pid>_<n>`), dropped when
// the importing file ends. Nothing is listed when neither variable is set.
import { afterAll } from 'vitest';
import { createRequire } from 'node:module';
import { MysqlStorage } from '../src/mysql-storage.js';

type Admin = { query(sql: string): Promise<unknown>; end(): Promise<void> };
const mysql = () => createRequire(import.meta.url)('mysql2/promise') as { createConnection(uri: string): Promise<Admin> };

export const MYSQL_SERVERS: Array<{ name: string; url: string }> = [
  ...(process.env.GNL_MYSQL_URL ? [{ name: 'MySQL', url: process.env.GNL_MYSQL_URL }] : []),
  ...(process.env.GNL_MARIADB_URL ? [{ name: 'MariaDB', url: process.env.GNL_MARIADB_URL }] : []),
];

let n = 0;
const made: Array<{ url: string; db: string }> = [];
let registered = false;
/** The importing file's cleanup: every database made here, dropped. */
function registerCleanup(): void {
  if (registered) return;
  registered = true;
  afterAll(async () => {
    for (const { url, db } of made.splice(0)) {
      const admin = await mysql().createConnection(url);
      try { await admin.query(`DROP DATABASE IF EXISTS \`${db}\``); } finally { await admin.end(); }
    }
  });
}

// Imported at a file's collection, so the hook is that file's.
if (MYSQL_SERVERS.length) registerCleanup();

/** A fresh, empty database on `url`'s server, its URL returned; dropped when the importing file ends. */
export async function freshDatabase(url: string): Promise<string> {
  const db = `gnl_t_${process.pid}_${Date.now().toString(36)}_${n++}`;
  const admin = await mysql().createConnection(url);
  try { await admin.query(`CREATE DATABASE \`${db}\``); } finally { await admin.end(); }
  made.push({ url, db });
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
