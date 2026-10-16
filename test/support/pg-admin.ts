// A database of a test's own on the server GNL_PG_URL names — created and dropped through that URL.
//
// Synchronous on purpose: the multi-process harnesses hand out stores from synchronous helpers. These
// used to shell out to `docker exec gnl-r7-pg psql`, a container that exists on one developer's machine
// and nowhere else — so on CI, where the server is a service container, every such test could only fail.
// The statement runs in a short child process through `pg`, which is @gnldev/durable's dependency.
import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const pgPath = createRequire(join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'packages', 'durable', 'package.json')).resolve('pg');

const RUN_ONE = `
const pg = require(process.argv[1]);
const c = new pg.Client({ connectionString: process.argv[2] });
c.connect().then(() => c.query(process.argv[3])).then(() => c.end(), (e) => { console.error(e.message); process.exit(1); });
`;

function adminSync(sql: string, url = process.env.GNL_PG_URL): void {
  if (!url) throw new Error('pg-admin: GNL_PG_URL is not set');
  execFileSync(process.execPath, ['-e', RUN_ONE, pgPath, url, sql], { stdio: 'pipe' });
}

/** Creates database `name` on GNL_PG_URL's server and returns its URL. */
export function createDatabaseSync(name: string): string {
  adminSync(`CREATE DATABASE ${name}`);
  const url = new URL(process.env.GNL_PG_URL!);
  url.pathname = `/${name}`;
  return url.toString();
}

/** Drops database `name`, closing its connections first. Best effort: a test's cleanup must not fail it. */
export function dropDatabaseSync(name: string): void {
  try { adminSync(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`); } catch { /* best effort */ }
}

/**
 * A pool of a test's own (raw statements, an old-format seed) on a database the test force-drops later:
 * with a listener on the pool and on every connection, as @gnldev/durable's PostgresStorage gives its own.
 *
 * Why: `pool.end()` resolves once the pool has asked each connection to end, not once the server has
 * ended its session. A `DROP DATABASE … WITH (FORCE)` right after can reach a session still open; the
 * server sends it 57P01 ("terminating connection due to administrator command"), `pg` emits 'error' on
 * the client and forwards it to the pool, and a pool with no 'error' listener throws it out of the
 * socket — an uncaught exception in whatever test file the worker is running (seen in CI on the shared
 * real-backend group, readrun-write-order.test.ts). A pool handed to PostgresStorage needs none of this:
 * the store attaches the same listeners.
 */
export function helperPool(connectionString: string, max = 1): any {
  const pg = createRequire(import.meta.url)(pgPath) as { Pool: new (c: object) => any };
  const pool = new pg.Pool({ connectionString, max });
  pool.on('error', () => {});
  pool.on('connect', (c: { on(e: string, fn: () => void): void }) => { c.on('error', () => {}); });
  return pool;
}
