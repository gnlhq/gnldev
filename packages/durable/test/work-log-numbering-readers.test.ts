// Invariant: `WorkStore.list` answers. Numbering the namespace's new records is a reader's chore, and a
// reader must not fail or stall because of what the database or another process is doing.
//
// Two measurements by the review panel (review2-A p-worklog.test.ts):
//   - Postgres whose `default_transaction_isolation` is REPEATABLE READ (or SERIALIZABLE — a setting
//     some managed providers and some teams choose): two readers numbering one namespace at once
//     collide on the counter row, and the loser's statement fails with 40001 "could not serialize
//     access due to concurrent update". 74 of 120 `list` calls threw.
//   - SQLite: numbering takes the write lock (BEGIN IMMEDIATE), so a reader of a log with new records
//     waited behind another process's write transaction — and threw "database is locked" after the
//     busy budget (15 s). A WAL read never waited in 0.9.
import { describe, it, expect, afterAll } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRequire } from 'node:module';
import { spawn } from 'node:child_process';
import { SqliteStorage } from '../src/sqlite-storage.js';
import { PostgresStorage } from '../src/postgres-storage.js';

const req = createRequire(import.meta.url);
const PG_URL = process.env.GNL_PG_URL;
const cleanup: Array<() => unknown> = [];
afterAll(async () => { for (const c of cleanup.reverse()) { try { await c(); } catch { /* best effort */ } } });

describe('SQLite: a reader does not wait for another process\'s write transaction', () => {
  it('list() answers at once with the records already numbered, and numbers the rest on a later call', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'gnl-wl-lock-'));
    cleanup.push(() => rmSync(dir, { recursive: true, force: true }));
    const file = join(dir, 'x.db');
    const s = new SqliteStorage(file);
    cleanup.push(() => s.close?.());
    await s.work.append('q', { v: 1 }, 'a1');
    await s.work.list('q'); // a1 numbered
    await s.work.append('q', { v: 2 }, 'a2'); // unnumbered until a read numbers it
    // A second connection — another process in production — holds the write lock for 1.5 s.
    const holder = spawn(process.execPath, ['-e', `
      const { DatabaseSync } = require('node:sqlite');
      const db = new DatabaseSync(${JSON.stringify(file)});
      db.exec('PRAGMA busy_timeout = 5000'); db.exec('BEGIN IMMEDIATE');
      db.prepare("INSERT INTO gnl_work_kv (key, value) VALUES ('hold', '1') ON CONFLICT(key) DO NOTHING").run();
      process.stdout.write('locked\\n');
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 1500);
      db.exec('COMMIT'); db.close();`]);
    await new Promise<void>((r) => holder.stdout.on('data', (d) => { if (String(d).includes('locked')) r(); }));
    const t0 = Date.now();
    const page = await s.work.list('q');
    const ms = Date.now() - t0;
    expect(ms).toBeLessThan(500);
    expect(page.items.map((r) => r.id)).toEqual(['a1']);
    await new Promise((r) => holder.on('exit', r));
    // The lock is gone: the next read numbers a2, after a1.
    expect((await s.work.list('q')).items.map((r) => r.id)).toEqual(['a1', 'a2']);
  }, 20_000);

  it('a cursor persisted while a record was left unnumbered still reaches it', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'gnl-wl-lock2-'));
    cleanup.push(() => rmSync(dir, { recursive: true, force: true }));
    const file = join(dir, 'x.db');
    const s = new SqliteStorage(file);
    cleanup.push(() => s.close?.());
    await s.work.append('q', { v: 1 }, 'b1');
    await s.work.append('q', { v: 1 }, 'b1b');
    const first = await s.work.list('q', { limit: 1 }); // b1, and a cursor after it
    expect(first.items.map((r) => r.id)).toEqual(['b1']);
    await s.work.append('q', { v: 2 }, 'b2');
    await s.work.append('q', { v: 3 }, 'b3');
    const { DatabaseSync } = req('node:sqlite') as { DatabaseSync: new (p: string) => any };
    const other = new DatabaseSync(file);
    other.exec('PRAGMA busy_timeout = 5000');
    other.exec('BEGIN IMMEDIATE');
    const during = await s.work.list('q', { cursor: first.nextCursor!, limit: 10 });
    other.exec('COMMIT'); other.close();
    // Only what was already numbered is listed while the lock is held elsewhere.
    expect(during.items.map((r) => r.id)).toEqual(['b1b']);
    // Then the new records are numbered after it — the persisted cursor reaches every one of them.
    expect((await s.work.list('q', { cursor: first.nextCursor!, limit: 10 })).items.map((r) => r.id)).toEqual(['b1b', 'b2', 'b3']);
  });
});

(PG_URL ? describe : describe.skip)('Postgres (real): a database whose default isolation is REPEATABLE READ or SERIALIZABLE', () => {
  it.each(['repeatable read', 'serializable'])('concurrent readers numbering one namespace all answer (%s)', async (level) => {
    const pg = req('pg') as { Pool: new (o: object) => { query(sql: string): Promise<unknown>; end(): Promise<void> } };
    const admin = new pg.Pool({ connectionString: PG_URL, max: 1 });
    cleanup.push(() => admin.end());
    const db = `gnl_rr_${level.replace(' ', '_')}_${Date.now().toString(36)}`;
    await admin.query(`CREATE DATABASE ${db}`);
    cleanup.push(() => admin.query(`DROP DATABASE IF EXISTS ${db} WITH (FORCE)`));
    await admin.query(`ALTER DATABASE ${db} SET default_transaction_isolation = '${level}'`);
    const url = new URL(PG_URL!); url.pathname = `/${db}`;
    const a = new PostgresStorage({ connectionString: url.toString() }); await a.init();
    const b = new PostgresStorage({ connectionString: url.toString() }); await b.init();
    cleanup.push(() => a.close(), () => b.close());
    const errors: string[] = [];
    const seen = new Set<string>();
    const written: string[] = [];
    for (let round = 0; round < 15; round++) {
      await Promise.all(Array.from({ length: 10 }, (_, i) => { const id = `r${round}-${i}`; written.push(id); return a.work.append('q', { i }, id); }));
      const rs = await Promise.allSettled([a.work.list('q', { limit: 1000 }), b.work.list('q', { limit: 1000 }), a.work.list('q', { limit: 1000 }), b.work.list('q', { limit: 1000 })]);
      for (const r of rs) {
        if (r.status === 'rejected') errors.push(String((r.reason as Error)?.message ?? r.reason));
        else r.value.items.forEach((x) => seen.add(x.id));
      }
    }
    expect(errors).toEqual([]);
    expect(written.filter((id) => !seen.has(id))).toEqual([]);
  }, 60_000);
});
