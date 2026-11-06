// A Sqlite store keeps its file locks when its process liveness is made.
//
// A process liveness on Sqlite lives in a directory named for the database file's identity (dev + inode,
// process-liveness.ts `storeIdentity`). To have an identity before the store exists, the file was created
// by opening it and closing it again — every time, also when the store already had it open. On POSIX,
// closing ANY descriptor of a file drops EVERY fcntl lock the process holds on it: the store's connection
// lost its locks on its own database. Another process that then closed its last connection to the file
// found no one else on it, checkpointed, and DELETED the -wal and -shm files under the live store, whose
// connection went on in files nobody else could see (measured, k1-takeover T1 on libSQL under load: the
// process that took the run over stopped in the middle of its answer, every read and write of its store
// pending from then on, `k1.db-wal (deleted)` among its open files; the closer was the test's own reader).
// Before the fix this file is red on both stores; T1 on libSQL, run beside the liveness files, was red in
// about a third of the batches.
//
// Here: the store is open and has written (its WAL is in use), its liveness is made, and a second process
// opens the file, reads, and closes. The store's -wal and -shm must still be there, and what it writes
// after must be read by another process.
import { describe, it, expect, afterAll } from 'vitest';
import { mkdtempSync, rmSync, existsSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { SqliteStorage } from '../src/sqlite-storage.js';
import { LibsqlStorage } from '../src/libsql-storage.js';
import { sqliteLiveness } from '../src/process-liveness.js';

const here = dirname(fileURLToPath(import.meta.url));
const ends: Array<() => unknown> = [];
afterAll(async () => { for (const e of ends.reverse()) await e(); });

const hasLibsql = (() => { try { createRequire(import.meta.url)('libsql'); return true; } catch { return false; } })();

/**
 * Another process: opens the file, counts what `key` names, and closes it — its last connection to it. With
 * the libSQL driver when it is here (the closer that deleted the files in k1-takeover was a libSQL store),
 * else node:sqlite.
 */
function otherProcessReads(path: string, key: string): number {
  const code = `
    let Db; try { Db = require('libsql'); } catch { Db = require('node:sqlite').DatabaseSync; }
    const db = new Db(process.argv[1]);
    const tables = db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all().map((r) => r.name);
    let n = 0;
    for (const t of tables) {
      const cols = db.prepare('PRAGMA table_info(' + JSON.stringify(t) + ')').all().map((c) => c.name);
      for (const c of cols) n += db.prepare('SELECT COUNT(*) AS n FROM ' + JSON.stringify(t) + ' WHERE CAST(' + JSON.stringify(c) + ' AS TEXT) = ?').get(process.argv[2]).n;
    }
    db.close();
    process.stdout.write(String(n));
  `;
  const r = spawnSync(process.execPath, ['--no-warnings', '-e', code, path, key], { encoding: 'utf8', cwd: here });
  if (r.status !== 0) throw new Error(r.stderr);
  return Number(r.stdout);
}

const STORES: Array<[string, (path: string) => any]> = [['sqlite', (p) => new SqliteStorage(p)]];
if (hasLibsql) STORES.push(['libsql', (p) => new LibsqlStorage(p)]);

describe.each(STORES)('a store keeps its locks when its liveness is made — %s', (_name, open) => {
  it("another process's last close leaves the open store's -wal and -shm in place, and sees what it writes after", async () => {
    const dir = mkdtempSync(join(tmpdir(), 'gnl-locks-'));
    ends.push(() => rmSync(dir, { recursive: true, force: true }));
    const path = join(dir, 'runs.db');
    const storage = open(path);
    ends.push(() => storage.close());
    await storage.runs.put('before-liveness', { n: 1 });
    expect(existsSync(`${path}-wal`)).toBe(true);
    // The store's own liveness, as the store makes it on first use (sqlite-storage.ts livenessSlot).
    const live = sqliteLiveness(path);
    ends.push(() => live.close());
    expect(otherProcessReads(path, 'before-liveness')).toBe(1);
    expect(existsSync(`${path}-wal`), 'the -wal under the open store').toBe(true);
    expect(existsSync(`${path}-shm`), 'the -shm under the open store').toBe(true);
    await storage.runs.put('after-liveness', { n: 2 });
    expect(otherProcessReads(path, 'after-liveness'), 'what the store wrote after, read by another process').toBe(1);
  });
});
