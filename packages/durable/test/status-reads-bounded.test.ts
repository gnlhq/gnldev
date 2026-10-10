// C+ step A — status reads that do not read the whole store.
//
// Measured on the 1M-run store (1 000 020 runs, 167 suspended, acme 100 008): the approval inbox read
// every run to find the suspended ones (23.3 s), the strict usage total read every run to price the
// unfinished ones and count the rest (acme 17 s, root 18 s), and Studio's live updates re-read every
// run each tick (22.8 s). Three capabilities answer those questions without the listing:
//   - `listRunsPaged({ statuses })`  — the runs that are not 'completed', from a partial index
//   - `countRuns({ runIdPrefix })`   — how many runs, counted by the engine
//   - `listRunsChangedSince(cursor)` — the runs that changed, by `updated_at`
// Each is held here to the answer the full listing gives (equivalence) and to reading only what it
// answers about (bounded), on every adapter: InMemory, Sqlite, pg-mem, and real Postgres when
// GNL_PG_URL is set.
import { describe, it, expect, afterAll } from 'vitest';
import { newDb } from 'pg-mem';
import {
  InMemoryStorage, InMemoryJournal, toJournal, withOrg, withRootScope, withSubjectJournal, listRunsArray,
  getOrgUsage, recordRunUsage, type Journal, type JournalReader, type RunSummary, type RunChange,
} from '../src/index.js';
import { SqliteStorage } from '../src/sqlite-storage.js';
import { PostgresStorage } from '../src/postgres-storage.js';
import { OPEN_RUN_STATUSES } from '../src/run-cursor.js';

type J = Journal & JournalReader;
const ends: (() => Promise<void>)[] = [];
afterAll(async () => { for (const e of ends) await e(); });

const BACKENDS: [string, () => Promise<J>][] = [
  ['InMemoryJournal', async () => new InMemoryJournal() as unknown as J],
  ['InMemoryStorage', async () => toJournal(new InMemoryStorage())],
  ['SqliteStorage', async () => toJournal(new SqliteStorage(':memory:'))],
  ['PostgresStorage (pg-mem)', async () => toJournal(new PostgresStorage({ pool: new (newDb().adapters.createPg().Pool)() }))],
];
if (process.env.GNL_PG_URL) {
  BACKENDS.push(['PostgresStorage (real)', async () => {
    const pg = (await import('pg')).default;
    const admin = new pg.Client({ connectionString: process.env.GNL_PG_URL }); await admin.connect();
    const db = `cpa_t_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`;
    await admin.query(`CREATE DATABASE ${db}`);
    const url = new URL(process.env.GNL_PG_URL!); url.pathname = `/${db}`;
    const s = new PostgresStorage({ connectionString: url.toString() });
    ends.push(async () => { await s.close(); await admin.query(`DROP DATABASE IF EXISTS ${db}`); await admin.end(); });
    return toJournal(s);
  }]);
}

const tick = () => new Promise((r) => setTimeout(r, 3)); // updated_at is in ms: let two writes differ
const model = (tokens: number) => ({ usage: { inputTokens: tokens / 2, outputTokens: tokens / 2, totalTokens: tokens }, response: { modelId: 'gpt-4o' } });

/** One run in the status asked for, with a priced model step. `id` carries any org prefix. */
async function seedRun(j: J, id: string, status: 'completed' | 'suspended' | 'failed' | 'running' | 'canceled', tokens: number) {
  await j.put(`${id}:model:0`, model(tokens));
  if (status === 'suspended' || status === 'canceled') await j.put(`${id}:tool:t1`, { status: 'suspended', output: { __gnl_suspend: { toolCallId: 't1', toolName: 'pay', reason: 'approve' } } });
  if (status === 'failed' || status === 'running' || status === 'canceled') await j.put(`${id}:outcome`, { status, at: 1 });
}

/**
 * A mixed store: three scopes, every status, a counter that covers some completed runs but not others
 * (runs written before the counter existed), and a counted run that was purged afterwards — so
 * `counter.runs + open runs` is NOT the run count, and only an exact count can stay exact.
 */
async function mixedStore(j: J) {
  const plan: [string, number, number][] = [['', 24, 1], ['org:acme:', 18, 2], ['org:globex:', 6, 3]];
  const statuses = ['suspended', 'failed', 'running', 'canceled'] as const;
  for (const [p, completed, mult] of plan) {
    for (let i = 0; i < completed; i++) await seedRun(j, `${p}done-${String(i).padStart(2, '0')}`, 'completed', 10 * mult + i);
    for (const [k, st] of statuses.entries()) if (p !== 'org:globex:' || st === 'suspended') await seedRun(j, `${p}open-${st}`, st, 7 * mult + k);
  }
  // The counter: about half of each scope's completed runs recorded usage; the rest are legacy.
  for (const [p, completed] of plan) {
    const view = (p ? withOrg(j, p.split(':')[1]!) : j) as J;
    for (let i = 0; i < completed; i += 2) await recordRunUsage(view, `done-${String(i).padStart(2, '0')}`);
    // Counted, then purged: the counter keeps it, the store does not.
    await seedRun(j, `${p}gone`, 'completed', 5);
    await recordRunUsage(view, 'gone');
    await j.deletePrefix!(`${p}gone:`);
  }
}

/** The same journal with one capability removed — the reader a journal written before it would be. */
function without<T extends object>(j: T, ...names: string[]): T {
  return new Proxy(j, {
    get: (t, p) => {
      if (names.includes(p as string)) return undefined;
      const v = Reflect.get(t, p, t);
      return typeof v === 'function' ? v.bind(t) : v;
    },
    has: (t, p) => !names.includes(p as string) && Reflect.has(t, p),
  });
}

/** Counts every run summary the journal HANDS OUT through its listing methods — what a caller reads. */
function counting(j: J) {
  const read = { listed: 0, listRunsCalls: 0, pages: 0 };
  const proxy = new Proxy(j, {
    get(t, p) {
      const v = Reflect.get(t, p, t);
      if (typeof v !== 'function') return v;
      if (p === 'listRuns') return async (...a: unknown[]) => { read.listRunsCalls++; const r: any = await v.apply(t, a); read.listed += Array.isArray(r) ? r.length : r.items.length; return r; };
      if (p === 'listRunsPaged') return async (...a: unknown[]) => { read.pages++; const r: any = await v.apply(t, a); read.listed += r.items.length; return r; };
      return v.bind(t);
    },
  }) as J;
  return { proxy, read };
}

const open = (rs: RunSummary[]) => rs.filter((r) => r.status !== 'completed');

describe.each(BACKENDS)('status reads — %s', (_name, make) => {
  it('listRunsPaged({ statuses }) hands out exactly the runs that are not completed, in listing order — raw, an organization, the root scope', async () => {
    const j = await make();
    await mixedStore(j);
    for (const view of [j, withOrg(j, 'acme') as J, withOrg(j, 'globex') as J, withRootScope(j)]) {
      const all = await listRunsArray(view);
      const paged: RunSummary[] = [];
      let cursor: string | undefined;
      do {
        const p = await view.listRunsPaged!({ statuses: OPEN_RUN_STATUSES, limit: 2, ...(cursor ? { cursor } : {}) });
        paged.push(...p.items);
        cursor = p.nextCursor;
      } while (cursor);
      expect(paged).toEqual(open(all));
      for (const st of OPEN_RUN_STATUSES) {
        expect((await view.listRunsPaged!({ status: st, limit: 50 })).items).toEqual(all.filter((r) => r.status === st));
      }
      // Not a superset: 'completed' is a status the set leaves out, and a set of one is that status.
      expect((await view.listRunsPaged!({ statuses: ['completed'], limit: 500 })).items).toEqual(all.filter((r) => r.status === 'completed'));
      expect((await view.listRunsPaged!({ statuses: [], limit: 500 })).items).toEqual([]);
    }
  });

  it('countRuns counts the rows listRuns returns — raw, an organization, the root scope — and a person\'s view withholds it', async () => {
    const j = await make();
    await mixedStore(j);
    for (const view of [j, withOrg(j, 'acme') as J, withOrg(j, 'globex') as J, withRootScope(j)]) {
      expect(await view.countRuns!()).toBe((await listRunsArray(view)).length);
    }
    expect(await j.countRuns!({ runIdPrefix: 'org:' })).toBe((await listRunsArray(j)).filter((r) => r.runId.startsWith('org:')).length);
    expect(await withRootScope(j).countRuns!({ runIdPrefix: 'org:acme:' })).toBe(0);
    const person = withSubjectJournal(j, 'ayse');
    expect(person.countRuns).toBeUndefined();
    expect(person.listRunsChangedSince).toBeUndefined();
  });

  it('strict usage gives the answer the full listing gave, for every scope — incl. legacy runs the counter never saw and a purged run it still holds', async () => {
    const j = await make();
    await mixedStore(j);
    for (const [org, view] of [['acme', j], ['globex', j], [undefined, j], [undefined, withRootScope(j)]] as const) {
      const now = await getOrgUsage(view, org);
      // The reader a journal without `countRuns` is: getOrgUsage lists every run, as it always did.
      const before = await getOrgUsage(without(view, 'countRuns'), org);
      expect(now).toEqual(before);
      expect(now.costUsd).toBeGreaterThan(0);
      // Why the count is a COUNT: the counter's own run total plus the open runs is a different number.
      const counter = await getOrgUsage(view, org, undefined, false);
      const opened = open(await listRunsArray((org ? withOrg(view, org) : view) as J)).length;
      expect(counter.runs + opened).not.toBe(now.runs);
    }
  });

  it('strict usage reads the open runs only, never the whole listing', async () => {
    const j = await make();
    await mixedStore(j);
    for (const org of ['acme', 'globex', undefined]) {
      const { proxy, read } = counting(j);
      await getOrgUsage(proxy, org);
      const scope = org ? withOrg(j, org) as J : j;
      const all = await listRunsArray(scope);
      expect(read.listRunsCalls, 'the whole-store listing was read').toBe(0);
      expect(read.listed).toBe(open(all).length);
      expect(read.listed).toBeLessThan(all.length / 2);
    }
  });

  it('listRunsChangedSince: every run once, in (updated_at, run_id) order; a step on an OLD run and a status flip come back; since and the scopes hold', async () => {
    const j = await make();
    await mixedStore(j);
    const walk = async (view: J, cursor?: string, opts?: { since?: number }) => {
      const out: RunChange[] = [];
      let c = cursor;
      let last = cursor;
      for (;;) {
        const p = await view.listRunsChangedSince!(c, { limit: 5, ...(c ? {} : opts) });
        out.push(...p.items);
        if (p.nextCursor) last = p.nextCursor;
        if (p.items.length < 5) return { out, last };
        c = p.nextCursor;
      }
    };
    for (const view of [j, withOrg(j, 'acme') as J, withRootScope(j)]) {
      const { out } = await walk(view);
      const ids = out.map((r) => r.runId);
      expect(new Set(ids).size).toBe(ids.length);
      expect([...ids].sort()).toEqual((await listRunsArray(view)).map((r) => r.runId).sort());
      for (let i = 1; i < out.length; i++) {
        const [a, b] = [out[i - 1]!, out[i]!];
        expect(a.updatedAt < b.updatedAt || (a.updatedAt === b.updatedAt && a.runId !== b.runId)).toBe(true);
      }
    }
    const { last: head } = await walk(j);
    await tick();
    // An OLD run gains a step; another run's approval is decided (suspended → completed).
    const t0 = Date.now();
    await j.put('done-03:model:1', model(4));
    await tick();
    await j.put('open-suspended:tool:t1', { status: 'succeeded', output: { ok: true } });
    await j.put('org:globex:done-01:model:1', model(4));
    const after = (await walk(j, head)).out;
    expect(after.map((r) => r.runId)).toEqual(['done-03', 'open-suspended', 'org:globex:done-01']);
    expect(after.find((r) => r.runId === 'done-03')!.modelSteps).toBe(2);
    expect(after.find((r) => r.runId === 'open-suspended')!.status).toBe('completed');
    for (const r of (await walk(j, undefined, { since: t0 })).out) expect(r.updatedAt).toBeGreaterThanOrEqual(t0);
    // The scopes: acme sees none of it, the root view sees the root's two and not globex's.
    expect((await walk(withOrg(j, 'acme') as J, undefined, { since: t0 })).out).toEqual([]);
    const globex = (await walk(withOrg(j, 'globex') as J, undefined, { since: t0 })).out;
    expect(globex.map((r) => r.runId)).toEqual(['done-01']);
    expect((await walk(withRootScope(j), undefined, { since: t0 })).out.map((r) => r.runId)).toEqual(['done-03', 'open-suspended']);
  });
});

describe('the change feed refuses a cursor it never issued', () => {
  it('a run-list cursor or a row number is not a position', async () => {
    const j = new InMemoryJournal();
    await expect(j.listRunsChangedSince('r1:5:1:1:a')).rejects.toThrow(/not a change-feed cursor/);
    await expect(j.listRunsChangedSince('40')).rejects.toThrow(/not a change-feed cursor/);
  });
});

/**
 * The index is what makes the open-status reads cheap, and only if the planner can prove a status
 * filter implies its predicate. Proven on the SQL the adapter actually sends: the statement is
 * captured from the adapter's own `listRuns`, then asked for its plan.
 */
describe('gnl_runs_open / gnl_runs_status serve every open-status read', () => {
  // One status reads `gnl_runs_status` (status, created_at, run_id); the set of every open status reads
  // `gnl_runs_open` (created_at, run_id) — see the Postgres DDL for why there are two (C+ A2).
  const indexFor = (q: Record<string, unknown>) => (q.status ? 'gnl_runs_status' : 'gnl_runs_open');
  const OPEN_READS: Record<string, unknown>[] = [
    { status: 'suspended' }, { status: 'canceled' }, { status: 'failed' }, { status: 'running' },
    { statuses: OPEN_RUN_STATUSES },
  ];
  // Not held here: an organization's open read (`runIdPrefix` too). Both indexes bound it, and the
  // planner picks by size — on these few rows the run id range is the smaller one; on the 1M store
  // (acme 100 008 runs) Postgres chose gnl_runs_open (0.2 ms, cplus-audit explain).

  const cursorOf = async (runs: any, q: Record<string, unknown>) => (await runs.listRuns({ ...q, limit: 1 })).nextCursor as string | undefined;

  it('Sqlite: the plan of each read names the index — first page and a cursor page; a completed read does not', async () => {
    const s = new SqliteStorage(':memory:');
    const db = (s as unknown as { db: { prepare: (sql: string) => any } }).db;
    for (let i = 0; i < 300; i++) await s.runs.put(`r${i}:model:0`, model(2));
    for (const [i, st] of ['suspended', 'failed', 'running', 'canceled'].entries()) await seedRun(toJournal(s), `o${i}`, st as never, 2);
    await seedRun(toJournal(s), 'org:acme:o9', 'suspended', 2);
    await seedRun(toJournal(s), 'org:acme:o8', 'suspended', 2);
    const plans = async (q: Record<string, unknown>) => {
      const seen: { sql: string; args: unknown[] }[] = [];
      const prepare = db.prepare.bind(db);
      db.prepare = (sql: string) => {
        const st = prepare(sql);
        if (!/FROM gnl_runs r/.test(sql)) return st;
        return new Proxy(st, { get: (t, p) => (p === 'all' ? (...args: unknown[]) => { seen.push({ sql, args }); return t.all(...args); } : typeof t[p] === 'function' ? t[p].bind(t) : t[p]) });
      };
      try {
        const cursor = await cursorOf(s.runs, q);
        await s.runs.listRuns({ ...q, limit: 1, ...(cursor ? { cursor } : {}) });
      } finally { db.prepare = prepare; }
      return seen.map(({ sql, args }) => prepare(`EXPLAIN QUERY PLAN ${sql}`).all(...args).map((x: any) => x.detail).join(' | '));
    };
    for (const q of OPEN_READS) {
      const ps = await plans(q);
      expect(ps.length, JSON.stringify(q)).toBeGreaterThanOrEqual(2);
      for (const p of ps) expect(p, JSON.stringify(q)).toMatch(new RegExp(`USING (COVERING )?INDEX ${indexFor(q)}\\b`));
    }
    for (const p of await plans({ status: 'completed' })) expect(p).not.toMatch(/gnl_runs_open|gnl_runs_status/);
    // The schema step sees it: dropped, it is reported missing and put back.
    (s as unknown as { db: { exec: (sql: string) => void } }).db.exec('DROP INDEX gnl_runs_open');
    expect((await s.checkSchema()).missingIndexes).toEqual(['gnl_runs_open']);
    await s.upgrade({ only: ['schema'] });
    expect((await s.checkSchema()).ok).toBe(true);
  });

  it.skipIf(!process.env.GNL_PG_URL)('Postgres (real): the plan of each read names the index, before and after ANALYZE; the schema step builds it CONCURRENTLY', async () => {
    const pg = (await import('pg')).default;
    const admin = new pg.Client({ connectionString: process.env.GNL_PG_URL }); await admin.connect();
    const dbName = `cpa_t_plan_${Date.now().toString(36)}`;
    await admin.query(`CREATE DATABASE ${dbName}`);
    const url = new URL(process.env.GNL_PG_URL!); url.pathname = `/${dbName}`;
    const pool = new pg.Pool({ connectionString: url.toString(), max: 2 });
    const s = new PostgresStorage({ pool });
    try {
      await s.init();
      await pool.query(`INSERT INTO gnl_runs (run_id, status, created_at, updated_at) SELECT 'r' || g, 'completed', g, g FROM generate_series(1, 20000) g`);
      for (const [i, st] of ['suspended', 'failed', 'running', 'canceled'].entries()) await seedRun(toJournal(s), `o${i}`, st as never, 2);
      await seedRun(toJournal(s), 'org:acme:o9', 'suspended', 2);
      await seedRun(toJournal(s), 'org:acme:o8', 'suspended', 2);
      const plans = async (q: Record<string, unknown>) => {
        const seen: { sql: string; params: unknown[] }[] = [];
        const query = pool.query.bind(pool) as (sql: string, params?: unknown[]) => Promise<any>;
        (pool as any).query = (sql: string, params?: unknown[]) => { if (/FROM gnl_runs r/.test(sql)) seen.push({ sql, params: params ?? [] }); return query(sql, params); };
        try {
          const cursor = await cursorOf(s.runs, q);
          await s.runs.listRuns({ ...q, limit: 1, ...(cursor ? { cursor } : {}) });
        } finally { (pool as any).query = query; }
        const out: string[] = [];
        for (const { sql, params } of seen) out.push((await query(`EXPLAIN ${sql}`, params)).rows.map((x: any) => x['QUERY PLAN']).join('\n'));
        return out;
      };
      for (const analyzed of [false, true]) {
        if (analyzed) await pool.query('ANALYZE gnl_runs');
        for (const q of OPEN_READS) {
          const ps = await plans(q);
          expect(ps.length, JSON.stringify(q)).toBeGreaterThanOrEqual(2);
          for (const p of ps) expect(p, `${analyzed ? 'analyzed' : 'fresh'} ${JSON.stringify(q)}`).toMatch(new RegExp(`${indexFor(q)}\\b`));
        }
      }
      await pool.query('DROP INDEX gnl_runs_open');
      expect((await s.checkSchema()).missingIndexes).toEqual(['gnl_runs_open']);
      const ran = await s.upgrade({ only: ['schema'] });
      expect((ran.steps.find((x) => x.name === 'schema')!.detail as { statements: string[] }).statements)
        .toEqual([`CREATE INDEX CONCURRENTLY IF NOT EXISTS gnl_runs_open ON gnl_runs (created_at, run_id) WHERE status <> 'completed'`]);
      expect((await s.checkSchema()).ok).toBe(true);
    } finally {
      await s.close().catch(() => {});
      await admin.query(`DROP DATABASE IF EXISTS ${dbName}`);
      await admin.end();
    }
  }, 60_000);
});
