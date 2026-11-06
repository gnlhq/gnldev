// @ts-nocheck
// k3 verification: which real backend a k3 test runs against. K3_BACKEND picks one of
// postgres | mysql | mongo | libsql (default postgres); the server comes from the same env names the
// repo's real-backend gate uses (GNL_PG_URL, GNL_MYSQL_URL, GNL_MONGO_URL) and, for libsql, a directory
// (K3_LIBSQL_DIR) in which each scope is a file. Test logic is the same on every backend; only the
// store is made here.
import { createRequire } from 'node:module';
import { mkdirSync, rmSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const durableRequire = createRequire(join(here, '..', '..', 'package.json'));

export const BACKEND = process.env.K3_BACKEND ?? 'postgres';
export const BASE_URL = {
  postgres: process.env.GNL_PG_URL,
  mysql: process.env.GNL_MYSQL_URL,
  mongo: process.env.GNL_MONGO_URL,
  libsql: process.env.K3_LIBSQL_DIR,
}[BACKEND];

const LOAD = {
  dist: {
    postgres: async () => (await import('../../dist/postgres-storage.js')).PostgresStorage,
    mysql: async () => (await import('../../dist/mysql-storage.js')).MysqlStorage,
    mongo: async () => (await import('../../dist/mongo-storage.js')).MongoStorage,
    libsql: async () => (await import('../../dist/libsql-storage.js')).LibsqlStorage,
  },
  src: {
    postgres: async () => (await import('../../src/postgres-storage.ts')).PostgresStorage,
    mysql: async () => (await import('../../src/mysql-storage.ts')).MysqlStorage,
    mongo: async () => (await import('../../src/mongo-storage.ts')).MongoStorage,
    libsql: async () => (await import('../../src/libsql-storage.ts')).LibsqlStorage,
  },
};

/**
 * The store behind `url` (a libsql "url" is a file path). `src: true` loads the TypeScript sources
 * (tests that import ../../src/*), otherwise dist (child processes, and tests that import the package):
 * a test must not mix the two, whose module-level registries are separate.
 */
export async function newStorage(url, { src = false } = {}) {
  const load = LOAD[src ? 'src' : 'dist'][BACKEND];
  if (!load) throw new Error(`K3_BACKEND: unknown backend ${BACKEND}`);
  const Store = await load();
  if (BACKEND === 'postgres') return new Store({ connectionString: url });
  if (BACKEND === 'mysql') return new Store({ connectionString: url });
  if (BACKEND === 'mongo') return new Store({ connectionString: url });
  return new Store(url);
}

const scopes = new Map();

/**
 * A database of this scope's own, empty, on the backend's server: a waker or poller scans EVERY run
 * of the store it is given, so files that share a store would resume each other's runs.
 * Postgres keeps the repo's shared database unless `isolate` asks for a schema (as the k3 tests always did).
 */
export function scopeUrl(tag, { isolate = false } = {}) {
  if (!scopes.has(tag)) scopes.set(tag, make(tag, isolate));
  return scopes.get(tag);
}

async function make(tag, isolate) {
  const name = `k3_${tag}`.replace(/[^a-z0-9_]/gi, '_');
  if (BACKEND === 'postgres') {
    if (!isolate) return BASE_URL;
    const pg = durableRequire('pg');
    const c = new pg.Client(BASE_URL);
    await c.connect();
    await c.query(`DROP SCHEMA IF EXISTS ${name} CASCADE`);
    await c.query(`CREATE SCHEMA ${name}`);
    await c.end();
    return `${BASE_URL}${BASE_URL.includes('?') ? '&' : '?'}options=-c%20search_path%3D${name}`;
  }
  if (BACKEND === 'mysql') {
    const mysql = durableRequire('mysql2/promise');
    const c = await mysql.createConnection(BASE_URL);
    await c.query(`DROP DATABASE IF EXISTS ${name}`);
    await c.query(`CREATE DATABASE ${name}`);
    await c.end();
    const u = new URL(BASE_URL);
    u.pathname = `/${name}`;
    return u.toString();
  }
  if (BACKEND === 'mongo') {
    const { MongoClient } = durableRequire('mongodb');
    const c = new MongoClient(BASE_URL);
    await c.connect();
    await c.db(name).dropDatabase();
    await c.close();
    const u = new URL(BASE_URL);
    u.pathname = `/${name}`;
    return u.toString();
  }
  mkdirSync(BASE_URL, { recursive: true });
  const file = join(BASE_URL, `${name}.db`);
  for (const suffix of ['', '-wal', '-shm', '-journal']) rmSync(file + suffix, { force: true });
  return file;
}
