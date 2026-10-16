// Real processes, real signals, on SQLite and Postgres — the two rules of the work in hand:
//
//  1. A drain RELEASES a job, it does not fail it (@gnldev/durable `attemptEndOf`). SIGTERM while a job's
//     run is in its tool body, on the job's only attempt: the body finishes, the run is released at its
//     next step, the process exits 0 — and another process continues the same run to `done`, the tool not
//     run again. Before, the job was dead-lettered `failed` and nobody continued it (audit C4).
//  2. `pendingWork` lists what a process HOLDS, from any process (@gnldev/durable `holdWhile`): a job a
//     worker in another process holds blocks — also while that worker is frozen (SIGSTOP: it still holds
//     it) — and stops blocking once it is killed. The dead holder's shadow is reclaimed by the next process
//     that holds work there, by the rule that judged it dead (audit C7).
//  3. A liveness id names one process lifetime: a process restarted under the configured id of one that
//     crashed holding a job takes that job over and runs it once (audit C8, here on Postgres too).
import { describe, it, expect, afterAll } from 'vitest';
import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import type { Storage } from '@gnldev/durable';
import { pendingWork, storeLiveness, toJournal, unbindLiveness } from '@gnldev/durable';
import { SqliteStorage } from '@gnldev/durable/sqlite';
import { createDatabaseSync, dropDatabaseSync } from '../../../test/support/pg-admin.js';
import { enqueue, listJobs } from '../src/index.js';

const here = dirname(fileURLToPath(import.meta.url));
const tsxLoader = join(dirname(createRequire(import.meta.url).resolve('tsx/package.json')), 'dist', 'loader.mjs');
const procScript = join(here, 'fixtures', 'm2-worker-proc.ts');
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const PG_URL = process.env.GNL_PG_URL;
type Kind = 'sqlite' | 'postgres';

const dirs: string[] = [];
const drops: string[] = [];
afterAll(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
  for (const n of drops) dropDatabaseSync(n);
});

let seq = 0;
function setup(kind: Kind) {
  const dir = mkdtempSync(join(tmpdir(), 'gnl-m2-hand-'));
  dirs.push(dir);
  let db = join(dir, 'q.db');
  if (kind === 'postgres') {
    const n = `m2_hand_${process.pid}_${seq++}`;
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
function start(st: ReturnType<typeof setup>, name: string, mode: 'plain' | 'run', maxAttempts = 1, livenessId?: string): { p: ChildProcess; exited: Promise<{ code: number | null; signal: string | null }> } {
  const p = spawn(process.execPath, ['--import', tsxLoader, procScript, st.kind, st.db, st.effects, st.go, name, String(process.pid), mode, String(maxAttempts), ...(livenessId ? [livenessId] : [])], { stdio: ['ignore', 'ignore', 'pipe'] });
  let err = '';
  p.stderr!.on('data', (d) => (err += d));
  const exited = new Promise<{ code: number | null; signal: string | null }>((resolve) => p.on('close', (code, signal) => {
    if (code !== 0 && code !== null) console.error(`worker ${name} exited ${code}: ${err}`);
    resolve({ code, signal });
  }));
  return { p, exited };
}
const lines = (f: string) => (existsSync(f) ? readFileSync(f, 'utf8').trim().split('\n').filter(Boolean) : []);
async function until(cond: () => boolean | Promise<boolean>, ms: number): Promise<boolean> {
  const end = Date.now() + ms;
  while (Date.now() < end) { if (await cond()) return true; await sleep(20); }
  return cond();
}

for (const kind of ['sqlite', 'postgres'] as const) describe.skipIf(kind === 'postgres' && !PG_URL)(`the work in hand, across processes (${kind})`, () => {
  it('SIGTERM in a job run\'s tool body on its last attempt: released, not failed — another process finishes it, the tool once', async () => {
    const st = setup(kind);
    const s = await open(kind, st.db);
    const id = await enqueue(s.work!, 't', {});
    await s.close?.();
    const a = start(st, 'A', 'run');
    expect(await until(() => lines(st.effects).includes('enter A'), 20_000), 'A entered the tool body').toBe(true);
    a.p.kill('SIGTERM');
    await sleep(200);
    writeFileSync(st.go, '');
    expect(await a.exited).toEqual({ code: 0, signal: null });
    const mid = await open(kind, st.db);
    const after = (await listJobs(mid.work!)).find((j) => j.id === id)!;
    await mid.close?.();
    expect({ status: after.status, attempts: after.attempts }, 'the drained attempt was spent').toEqual({ status: 'pending', attempts: 0 });
    const b = start(st, 'B', 'run');
    const s2 = await open(kind, st.db);
    expect(await until(async () => (await listJobs(s2.work!)).find((j) => j.id === id)!.status === 'done', 20_000), 'B finished the job').toBe(true);
    await s2.close?.();
    b.p.kill('SIGTERM');
    await b.exited;
    expect(lines(st.effects).filter((l) => !l.startsWith('ready'))).toEqual(['enter A', 'effect A']);
  }, 60_000);

  it('a job held in another process blocks, frozen or not; killed, it does not — and its shadow is reclaimed by the next holder', async () => {
    const st = setup(kind);
    const s = await open(kind, st.db);
    const id = await enqueue(s.work!, 't', {});
    const journal = toJournal(s.runs);
    // As `gnl pending` does: the store's liveness, to judge the holders by.
    const live = await storeLiveness(journal, { own: () => (s as { processLiveness?: () => never }).processLiveness?.() });
    const a = start(st, 'A', 'plain', 3);
    try {
      expect(await until(() => lines(st.effects).includes('enter A'), 20_000)).toBe(true);
      const held = await pendingWork(journal);
      expect({ running: held.running.map((r) => r.runId), blocking: held.blocking }).toEqual({ running: [`job:${id}`], blocking: true });
      expect(held.running[0]!.what).toContain("job 't'");
      a.p.kill('SIGSTOP');
      expect((await pendingWork(journal)).blocking, 'a frozen holder still holds its job').toBe(true);
      a.p.kill('SIGKILL');
      await a.exited;
      expect(await until(async () => !(await pendingWork(journal)).blocking, 10_000), 'a dead holder holds nothing').toBe(true);
      expect((await journal.listKeys!('__hand__:')).length, "the dead holder's shadow is still there").toBe(1);
      writeFileSync(st.go, '');
      const b = start(st, 'B', 'plain', 3);
      expect(await until(async () => (await listJobs(s.work!)).find((j) => j.id === id)!.status === 'done', 20_000), 'B took the job over').toBe(true);
      expect(await until(async () => (await journal.listKeys!('__hand__:')).length === 0, 10_000), 'no shadow is left').toBe(true);
      b.p.kill('SIGTERM');
      await b.exited;
      expect(lines(st.effects).filter((l) => l.startsWith('effect'))).toEqual(['effect B']);
    } finally {
      if (a.p.exitCode === null && a.p.signalCode === null) a.p.kill('SIGKILL');
      unbindLiveness(journal);
      await live?.close();
      await s.close?.();
    }
  }, 60_000);

  it('a process restarted under the configured liveness id of one that crashed holding a job takes it over, once', async () => {
    const st = setup(kind);
    const s = await open(kind, st.db);
    const id = await enqueue(s.work!, 't', {});
    await s.close?.();
    const a = start(st, 'A', 'plain', 3, 'slot-1');
    expect(await until(() => lines(st.effects).includes('enter A'), 20_000)).toBe(true);
    a.p.kill('SIGKILL');
    await a.exited;
    writeFileSync(st.go, '');
    const b = start(st, 'B', 'plain', 3, 'slot-1'); // the same slot, restarted
    const s2 = await open(kind, st.db);
    const done = await until(async () => (await listJobs(s2.work!)).find((j) => j.id === id)!.status === 'done', 20_000);
    await s2.close?.();
    b.p.kill('SIGTERM');
    await b.exited;
    expect(done, "the dead holder's job was never taken over").toBe(true);
    expect(lines(st.effects).filter((l) => l.startsWith('effect'))).toEqual(['effect B']);
  }, 60_000);
});
