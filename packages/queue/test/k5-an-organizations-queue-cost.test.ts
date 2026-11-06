// k5 (Mod 3): a queue operation's cost and wait depend only on its own organization's jobs.
//
// Invariant: reading or changing ONE job is a point access whose cost does not grow with any other
// organization's jobs; listing an organization's jobs returns only that organization's, page by page,
// at a cost that does not grow with any other organization's; and a shared worker never makes one
// organization's ready job wait behind another organization's whole backlog.
//
// Candidate-neutral: the same file runs on every candidate. Worker options a candidate needs for its
// fairness (and only those) come from K5_WORKER_OPTS (JSON). Cost is counted in work-store PORT calls,
// which is backend-neutral (a Postgres-only row count is measured separately by the bench script).
import { AsyncLocalStorage } from 'node:async_hooks';
import { describe, it, expect, afterAll, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { InMemoryStorage, type Storage, type WorkStore } from '@gnldev/durable';
import { SqliteStorage } from '@gnldev/durable/sqlite';
import * as Q from '../src/index.js';

const q = Q as any;
const here = dirname(fileURLToPath(import.meta.url));
const PG_URL = process.env.GNL_PG_URL;
const WORKER_OPTS: Record<string, unknown> = JSON.parse(process.env.K5_WORKER_OPTS ?? '{}');
const ends: Array<() => Promise<void>> = [];
afterAll(async () => { for (const e of ends.reverse()) await e().catch(() => {}); });
// A Postgres store of its own is closed when the test that opened it ends, not when the file does. Each one fills with
// 50 appends in parallel, so its pool grows to the full 10 connections and, with its liveness session, keeps one for good:
// the 15 the file opens held 97 of the server's 100 slots at once (measured), and any other file that ran beside it in the
// shared group — three at a time — was refused with `too many clients`, this one included.
const perTest: Array<() => Promise<void>> = [];
afterEach(async () => { for (const e of perTest.splice(0).reverse()) await e().catch(() => {}); });

const fromDurable = (m: string) => createRequire(join(here, '..', '..', 'durable', 'package.json'))(m);
let pgAdmin: any;
const pgUrlOf = new WeakMap<object, string>();
async function pgStorage(): Promise<Storage> {
  const { PostgresStorage } = await import('@gnldev/durable/postgres');
  if (!pgAdmin) {
    pgAdmin = new (fromDurable('pg').Client)({ connectionString: PG_URL });
    await pgAdmin.connect();
    ends.push(async () => { await pgAdmin.end(); });
  }
  const schema = `k5_${process.pid}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`;
  await pgAdmin.query(`CREATE SCHEMA ${schema}`);
  const u = new URL(PG_URL!);
  u.searchParams.set('options', `-c search_path=${schema}`);
  const s = new PostgresStorage({ connectionString: u.toString() }) as unknown as Storage;
  await (s as any).init?.();
  pgUrlOf.set(s, u.toString());
  perTest.push(async () => { await (s as any).close?.().catch(() => {}); await pgAdmin.query(`DROP SCHEMA ${schema} CASCADE`); });
  return s;
}
type Mk = () => Promise<Storage>;
const BACKENDS: Array<[string, Mk]> = [
  ['memory', async () => new InMemoryStorage()],
  ['sqlite', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'k5-'));
    const s = new SqliteStorage(join(dir, 'q.db')) as unknown as Storage;
    await (s as any).init?.();
    ends.push(async () => { await (s as any).close?.(); rmSync(dir, { recursive: true, force: true }); });
    return s;
  }],
];
if (PG_URL) BACKENDS.push(['postgres', pgStorage]);

/** Marks the calls `fn` makes: a timer armed before it (enqueue's no-worker notice) reads the same store, and is not its cost. */
const measured = new AsyncLocalStorage<true>();
/** Counts every work-store port call `fn` makes. */
async function portCalls(work: WorkStore, fn: () => Promise<unknown>): Promise<{ calls: number; result: unknown }> {
  const saved = new Map<string, unknown>();
  let calls = 0;
  for (const m of ['list', 'get', 'put', 'append', 'ackOnce', 'putIfMatch', 'read', 'deletePrefix', 'deleteIdPrefix']) {
    const f = (work as any)[m];
    if (typeof f !== 'function') continue;
    saved.set(m, f);
    (work as any)[m] = (...a: unknown[]) => { if (measured.getStore()) calls++; return f.apply(work, a); };
  }
  try {
    const result = await measured.run(true, fn);
    return { calls, result };
  } finally {
    for (const [m, f] of saved) (work as any)[m] = f;
  }
}

/** `n` jobs of `orgId`, appended in parallel batches. */
async function fill(work: WorkStore, orgId: string, n: number): Promise<string[]> {
  const ids: string[] = [];
  for (let i = 0; i < n; i += 50) {
    ids.push(...await Promise.all(Array.from({ length: Math.min(50, n - i) }, (_, k) => q.enqueue(work, 't', { i: i + k }, { orgId }))));
  }
  return ids;
}

/** Runs `runOnce` until the queue is empty; returns the organization of each job in start order. */
async function startOrder(storage: Storage, onStart?: (ctx: any, order: string[]) => Promise<void>): Promise<string[]> {
  const order: string[] = [];
  const w = q.createWorker(storage, { t: async (_p: unknown, ctx: any) => { order.push(ctx.orgId); await onStart?.(ctx, order); } }, { ttlMs: 10_000, ...WORKER_OPTS });
  try { while (await w.runOnce()) { /* next */ } } finally { await w.close(); }
  return order;
}

for (const [name, mk] of BACKENDS) {
  describe(`k5 — an organization's queue cost (${name})`, () => {
    it('N3: cancelJob of one job costs the same with 30 or 300 jobs of another organization', async () => {
      const cost: number[] = [];
      for (const n of [30, 300]) {
        const s = await mk();
        await fill(s.work!, 'orgx', n);
        const y = await q.enqueue(s.work!, 't', {}, { orgId: 'orgy' });
        const r = await portCalls(s.work!, () => q.cancelJob(s.work!, y));
        expect(r.result).toBe(true);
        cost.push(r.calls);
      }
      expect(cost[1]).toBeLessThanOrEqual(cost[0]!);
    });

    it('N3: getJob reads one job at a cost that does not grow with another organization\'s jobs', async () => {
      const cost: number[] = [];
      for (const n of [30, 300]) {
        const s = await mk();
        await fill(s.work!, 'orgx', n);
        const y = await q.enqueue(s.work!, 't', { y: 1 }, { orgId: 'orgy' });
        const r = await portCalls(s.work!, () => q.getJob(s.work!, y));
        expect(r.result).toMatchObject({ id: y, type: 't', status: 'pending', orgId: 'orgy', attempts: 0 });
        cost.push(r.calls);
      }
      expect(cost[1]).toBeLessThanOrEqual(cost[0]!);
    });

    it('N3: listJobs({ orgId }) pages through that organization only — never another\'s job — at a cost that does not grow with other organizations', async () => {
      const cost: number[] = [];
      for (const n of [30, 300]) {
        const s = await mk();
        const ys: string[] = [];
        // Y's jobs spread through X's backlog.
        for (let k = 0; k < 12; k++) {
          await fill(s.work!, 'orgx', Math.floor(n / 12));
          ys.push(await q.enqueue(s.work!, 't', { k }, { orgId: 'orgy' }));
        }
        const seen: any[] = [];
        let cursor: string | undefined;
        let first = true;
        do {
          const r = await portCalls(s.work!, () => q.listJobs(s.work!, { orgId: 'orgy', limit: 5, ...(cursor ? { cursor } : {}) }));
          const page = r.result as { items: any[]; nextCursor?: string };
          if (first) { cost.push(r.calls); first = false; }
          seen.push(...page.items);
          cursor = page.nextCursor;
        } while (cursor);
        expect(seen.map((j) => j.id).sort()).toEqual([...ys].sort());
        expect(seen.every((j) => j.orgId === 'orgy')).toBe(true);
        const xs = (await q.listJobs(s.work!, { orgId: 'orgx', limit: 1000 })).items as any[];
        expect(xs.some((j) => j.orgId !== 'orgx')).toBe(false);
      }
      expect(cost[1]).toBeLessThanOrEqual(cost[0]!);
    });

    it('N2: one shared worker — org-Y\'s single job starts within the first 2 jobs, not behind org-X\'s 200', async () => {
      const s = await mk();
      await fill(s.work!, 'orgx', 200);
      await q.enqueue(s.work!, 't', {}, { orgId: 'orgy' });
      const order = await startOrder(s);
      expect(order.length).toBe(201);
      expect(order.indexOf('orgy') + 1).toBeLessThanOrEqual(2);
    }, 120_000);

    it('N2 (two slots): org-Y\'s job starts within the first 4, while org-X\'s 100 jobs are running', async () => {
      const s = await mk();
      await fill(s.work!, 'orgx', 100);
      await q.enqueue(s.work!, 't', {}, { orgId: 'orgy' });
      const order: string[] = [];
      const w = q.createWorker(s, { t: async (_p: unknown, ctx: any) => { order.push(ctx.orgId); await new Promise((r) => setTimeout(r, 5)); } },
        { ttlMs: 10_000, pollMs: 2, maxPollMs: 20, concurrency: 2, ...WORKER_OPTS });
      w.start();
      const until = Date.now() + 90_000;
      while (order.length < 101 && Date.now() < until) await new Promise((r) => setTimeout(r, 20));
      await w.close();
      expect(order.length).toBe(101);
      // Handler START order, not claim order: with two slots a claim decided first can start second. The
      // bound is one round of the two lanes with work for each of the two slots.
      expect(order.indexOf('orgy') + 1).toBeLessThanOrEqual(4);
    }, 120_000);

    it('sibling (imbalance 300/10/1): every organization is served once per round', async () => {
      const s = await mk();
      await fill(s.work!, 'orgx', 300);
      await fill(s.work!, 'orgy', 10);
      await fill(s.work!, 'orgz', 1);
      const order = await startOrder(s);
      expect(order.length).toBe(311);
      expect(order.indexOf('orgz') + 1).toBeLessThanOrEqual(3);
      expect(order.lastIndexOf('orgy') + 1).toBeLessThanOrEqual(30);
    }, 180_000);

    it('sibling (a producer that never stops): org-X enqueues while it runs — org-Y\'s job, enqueued meanwhile, starts within 2 more jobs', async () => {
      const s = await mk();
      await fill(s.work!, 'orgx', 40);
      let yEnqueuedAfter = -1;
      const order = await startOrder(s, async (ctx, ord) => {
        if (ctx.orgId !== 'orgx') return;
        if (ord.length <= 60) await ctx.enqueue('t', { more: true }); // org-X keeps adding to its own backlog
        if (ord.length === 5) { await q.enqueue(s.work!, 't', {}, { orgId: 'orgy' }); yEnqueuedAfter = ord.length; }
      });
      expect(yEnqueuedAfter).toBe(5);
      expect(order.indexOf('orgy') + 1 - yEnqueuedAfter).toBeLessThanOrEqual(2);
    }, 180_000);

    it('sibling (an id that does not exist): cancel/retry/move/getJob answer "no" at a cost that does not grow', async () => {
      const cost: number[] = [];
      for (const n of [30, 300]) {
        const s = await mk();
        await fill(s.work!, 'orgx', n);
        const r = await portCalls(s.work!, async () => [
          await q.cancelJob(s.work!, 'nope'),
          await q.retryJob(s.work!, 'nope'),
          await q.moveJob(s.work!, 'nope', { orgId: 'orgy' }),
          await q.getJob?.(s.work!, 'nope'),
        ]);
        expect(r.result).toEqual([false, null, null, undefined]);
        cost.push(r.calls);
      }
      expect(cost[1]).toBeLessThanOrEqual(cost[0]!);
    });

    it('sibling (erasure): an erased person\'s job is gone from getJob and listJobs; a purged organization takes new jobs and runs them', async () => {
      const s = await mk();
      const ayse = await q.enqueue(s.work!, 't', {}, { orgId: 'acme', resourceId: 'ayse' });
      const bora = await q.enqueue(s.work!, 't', {}, { orgId: 'acme', resourceId: 'bora' });
      await q.jobEraser(s).erase({ resourceId: 'ayse', orgId: 'acme' });
      expect(await q.getJob(s.work!, ayse)).toBeUndefined();
      expect(await q.cancelJob(s.work!, ayse)).toBe(false);
      expect((await q.listJobs(s.work!, { orgId: 'acme' })).items.map((j: any) => j.id)).toEqual([bora]);
      await q.jobEraser(s).eraseOrganization('acme');
      expect((await q.listJobs(s.work!, { orgId: 'acme' })).items).toEqual([]);
      const again = await q.enqueue(s.work!, 't', {}, { orgId: 'acme' });
      const order = await startOrder(s);
      expect(order).toEqual(['acme']);
      expect(await q.getJob(s.work!, again)).toMatchObject({ status: 'done', attempts: 1 });
    });

    it('sibling (one id enqueued twice at once): what getJob reports is what the worker runs', async () => {
      const s = await mk();
      const later = Date.now() + 3_600_000;
      const ids: string[] = [];
      for (let k = 0; k < 10; k++) {
        const [a, b] = await Promise.all([
          q.enqueue(s.work!, 't', { k }, { id: `dup-${k}`, orgId: 'orgy', runAt: later }),
          q.enqueue(s.work!, 't', { k }, { id: `dup-${k}`, orgId: 'orgy' }),
        ]);
        expect(a).toBe(b);
        ids.push(a);
      }
      const waits = new Map<string, boolean>();
      for (const id of ids) waits.set(id, (await q.getJob(s.work!, id)).notBefore !== undefined);
      const ran = new Set<string>();
      await q.createWorker(s, { t: async (_p: unknown, ctx: any) => { ran.add(ctx.jobId); } }, { ...WORKER_OPTS }).drain();
      expect(ids.map((id) => [id, ran.has(id)])).toEqual(ids.map((id) => [id, !waits.get(id)]));
    });

    it('sibling (drain): drain() runs every organization\'s jobs and the system\'s', async () => {
      const s = await mk();
      await fill(s.work!, 'orgx', 60);
      await fill(s.work!, 'orgy', 7);
      await q.enqueue(s.work!, 't', {});
      let ran = 0;
      const n = await q.createWorker(s, { t: async () => { ran++; } }, { ...WORKER_OPTS }).drain();
      expect([n, ran]).toEqual([68, 68]);
    }, 120_000);
  });
}

describe.skipIf(!PG_URL)('k5 — two workers on two pools (postgres)', () => {
  it('3 organizations × 40 jobs, two workers with two slots each: every handler runs exactly once and every job ends done', async () => {
    const a = await pgStorage();
    const { PostgresStorage } = await import('@gnldev/durable/postgres');
    const b = new PostgresStorage({ connectionString: pgUrlOf.get(a)! }) as unknown as Storage;
    await (b as any).init?.();
    perTest.push(async () => { await (b as any).close?.(); });
    const ids: string[] = [];
    for (const org of ['o1', 'o2', 'o3']) ids.push(...await fill(a.work!, org, 40));
    const ran = new Map<string, number>();
    const h = { t: async (_p: unknown, ctx: any) => { ran.set(ctx.jobId, (ran.get(ctx.jobId) ?? 0) + 1); await new Promise((r) => setTimeout(r, Math.random() * 3)); } };
    const ws = [a, b].map((st) => q.createWorker(st, h, { ttlMs: 5000, pollMs: 2, maxPollMs: 20, concurrency: 2, ...WORKER_OPTS }));
    for (const w of ws) w.start();
    const until = Date.now() + 90_000;
    while (ran.size < ids.length && Date.now() < until) await new Promise((r) => setTimeout(r, 20));
    await new Promise((r) => setTimeout(r, 300));
    for (const w of ws) await w.close();
    expect(ran.size).toBe(ids.length);
    expect([...ran.values()].every((v) => v === 1)).toBe(true);
    for (const org of ['o1', 'o2', 'o3']) {
      const items = (await q.listJobs(a.work!, { orgId: org, limit: 1000 })).items as any[];
      expect(items.length).toBe(40);
      expect(items.every((j) => j.status === 'done')).toBe(true);
    }
  }, 120_000);
});
