// WorkStore.list cursors — a position that deletions and producer clocks cannot move.
//
// @gnldev/queue (`qcursor`) and @gnldev/events (`evtcursor:*`) PERSIST the cursor `list` hands back and
// resume from it on every poll, in every process. So the cursor is not a paging convenience: it is the
// line "everything before this has been handled". Measured before this file existed:
//   · the cursor was a row OFFSET into `ORDER BY ts, id`. `eraseSubject` deleting 300 of one person's
//     jobs moved every other person's rows 300 places to the left, under a cursor that did not move —
//     their pending jobs never ran and their events were never delivered (in-memory and SQLite);
//   · `ts` is the PRODUCER's `Date.now()`. A producer 5s behind had its row sorted before the cursor on
//     SQLite/Postgres/Redis, so it was never seen at all.
// The same contract runs against every bundled adapter (and a live Postgres/Redis under GNL_INTEGRATION=1).
import { describe, it, expect, vi, afterEach, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRequire } from 'node:module';
import { newDb } from 'pg-mem';
import { InMemoryStorage, RedisStorage } from '../src/index.js';
import { SqliteStorage } from '../src/sqlite-storage.js';
import { PostgresStorage } from '../src/postgres-storage.js';
import { makeFakeRedis } from './fake-redis.js';
import type { WorkStore, Storage } from '../src/index.js';

const { DatabaseSync } = createRequire(import.meta.url)('node:sqlite') as { DatabaseSync: new (path: string) => any };

const RUN = process.env.GNL_INTEGRATION === '1';
const PG_URL = process.env.GNL_PG_URL ?? 'postgres://postgres:gnl@localhost:55432/gnl';
const REDIS_URL = process.env.GNL_REDIS_URL ?? 'redis://localhost:6380';
const SEED = `wc${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;

afterEach(() => vi.restoreAllMocks());

type Make = () => Promise<Storage> | Storage;
const backends: Array<[string, Make]> = [
  ['in-memory', () => new InMemoryStorage()],
  ['sqlite', () => new SqliteStorage(':memory:')],
  ['postgres (pg-mem)', () => { const { Pool } = newDb().adapters.createPg(); return new PostgresStorage({ pool: new Pool() }); }],
  ['redis (fake)', () => new RedisStorage({ client: makeFakeRedis() as never })],
];

let ns = 0;
/** A fresh namespace per test, so the live backends can share one database. */
const freshNs = () => `${SEED}:log${ns++}`;

/** Reads like the queue and the events consumer do: persist `nextCursor` only after a FULL page. */
async function readFrom(work: WorkStore, logNs: string, cursor: string | undefined, limit = 50) {
  const ids: string[] = [];
  let persisted = cursor;
  let c = cursor;
  for (;;) {
    const page = await work.list<{ v: number }>(logNs, { cursor: c, limit });
    ids.push(...page.items.map((r) => r.id));
    if (!page.nextCursor) return { ids, persisted };
    c = page.nextCursor;
    persisted = c;
  }
}

async function append(work: WorkStore, logNs: string, ids: string[]) {
  for (const id of ids) await work.append(logNs, { v: 1 }, id);
}
const range = (p: string, n: number, from = 0) => Array.from({ length: n }, (_, i) => `${p}${String(i + from).padStart(4, '0')}`);

function contract(name: string, make: Make) {
  describe(`WorkStore.list cursor — ${name}`, () => {
    it('erasing records BEHIND a persisted cursor does not move it: every later record is seen', async () => {
      const w = (await make()).work!;
      const n = freshNs();
      await append(w, n, range('ayse-', 120));
      const first = await readFrom(w, n, undefined);
      expect(first.ids).toHaveLength(120);
      expect(await w.deleteIdPrefix!('ayse-')).toBe(120);
      await append(w, n, range('carol-', 10));
      expect((await readFrom(w, n, first.persisted)).ids).toEqual(range('carol-', 10));
    });

    it('SIBLING — deleting records in the MIDDLE (interleaved owners) neither skips nor repeats the survivors after the cursor', async () => {
      const w = (await make()).work!;
      const n = freshNs();
      const all: string[] = [];
      for (let i = 0; i < 150; i++) all.push(i % 2 === 0 ? `ayse-${String(i).padStart(4, '0')}` : `carol-${String(i).padStart(4, '0')}`);
      await append(w, n, all);
      // Two full pages seen and persisted; the third is not.
      const p1 = await w.list(n, { limit: 50 });
      const p2 = await w.list(n, { limit: 50, cursor: p1.nextCursor });
      const persisted = p2.nextCursor!;
      await w.deleteIdPrefix!('ayse-');
      const expected = all.slice(100).filter((id) => id.startsWith('carol-'));
      expect((await readFrom(w, n, persisted)).ids).toEqual(expected);
    });

    it('SIBLING — deleting EVERY record of the log and writing again: the new records land after the old cursor', async () => {
      const w = (await make()).work!;
      const n = freshNs();
      await append(w, n, range('x-', 60));
      const { persisted } = await readFrom(w, n, undefined);
      await w.deleteIdPrefix!('x-');
      await append(w, n, range('y-', 5));
      expect((await readFrom(w, n, persisted)).ids).toEqual(range('y-', 5));
    });

    it('a producer whose clock is 5s BEHIND still lands after the cursor, exactly once', async () => {
      const w = (await make()).work!;
      const n = freshNs();
      await append(w, n, range('a-', 60));
      const { persisted } = await readFrom(w, n, undefined);
      const real = Date.now.bind(Date);
      vi.spyOn(Date, 'now').mockImplementation(() => real() - 5_000);
      await w.append(n, { v: 1 }, 'late-clock');
      vi.restoreAllMocks();
      const after = (await readFrom(w, n, persisted)).ids;
      expect(after.filter((id) => id === 'late-clock')).toHaveLength(1);
      expect(after).toEqual([...range('a-', 10, 50), 'late-clock']);
    });

    it('SIBLING — four producers with skewed clocks, interleaved with a paging reader: every record is seen', async () => {
      const w = (await make()).work!;
      const n = freshNs();
      const skew = [-3_000, 0, 2_000, -1_000];
      const real = Date.now.bind(Date);
      let producer = 0;
      vi.spyOn(Date, 'now').mockImplementation(() => real() + skew[producer]!);
      const seen = new Set<string>();
      let cursor: string | undefined;
      const written: string[] = [];
      for (let i = 0; i < 200; i++) {
        producer = i % 4;
        const id = `p${producer}-${String(i).padStart(4, '0')}`;
        await w.append(n, { v: i }, id);
        written.push(id);
        if (i % 9 === 0) {
          const r = await readFrom(w, n, cursor, 7);
          r.ids.forEach((x) => seen.add(x));
          cursor = r.persisted;
        }
      }
      vi.restoreAllMocks();
      (await readFrom(w, n, cursor, 7)).ids.forEach((x) => seen.add(x));
      expect(written.filter((id) => !seen.has(id))).toEqual([]);
    });

    it('SIBLING — a worker restart between steps: a cursor read back from the KV store resumes at the same record', async () => {
      const s = await make();
      const w = s.work!;
      const n = freshNs();
      await append(w, n, range('r-', 75));
      const { persisted } = await readFrom(w, n, undefined);
      await w.put(`${n}:cursor`, persisted); // the queue/events way of keeping it across processes
      await w.deleteIdPrefix!('r-000'); // r-0000..r-0009 erased while "down"
      await append(w, n, range('s-', 3));
      const resumed = await w.get<string>(`${n}:cursor`);
      expect((await readFrom(w, n, resumed)).ids).toEqual([...range('r-', 25, 50), ...range('s-', 3)]);
    });

    it('paging with a small limit returns every record once, in append order', async () => {
      const w = (await make()).work!;
      const n = freshNs();
      await append(w, n, range('k-', 50));
      expect((await readFrom(w, n, undefined, 7)).ids).toEqual(range('k-', 50));
    });

    it('UPGRADE — a cursor this store did not issue (a 0.9 row offset) restarts at the head instead of skipping', async () => {
      const w = (await make()).work!;
      const n = freshNs();
      await append(w, n, range('u-', 60));
      expect((await readFrom(w, n, '50')).ids).toEqual(range('u-', 60));
    });
  });
}

for (const [name, make] of backends) contract(name, make);

describe.skipIf(!RUN)('WorkStore.list cursor — live backends', () => {
  const pools: PostgresStorage[] = [];
  const redisClients: Array<{ quit(): Promise<unknown> }> = [];
  beforeAll(async () => {
    const probe = new PostgresStorage({ connectionString: PG_URL });
    for (let i = 0; ; i++) {
      try { await probe.init(); break; } catch (e) { if (i >= 20) throw e; await new Promise((r) => setTimeout(r, 500)); }
    }
    pools.push(probe);
  }, 30_000);
  afterAll(async () => {
    for (const p of pools) await p.close();
    for (const c of redisClients) await c.quit();
  });
  const pg = () => { const s = new PostgresStorage({ connectionString: PG_URL }); pools.push(s); return s; };
  const redis = async () => {
    const { default: Redis } = await import('ioredis');
    const client = new Redis(REDIS_URL, { maxRetriesPerRequest: 2 });
    redisClients.push(client);
    return new RedisStorage({ client: client as never, keyPrefix: `${SEED}:` });
  };
  contract('postgres (live)', pg);
  contract('redis (live)', redis);

  for (const [name, make] of [['postgres (live)', pg], ['redis (live)', redis]] as const) {
    it(`${name}: 8 concurrent producers on separate connections vs a reader persisting cursors — nothing is passed over`, async () => {
      const producers = await Promise.all(Array.from({ length: 4 }, () => make()));
      const reader = (await make()).work!;
      const n = freshNs();
      const written: string[] = [];
      let done = false;
      const seen = new Set<string>();
      const readLoop = (async () => {
        let cursor: string | undefined;
        while (!done) {
          const r = await readFrom(reader, n, cursor, 10);
          r.ids.forEach((x) => seen.add(x));
          cursor = r.persisted;
        }
        const r = await readFrom(reader, n, cursor, 10);
        r.ids.forEach((x) => seen.add(x));
      })();
      await Promise.all(Array.from({ length: 8 }, async (_, p) => {
        const w = producers[p % producers.length]!.work!;
        for (let i = 0; i < 100; i++) {
          const id = `c${p}-${String(i).padStart(4, '0')}`;
          await w.append(n, { v: i }, id);
          written.push(id);
        }
      }));
      done = true;
      await readLoop;
      expect(written.filter((id) => !seen.has(id))).toEqual([]);
    }, 60_000);
  }
});

describe('UPGRADE — a SQLite database written by 0.9 (no `seq` column, rows ordered by the producer clock)', () => {
  // Rows written before sequences are numbered by the first read in the order they were INSERTED
  // (`rowid`), which is 0.9's `(ts, id)` order except where producer clocks disagreed — the case that
  // order got wrong. Every row is read exactly once, and a new one after all of them.
  it('opens, keeps every row readable once (in insertion order), and appends after them', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'gnl-wlog-'));
    const file = join(dir, 'old.db');
    try {
      const old = new DatabaseSync(file);
      old.exec(`CREATE TABLE gnl_work_log (ns TEXT NOT NULL, id TEXT NOT NULL, payload TEXT NOT NULL, ts INTEGER NOT NULL, PRIMARY KEY (ns, id));
        CREATE INDEX gnl_work_log_ns ON gnl_work_log (ns, ts);`);
      const ins = old.prepare('INSERT INTO gnl_work_log (ns, id, payload, ts) VALUES (?, ?, ?, ?)');
      // Inserted out of clock order on purpose: the 0.9 order is (ts, id), not insertion.
      for (let i = 59; i >= 0; i--) ins.run('qjob', `old-${String(i).padStart(4, '0')}`, JSON.stringify({ json: { v: i } }), 1_000 + i);
      old.close();

      const s = new SqliteStorage(file);
      const inserted = range('old-', 60).reverse();
      expect((await readFrom(s.work, 'qjob', undefined, 7)).ids).toEqual(inserted);
      const { persisted } = await readFrom(s.work, 'qjob', undefined);
      await s.work.append('qjob', { v: 1 }, 'new-0000');
      expect((await readFrom(s.work, 'qjob', persisted)).ids).toEqual([...inserted.slice(50), 'new-0000']);
      expect((await s.checkSchema()).ok).toBe(true);
      await s.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

/** A 0.9 `gnl_work_log` (no `seq`), rows inserted out of clock order, then opened by this version. */
async function pgUpgrade(pool: { query(sql: string, p?: unknown[]): Promise<unknown> }, open: () => PostgresStorage) {
  await pool.query(`CREATE TABLE gnl_work_log (ns TEXT NOT NULL, id TEXT NOT NULL, payload TEXT NOT NULL, ts BIGINT NOT NULL, PRIMARY KEY (ns, id))`);
  for (let i = 59; i >= 0; i--) {
    await pool.query('INSERT INTO gnl_work_log (ns, id, payload, ts) VALUES ($1, $2, $3, $4)', ['qjob', `old-${String(i).padStart(4, '0')}`, JSON.stringify({ json: { v: i } }), 1_000 + i]);
  }
  const s = open();
  await s.init();
  expect((await readFrom(s.work, 'qjob', undefined, 7)).ids).toEqual(range('old-', 60));
  const { persisted } = await readFrom(s.work, 'qjob', undefined);
  await s.work.append('qjob', { v: 1 }, 'new-0000');
  expect((await readFrom(s.work, 'qjob', persisted)).ids).toEqual([...range('old-', 10, 50), 'new-0000']);
  return s;
}

describe('UPGRADE — a Postgres database written by 0.9', () => {
  it('pg-mem: opens, keeps every row readable in the old order, and appends after them', async () => {
    // pg-mem refuses `CREATE TABLE IF NOT EXISTS` over a table that already exists (it reports the
    // skipped column list as "unread AST"); real Postgres does not. The coverage check is a pg-mem
    // self-test, not a Postgres rule, so it is switched off for this one database.
    const { Pool } = newDb({ noAstCoverageCheck: true }).adapters.createPg();
    const pool = new Pool();
    await pgUpgrade(pool, () => new PostgresStorage({ pool }));
  });

  it.skipIf(!RUN)('live: the same, on a database of its own', async () => {
    const { Pool } = await import('pg');
    const admin = new Pool({ connectionString: PG_URL });
    const name = `gnl_upg_${SEED}`.toLowerCase();
    await admin.query(`CREATE DATABASE ${name}`);
    const url = new URL(PG_URL);
    url.pathname = `/${name}`;
    const pool = new Pool({ connectionString: url.toString() });
    try {
      const s = await pgUpgrade(pool, () => new PostgresStorage({ pool }));
      expect((await s.checkSchema()).ok).toBe(true);
    } finally {
      await pool.end();
      await admin.query(`DROP DATABASE ${name}`);
      await admin.end();
    }
  }, 60_000);
});

describe('SIBLING — adoptIntoOrg moves a log into an organization that already has one', () => {
  // Every bundled store. The first cut covered SQLite and pg-mem only; measured then: the in-memory
  // store REPLACED the organization's log with the moved one (60 records gone, 5 behind the cursor),
  // and Redis did not move `wl:` logs at all — the organization's reader never saw the adopted records.
  const all: Array<[string, () => Storage]> = [
    ['in-memory', () => new InMemoryStorage()],
    ['sqlite', () => new SqliteStorage(':memory:')],
    ['postgres (pg-mem)', () => { const { Pool } = newDb().adapters.createPg(); return new PostgresStorage({ pool: new Pool() }); }],
    ['redis (fake)', () => new RedisStorage({ client: makeFakeRedis() as never })],
  ];
  it.each(all)('%s: the moved records land after the organization\'s persisted cursor, and its own records survive', async (_name, make) => {
    const s = make();
    await append(s.work!, 'evt:t', range('root-', 5));
    await append(s.work!, 'org:acme:evt:t', range('org-', 60));
    const { persisted } = await readFrom(s.work!, 'org:acme:evt:t', undefined);
    await s.adoptIntoOrg!('acme', { allowUnregistered: true });
    expect((await readFrom(s.work!, 'org:acme:evt:t', persisted)).ids).toEqual([...range('org-', 10, 50), ...range('root-', 5)]);
    expect((await readFrom(s.work!, 'org:acme:evt:t', undefined)).ids).toHaveLength(65);
    expect((await readFrom(s.work!, 'evt:t', undefined)).ids).toEqual([]);
    await s.work!.append('org:acme:evt:t', { v: 1 }, 'after');
    expect((await readFrom(s.work!, 'org:acme:evt:t', persisted)).ids.at(-1)).toBe('after');
  });
  it.each(all)('%s: SIBLING — the organization\'s log was erased (its numbers are spent, no record left): the moved records still land after the cursor', async (_name, make) => {
    const s = make();
    await append(s.work!, 'org:acme:evt:t', range('old-', 60));
    const { persisted } = await readFrom(s.work!, 'org:acme:evt:t', undefined);
    await s.work!.deletePrefix!('org:acme:evt:t');
    await append(s.work!, 'evt:t', range('root-', 5));
    await s.adoptIntoOrg!('acme', { allowUnregistered: true });
    expect((await readFrom(s.work!, 'org:acme:evt:t', persisted)).ids).toEqual(range('root-', 5));
  });
  it.each(all)('%s: SIBLING — a log with no organization counterpart moves whole, in its order', async (_name, make) => {
    const s = make();
    await append(s.work!, 'qjob', range('j-', 70));
    await s.adoptIntoOrg!('acme', { allowUnregistered: true });
    expect((await readFrom(s.work!, 'org:acme:qjob', undefined, 9)).ids).toEqual(range('j-', 70));
  });
});
