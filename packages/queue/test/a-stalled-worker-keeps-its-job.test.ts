// A worker that is frozen — not dead — keeps the job it holds; a worker that is dead gives it up.
//
// The lease was judged by its age: a worker that stopped renewing past `ttlMs` read as crashed and
// another worker took the job. Age cannot tell a dead process from a frozen one. A process stopped by
// the scheduler, a GC pause, a VM migration (here: a real SIGSTOP) stops renewing; the second worker
// runs the handler; the first comes back and finishes its own: the side effect twice.
//
// The lease is a holder stamp like every other: it names the process holding it, and is live exactly
// while that process is (process-liveness.ts). Separate OS processes on one SQLite file, and (with
// GNL_PG_URL) on one Postgres database.
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
import { enqueue } from '../src/index.js';

const here = dirname(fileURLToPath(import.meta.url));
// The worker runs in the spawned process itself (tsx as a loader, not its forking CLI), so SIGSTOP and
// SIGKILL reach the process that holds the job.
const tsxLoader = join(dirname(createRequire(import.meta.url).resolve('tsx/package.json')), 'dist', 'loader.mjs');
const procScript = join(here, 'fixtures', 'stalled-worker-proc.ts');
const TTL = 1_000;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const dirs: string[] = [];
afterAll(() => { for (const d of dirs) rmSync(d, { recursive: true, force: true }); });

type Kind = 'sqlite' | 'postgres';
const PG_URL = process.env.GNL_PG_URL;
const drops: string[] = [];
afterAll(() => {
  for (const name of drops) {
    dropDatabaseSync(name);
  }
});

let seq = 0;
function setup(kind: Kind) {
  const dir = mkdtempSync(join(tmpdir(), 'gnl-q-stalled-'));
  dirs.push(dir);
  let db = join(dir, 'q.db');
  if (kind === 'postgres') {
    const name = `ql_stalled_${process.pid}_${seq++}`;
    db = createDatabaseSync(name);
    drops.push(name);
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

function start({ kind, db, effects, go }: ReturnType<typeof setup>, name: string): { p: ChildProcess; exited: Promise<number | null> } {
  const p = spawn(process.execPath, ['--import', tsxLoader, procScript, kind, db, effects, go, name, String(TTL), String(process.pid)], { stdio: ['ignore', 'ignore', 'pipe'] });
  let err = '';
  p.stderr!.on('data', (d) => (err += d));
  const exited = new Promise<number | null>((resolve) => p.on('close', (code) => {
    if (code !== 0 && code !== null) console.error(`worker ${name} exited ${code}: ${err}`);
    resolve(code);
  }));
  return { p, exited };
}

const lines = (f: string) => (existsSync(f) ? readFileSync(f, 'utf8').trim().split('\n').filter(Boolean) : []);
async function until(cond: () => boolean, ms: number): Promise<boolean> {
  const end = Date.now() + ms;
  while (Date.now() < end) { if (cond()) return true; await sleep(20); }
  return cond();
}

for (const kind of ['sqlite', 'postgres'] as const) describe.skipIf(kind === 'postgres' && !PG_URL)(`a stalled worker keeps its job; a dead one gives it up (separate processes, ${kind})`, () => {
  it('SIGSTOP past the lease: no second worker runs the job — the side effect happens once', async () => {
    const st = setup(kind);
    const { effects, go } = st;
    const s = await open(kind, st.db);
    await enqueue(s.work!, 't', {});
    await s.close?.();
    const a = start(st, 'A');
    expect(await until(() => lines(effects).includes('enter A'), 20_000), 'A took the job').toBe(true);
    a.p.kill('SIGSTOP');
    writeFileSync(go, '');
    const b = start(st, 'B');
    await sleep(TTL * 4); // far past A's lease
    const duringFreeze = lines(effects);
    a.p.kill('SIGCONT');
    await Promise.all([a.exited, b.exited]);
    expect(duringFreeze, 'B ran the job while A was frozen, not dead').not.toContain('enter B');
    expect(lines(effects).filter((l) => l.startsWith('effect'))).toEqual(['effect A']);
  }, 60_000);

  it('SIGKILL: the dead worker\'s job is taken over and runs once', async () => {
    const st = setup(kind);
    const { effects, go } = st;
    const s = await open(kind, st.db);
    await enqueue(s.work!, 't', {});
    await s.close?.();
    const a = start(st, 'A');
    expect(await until(() => lines(effects).includes('enter A'), 20_000), 'A took the job').toBe(true);
    a.p.kill('SIGKILL');
    await a.exited;
    writeFileSync(go, '');
    const b = start(st, 'B');
    await b.exited;
    expect(lines(effects).filter((l) => l.startsWith('effect'))).toEqual(['effect B']);
  }, 60_000);
});
