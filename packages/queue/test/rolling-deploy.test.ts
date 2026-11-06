// A rolling deploy: a 0.9 process keeps enqueueing into the database this version's worker drains.
//
// INVARIANT: a job is run whichever version enqueued it. The worker persists `qcursor` as "every job
// before here is finished"; a job sorted behind it is never claimed. Measured on the first cut of the
// sequenced cursor (review panel, round 2, `mixed.mjs`): 60 jobs drained by this version, then 3
// enqueued by a 0.9.0 process on the same SQLite file — `pending 3` after every later drain, forever,
// because 0.9's INSERT names no `seq` and the row took the default 0, ahead of the cursor.
//
// The 0.9 producer here is this version's `enqueue` over a WorkStore whose `append` is 0.9.0's exact
// statement on its own connection: `enqueue`'s record shape did not change between the two versions,
// only the store's write did.
import { describe, it, expect, afterAll } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRequire } from 'node:module';
import { serialize, type Storage, type WorkStore } from '@gnldev/durable';
import { SqliteStorage } from '@gnldev/durable/sqlite';
import { enqueue, createWorker, queueUpgrade } from '../src/index.js';
import { listAllJobs as listJobs } from './fixtures/k5-list-all.js';

const { DatabaseSync } = createRequire(import.meta.url)('node:sqlite') as { DatabaseSync: new (path: string) => any };
const OLD_APPEND = 'INSERT INTO gnl_work_log (ns, id, payload, ts) VALUES (?, ?, ?, ?) ON CONFLICT(ns, id) DO NOTHING';

const cleanups: Array<() => void> = [];
afterAll(() => { for (const c of cleanups.splice(0)) c(); });

function shared() {
  const dir = mkdtempSync(join(tmpdir(), 'gnl-q-rolling-'));
  const file = join(dir, 'shared.db');
  const storage = new SqliteStorage(file) as unknown as Storage;
  const db = new DatabaseSync(file);
  cleanups.push(() => { db.close(); rmSync(dir, { recursive: true, force: true }); });
  /**
   * A 0.9 process's enqueue: its own connection, its own statement, into the ONE log every job went to
   * then (`qjob`). k5 E: this version's `enqueue` writes a lane and a ready entry, so the producer of an
   * earlier version is spelled out here rather than borrowed.
   */
  const old09 = {
    enqueue(payload: unknown) {
      const eid = `qjob-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`;
      db.prepare(OLD_APPEND).run('qjob', eid, serialize({ type: 't', payload }), Date.now());
      return eid;
    },
  };
  const ran: string[] = [];
  const worker = createWorker(storage, { t: async (p: any) => { ran.push(p.n); } });
  return { storage, old09, ran, worker };
}

const statuses = async (work: WorkStore) =>
  (await listJobs(work)).reduce<Record<string, number>>((a, j) => ((a[j.status] = (a[j.status] ?? 0) + 1), a), {});

// k5 E — a worker of this version takes jobs from the ready set, which an earlier version's producer does
// not write. On a store whose old log was never moved (data v1) it is refused OUT LOUD (the worker names
// `gnl upgrade`), never left with jobs waiting unseen; after the upgrade every job runs exactly once.
/** The queue's upgrade steps, run in order: what `gnl upgrade`, then `--only queue/lanes-cleanup`, do. */
const upgraded = async (storage: Parameters<typeof queueUpgrade>[0]) => { for (const step of [queueUpgrade(storage)].flat()) await step.run(); };

describe('queue — a 0.9 producer and this version\'s worker on one SQLite file', () => {
  it('jobs a 0.9 process enqueues are refused out loud until the upgrade, then all run once', async () => {
    const { storage, old09, ran, worker } = shared();
    for (let i = 0; i < 60; i++) await enqueue(storage.work!, 't', { n: `new${i}` });
    await worker.drain();
    for (let i = 0; i < 3; i++) old09.enqueue({ n: `old${i}` });
    await expect(worker.drain()).rejects.toThrow(/gnl upgrade/);
    const [lanes, cleanup] = [queueUpgrade(storage)].flat();
    expect(await lanes!.run()).toMatchObject({ jobs: 3, ready: 3 });
    await cleanup!.run();
    await worker.drain();
    expect(ran.filter((x) => x.startsWith('old'))).toEqual(['old0', 'old1', 'old2']);
    expect(await statuses(storage.work!)).toEqual({ done: 63 });
  });

  it('SIBLING — a fresh worker (a restarted process) is refused the same way', async () => {
    const { storage, old09 } = shared();
    for (let i = 0; i < 3; i++) old09.enqueue({ n: `old${i}` });
    const ran2: string[] = [];
    const w = createWorker(storage, { t: async (p: any) => { ran2.push(p.n); } });
    await expect(w.runOnce()).rejects.toThrow(/gnl upgrade/);
    await upgraded(storage);
    await w.drain();
    expect(ran2).toEqual(['old0', 'old1', 'old2']);
  });

  it('SIBLING — the upgrade run twice (a crash, a second operator) runs nothing twice', async () => {
    const { storage, old09, ran, worker } = shared();
    for (let i = 0; i < 12; i++) old09.enqueue({ n: `r${i}` });
    const [lanes, cleanup] = [queueUpgrade(storage)].flat();
    expect(await lanes!.plan!()).toMatchObject({ jobs: 12, ready: 12 });
    await upgraded(storage);
    expect(await lanes!.run()).toMatchObject({ jobs: 0, ready: 0 });
    expect(await cleanup!.run()).toMatchObject({ jobs: 0, ready: 0 });
    await worker.drain();
    expect(ran).toHaveLength(12);
    expect(new Set(ran).size).toBe(12);
  });
});
