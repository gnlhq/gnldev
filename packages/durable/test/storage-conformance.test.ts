// The storage conformance kit (`@gnldev/durable/testing` storageConformance) on every store this
// repository ships: the run journal's scenarios through `toJournal`, then each port the store offers.
// With GNL_PG_URL also a real Postgres, a fresh schema per opened store, dropped at the end.
import { describe, it, afterAll } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { newDb } from 'pg-mem';
import pg from 'pg';
import { InMemoryStorage } from '@gnldev/durable';
import { storageConformance } from '@gnldev/durable/testing';
import { SqliteStorage } from '../src/sqlite-storage.js';
import { PostgresStorage } from '../src/postgres-storage.js';

const PG_URL = process.env.GNL_PG_URL;
const ends: Array<() => Promise<void> | void> = [];
afterAll(async () => { for (const e of ends.reverse()) await e(); });

// One process reaches an in-memory store: it has no liveness of its own (the registry binds one in process).
storageConformance('InMemory', () => new InMemoryStorage(), { describe, it, ports: ['work', 'vectors', 'memory', 'upgrade'], timeout: 120_000 });

const sqliteFile = new WeakMap<object, string>();
storageConformance('Sqlite (a file)', () => {
  const dir = mkdtempSync(join(tmpdir(), 'gnl-storage-conf-'));
  ends.push(() => rmSync(dir, { recursive: true, force: true }));
  const s = new SqliteStorage(join(dir, 's.db'));
  sqliteFile.set(s, join(dir, 's.db'));
  return s;
}, { describe, it, timeout: 120_000, reopen: (s) => new SqliteStorage(sqliteFile.get(s)!) });

// pg-mem is a test double: it reports a lost claim as won, cannot page a run list, lets other
// connections see a batch before it commits, cannot order two appends, and cannot make a liveness.
storageConformance('Postgres (pg-mem)', () => {
  const { Pool } = newDb().adapters.createPg();
  return new PostgresStorage({ pool: new Pool() });
}, { describe, it, exactClaim: false, pageWalk: false, serialisesAppends: false, ports: ['work', 'vectors', 'memory', 'upgrade'], timeout: 120_000 });

if (PG_URL) {
  const admin = new pg.Pool({ connectionString: PG_URL, max: 2 });
  admin.on('error', () => {});
  let n = 0;
  const schemas: string[] = [];
  ends.push(async () => { for (const s of schemas) await admin.query(`DROP SCHEMA IF EXISTS ${s} CASCADE`); await admin.end(); });
  const pgSchema = new WeakMap<object, string>();
  const openIn = (schema: string) => {
    const u = new URL(PG_URL);
    u.searchParams.set('options', `-c search_path=${schema}`);
    const s = new PostgresStorage({ connectionString: u.toString() });
    pgSchema.set(s, schema);
    return s;
  };
  storageConformance('Postgres (real)', async () => {
    const schema = `sc_${process.pid}_${n++}`;
    schemas.push(schema);
    await admin.query(`CREATE SCHEMA ${schema}`);
    return openIn(schema);
  }, { describe, it, clock: 'shared', timeout: 120_000, reopen: (s) => openIn(pgSchema.get(s)!) });
}
