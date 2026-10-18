// A libSQL store is a local file, run by the Sqlite store on the libSQL driver — and only that.
//
// Two other ways the libSQL driver opens a database are refused where the store is made, each because
// a promise cannot be kept on it (measured, raporlar/2026-10-18-turso-mod3):
// - an embedded replica (`syncUrl`): a write goes to the remote primary and a read comes from the
//   local copy, so a write is not read back until the copy syncs — the conformance kit failed 29 of
//   34 scenarios on it, a claim among them, which means a call could be taken twice;
// - a remote database (`libsql:`, `http(s):`, `ws(s):`): a remote libSQL server has no session a
//   process holds, so whether another process is alive can only be told by a lease it renews — and a
//   live process that stalls past its lease is taken over: its side effect ran twice, 3 of 3.
import { describe, it, expect, afterAll } from 'vitest';
import { mkdtempSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { LibsqlStorage } from '../src/libsql-storage.js';

const dirs: string[] = [];
afterAll(() => { for (const d of dirs) rmSync(d, { recursive: true, force: true }); });
const file = () => { const d = mkdtempSync(join(tmpdir(), 'gnl-libsql-')); dirs.push(d); return join(d, 'runs.db'); };

describe('a libSQL store keeps only what it can', () => {
  it('a local file opens, and keeps what it is given', async () => {
    const s = new LibsqlStorage(file());
    await s.runs.put('k', { v: 1 });
    expect(await s.runs.get('k')).toEqual({ v: 1 });
    expect(await s.runs.putIfMatch!('k', { v: 1 }, { v: 2 })).toBe(true);
    expect(await s.runs.putIfMatch!('k', { v: 1 }, { v: 3 })).toBe(false);
    s.close();
  });

  it('an embedded replica is refused, naming why', () => {
    expect(() => new LibsqlStorage(file(), { syncUrl: 'http://127.0.0.1:8080' })).toThrow(/embedded replica[\s\S]*read back/);
  });

  it('an auth token is refused with it: it is only for a remote database', () => {
    expect(() => new LibsqlStorage(file(), { authToken: 't' })).toThrow(/remote/);
  });

  for (const url of ['libsql://db.example.com', 'http://127.0.0.1:8080', 'https://db.example.com', 'ws://127.0.0.1:8080', 'wss://db.example.com', 'LIBSQL://DB.EXAMPLE.COM']) {
    it(`a remote database is refused, naming why: ${url}`, () => {
      expect(() => new LibsqlStorage(url)).toThrow(/remote[\s\S]*twice/);
    });
  }

  it('a misspelled option is refused', () => {
    expect(() => new LibsqlStorage(file(), { syncUrll: 'x' } as never)).toThrow(/syncUrll/);
  });

  it('nothing is created on disk for a refused store', () => {
    const f = file();
    expect(() => new LibsqlStorage(f, { syncUrl: 'http://127.0.0.1:8080' })).toThrow();
    expect(existsSync(f)).toBe(false);
  });
});
