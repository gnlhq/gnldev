// AUDIT C (red): one SQLite file reached through two paths (a symlink — a release directory that links
// its data file to a shared one) is one store. A worker frozen with a job in hand on one path must keep
// it from a worker on the other path. The process locks live in `<dbPath>.procs/`, a directory named
// after the PATH, not the file: the second worker finds no lock file for the holder, reads it as dead,
// and runs the job beside it.
import { describe, it, expect, afterAll } from 'vitest';
import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { SqliteStorage } from '@gnldev/durable/sqlite';
import { enqueue } from '../src/index.js';

const here = dirname(fileURLToPath(import.meta.url));
const tsxLoader = join(dirname(createRequire(import.meta.url).resolve('tsx/package.json')), 'dist', 'loader.mjs');
const procScript = join(here, 'fixtures', 'stalled-worker-proc.ts');
const TTL = 1_000;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const dirs: string[] = [];
afterAll(() => { for (const d of dirs) rmSync(d, { recursive: true, force: true }); });

function start(db: string, effects: string, go: string, name: string): { p: ChildProcess; exited: Promise<number | null> } {
  const p = spawn(process.execPath, ['--import', tsxLoader, procScript, 'sqlite', db, effects, go, name, String(TTL), String(process.pid)], { stdio: ['ignore', 'ignore', 'pipe'] });
  const exited = new Promise<number | null>((resolve) => p.on('close', (code) => resolve(code)));
  return { p, exited };
}
const lines = (f: string) => (existsSync(f) ? readFileSync(f, 'utf8').trim().split('\n').filter(Boolean) : []);
async function until(cond: () => boolean, ms: number): Promise<boolean> {
  const end = Date.now() + ms;
  while (Date.now() < end) { if (cond()) return true; await sleep(20); }
  return cond();
}

describe('one SQLite file, two paths to it (separate processes)', () => {
  it('a frozen worker on one path keeps its job from a worker on the other path', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'gnl-q-twopaths-'));
    dirs.push(dir);
    mkdirSync(join(dir, 'shared'));
    mkdirSync(join(dir, 'release-b'));
    const real = join(dir, 'shared', 'q.db');
    const viaLink = join(dir, 'release-b', 'q.db');
    const effects = join(dir, 'effects.txt');
    const go = join(dir, 'go');
    const s = new SqliteStorage(real);
    await s.init();
    await enqueue(s.work!, 't', {});
    await s.close();
    symlinkSync(real, viaLink);
    const a = start(real, effects, go, 'A');
    expect(await until(() => lines(effects).includes('enter A'), 20_000), 'A took the job').toBe(true);
    a.p.kill('SIGSTOP');
    const b = start(viaLink, effects, go, 'B');
    await sleep(TTL * 4);
    const duringFreeze = lines(effects);
    writeFileSync(go, '');
    a.p.kill('SIGCONT');
    await Promise.all([a.exited, b.exited]);
    expect(duringFreeze, 'B ran the job while A (same file, other path) was frozen, not dead').not.toContain('enter B');
    expect(lines(effects).filter((l) => l.startsWith('effect'))).toEqual(['effect A']);
  }, 60_000);
});
