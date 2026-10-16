// Sqlite liveness is keyed by the database FILE (device + inode) — siblings of audit R2-6 (hard links) and
// C1 (symlinks): every name of one file, and every moment of its life (before it exists, after), lands on
// one lock directory.
import { describe, it, expect, vi } from 'vitest';
import { mkdtempSync, linkSync, symlinkSync, existsSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { sqliteLiveness, sqliteLivenessDir } from '../src/process-liveness.js';
import { SqliteStorage } from '../src/sqlite-storage.js';
import { toJournal } from '../src/index.js';

describe('Sqlite liveness is keyed by the database file', () => {
  it('a process that opens the file before it exists and one that opens it after share one directory, and see each other', async () => {
    const d = mkdtempSync(join(tmpdir(), 'lv-new-'));
    const db = join(d, 'app.db');
    const first = sqliteLiveness(db); // nothing on disk yet
    const storage = new SqliteStorage(db); // the store opens the file the liveness made
    await toJournal(storage.runs).put('k', { v: 1 });
    const second = sqliteLiveness(db);
    try {
      expect({ exists: existsSync(db), seen: await second.isAlive(first.id), stored: await toJournal(storage.runs).get('k') })
        .toEqual({ exists: true, seen: true, stored: { v: 1 } });
    } finally { await first.close(); await second.close(); await (storage as any).close?.(); }
  });

  it('a symlink and a hard link to one file (same directory) share one directory with the file itself', async () => {
    const d = mkdtempSync(join(tmpdir(), 'lv-names-'));
    const db = join(d, 'app.db');
    new SqliteStorage(db);
    linkSync(db, join(d, 'hard.db'));
    symlinkSync(db, join(d, 'soft.db'));
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const dirs = new Set([db, join(d, 'hard.db'), join(d, 'soft.db')].map(sqliteLivenessDir));
      const la = sqliteLiveness(join(d, 'soft.db'));
      const lb = sqliteLiveness(join(d, 'hard.db'));
      try {
        expect({ dirs: dirs.size, seen: await lb.isAlive(la.id), said: warn.mock.calls.some((c) => /hard links/.test(String(c[0]))) })
          .toEqual({ dirs: 1, seen: true, said: true });
      } finally { await la.close(); await lb.close(); }
    } finally { warn.mockRestore(); }
  });

  it('the directory names the inode: a file replaced under the same name is another store', () => {
    const d = mkdtempSync(join(tmpdir(), 'lv-ino-'));
    const db = join(d, 'app.db');
    new SqliteStorage(db);
    expect(sqliteLivenessDir(db)).toContain(`${statSync(db).ino}`);
  });
});
