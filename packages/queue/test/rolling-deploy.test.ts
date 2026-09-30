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
import { enqueue, createWorker, listJobs } from '../src/index.js';

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
  /** A 0.9 process's WorkStore: its own connection, its own append statement; everything else shared. */
  const old09: WorkStore = Object.assign(Object.create(storage.work!), {
    async append(ns: string, payload: unknown, id?: string) {
      const eid = id ?? `${ns}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`;
      db.prepare(OLD_APPEND).run(ns, eid, serialize(payload), Date.now());
      return eid;
    },
  });
  const ran: string[] = [];
  const worker = createWorker(storage, { t: async (p: any) => { ran.push(p.n); } });
  return { storage, old09, ran, worker };
}

const statuses = async (work: WorkStore) =>
  (await listJobs(work)).reduce<Record<string, number>>((a, j) => ((a[j.status] = (a[j.status] ?? 0) + 1), a), {});

describe('queue — a 0.9 producer and this version\'s worker on one SQLite file', () => {
  it('jobs a 0.9 process enqueues after the worker persisted its cursor all run', async () => {
    const { storage, old09, ran, worker } = shared();
    for (let i = 0; i < 60; i++) await enqueue(storage.work!, 't', { n: `new${i}` });
    await worker.drain();
    expect(await storage.work!.get('qcursor')).toBeTruthy();
    for (let i = 0; i < 3; i++) await enqueue(old09, 't', { n: `old${i}` });
    await worker.drain();
    expect(ran.filter((x) => x.startsWith('old'))).toEqual(['old0', 'old1', 'old2']);
    expect(await statuses(storage.work!)).toEqual({ done: 63 });
  });

  it('SIBLING — a fresh worker (a restarted process) runs them too, from the persisted cursor', async () => {
    const { storage, old09, worker } = shared();
    for (let i = 0; i < 60; i++) await enqueue(storage.work!, 't', { n: `new${i}` });
    await worker.drain();
    for (let i = 0; i < 3; i++) await enqueue(old09, 't', { n: `old${i}` });
    const ran2: string[] = [];
    await createWorker(storage, { t: async (p: any) => { ran2.push(p.n); } }).drain();
    expect(ran2).toEqual(['old0', 'old1', 'old2']);
  });

  it('SIBLING — both versions enqueue in turn between drains: every job runs exactly once', async () => {
    const { storage, old09, ran, worker } = shared();
    for (let round = 0; round < 5; round++) {
      for (let i = 0; i < 12; i++) await enqueue(i % 2 ? old09 : storage.work!, 't', { n: `r${round}-${i}` });
      await worker.drain();
    }
    expect(ran).toHaveLength(60);
    expect(new Set(ran).size).toBe(60);
  });
});
