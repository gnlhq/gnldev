// A run's row (`gnl_runs`) is a function of the run's records as committed — whoever wrote them, in
// whatever order their transactions interleave.
//
// `putIfMatch` on a run's record (a tool-claim takeover, `releaseToolClaim`) used to recount the run: it
// read the run's OTHER records without locking them, then overwrote `suspended_count` with what it read.
// A record of the same run written by another transaction in between was lost from the count, or counted
// twice. Measured on a real Postgres (release audit d-status, F2): 25 of 200 rounds drifted, e.g.
// `suspended_count=1` with 2 suspended records. A count of 0 next to a suspended record hides the approval
// from /approvals and lets retention sweep the run; a count of 1 with none is a phantom approval.
//
// Every write path now counts its own record from the row it replaced, read under that record's lock, and
// adds the difference to the run's row — the same rule `put`, `putIfAbsent` and `applyBatch` follow — and a
// deletion of some of a run's records subtracts what the DELETE itself read (the last scenario).
//
// The first scenario forces the interleaving: a writer's `put` is held just before its COMMIT (its record
// and its run-row change are written, not yet visible) while `putIfMatch` runs on another connection.
import { it, expect, afterAll } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRequire } from 'node:module';
import pg from 'pg';
import { toJournal } from '@gnldev/durable';
import { SqliteStorage } from '../src/sqlite-storage.js';
import { PostgresStorage } from '../src/postgres-storage.js';

const { DatabaseSync } = createRequire(import.meta.url)('node:sqlite') as { DatabaseSync: new (path: string) => any };
const PG_URL = process.env.GNL_PG_URL;
const ends: Array<() => Promise<void> | void> = [];
afterAll(async () => { for (const e of ends.reverse()) await e(); });

const SUSP = { status: 'suspended', output: { __gnl_suspend: { toolCallId: 'c', toolName: 'pay', reason: 'approve' } } };
const OK = { status: 'succeeded', output: 1 };

let seq = 0;
async function schemaUrl(): Promise<{ schema: string; pool: (max: number) => pg.Pool }> {
  const schema = `rowcount_${process.pid}_${seq++}`;
  const setup = new pg.Pool({ connectionString: PG_URL, max: 1 });
  await setup.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
  await setup.query(`CREATE SCHEMA ${schema}`);
  await setup.end();
  ends.push(async () => {
    const drop = new pg.Pool({ connectionString: PG_URL, max: 1 });
    await drop.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
    await drop.end();
  });
  return {
    schema,
    pool: (max) => {
      const p = new pg.Pool({ connectionString: PG_URL, max, options: `-c search_path=${schema}` });
      p.on('error', () => {});
      ends.push(() => p.end());
      return p;
    },
  };
}

/** A pool whose transactions stop at COMMIT until `release()` — `reached` resolves when one is held there. */
function gatedPool(pool: pg.Pool) {
  let release!: () => void;
  const gate = new Promise<void>((r) => { release = r; });
  let reach!: () => void;
  const reached = new Promise<void>((r) => { reach = r; });
  let armed = true;
  const wrapped = Object.create(pool) as pg.Pool;
  (wrapped as any).query = pool.query.bind(pool);
  (wrapped as any).connect = async () => {
    const client = await pool.connect();
    const query = client.query.bind(client);
    return new Proxy(client, {
      get(t, p) {
        if (p === 'query') return async (sql: any, params?: any) => {
          if (armed && sql === 'COMMIT') { armed = false; reach(); await gate; }
          return query(sql, params);
        };
        const v = Reflect.get(t, p, t);
        return typeof v === 'function' ? v.bind(t) : v;
      },
    });
  };
  return { pool: wrapped, reached, release };
}

const counted = async (pool: pg.Pool, runId: string) => {
  const row = (await pool.query(`SELECT suspended_count, status FROM gnl_runs WHERE run_id = $1`, [runId])).rows[0];
  const real = (await pool.query(`SELECT count(*)::int AS n FROM gnl_run_journal WHERE run_id = $1 AND suspended`, [runId])).rows[0].n;
  return { row: Number(row.suspended_count), status: row.status as string, records: Number(real) };
};

it.skipIf(!PG_URL)('Postgres: a putIfMatch takeover next to an uncommitted write of another record of the run — both counted', async () => {
  const { pool } = await schemaUrl();
  const plain = pool(4);
  const storage = new PostgresStorage({ pool: plain });
  await storage.init();
  const j = toJournal(storage.runs) as any;
  await j.put('r:tool:p', OK);

  const g = gatedPool(pool(2));
  const writer = toJournal(new PostgresStorage({ pool: g.pool }).runs) as any;
  const held = writer.put('r:tool:q', SUSP); // a new suspended record, held before its COMMIT
  await g.reached;
  // The takeover suspends p. Its run-row write waits for the held writer's lock on the run's row.
  const takeover = j.putIfMatch('r:tool:p', OK, SUSP);
  const waiter = pool(1);
  for (let i = 0; i < 200; i++) {
    const w = await waiter.query(`SELECT count(*)::int AS n FROM pg_stat_activity WHERE wait_event_type = 'Lock' AND datname = current_database()`);
    if (w.rows[0].n > 0) break;
    await new Promise((r) => setTimeout(r, 10));
  }
  g.release();
  await held;
  expect(await takeover).toBe(true);
  const c = await counted(plain, 'r');
  expect(c).toEqual({ row: 2, status: 'suspended', records: 2 });
  // And the takeover resolved again: one suspended record left, and the row says so.
  expect(await j.putIfMatch('r:tool:p', SUSP, OK)).toBe(true);
  expect(await counted(plain, 'r')).toEqual({ row: 1, status: 'suspended', records: 1 });
}, 60_000);

it.skipIf(!PG_URL)('Postgres: 200 rounds of a takeover racing two other writers of the run — the row equals the records after every round', async () => {
  const { pool } = await schemaUrl();
  const p = pool(8);
  const storage = new PostgresStorage({ pool: p });
  await storage.init();
  const j = toJournal(storage.runs) as any;
  await j.put('r:tool:p', OK);
  const drifted: string[] = [];
  for (let round = 0; round < 200; round++) {
    const a = round % 2 ? SUSP : OK;
    const b = round % 2 ? OK : SUSP;
    await Promise.all([
      j.putIfMatch('r:tool:p', a === SUSP ? OK : SUSP, a),
      j.put('r:tool:q', b),
      j.put(`r:tool:w${round % 3}`, round % 4 < 2 ? SUSP : OK),
    ]);
    const c = await counted(p, 'r');
    if (c.row !== c.records) drifted.push(`round ${round}: row ${c.row}, records ${c.records}`);
  }
  expect(drifted).toEqual([]);
}, 300_000);

it('Sqlite: two handles on one file, a takeover racing writers of the run — the row equals the records', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'gnl-rowcount-'));
  const file = join(dir, 'j.db');
  const s1 = new SqliteStorage(file);
  const s2 = new SqliteStorage(file);
  ends.push(() => { s1.close?.(); s2.close?.(); rmSync(dir, { recursive: true, force: true }); });
  const a = toJournal(s1.runs) as any;
  const b = toJournal(s2.runs) as any;
  await a.put('r:tool:p', OK);
  const db = new DatabaseSync(file);
  ends.push(() => db.close());
  for (let round = 0; round < 100; round++) {
    const x = round % 2 ? SUSP : OK;
    await Promise.all([
      a.putIfMatch('r:tool:p', x === SUSP ? OK : SUSP, x),
      b.put('r:tool:q', round % 2 ? OK : SUSP),
      b.put(`r:tool:w${round % 3}`, round % 4 < 2 ? SUSP : OK),
    ]);
    const row = db.prepare(`SELECT suspended_count AS n FROM gnl_runs WHERE run_id = 'r'`).get();
    const real = db.prepare(`SELECT count(*) AS n FROM gnl_run_journal WHERE run_id = 'r' AND suspended = 1`).get();
    expect(Number(row.n), `round ${round}`).toBe(Number(real.n));
  }
}, 120_000);

it.skipIf(!PG_URL)('Postgres: deleting single records of a run while others of it are written and taken over — the row equals the records', async () => {
  const { pool } = await schemaUrl();
  const p = pool(8);
  const storage = new PostgresStorage({ pool: p });
  await storage.init();
  const j = toJournal(storage.runs) as any;
  await j.put('r:model:0', { text: 'keeps the run' });
  await j.put('r:tool:p', OK);
  const drifted: string[] = [];
  for (let round = 0; round < 100; round++) {
    await j.put(`r:tool:d${round}`, round % 2 ? SUSP : OK);
    await Promise.all([
      j.deletePrefix(`r:tool:d${round}`),
      j.put(`r:tool:n${round}`, round % 3 ? SUSP : OK),
      j.putIfMatch('r:tool:p', round % 2 ? OK : SUSP, round % 2 ? SUSP : OK),
      round % 5 === 0 ? j.deletePrefix(`r:tool:n${round - 5}`) : Promise.resolve(),
    ]);
    const c = await counted(p, 'r');
    const tools = (await p.query(`SELECT tool_calls FROM gnl_runs WHERE run_id = 'r'`)).rows[0].tool_calls;
    const realTools = (await p.query(`SELECT count(*)::int AS n FROM gnl_run_journal WHERE run_id = 'r' AND kind = 'tool'`)).rows[0].n;
    if (c.row !== c.records || Number(tools) !== realTools) drifted.push(`round ${round}: suspended ${c.row}/${c.records}, tools ${tools}/${realTools}`);
  }
  expect(drifted).toEqual([]);
}, 300_000);
