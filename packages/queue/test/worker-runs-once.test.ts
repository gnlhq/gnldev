// A job's handler runs at most once per completion, across workers — side effects outside `ctx.run`
// included.
//
// The worker asked "is this job finished?" BEFORE it took the lease and never after. Between the two,
// another worker could take the lease, run the job, write `qdone` and release; the lease was then
// simply free, and the handler ran a second time. Measured on Postgres, 3 workers × 400 jobs: 3-5% of
// jobs ran twice, 0.9.0 included. The check now also runs under the lease (`isTerminal`).
//
// The interleaving is forced here, deterministically: worker A's "finished?" read is held open until
// worker B has run the job to the end. Then the same rule under real contention: separate OS processes
// on one SQLite file, and (with GNL_PG_URL) real Postgres pools.
import { describe, it, expect } from 'vitest';
import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { InMemoryStorage, type Storage, type WorkStore } from '@gnldev/durable';
import { SqliteStorage } from '@gnldev/durable/sqlite';
import { createWorker, enqueue, listJobs } from '../src/index.js';

/** A view of `storage` whose work store holds the FIRST read of `holdKey` open until `release()`. */
function holdingFirstRead(storage: Storage, holdKey: string) {
  let open!: () => void;
  const gate = new Promise<void>((r) => { open = r; });
  let reached!: () => void;
  const atGate = new Promise<void>((r) => { reached = r; });
  let held = false;
  const base = storage.work!;
  const work = new Proxy(base, {
    get(t, p) {
      if (p === 'get') {
        return async (key: string) => {
          const v = await t.get(key);
          if (key === holdKey && !held) { held = true; reached(); await gate; }
          return v;
        };
      }
      const v = (t as any)[p];
      return typeof v === 'function' ? v.bind(t) : v;
    },
  }) as WorkStore;
  const view = new Proxy(storage, {
    get(t, p) {
      if (p === 'work') return work;
      const v = (t as any)[p];
      return typeof v === 'function' ? v.bind(t) : v;
    },
  }) as Storage;
  return { view, atGate, release: () => open() };
}

describe('worker: "finished?" is answered under the lease', () => {
  it('A read "not done", B ran the job to the end and released, A takes the free lease — the handler does not run again', async () => {
    const storage = new InMemoryStorage();
    const id = await enqueue(storage.work!, 't', {});
    const effects: string[] = [];
    const handler = (who: string) => ({ t: async () => { effects.push(who); } });
    const a = holdingFirstRead(storage, `qdone:${id}`);
    const workerA = createWorker(a.view, handler('A'), { owner: 'A', heartbeat: false });
    const workerB = createWorker(storage, handler('B'), { owner: 'B', heartbeat: false });

    const runA = workerA.runOnce();
    await a.atGate; // A has read "not done"
    expect(await workerB.runOnce()).toBe(true); // B: lease, handler, qdone, release
    a.release();
    await runA;

    expect(effects).toEqual(['B']); // was ['B', 'A']
    expect((await listJobs(storage.work!))[0]).toMatchObject({ status: 'done', attempts: 1 }); // B's one attempt
  });

  it('the same for a dead letter: B failed it at its last attempt — A does not hand it to the handler once more', async () => {
    const storage = new InMemoryStorage();
    const id = await enqueue(storage.work!, 't', {});
    const effects: string[] = [];
    const handler = (who: string) => ({ t: async () => { effects.push(who); throw new Error('down'); } });
    const a = holdingFirstRead(storage, `qfail:${id}`);
    const workerA = createWorker(a.view, handler('A'), { owner: 'A', heartbeat: false, maxAttempts: 1 });
    const workerB = createWorker(storage, handler('B'), { owner: 'B', heartbeat: false, maxAttempts: 1 });

    const runA = workerA.runOnce();
    await a.atGate;
    await workerB.runOnce();
    a.release();
    await runA;

    expect(effects).toEqual(['B']); // was ['B', 'A'], and A's failure bumped qatt past maxAttempts
    expect((await listJobs(storage.work!))[0]).toMatchObject({ status: 'failed', attempts: 1 });
  });

  it('a job that failed and is NOT terminal is still retried by the next worker (the re-check does not swallow retries)', async () => {
    const storage = new InMemoryStorage();
    await enqueue(storage.work!, 't', {});
    let n = 0;
    const w = createWorker(storage, { t: async () => { if (++n === 1) throw new Error('once'); } }, { heartbeat: false, maxAttempts: 3 });
    expect(await w.runOnce()).toBe(true);
    expect(await w.runOnce()).toBe(true);
    expect(n).toBe(2);
    expect((await listJobs(storage.work!))[0]).toMatchObject({ status: 'done', attempts: 2 }); // attempts started
  });
});

// ── real contention ────────────────────────────────────────────────────────────────────────────
const here = dirname(fileURLToPath(import.meta.url));
const tsxBin = join(here, '..', '..', '..', 'node_modules', '.bin', 'tsx');
const procScript = join(here, 'fixtures', 'worker-proc.ts');

function runProc(db: string, effects: string, name: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const p = spawn(tsxBin, [procScript, db, effects, name], { stdio: ['ignore', 'pipe', 'pipe'] });
    let err = '';
    p.stderr.on('data', (d) => (err += d));
    p.on('close', (code) => (code === 0 ? resolve() : reject(new Error(`worker process ${name} exited ${code}: ${err}`))));
  });
}

function duplicates(lines: string[]): string[] {
  const seen = new Map<string, number>();
  for (const l of lines) seen.set(l, (seen.get(l) ?? 0) + 1);
  return [...seen].filter(([, n]) => n > 1).map(([k]) => k);
}

describe('worker: separate processes on one SQLite file', () => {
  it('2 processes × 3 workers, 150 jobs: every job ran exactly once', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'gnl-queue-once-'));
    try {
      const db = join(dir, 'q.db');
      const effects = join(dir, 'effects.txt');
      const s = new SqliteStorage(db);
      const ids: string[] = [];
      for (let i = 0; i < 150; i++) ids.push(await enqueue(s.work!, 't', { k: `j${i}` }));
      await s.close();
      await Promise.all([runProc(db, effects, 'P1'), runProc(db, effects, 'P2')]);
      const lines = existsSync(effects) ? readFileSync(effects, 'utf8').split('\n').filter(Boolean).map((l) => l.split(' ')[0]!) : [];
      expect(duplicates(lines)).toEqual([]);
      expect(new Set(lines).size).toBe(150);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, 120_000);
});

const PG_URL = process.env.GNL_PG_URL;
describe.skipIf(!PG_URL)('worker: real Postgres, separate pools (GNL_PG_URL)', () => {
  it('3 workers on 3 pools, 4 producers × 100 jobs while they run: every job ran exactly once', async () => {
    const { PostgresStorage } = await import('@gnldev/durable/postgres');
    // A database of its own: a worker claims every job in the store, other tests' included.
    // `pg` is @gnldev/durable's (optional peer) dependency, not this package's: resolved from there.
    const pg = createRequire(join(here, '..', '..', 'durable', 'package.json'))('pg');
    const admin = new pg.Client({ connectionString: PG_URL });
    await admin.connect();
    const dbName = `q_once_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`;
    await admin.query(`CREATE DATABASE ${dbName}`);
    const url = new URL(PG_URL!);
    url.pathname = `/${dbName}`;
    const mk = async () => { const s = new PostgresStorage({ connectionString: url.toString() }); await (s as any).init?.(); return s; };
    const workers = await Promise.all([mk(), mk(), mk()]);
    const producer = await mk();
    const ran: string[] = [];
    const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
    try {
      const ws = workers.map((s) => createWorker(s, { t: async (p: { k: string }) => { ran.push(p.k); await sleep(Math.random() * 3); } }, { ttlMs: 5000 }));
      let stop = false;
      const loops = ws.map(async (w) => { while (!stop) { if (!(await w.runOnce().catch(() => false))) await sleep(5); } });
      const ks: string[] = [];
      await Promise.all([0, 1, 2, 3].map(async (p) => {
        for (let i = 0; i < 100; i++) { const k = `${p}-${i}`; await enqueue(producer.work!, 't', { k }); ks.push(k); }
      }));
      const until = Date.now() + 60_000;
      while (new Set(ran).size < ks.length && Date.now() < until) await sleep(50);
      await sleep(300);
      stop = true;
      await Promise.all(loops);
      expect(duplicates(ran)).toEqual([]);
      expect(new Set(ran).size).toBe(ks.length);
    } finally {
      for (const s of [...workers, producer]) await (s as any).close?.();
      await admin.query(`DROP DATABASE IF EXISTS ${dbName}`);
      await admin.end();
    }
  }, 120_000);
});
