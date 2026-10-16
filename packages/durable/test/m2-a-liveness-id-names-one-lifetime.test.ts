// A liveness id names ONE process lifetime (process-liveness.ts `livenessIdOf`): a configured id is a
// prefix, every opening adds a part of its own. Siblings of audit C8 (a restarted process took the id of
// the one that crashed and read its stamps as its own) and of C10 (a dead holder's lock file is
// reclaimed by the probe that judged it dead — safe only because nobody can come back under its id).
import { describe, it, expect, afterAll } from 'vitest';
import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { inMemoryLiveness, sqliteLiveness, sqliteLivenessDir, postgresLiveness } from '../src/process-liveness.js';

const here = dirname(fileURLToPath(import.meta.url));
const tsxLoader = join(dirname(createRequire(import.meta.url).resolve('tsx/package.json')), 'dist', 'loader.mjs');
const PG = process.env.GNL_PG_URL;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const dirs: string[] = [];
afterAll(() => { for (const d of dirs) rmSync(d, { recursive: true, force: true }); });

function holder(db: string, prefix: string) {
  const p = spawn(process.execPath, ['--import', tsxLoader, join(here, 'fixtures', 'audit-c-liveness-holder-proc.ts'), db, prefix], { stdio: 'ignore' });
  const exited = new Promise((r) => p.on('close', r));
  return { p, exited, id: async () => {
    for (let i = 0; i < 1000 && !existsSync(`${db}.ready-${prefix}`); i++) await sleep(20);
    return readFileSync(`${db}.ready-${prefix}`, 'utf8');
  } };
}

describe('a liveness id names one process lifetime', () => {
  it('in memory: two openings under one configured id are two ids; closing one leaves the other alive', async () => {
    const a = inMemoryLiveness('slot-1');
    const b = inMemoryLiveness('slot-1');
    expect(a.id).not.toBe(b.id);
    expect(a.id.startsWith('slot-1:') && b.id.startsWith('slot-1:')).toBe(true);
    await a.close();
    expect(await b.isAlive(b.id)).toBe(true);
    expect(await b.isAlive(a.id)).toBe(false);
    await b.close();
  });

  it('sqlite: a frozen holder (SIGSTOP) is alive and keeps its lock file; once killed, its file is reclaimed and a second probe recreates nothing', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'gnl-m2-lid-'));
    dirs.push(dir);
    const db = join(dir, 'app.db');
    const h = holder(db, 'slot-1');
    const id = await h.id();
    expect(id.startsWith('slot-1:')).toBe(true);
    const me = sqliteLiveness(db, 'slot-1');
    try {
      expect(me.id).not.toBe(id);
      h.p.kill('SIGSTOP');
      expect(await me.isAlive(id)).toBe(true);
      expect(readdirSync(sqliteLivenessDir(db)).some((f) => f.startsWith(encodeURIComponent(id)))).toBe(true);
      h.p.kill('SIGKILL');
      await h.exited;
      expect(await me.isAlive(id)).toBe(false);
      expect(await me.isAlive(id)).toBe(false);
      expect(readdirSync(sqliteLivenessDir(db)).filter((f) => !f.startsWith(encodeURIComponent(me.id)))).toEqual([]);
    } finally {
      await me.close();
    }
    expect(readdirSync(sqliteLivenessDir(db))).toEqual([]);
  }, 30_000);

  it.skipIf(!PG)('postgres: two sessions given one id both start, each under an id of its own', async () => {
    const a = await postgresLiveness({ connectionString: PG!, id: 'slot-1' });
    const b = await postgresLiveness({ connectionString: PG!, id: 'slot-1' });
    try {
      expect(a.id).not.toBe(b.id);
      expect(a.id.startsWith('slot-1:') && b.id.startsWith('slot-1:')).toBe(true);
      expect(await a.isAlive(b.id)).toBe(true);
    } finally {
      await a.close();
      await b.close();
    }
  });
});
