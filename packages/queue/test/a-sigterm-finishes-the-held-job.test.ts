// SIGTERM to a process running queue jobs: the job it holds finishes and is recorded, no next job is
// taken, and the process exits 0 — the next job runs in another process, once.
//
// Before, nothing in the framework answered SIGTERM: the process died where it stood, the job in its
// handler was cut off, and another process ran the handler again from the start.
import { describe, it, expect, afterAll } from 'vitest';
import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import type { Storage } from '@gnldev/durable';
import { SqliteStorage } from '@gnldev/durable/sqlite';
import { createDatabaseSync, dropDatabaseSync } from '../../../test/support/pg-admin.js';
import { enqueue, listJobs } from '../src/index.js';

const here = dirname(fileURLToPath(import.meta.url));
const tsxLoader = join(dirname(createRequire(import.meta.url).resolve('tsx/package.json')), 'dist', 'loader.mjs');
const procScript = join(here, 'fixtures', 'sigterm-worker-proc.ts');
const TTL = 1_000;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const dirs: string[] = [];
afterAll(() => { for (const d of dirs) rmSync(d, { recursive: true, force: true }); });
type Kind = 'sqlite' | 'postgres';
const PG_URL = process.env.GNL_PG_URL;
const drops: string[] = [];
afterAll(() => {
  for (const n of drops) {
    dropDatabaseSync(n);
  }
});

let seq = 0;
function setup(kind: Kind) {
  const dir = mkdtempSync(join(tmpdir(), 'gnl-q-sigterm-'));
  dirs.push(dir);
  let db = join(dir, 'q.db');
  if (kind === 'postgres') {
    const n = `dp_sigterm_${process.pid}_${seq++}`;
    db = createDatabaseSync(n);
    drops.push(n);
  }
  return { kind, db, effects: join(dir, 'effects.txt'), go: join(dir, 'go') };
}
async function open(kind: Kind, db: string): Promise<Storage> {
  const s: Storage = kind === 'postgres'
    ? new (await import('@gnldev/durable/postgres')).PostgresStorage({ connectionString: db }) as unknown as Storage
    : new SqliteStorage(db) as unknown as Storage;
  await s.init?.();
  return s;
}
function start({ kind, db, effects, go }: ReturnType<typeof setup>, name: string): { p: ChildProcess; exited: Promise<{ code: number | null; signal: string | null }> } {
  const p = spawn(process.execPath, ['--import', tsxLoader, procScript, kind, db, effects, go, name, String(TTL), String(process.pid)], { stdio: ['ignore', 'ignore', 'pipe'] });
  let err = '';
  p.stderr!.on('data', (d) => (err += d));
  const exited = new Promise<{ code: number | null; signal: string | null }>((resolve) => p.on('close', (code, signal) => {
    if (code !== 0 && code !== null) console.error(`worker ${name} exited ${code}: ${err}`);
    resolve({ code, signal });
  }));
  return { p, exited };
}
const lines = (f: string) => (existsSync(f) ? readFileSync(f, 'utf8').trim().split('\n').filter(Boolean) : []);
async function until(cond: () => boolean, ms: number): Promise<boolean> {
  const end = Date.now() + ms;
  while (Date.now() < end) { if (cond()) return true; await sleep(20); }
  return cond();
}

for (const kind of ['sqlite', 'postgres'] as const) describe.skipIf(kind === 'postgres' && !PG_URL)(`SIGTERM while a job runs (separate processes, ${kind})`, () => {
  it('the held job finishes once, no next job is taken, the process exits 0; the next job runs elsewhere once', async () => {
    const st = setup(kind);
    const { effects, go } = st;
    const s = await open(kind, st.db);
    await enqueue(s.work!, 't', { job: 'j1' });
    await s.close?.();
    const a = start(st, 'A');
    expect(await until(() => lines(effects).includes('enter A j1'), 20_000), 'A took j1').toBe(true);
    const s2 = await open(kind, st.db);
    await enqueue(s2.work!, 't', { job: 'j2' });
    await s2.close?.();
    a.p.kill('SIGTERM');
    await sleep(300);
    expect(a.p.exitCode === null && a.p.signalCode === null, 'A died on SIGTERM with j1 in its handler').toBe(true);
    writeFileSync(go, '');
    const exit = await a.exited;
    expect(exit).toEqual({ code: 0, signal: null });
    expect(lines(effects).filter((l) => !l.startsWith('ready')), 'A took j2 while shutting down').toEqual(['enter A j1', 'effect A j1']);
    const b = start(st, 'B');
    expect(await until(() => lines(effects).includes('effect B j2'), 20_000), 'B ran j2').toBe(true);
    b.p.kill('SIGTERM');
    await b.exited;
    expect(lines(effects).filter((l) => l.startsWith('enter'))).toEqual(['enter A j1', 'enter B j2']);
    const s3 = await open(kind, st.db);
    expect((await listJobs(s3.work!)).map((j) => j.status)).toEqual(['done', 'done']);
    await s3.close?.();
  }, 60_000);
});
