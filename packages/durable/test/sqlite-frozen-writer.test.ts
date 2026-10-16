// A process frozen (SIGSTOP, a paused VM, a debugger) in the middle of a Sqlite write holds the database's
// write lock until it runs again — SQLite's lock belongs to the process, and nothing in it can give the
// lock back while it is stopped. What the rest of the deployment may NOT do is need that lock to READ:
// opening a store whose schema is current writes nothing, a read-only job reads (WAL readers never wait on
// the writer), and closing a store waits for nobody. Measured before the fix: every other process died at
// open with `database is locked` after the 15 s busy wait (sqlite-storage.ts boot: `INSERT OR IGNORE` of the
// schema version) — `gnl pending` and `gnl upgrade` exited 1 instead of answering.
import { describe, it, expect, afterAll } from 'vitest';
import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { SqliteStorage } from '../src/sqlite-storage.js';

const here = dirname(fileURLToPath(import.meta.url));
const tsxLoader = join(dirname(createRequire(import.meta.url).resolve('tsx/package.json')), 'dist', 'loader.mjs');
const dirs: string[] = [];
const frozen: number[] = [];
afterAll(() => {
  for (const pid of frozen) { try { process.kill(pid, 'SIGCONT'); process.kill(pid, 'SIGKILL'); } catch { /* gone */ } }
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
});

/** A store file whose writer is frozen inside a write transaction. */
async function frozenWriter(): Promise<string> {
  const dir = mkdtempSync(join(tmpdir(), 'gnl-frozen-'));
  dirs.push(dir);
  const db = join(dir, 'app.db');
  new SqliteStorage(db).close(); // the schema exists: what a deployment's file looks like
  const p = spawn(process.execPath, ['--import', tsxLoader, join(here, 'fixtures', 'frozen-writer-proc.ts'), db], { stdio: 'ignore' });
  for (let i = 0; i < 1500 && !existsSync(`${db}.frozen-ready`); i++) await new Promise((r) => setTimeout(r, 20));
  const pid = Number(readFileSync(`${db}.frozen-ready`, 'utf8'));
  expect(pid).toBe(p.pid);
  process.kill(pid, 'SIGSTOP');
  frozen.push(pid);
  return db;
}

function readerRun(db: string, job: string): Promise<{ exit: number | null; wallMs: number; out: any }> {
  const t0 = Date.now();
  return new Promise((resolve) => {
    const p = spawn(process.execPath, ['--import', tsxLoader, join(here, 'fixtures', 'frozen-store-reader-proc.ts'), db, job], { stdio: ['ignore', 'pipe', 'inherit'] });
    let text = '';
    p.stdout.on('data', (b) => (text += b));
    const cap = setTimeout(() => p.kill('SIGKILL'), 40_000);
    p.on('close', (exit) => {
      clearTimeout(cap);
      let out: any;
      try { out = JSON.parse(text.trim().split('\n').pop() ?? ''); } catch { out = text; }
      resolve({ exit, wallMs: Date.now() - t0, out });
    });
  });
}

describe('a Sqlite writer frozen mid-write does not stop another process from reading', () => {
  it('gnl pending (open + pendingWork + close) answers at once', async () => {
    const db = await frozenWriter();
    const r = await readerRun(db, 'pending');
    expect({ exit: r.exit, ok: r.out?.ok, error: r.out?.error, slow: r.out?.closed > 3_000, t: r.out?.closed > 3_000 ? [r.out?.opened, r.out?.done, r.out?.closed] : undefined }).toEqual({ exit: 0, ok: true, error: undefined, slow: false, t: undefined });
  }, 60_000);

  it('gnl upgrade --list (open + a dry run) answers at once', async () => {
    const db = await frozenWriter();
    const r = await readerRun(db, 'upgrade-list');
    expect({ exit: r.exit, ok: r.out?.ok, error: r.out?.error, slow: r.out?.closed > 3_000, t: r.out?.closed > 3_000 ? [r.out?.opened, r.out?.done, r.out?.closed] : undefined }).toEqual({ exit: 0, ok: true, error: undefined, slow: false, t: undefined });
  }, 60_000);

  it('a read of the runs (open + get + listRuns + close) answers at once, and sees what was committed', async () => {
    const db = await frozenWriter();
    const r = await readerRun(db, 'read');
    expect({ exit: r.exit, ok: r.out?.ok, error: r.out?.error, slow: r.out?.closed > 3_000, runs: r.out?.out?.runs, t: r.out?.closed > 3_000 ? [r.out?.opened, r.out?.done, r.out?.closed] : undefined }).toEqual({ exit: 0, ok: true, error: undefined, slow: false, runs: ['r-frozen'], t: undefined });
  }, 60_000);
});

describe('opening a Sqlite file whose schema is current writes nothing (the rule the frozen-writer tests rest on)', () => {
  it('opens and closes at once while another connection holds the write lock (in one process)', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'gnl-boot-'));
    dirs.push(dir);
    const db = join(dir, 'app.db');
    await new SqliteStorage(db).close();
    const { DatabaseSync } = createRequire(import.meta.url)('node:sqlite') as { DatabaseSync: new (p: string) => any };
    const holder = new DatabaseSync(db);
    holder.exec('BEGIN IMMEDIATE');
    holder.prepare('INSERT INTO gnl_meta(k, v) VALUES (?, ?)').run('held', '1');
    const t0 = Date.now();
    let error: string | undefined;
    try {
      const s = new SqliteStorage(db);
      await s.runs.get('nothing');
      await s.close();
    } catch (e) { error = String((e as Error).message); }
    const ms = Date.now() - t0;
    holder.exec('ROLLBACK');
    holder.close();
    expect({ error, slow: ms > 1_000 }).toEqual({ error: undefined, slow: false });
  }, 30_000);
});
