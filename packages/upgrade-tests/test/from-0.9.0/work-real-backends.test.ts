// Upgrade from 0.9.0 on a real Postgres and a real Redis: the queue and events 0.9.0 left behind (the
// same scenarios as queue.db / events.db, and as queue-erased.db / events-erased.db where 0.9.0 itself
// erased a person), loaded from `postgres-work*.sql` / `redis-work*.json` into a fresh database or key
// prefix and opened by the current stores. The work store is where the three
// backends differ (Postgres adds `seq`, `ord` and `gnl_work_seq`; Redis numbers records itself).
//
// Runs with GNL_INTEGRATION=1, against GNL_PG_URL and GNL_REDIS_URL — the variables, defaults and
// servers the repository's other real-backend tests use (CI job `integration`,
// scripts/check-real-backends.mjs). The Postgres URL must allow CREATE DATABASE.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { createRequire } from 'node:module';
import { afterEach, describe, expect, it } from 'vitest';
import { eraseSubject } from '@gnldev/durable';
import { PostgresStorage } from '@gnldev/durable/postgres';
import { RedisStorage } from '@gnldev/durable/redis';
import { createConsumer, eventEraser } from '@gnldev/events';
import { createWorker, jobEraser } from '@gnldev/queue';
import * as S from '../../generate/shapes.mjs';
import { FIXTURES_090 } from '../support.js';

const RUN = process.env.GNL_INTEGRATION === '1';
const PG_URL = process.env.GNL_PG_URL ?? 'postgres://postgres:gnl@localhost:55432/gnl';
const REDIS_URL = process.env.GNL_REDIS_URL ?? 'redis://localhost:6380';
const require = createRequire(import.meta.url);

const pad = (n: number) => String(n).padStart(3, '0');
const pendingJobs = [
  ...Array.from({ length: S.QUEUE.plainJobs - S.QUEUE.plainDoneOn090 }, (_, i) => `p${pad(S.QUEUE.plainDoneOn090 + i)}`),
  ...Array.from({ length: S.QUEUE.carolJobs }, (_, i) => `c${i}`),
].sort();
const E = S.EVENTS;
const pendingEvents = [
  ...Array.from({ length: E.pendingAfter }, (_, i) => `e${pad(E.deliveredOn090 + i)}`),
  ...Array.from({ length: E.carolPending }, (_, i) => `c${i}`),
].sort();

type Store = PostgresStorage | RedisStorage;
/** `work`: as left by 0.9.0; `work-erased`: 0.9.0 then erased ayse under its row-offset cursors. */
type Variant = 'work' | 'work-erased';
interface Loaded {
  storage: Store;
  /** Every stored string holding `needle` (rows on Postgres, keys and values on Redis). */
  containing(needle: string): Promise<string[]>;
  /** A second process on the same data. */
  reopen(): Promise<Store>;
}
const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  while (cleanups.length) await cleanups.pop()!().catch(() => undefined);
});

async function loadPostgres(variant: Variant): Promise<Loaded> {
  const pg = require('pg');
  const admin = new pg.Client({ connectionString: PG_URL });
  await admin.connect();
  const db = `gnl_upgrade_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 7)}`;
  await admin.query(`CREATE DATABASE ${db}`);
  const u = new URL(PG_URL);
  u.pathname = `/${db}`;
  const loader = new pg.Client({ connectionString: u.toString() });
  await loader.connect();
  await loader.query(readFileSync(join(FIXTURES_090, `postgres-${variant}.sql`), 'utf8'));
  await loader.end();
  const opened: Store[] = [];
  const open = async () => {
    const s = new PostgresStorage({ connectionString: u.toString() });
    await s.init();
    opened.push(s);
    return s;
  };
  cleanups.push(async () => {
    for (const s of opened) await s.close();
    await admin.query(`DROP DATABASE IF EXISTS ${db} WITH (FORCE)`);
    await admin.end();
  });
  const storage = await open();
  const containing = async (needle: string) => {
    const c = new pg.Client({ connectionString: u.toString() });
    await c.connect();
    try {
      const cols = (await c.query("SELECT table_name, column_name FROM information_schema.columns WHERE table_schema = 'public' AND data_type = 'text'")).rows as Array<{ table_name: string; column_name: string }>;
      const out: string[] = [];
      for (const { table_name: t, column_name: col } of cols) {
        const r = await c.query(`SELECT "${col}" AS v FROM "${t}" WHERE strpos("${col}", $1) > 0`, [needle]);
        for (const row of r.rows) out.push(`${t}.${col}=${String(row.v).slice(0, 120)}`);
      }
      return out;
    } finally {
      await c.end();
    }
  };
  return { storage, containing, reopen: open };
}

async function loadRedis(variant: Variant): Promise<Loaded> {
  const Redis = require('ioredis');
  const prefix = `gnlupg${Date.now().toString(36)}${Math.random().toString(36).slice(2, 7)}:`;
  const client = new Redis(REDIS_URL);
  const dump = JSON.parse(readFileSync(join(FIXTURES_090, `redis-${variant}.json`), 'utf8')) as { keys: Array<{ k: string; type: string; v: any }> };
  for (const { k, type, v } of dump.keys) {
    const key = prefix + k;
    if (type === 'string') await client.set(key, v);
    else if (type === 'hash') await client.hset(key, v);
    else if (type === 'zset') for (const [member, score] of v) await client.zadd(key, score, member);
    else if (type === 'list') await client.rpush(key, ...v);
    else if (type === 'set') await client.sadd(key, ...v);
  }
  const opened: Store[] = [];
  const open = async () => {
    const s = new RedisStorage({ connectionString: REDIS_URL, keyPrefix: prefix });
    await s.init();
    opened.push(s);
    return s;
  };
  cleanups.push(async () => {
    for (const s of opened) await s.close();
    const keys = await client.keys(`${prefix}*`);
    if (keys.length) await client.del(...keys);
    await client.quit();
  });
  const storage = await open();
  const containing = async (needle: string) => {
    const out: string[] = [];
    for (const key of await client.keys(`${prefix}*`)) {
      const type = await client.type(key);
      const v = type === 'string' ? await client.get(key) : type === 'zset' ? (await client.zrange(key, 0, -1)).join(' ') : type === 'hash' ? JSON.stringify(await client.hgetall(key)) : '';
      if (key.includes(needle) || String(v).includes(needle)) out.push(key.slice(prefix.length));
    }
    return out;
  };
  return { storage, containing, reopen: open };
}

const worker = (storage: Store, ran: string[]) =>
  createWorker(storage, { plain: async (p: { n: string }) => { ran.push(p.n); } }, { maxAttempts: 2, heartbeat: false });
const consumer = (storage: Store, seen: string[]) =>
  createConsumer(storage.work!, E.topic, async (p: { n: string }) => { seen.push(p.n); }, { name: E.consumer });

describe.skipIf(!RUN).each([
  ['Postgres', loadPostgres],
  ['Redis', loadRedis],
] as const)('upgrade from 0.9.0 — work store on a real %s', (name, loadAs) => {
  const load = () => loadAs('work');
  if (name === 'Postgres') {
    it('the current code migrates the 0.9.0 schema once, and a second open changes nothing', async () => {
      const f = await load();
      const pgStore = f.storage as PostgresStorage;
      expect(await pgStore.checkSchema()).toMatchObject({ ok: true, missingTables: [], missingColumns: [] });
      const again = (await f.reopen()) as PostgresStorage;
      expect((await again.migrateSchema()).statements).toEqual([]);
    });
  }

  it('the first drain after the upgrade runs every job 0.9.0 left pending, once', async () => {
    const f = await load();
    const ran: string[] = [];
    await worker(f.storage, ran).drain();
    expect([...ran].sort()).toEqual(pendingJobs);
    expect(await worker(await f.reopen(), ran).drain()).toBe(0);
  });

  it("erasing a person right after the upgrade skips none of anybody else's jobs, and leaves nothing of theirs", async () => {
    const f = await load();
    await eraseSubject(f.storage, 'ayse', { erasers: [jobEraser(f.storage), eventEraser(f.storage.work!)] });
    const ran: string[] = [];
    await worker(f.storage, ran).drain();
    expect([...ran].sort()).toEqual(pendingJobs);
    expect(await f.containing('~o~:ayse:')).toEqual([]);
  });

  it('the first poll after the upgrade delivers exactly the events 0.9.0 had not, once', async () => {
    const f = await load();
    const seen: string[] = [];
    await consumer(f.storage, seen).poll();
    await consumer(await f.reopen(), seen).poll();
    expect([...seen].sort()).toEqual(pendingEvents);
  });

  it("erasing a person right after the upgrade skips none of anybody else's events", async () => {
    const f = await load();
    await eraseSubject(f.storage, 'ayse', { erasers: [jobEraser(f.storage), eventEraser(f.storage.work!)] });
    const seen: string[] = [];
    await consumer(f.storage, seen).poll();
    expect([...seen].sort()).toEqual(pendingEvents);
  });

  it('a queue 0.9.0 itself erased a person from: the first drain runs every job that was pending, once', async () => {
    const f = await loadAs('work-erased');
    const ran: string[] = [];
    await worker(f.storage, ran).drain();
    expect([...ran].sort()).toEqual(pendingJobs);
    expect(await worker(await f.reopen(), ran).drain()).toBe(0);
  });

  it('a topic 0.9.0 itself erased a person from: the first poll delivers every undelivered event, once', async () => {
    const f = await loadAs('work-erased');
    const seen: string[] = [];
    await consumer(f.storage, seen).poll();
    await consumer(await f.reopen(), seen).poll();
    expect([...seen].sort()).toEqual(pendingEvents);
  });
});
