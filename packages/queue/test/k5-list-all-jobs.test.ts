// k5 (5b): every organization's jobs, for an operator — `listAllJobs(work, { cursor, limit })`.
//
// `listJobs(work)` with no `orgId` lists the jobs that have no organization, and only those: an
// organization's caller never sees another's, and the call that sees them all is a different call, named
// for it. `listAllJobs` pages through every lane — the jobs with no organization first, then each
// organization's lane in name order, each in enqueue order — with a cursor that is a position (a lane, a
// place in it, and the moment the listing started), so a job enqueued while it pages is never listed twice
// and never makes it skip one that was there; one enqueued after the start is the next listing's (5h-1). Its cost: a page reads its lanes' records and the jobs' markers in one read (`getMany`),
// never a query per job.
//
//   GNL_PG_URL=… GNL_MYSQL_URL=… GNL_MONGO_URL=… npx vitest run packages/queue/test/k5-list-all-jobs.test.ts
import { AsyncLocalStorage } from 'node:async_hooks';
import { describe, it, expect, afterAll } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { InMemoryStorage, withOrgStorage, type Storage, type WorkStore } from '@gnldev/durable';
import { SqliteStorage } from '@gnldev/durable/sqlite';
import * as Q from '../src/index.js';

const q = Q as any;
const here = dirname(fileURLToPath(import.meta.url));
const PG_URL = process.env.GNL_PG_URL;
const MYSQL_URL = process.env.GNL_MYSQL_URL;
const MONGO_URL = process.env.GNL_MONGO_URL;
const fromDurable = (m: string) => createRequire(join(here, '..', '..', 'durable', 'package.json'))(m);
const tag = () => `k5la_${process.pid}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`;
const ends: Array<() => Promise<void>> = [];
afterAll(async () => { for (const e of ends.reverse()) await e().catch(() => {}); });

async function opened(s: Storage): Promise<Storage> {
  await (s as any).init?.();
  ends.push(async () => { await (s as any).close?.(); });
  return s;
}
type Mk = () => Promise<Storage>;
const sqliteFile = () => {
  const dir = mkdtempSync(join(tmpdir(), 'k5la-'));
  ends.push(async () => rmSync(dir, { recursive: true, force: true }));
  return join(dir, 'q.db');
};
const BACKENDS: Array<[string, Mk]> = [
  ['memory', async () => new InMemoryStorage()],
  ['sqlite', async () => opened(new SqliteStorage(sqliteFile()) as unknown as Storage)],
];
let hasLibsql = true;
try { createRequire(join(here, '..', '..', 'durable', 'package.json')).resolve('libsql'); } catch { hasLibsql = false; }
if (hasLibsql) BACKENDS.push(['libsql', async () => {
  const { LibsqlStorage } = await import('@gnldev/durable/libsql');
  return opened(new LibsqlStorage(sqliteFile()) as unknown as Storage);
}]);
if (PG_URL) BACKENDS.push(['postgres', async () => {
  const { PostgresStorage } = await import('@gnldev/durable/postgres');
  const schema = tag();
  const admin = new (fromDurable('pg').Client)({ connectionString: PG_URL });
  await admin.connect(); await admin.query(`CREATE SCHEMA ${schema}`); await admin.end();
  ends.push(async () => { const a = new (fromDurable('pg').Client)({ connectionString: PG_URL }); await a.connect(); await a.query(`DROP SCHEMA ${schema} CASCADE`); await a.end(); });
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
  ends.push(async () => { const c = new (fromDurable('mongodb').MongoClient)(MONGO_URL); try { await c.db(u.pathname.slice(1)).dropDatabase(); } finally { await c.close(); } });
  return opened(new MongoStorage({ connectionString: u.toString() }) as unknown as Storage);
}]);

/** Every page of `listAllJobs`, `limit` at a time; `during(i)` runs after page i. */
async function allPages(work: WorkStore, limit: number, during?: (i: number) => Promise<void>): Promise<{ items: any[]; pages: number }> {
  const items: any[] = [];
  let cursor: string | undefined;
  for (let i = 0; ; i++) {
    const page = await q.listAllJobs(work, { limit, ...(cursor !== undefined ? { cursor } : {}) });
    expect(page.items.length).toBeLessThanOrEqual(limit);
    items.push(...page.items);
    await during?.(i);
    if (!page.nextCursor) return { items, pages: i + 1 };
    cursor = page.nextCursor;
  }
}

/** Counts every work-store port call made while `fn` runs. */
/** Marks the calls `fn` makes: a timer armed before it (enqueue's no-worker notice) reads the same store, and is not its cost. */
const measured = new AsyncLocalStorage<true>();
async function portCalls<T>(work: WorkStore, fn: () => Promise<T>): Promise<{ calls: Record<string, number>; total: number; result: T }> {
  const saved = new Map<string, unknown>();
  const calls: Record<string, number> = {};
  for (const m of ['list', 'listNamespaces', 'get', 'getMany', 'put', 'append', 'ackOnce', 'putIfMatch', 'read', 'deletePrefix', 'deleteIdPrefix']) {
    const f = (work as any)[m];
    if (typeof f !== 'function') continue;
    saved.set(m, f);
    (work as any)[m] = (...a: unknown[]) => { if (measured.getStore()) calls[m] = (calls[m] ?? 0) + 1; return f.apply(work, a); };
  }
  try {
    const result = await measured.run(true, fn);
    return { calls, total: Object.values(calls).reduce((a, b) => a + b, 0), result };
  } finally {
    for (const [m, f] of saved) (work as any)[m] = f;
  }
}

const ORGS = ['acme', 'globex', 'initech', 'umbrella', 'zeta'];
/** Jobs with no organization and of five organizations, of different sizes (a lane ending at a page edge included); some finished. */
async function fill(work: WorkStore): Promise<Map<string, { orgId?: string; status: string }>> {
  const want = new Map<string, { orgId?: string; status: string }>();
  for (let i = 0; i < 7; i++) want.set(await q.enqueue(work, 't', { i }), { status: 'pending' });
  for (const [k, orgId] of ORGS.entries()) {
    for (let i = 0; i < 3 + k * 4; i++) want.set(await q.enqueue(work, 't', { i }, { orgId }), { orgId, status: 'pending' });
  }
  const ids = [...want.keys()];
  // Finished in each way the markers say it.
  await work.put(`qdone:${ids[1]}`, { at: 1, ok: true }); want.get(ids[1]!)!.status = 'done';
  await work.put(`qfail:${ids[9]}`, { error: 'boom', attempts: 1 }); want.get(ids[9]!)!.status = 'failed';
  expect(await q.cancelJob(work, ids[20])).toBe(true); want.get(ids[20]!)!.status = 'cancelled';
  return want;
}

for (const [name, mk] of BACKENDS) {
  describe(`listAllJobs — every organization's jobs (${name})`, () => {
    it('listJobs with no orgId stays the jobs with no organization; listAllJobs is every job, each once, with its organization and status', async () => {
      const s = await mk();
      const want = await fill(s.work!);
      const none = await q.listJobs(s.work!, { limit: 1000 });
      expect(none.items.map((j: any) => j.id).sort()).toEqual([...want].filter(([, v]) => v.orgId === undefined).map(([id]) => id).sort());
      const { items } = await allPages(s.work!, 1000);
      expect(items).toHaveLength(want.size);
      expect(new Set(items.map((j: any) => j.id)).size).toBe(want.size);
      for (const j of items) {
        const w = want.get(j.id)!;
        expect([j.id, j.orgId, j.status]).toEqual([j.id, w.orgId, w.status]);
      }
      // The jobs with no organization first, then each organization's lane in name order, each in enqueue order.
      const order = items.map((j: any) => j.orgId ?? '');
      expect(order).toEqual([...order].sort());
      expect(items.filter((j: any) => j.orgId === 'zeta').map((j: any) => j.id)).toEqual([...want].filter(([, v]) => v.orgId === 'zeta').map(([id]) => id));
    });

    it('the same list at every page size: page edges inside a lane, at its end and across empty ends', async () => {
      const s = await mk();
      const want = await fill(s.work!);
      const whole = (await allPages(s.work!, 1000)).items.map((j: any) => j.id);
      for (const limit of [1, 3, 7, 10, 50]) {
        const { items, pages } = await allPages(s.work!, limit);
        expect([limit, items.map((j: any) => j.id)]).toEqual([limit, whole]);
        expect(pages).toBe(Math.max(1, Math.ceil(want.size / limit)));
      }
      // An empty queue: one empty page, no cursor.
      expect(await q.listAllJobs((await mk()).work!)).toEqual({ items: [] });
    });

    it('jobs enqueued while it pages: every job that was there is listed once, nothing twice', async () => {
      const s = await mk();
      const before = [...(await fill(s.work!)).keys()];
      let added = 0;
      const { items } = await allPages(s.work!, 4, async () => {
        // Into a lane already passed, the one being read, one ahead, a new organization's, and none.
        for (const orgId of [undefined, 'acme', 'umbrella', 'zeta', `new${added}`, 'aaa-first']) {
          await q.enqueue(s.work!, 't', { late: added }, orgId ? { orgId } : {});
          added++;
        }
      });
      const ids = items.map((j: any) => j.id);
      expect(new Set(ids).size).toBe(ids.length);
      for (const id of before) expect(ids).toContain(id);
      expect(ids.length).toBeLessThan(before.length + added);
    }, 60_000);

    it('producers enqueue at the same time as it pages (several at once, into every lane): every job that was there is listed once, nothing twice', async () => {
      const s = await mk();
      const before = [...(await fill(s.work!)).keys()];
      let stop = false;
      let added = 0;
      const lanes = [undefined, ...ORGS, 'aaa', 'zzz'];
      const producers = Array.from({ length: 4 }, async (_, p) => {
        // Bounded to 300 jobs; the producer that never stops is the 5h-1 case below.
        for (let i = 0; !stop && added < 300; i++) {
          const orgId = lanes[(i + p) % lanes.length];
          await q.enqueue(s.work!, 't', { p, i }, orgId ? { orgId } : {});
          added++;
        }
      });
      try {
        const { items } = await allPages(s.work!, 3, () => new Promise((r) => setTimeout(r, 5)));
        const ids = items.map((j: any) => j.id);
        expect(new Set(ids).size).toBe(ids.length);
        for (const id of before) expect(ids).toContain(id);
        expect(added).toBeGreaterThan(0);
      } finally { stop = true; await Promise.all(producers); }
    }, 60_000);

    it('5h-1: fixed at its start — under a producer that never stops (every lane, the one being read, new organizations) the list ends, with every job that was there exactly once and none added after; the next list has them', async () => {
      const s = await mk();
      const before = [...(await fill(s.work!)).keys()];
      const lanes = [undefined, ...ORGS, 'aaa', 'zzz'];
      let stop = false;
      let added = 0;
      let producer: Promise<void> | undefined;
      const later: string[] = [];
      const startProducer = () => {
        producer ??= (async () => {
          await new Promise((r) => setTimeout(r, 2)); // after the first page's moment, on this clock
          // Never stops on its own while the list pages (held to a minute, so a list that does not end fails
          // instead of hanging); yields each turn, as producers in other processes do not need to.
          const until = Date.now() + 60_000;
          for (let i = 0; !stop && Date.now() < until; i++) {
            const orgId = i % 5 === 4 ? `new${i}` : lanes[i % lanes.length];
            later.push(await q.enqueue(s.work!, 't', { late: i }, orgId ? { orgId } : {}));
            added++;
            await new Promise((r) => setImmediate(r));
          }
        })();
      };
      const MAX_PAGES = 500; // what "it ends" is held to: the jobs there at the start are 62, 21 pages of 3
      try {
        const items: any[] = [];
        let cursor: string | undefined;
        let pages = 0;
        for (;;) {
          const page = await q.listAllJobs(s.work!, { limit: 3, ...(cursor !== undefined ? { cursor } : {}) });
          items.push(...page.items);
          pages++;
          startProducer();
          if (!page.nextCursor || pages >= MAX_PAGES) { cursor = page.nextCursor; break; }
          cursor = page.nextCursor;
          await new Promise((r) => setTimeout(r, 5));
        }
        expect(cursor, `the list ended (${pages} pages, ${added} jobs added meanwhile)`).toBeUndefined();
        expect(added, 'the producer ran while it paged').toBeGreaterThan(0);
        const ids = items.map((j: any) => j.id);
        expect(ids.length, 'nothing twice').toBe(new Set(ids).size);
        expect(new Set(ids)).toEqual(new Set(before));
        stop = true;
        await producer;
        // What came after is the next list's.
        const next = new Set((await allPages(s.work!, 1000)).items.map((j: any) => j.id));
        for (const id of [...before, ...later]) expect(next.has(id), id).toBe(true);
      } finally { stop = true; await producer; }
    }, 120_000);

    it('refuses an organization\'s view of the store, and a misspelled option', async () => {
      const s = await mk();
      const org = withOrgStorage(s, 'acme') as Storage;
      await expect(q.listAllJobs(org.work!)).rejects.toThrow(/organization 'acme'.*root storage/s);
      await expect(q.listAllJobs(s.work!, { orgId: 'acme' })).rejects.toThrow(/orgId/);
      await expect(q.listAllJobs(s.work!, { cursor: 'not-a-cursor' })).rejects.toThrow(/cursor/);
    });

    it('cost: 100 organizations, 10 000 jobs — port calls per page do not grow with the jobs on it (no read per job)', async () => {
      const s = await mk();
      for (let o = 0; o < 100; o++) await q.enqueueMany(s.work!, Array.from({ length: 100 }, (_, i) => ({ type: 't', payload: { i }, options: { orgId: `org${String(o).padStart(3, '0')}` } })));
      for (const limit of [100, 1000]) {
        const r = await portCalls(s.work!, () => allPages(s.work!, limit));
        expect(r.result.items).toHaveLength(10_000);
        expect(new Set(r.result.items.map((j: any) => j.id)).size).toBe(10_000);
        console.log(`[k5 listAllJobs ${name}] 100 orgs × 100 jobs, limit ${limit}: ${r.result.pages} pages, ${r.total} port calls ${JSON.stringify(r.calls)}`);
        // Per page: its lanes' list calls, a lane probe per lane it ends, and the markers in one getMany (500 keys a statement).
        expect(r.calls.get ?? 0).toBe(0);
        expect(r.calls.read ?? 0).toBe(0);
        expect(r.total).toBeLessThan(10_000 / 20);
      }
    }, 300_000);
  });
}
