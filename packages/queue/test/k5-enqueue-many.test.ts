// k5 (5c-ek): many jobs in one call — `enqueueMany` — with the same fairness and the same promises as `enqueue`.
//
// Invariant: a call either adds every job it names or none; each organization's jobs in it are taken in
// the order of the call, one turn apart, exactly as one `enqueue` after another would rank them; an id
// already enqueued (or repeated in the call) is one job; and a worker runs every job once.
import { describe, it, expect, afterAll } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { InMemoryStorage, type Storage } from '@gnldev/durable';
import { SqliteStorage } from '@gnldev/durable/sqlite';
import * as Q from '../src/index.js';

const q = Q as any;
const here = dirname(fileURLToPath(import.meta.url));
const PG_URL = process.env.GNL_PG_URL;
const MYSQL_URL = process.env.GNL_MYSQL_URL;
const MONGO_URL = process.env.GNL_MONGO_URL;
const ends: Array<() => Promise<void>> = [];
afterAll(async () => { for (const e of ends.reverse()) await e().catch(() => {}); });
const fromDurable = (m: string) => createRequire(join(here, '..', '..', 'durable', 'package.json'))(m);
const tag = () => `k5m_${process.pid}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`;

async function opened(s: Storage): Promise<Storage> {
  await (s as any).init?.();
  ends.push(async () => { await (s as any).close?.(); });
  return s;
}
type Mk = () => Promise<Storage>;
const BACKENDS: Array<[string, Mk]> = [
  ['memory', async () => new InMemoryStorage()],
  ['sqlite', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'k5m-'));
    ends.push(async () => rmSync(dir, { recursive: true, force: true }));
    return opened(new SqliteStorage(join(dir, 'q.db')) as unknown as Storage);
  }],
];
if (PG_URL) BACKENDS.push(['postgres', async () => {
  const { PostgresStorage } = await import('@gnldev/durable/postgres');
  const schema = tag();
  const admin = new (fromDurable('pg').Client)({ connectionString: PG_URL });
  await admin.connect();
  await admin.query(`CREATE SCHEMA ${schema}`);
  await admin.end();
  ends.push(async () => {
    const a = new (fromDurable('pg').Client)({ connectionString: PG_URL });
    await a.connect(); await a.query(`DROP SCHEMA ${schema} CASCADE`); await a.end();
  });
  const u = new URL(PG_URL);
  u.searchParams.set('options', `-c search_path=${schema}`);
  return opened(new PostgresStorage({ connectionString: u.toString() }) as unknown as Storage);
}]);
if (MYSQL_URL) BACKENDS.push(['mysql', async () => {
  const { MysqlStorage } = await import('@gnldev/durable/mysql');
  const db = tag();
  const my = fromDurable('mysql2/promise');
  const admin = await my.createConnection(MYSQL_URL); await admin.query(`CREATE DATABASE ${db}`); await admin.end();
  ends.push(async () => { const a = await my.createConnection(MYSQL_URL); await a.query(`DROP DATABASE IF EXISTS ${db}`); await a.end(); });
  const u = new URL(MYSQL_URL);
  u.pathname = `/${db}`;
  return opened(new MysqlStorage({ connectionString: u.toString() }) as unknown as Storage);
}]);
if (MONGO_URL) BACKENDS.push(['mongo', async () => {
  const { MongoStorage } = await import('@gnldev/durable/mongo');
  const u = new URL(MONGO_URL);
  u.pathname = `/${tag()}`;
  ends.push(async () => {
    const c = new (fromDurable('mongodb').MongoClient)(MONGO_URL);
    try { await c.db(u.pathname.slice(1)).dropDatabase(); } finally { await c.close(); }
  });
  return opened(new MongoStorage({ connectionString: u.toString() }) as unknown as Storage);
}]);

/** Runs `runOnce` until the queue is empty; returns `[orgId, payload.n]` of each job in start order. */
async function startOrder(storage: Storage): Promise<Array<[string | undefined, unknown]>> {
  const order: Array<[string | undefined, unknown]> = [];
  const w = q.createWorker(storage, { t: async (p: { n?: unknown }, ctx: any) => { order.push([ctx.orgId, p.n]); } }, { ttlMs: 10_000 });
  try { while (await w.runOnce()) { /* next */ } } finally { await w.close(); }
  return order;
}
const jobs = (orgId: string | undefined, n: number, from = 0) =>
  Array.from({ length: n }, (_, i) => ({ type: 't', payload: { n: from + i }, ...(orgId !== undefined ? { options: { orgId } } : {}) }));

for (const [name, mk] of BACKENDS) {
  describe(`k5 — enqueueMany (${name})`, () => {
    it('returns the ids in call order; each organization\'s jobs are listed and run in that order, organizations served once per round', async () => {
      const s = await mk();
      const ids: string[] = await q.enqueueMany(s.work, [...jobs('orga', 3), ...jobs('orgb', 2), ...jobs(undefined, 1)]);
      expect(ids.length).toBe(6);
      expect(new Set(ids).size).toBe(6);
      expect((await q.listJobs(s.work, { orgId: 'orga' })).items.map((j: any) => j.id)).toEqual(ids.slice(0, 3));
      expect((await q.getJob(s.work, ids[4]))?.status).toBe('pending');
      expect(await startOrder(s)).toEqual([['orga', 0], ['orgb', 0], [undefined, 0], ['orga', 1], ['orgb', 1], ['orga', 2]]);
      for (const id of ids) expect((await q.getJob(s.work, id))?.status).toBe('done');
    }, 120_000);

    it('fairness as enqueue: org-X\'s 1000 jobs in two calls, then org-Y\'s one — Y starts within the first 2', async () => {
      const s = await mk();
      await q.enqueueMany(s.work, jobs('orgx', 500));
      await q.enqueueMany(s.work, jobs('orgx', 500, 500));
      await q.enqueue(s.work, 't', { n: 'y' }, { orgId: 'orgy' });
      const order = await startOrder(s);
      expect(order.length).toBe(1001);
      expect(order.findIndex(([o]) => o === 'orgy') + 1).toBeLessThanOrEqual(2);
      expect(order.filter(([o]) => o === 'orgx').map(([, n]) => n)).toEqual(Array.from({ length: 1000 }, (_, i) => i));
    }, 300_000);

    it('one invalid job anywhere in the call: the call is refused and nothing is written', async () => {
      const s = await mk();
      const bad = [
        { type: 't', payload: {}, options: { orgId: 'orga', runAt: 'tomorrow' } },
        { type: 't', payload: {}, options: { orgId: 'orga', priority: 1 } },
        { type: 't', payload: {}, options: { orgId: 'bad:id' } },
        { type: 't', payload: {}, options: { orgId: 'orga', resourceId: '' } },
        { type: 't', payload: {}, opts: { orgId: 'orga' } },
      ];
      for (const b of bad) await expect(q.enqueueMany(s.work, [...jobs('orga', 3), b, ...jobs('orga', 3)])).rejects.toThrow(/@gnldev\/(queue|durable|options)|enqueue/);
      expect((await q.listJobs(s.work, { orgId: 'orga' })).items).toEqual([]);
      expect(await startOrder(s)).toEqual([]);
    }, 120_000);

    it('an id already enqueued, or repeated in the call, is one job: the first record stays and takes no second turn', async () => {
      const s = await mk();
      const first = await q.enqueue(s.work, 't', { n: 'first' }, { orgId: 'orga', id: 'csv-1' });
      const ids: string[] = await q.enqueueMany(s.work, [
        { type: 't', payload: { n: 'again' }, options: { orgId: 'orga', id: 'csv-1' } },
        { type: 't', payload: { n: 2 }, options: { orgId: 'orga', id: 'csv-2' } },
        { type: 't', payload: { n: 'dup' }, options: { orgId: 'orga', id: 'csv-2' } },
        { type: 't', payload: { n: 3 }, options: { orgId: 'orga', id: 'csv-3' } },
      ]);
      expect(ids[0]).toBe(first);
      expect(ids[1]).toBe(ids[2]);
      expect(await q.enqueueMany(s.work, [{ type: 't', payload: { n: 'later' }, options: { orgId: 'orga', id: 'csv-3' } }])).toEqual([ids[3]]);
      expect((await q.listJobs(s.work, { orgId: 'orga' })).items.map((j: any) => j.id)).toEqual([first, ids[1], ids[3]]);
      expect(await startOrder(s)).toEqual([['orga', 'first'], ['orga', 2], ['orga', 3]]);
    }, 120_000);

    it('an empty call writes nothing and returns no id; a call that is not a list is refused', async () => {
      const s = await mk();
      expect(await q.enqueueMany(s.work, [])).toEqual([]);
      await expect(q.enqueueMany(s.work, { type: 't' })).rejects.toThrow(TypeError);
      expect(await startOrder(s)).toEqual([]);
    });

    it('maxDepth counts the call\'s own jobs: a call that would pass the limit is refused whole', async () => {
      const s = await mk();
      await q.enqueueMany(s.work, jobs('orga', 3));
      const over = jobs('orga', 3).map((j) => ({ ...j, options: { ...j.options, maxDepth: 5 } }));
      await expect(q.enqueueMany(s.work, over)).rejects.toBeInstanceOf(q.QueueDepthExceededError);
      expect((await q.listJobs(s.work, { orgId: 'orga' })).items.length).toBe(3);
      await q.enqueueMany(s.work, over.slice(0, 2));
      expect((await q.listJobs(s.work, { orgId: 'orga' })).items.length).toBe(5);
    });

    it('two calls for one organization at once: every job once, each call\'s jobs in its order, and org-Y still starts within the first 2', async () => {
      const s = await mk();
      const [a, b] = await Promise.all([q.enqueueMany(s.work, jobs('orgx', 60)), q.enqueueMany(s.work, jobs('orgx', 60, 100))]);
      await q.enqueue(s.work, 't', { n: 'y' }, { orgId: 'orgy' });
      expect(new Set([...a, ...b]).size).toBe(120);
      const order = await startOrder(s);
      expect(order.length).toBe(121);
      expect(order.findIndex(([o]) => o === 'orgy') + 1).toBeLessThanOrEqual(2);
      const ns = order.filter(([o]) => o === 'orgx').map(([, n]) => n as number);
      expect(ns.filter((n) => n < 100)).toEqual(Array.from({ length: 60 }, (_, i) => i));
      expect(ns.filter((n) => n >= 100)).toEqual(Array.from({ length: 60 }, (_, i) => 100 + i));
    }, 120_000);

    it('a queue made by createQueue enqueues many too', async () => {
      const s = await mk();
      const ran: unknown[] = [];
      const queue = q.createQueue(s, { t: async (p: { n: unknown }) => { ran.push(p.n); } }, { worker: false });
      expect((await queue.enqueueMany(jobs('orga', 2))).length).toBe(2);
      await queue.close();
      expect((await startOrder(s)).map(([, n]) => n)).toEqual([0, 1]);
    });
  });
}
