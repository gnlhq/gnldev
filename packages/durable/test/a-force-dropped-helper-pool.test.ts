// A test's own pool on a database it force-drops must not take the worker down.
//
// CI (real-backend Postgres, en_US.utf8, shared group) failed on a0b6d74a with an unhandled 57P01
// ("terminating connection due to administrator command") attributed to readrun-write-order.test.ts.
// That file seeded an old-format store through a raw `pg.Pool` — the one pool in it not handed to
// PostgresStorage, so the one with no 'error' listener — and its cleanup force-dropped the database right
// after `pool.end()`. `pool.end()` resolves once each connection was ASKED to end; a session the server
// has not closed yet is terminated by the drop, `pg` emits the server's 57P01 on the client, forwards it
// to the pool, and a pool with no listener throws it out of the socket.
//
// The CI timing (end in flight) is not reproducible here; the path it takes is: a session of the pool
// still open when the drop runs. Measured in a child process, each way: the raw pool dies with 57P01, the
// pool from test/support/pg-admin.ts `helperPool` lives.
import { describe, it, expect } from 'vitest';
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const PG_URL = process.env.GNL_PG_URL;
const here = dirname(fileURLToPath(import.meta.url));
const pgPath = createRequire(import.meta.url).resolve('pg');
const tsxLoader = join(dirname(createRequire(import.meta.url).resolve('tsx/package.json')), 'dist', 'loader.mjs');

/** A child that opens a pool on a fresh database, leaves a session idle, force-drops the database, and waits. */
const CHILD = (kind: 'raw' | 'helper') => `
import { createRequire } from 'node:module';
import { helperPool } from ${JSON.stringify(join(here, '..', '..', '..', 'test', 'support', 'pg-admin.ts'))};
const pg = createRequire(import.meta.url)(${JSON.stringify(pgPath)});
const base = process.env.GNL_PG_URL;
const admin = new pg.Client({ connectionString: base });
await admin.connect();
const name = 'fdh_' + process.pid + '_' + Date.now().toString(36);
await admin.query('CREATE DATABASE ' + name);
const u = new URL(base); u.pathname = '/' + name;
const pool = ${kind === 'raw' ? "new pg.Pool({ connectionString: u.toString(), max: 1 })" : 'helperPool(u.toString())'};
await pool.query('SELECT 1');
await admin.query('DROP DATABASE IF EXISTS ' + name + ' WITH (FORCE)');
await new Promise((r) => setTimeout(r, 300));
await pool.end().catch(() => {});
await admin.end();
console.log('alive');
`;

const runChild = (kind: 'raw' | 'helper') =>
  spawnSync(process.execPath, ['--import', tsxLoader, '--input-type=module', '-e', CHILD(kind)], { env: { ...process.env, GNL_PG_URL: PG_URL }, encoding: 'utf8', timeout: 20_000 });

describe.skipIf(!PG_URL)('a test pool on a force-dropped database (real Postgres)', () => {
  it('control: a raw pool with no listener dies with 57P01', () => {
    const r = runChild('raw');
    expect({ alive: r.stdout.includes('alive'), code57P01: /57P01|administrator command/.test(r.stderr) }).toEqual({ alive: false, code57P01: true });
  }, 30_000);

  it('helperPool lives through it', () => {
    const r = runChild('helper');
    expect({ alive: r.stdout.includes('alive'), status: r.status, stderr: r.stderr.trim() }).toEqual({ alive: true, status: 0, stderr: '' });
  }, 30_000);
});
