// AUDIT C (red): a process liveness may be given its id (`sqliteLiveness(dbPath, id)`,
// `postgresLiveness({ id })`) — a stable name per process slot (a pm2 instance, a hostname). A process
// that crashed holding a job, restarted under the SAME id, reads the dead holder's stamp as its own
// (`holderAlive`: proc === my id → alive): the job is never taken over, by it or anyone. The dead
// holder's work must be taken once.
import { describe, it, expect, afterAll } from 'vitest';
import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { SqliteStorage } from '@gnldev/durable/sqlite';
import { enqueue } from '../src/index.js';

const here = dirname(fileURLToPath(import.meta.url));
const tsxLoader = join(dirname(createRequire(import.meta.url).resolve('tsx/package.json')), 'dist', 'loader.mjs');
const procScript = join(here, 'fixtures', 'audit-c-fixed-id-worker-proc.ts');
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const dirs: string[] = [];
afterAll(() => { for (const d of dirs) rmSync(d, { recursive: true, force: true }); });

function start(db: string, effects: string, go: string, name: string, id: string): { p: ChildProcess; exited: Promise<number | null> } {
  const p = spawn(process.execPath, ['--import', tsxLoader, procScript, db, effects, go, name, '1000', String(process.pid), id], { stdio: ['ignore', 'ignore', 'pipe'] });
  return { p, exited: new Promise((r) => p.on('close', (c) => r(c))) };
}
const lines = (f: string) => (existsSync(f) ? readFileSync(f, 'utf8').trim().split('\n').filter(Boolean) : []);

describe('a process restarted under the id of one that crashed holding a job', () => {
  it('takes the dead holder\'s job over and runs it once', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'gnl-q-reused-id-'));
    dirs.push(dir);
    const db = join(dir, 'q.db');
    const effects = join(dir, 'effects.txt');
    const go = join(dir, 'go');
    const s = new SqliteStorage(db);
    await s.init();
    await enqueue(s.work!, 't', {});
    await s.close();
    const a = start(db, effects, go, 'A', 'slot-1');
    for (let i = 0; i < 1000 && !lines(effects).includes('enter A'); i++) await sleep(20);
    a.p.kill('SIGKILL');
    await a.exited;
    writeFileSync(go, '');
    const b = start(db, effects, go, 'B', 'slot-1'); // the same slot, restarted
    await b.exited;
    expect(lines(effects).filter((l) => l.startsWith('effect'))).toEqual(['effect B']);
  }, 30_000);
});
