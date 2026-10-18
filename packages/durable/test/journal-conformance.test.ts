// The journal conformance scenarios (`@gnldev/durable/testing`) on every store this repository ships —
// and on a journal written the way a user writes one: a Map, in this file, built on public exports only.
//
// ADR-0007's conformance condition: four stores and a custom KV journal pass the same scenarios. The
// "older version" writer of each SQL store is the previous release's statements (older-writer.ts), from
// a connection of its own, so the rows it leaves unplaced are really unplaced.
//
// Stores: InMemory, Sqlite (a file), Postgres on pg-mem, the custom journal; with GNL_PG_URL also a real
// Postgres, in one database this file creates (`cpd_conf_…`), a schema per scenario, dropped at the end;
// with GNL_MYSQL_URL / GNL_MARIADB_URL a MySQL / MariaDB server, a database per scenario. No older version
// ever wrote a MySQL store, so those subjects have no older writer.
// A two-minute ceiling per scenario: D4 kills a deletion at every store call, about 7 s on pg-mem alone
// and past the suite's 30 s default when the full run contends for the machine (measured).
import { describe, it, afterAll } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRequire } from 'node:module';
import { newDb } from 'pg-mem';
import pg from 'pg';
import { InMemoryStorage, toJournal, parseJournalKey, runRecordOf, summarizeRun, pageRunsFromArray, serialize, deserialize } from '@gnldev/durable';
import type { Journal, JournalBatch, JournalReader, JournalEntry, RunSummary } from '@gnldev/durable';
import { journalConformance, type ConformanceSubject } from '@gnldev/durable/testing';
import { SqliteStorage } from '../src/sqlite-storage.js';
import { PostgresStorage } from '../src/postgres-storage.js';
import { oldSqlitePut, oldPgPut } from './older-writer.js';
import { mysqlStores } from './real-backends.js';

const { DatabaseSync } = createRequire(import.meta.url)('node:sqlite') as { DatabaseSync: new (path: string) => any };
const PG_URL = process.env.GNL_PG_URL;
const ends: Array<() => Promise<void> | void> = [];
afterAll(async () => { for (const e of ends.reverse()) await e(); });

journalConformance('InMemory', () => ({ journal: toJournal(new InMemoryStorage().runs) }), { describe, it, timeout: 120_000 });

journalConformance('Sqlite', () => {
  const dir = mkdtempSync(join(tmpdir(), 'gnl-conformance-'));
  const file = join(dir, 'j.db');
  const storage = new SqliteStorage(file);
  const old = new DatabaseSync(file);
  old.exec('PRAGMA busy_timeout = 5000');
  return {
    journal: toJournal(storage.runs),
    async writeAsOlderVersion(key, value) { oldSqlitePut(old, key, value); },
    close() { old.close(); storage.close?.(); rmSync(dir, { recursive: true, force: true }); },
  };
}, { describe, it, timeout: 120_000 });

// pg-mem: no row comparison (the keyset cursor) and a misreported lost claim — declared, not hidden.
// Both are proven on the real Postgres below.
journalConformance('Postgres (pg-mem)', async () => {
  const { Pool } = newDb().adapters.createPg();
  const pool = new Pool();
  const storage = new PostgresStorage({ pool });
  await storage.init();
  return { journal: toJournal(storage.runs), writeAsOlderVersion: (key, value) => oldPgPut(pool, key, value) };
}, { describe, it, exactClaim: false, pageWalk: false, timeout: 120_000 });

if (PG_URL) {
  let db: { admin: pg.Pool; url: string } | undefined;
  let seq = 0;
  journalConformance('Postgres (real)', async () => {
    if (!db) {
      const name = `cpd_conf_${process.pid}_${Date.now().toString(36)}`;
      const admin = new pg.Pool({ connectionString: PG_URL, max: 1 });
      admin.on('error', () => {});
      await admin.query(`CREATE DATABASE ${name}`);
      const u = new URL(PG_URL);
      u.pathname = `/${name}`;
      db = { admin, url: u.toString() };
      ends.push(async () => { await admin.query(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`); await admin.end(); });
    }
    const schema = `s${seq++}`;
    const setup = new pg.Pool({ connectionString: db.url, max: 1 });
    await setup.query(`CREATE SCHEMA ${schema}`);
    await setup.end();
    const pool = new pg.Pool({ connectionString: db.url, max: 4, options: `-c search_path=${schema}` });
    const oldPool = new pg.Pool({ connectionString: db.url, max: 1, options: `-c search_path=${schema}` });
    for (const p of [pool, oldPool]) p.on('error', () => {});
    const storage = new PostgresStorage({ pool });
    await storage.init();
    return {
      journal: toJournal(storage.runs),
      writeAsOlderVersion: (key, value) => oldPgPut(oldPool, key, value),
      async close() { await oldPool.end(); await pool.end(); },
    };
  }, { describe, it, clock: 'shared', timeout: 120_000 });
}

for (const [name, make] of mysqlStores(' (real)')) {
  journalConformance(name, async () => {
    const storage = await make();
    await storage.init();
    return { journal: toJournal(storage.runs), close: () => storage.close() };
  }, { describe, it, clock: 'shared', timeout: 120_000 });
}

/**
 * A journal as a user writes one against the documented port: a Map of keys, the store's guarantees
 * (journal.ts JOURNAL_GUARANTEES — each atomic because nothing awaits between its read and its write, and
 * the clock of the one process that reaches the map), values copied the way every store copies them
 * (`serialize`/`deserialize`), and the reader built
 * from the public helpers — `parseJournalKey` for a run's entries, `runRecordOf` for the records that make
 * a run, `summarizeRun` for its status, `pageRunsFromArray` for the page.
 */
/** A copy the way every store makes one: through the store serialization. */
const copy = <T>(v: T): T => (v === undefined ? v : deserialize<T>(serialize(v)));

class MapJournal implements Journal, JournalReader {
  private readonly m = new Map<string, unknown>();
  private readonly counters = new Map<string, Record<string, number>>();
  async get<T = unknown>(key: string): Promise<T | undefined> { return this.m.has(key) ? copy(this.m.get(key)) as T : undefined; }
  async put(key: string, value: unknown): Promise<void> { this.m.set(key, copy(value)); }
  async putIfAbsent(key: string, value: unknown): Promise<boolean> {
    if (this.m.has(key)) return false;
    this.m.set(key, copy(value));
    return true;
  }
  async putIfMatch(key: string, expected: unknown, value: unknown): Promise<boolean> {
    if (!this.m.has(key) || JSON.stringify(this.m.get(key)) !== JSON.stringify(expected)) return false;
    this.m.set(key, copy(value));
    return true;
  }
  async applyBatch(batch: JournalBatch): Promise<boolean> {
    if (batch.claim && this.m.has(batch.claim.key)) return false;
    // Every value is copied before anything is written: one that cannot be copied leaves the store as it was.
    const claim = batch.claim ? copy(batch.claim.value) : undefined;
    const puts = (batch.puts ?? []).map((p) => [p.key, copy(p.value)] as const);
    if (batch.claim) this.m.set(batch.claim.key, claim);
    for (const { key, fields } of batch.incrs ?? []) this.bump(key, fields);
    for (const [key, value] of puts) this.m.set(key, value);
    return true;
  }
  async incrBy(key: string, fields: Record<string, number>): Promise<Record<string, number>> {
    return { ...this.bump(key, fields) };
  }
  async getCounters(key: string): Promise<Record<string, number> | undefined> {
    const c = this.counters.get(key);
    return c ? { ...c } : undefined;
  }
  private bump(key: string, fields: Record<string, number>): Record<string, number> {
    const c = this.counters.get(key) ?? {};
    for (const [f, d] of Object.entries(fields)) c[f] = (c[f] ?? 0) + d;
    this.counters.set(key, c);
    return c;
  }
  /** One process reaches this map, so its clock is the store's. */
  async now(): Promise<number> {
    return Date.now();
  }
  async listKeys(prefix: string, opts?: { limit?: number }): Promise<string[]> {
    return [...this.m.keys(), ...this.counters.keys()].filter((k) => k.startsWith(prefix)).sort().slice(0, opts?.limit ?? Infinity);
  }
  async deletePrefix(prefix: string): Promise<number> {
    let n = 0;
    for (const k of [...this.m.keys()]) if (k.startsWith(prefix)) { this.m.delete(k); n++; }
    for (const k of [...this.counters.keys()]) if (k.startsWith(prefix)) { this.counters.delete(k); n++; }
    return n;
  }
  async readRun(runId: string): Promise<JournalEntry[]> {
    const out: JournalEntry[] = [];
    for (const [key, value] of this.m) {
      const p = parseJournalKey(key);
      if (p?.runId === runId) out.push({ key, runId, kind: p.kind, value: copy(value), seq: out.length });
    }
    return out;
  }
  async listRuns(): Promise<RunSummary[]> {
    const ids = new Set<string>();
    for (const [key, value] of this.m) {
      const id = runRecordOf(key, value)?.runId;
      if (id) ids.add(id);
    }
    const out: RunSummary[] = [];
    for (const runId of ids) {
      const outcome = this.m.get(`${runId}:outcome`) as { status: 'completed' } | undefined;
      const input = (this.m.get(`${runId}:input`) ?? {}) as Partial<Record<'threadId' | 'agent' | 'resourceId' | 'workKey' | 'parentRunId', string>>;
      const fields = Object.fromEntries((['threadId', 'agent', 'resourceId', 'workKey', 'parentRunId'] as const).flatMap((f) => (input[f] ? [[f, input[f]]] : [])));
      out.push({ ...summarizeRun(runId, await this.readRun(runId), outcome), ...fields });
    }
    return out;
  }
  async listRunsPaged(q?: Parameters<NonNullable<JournalReader['listRunsPaged']>>[0]): Promise<{ items: RunSummary[]; nextCursor?: string }> {
    return pageRunsFromArray(await this.listRuns(), q);
  }
}

journalConformance('a custom KV journal (Map)', (): ConformanceSubject => ({ journal: new MapJournal() }), { describe, it, timeout: 120_000 });
