// Two writers of this version never deadlock each other on Postgres: every write takes the rows it locks
// in one order the adapter decides — journal rows by key, then the runs' rows by run id, then counters by
// (key, field) — whatever order the caller listed them in.
//
// `applyBatch` used to lock its journal rows in the caller's `puts` order, and its counters in the
// caller's `incrs` order, in the middle of the transaction. Two batches naming the same rows in opposite
// orders deadlocked: 29 of 30 rounds on a real Postgres (release audit d-status, F1), each costing
// `deadlock_timeout` (1 s) before the retry, and under a 16-writer load 8 aborts reached the caller after
// the retries ran out — while the adapter's own comment said two processes of this version cannot deadlock.
//
// Counted here: every 40P01 a statement of the storage meets, seen at the connection (the retry would
// otherwise hide it), not `pg_stat_database` (other suites share the database).
import { it, expect, afterAll } from 'vitest';
import pg from 'pg';
import { toJournal } from '@gnldev/durable';
import { PostgresStorage } from '../src/postgres-storage.js';

const PG_URL = process.env.GNL_PG_URL;
const ends: Array<() => Promise<void> | void> = [];
afterAll(async () => { for (const e of ends.reverse()) await e(); });

let seq = 0;
/** A storage on a schema of its own, with a count of the deadlocks its connections were aborted by. */
async function storage(): Promise<{ j: any; deadlocks: () => number }> {
  const schema = `lockorder_${process.pid}_${seq++}`;
  const setup = new pg.Pool({ connectionString: PG_URL, max: 1 });
  await setup.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
  await setup.query(`CREATE SCHEMA ${schema}`);
  await setup.end();
  const pool = new pg.Pool({ connectionString: PG_URL, max: 8, options: `-c search_path=${schema}` });
  pool.on('error', () => {});
  ends.push(async () => {
    await pool.end();
    const drop = new pg.Pool({ connectionString: PG_URL, max: 1 });
    await drop.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
    await drop.end();
  });
  let n = 0;
  const counting = Object.create(pool) as pg.Pool;
  (counting as any).query = pool.query.bind(pool);
  (counting as any).connect = async () => {
    const client = await pool.connect();
    const query = client.query.bind(client);
    return new Proxy(client, {
      get(t, p) {
        if (p === 'query') return (sql: any, params?: any) => query(sql, params).catch((e: any) => { if (e?.code === '40P01') n++; throw e; });
        const v = Reflect.get(t, p, t);
        return typeof v === 'function' ? v.bind(t) : v;
      },
    });
  };
  const st = new PostgresStorage({ pool: counting });
  await st.init();
  return { j: toJournal(st.runs), deadlocks: () => n };
}

const ROUNDS = 20;

it.skipIf(!PG_URL)('two batches writing the same two records of one run in opposite orders — no deadlock', async () => {
  const { j, deadlocks } = await storage();
  await j.put('d:tool:x', { status: 'succeeded' });
  await j.put('d:tool:y', { status: 'succeeded' });
  for (let i = 0; i < ROUNDS; i++) {
    await Promise.all([
      j.applyBatch({ puts: [{ key: 'd:tool:x', value: { status: 'succeeded', output: i } }, { key: 'd:tool:y', value: { status: 'succeeded', output: i } }] }),
      j.applyBatch({ puts: [{ key: 'd:tool:y', value: { status: 'succeeded', output: -i } }, { key: 'd:tool:x', value: { status: 'succeeded', output: -i } }] }),
    ]);
  }
  expect(deadlocks()).toBe(0);
}, 120_000);

it.skipIf(!PG_URL)('two batches writing records of two runs in opposite orders, one of them through its claim — no deadlock, and a lost claim still writes nothing', async () => {
  const { j, deadlocks } = await storage();
  await j.put('d1:tool:x', { status: 'succeeded' });
  await j.put('d2:tool:y', { status: 'succeeded' });
  let lost = 0;
  for (let i = 0; i < ROUNDS; i++) {
    const [a, b] = await Promise.all([
      j.applyBatch({ claim: { key: `d2:tool:claim${i}`, value: { status: 'running' } }, puts: [{ key: 'd2:tool:y', value: { status: 'succeeded', output: i } }, { key: 'd1:tool:x', value: { status: 'succeeded', output: i } }] }),
      j.applyBatch({ claim: { key: `d2:tool:claim${i}`, value: { status: 'running' } }, puts: [{ key: 'd1:tool:x', value: { status: 'succeeded', output: -i } }, { key: 'd2:tool:y', value: { status: 'succeeded', output: -i } }] }),
    ]);
    expect([a, b].filter(Boolean)).toHaveLength(1); // one claim wins
    if (!a || !b) lost++;
    // The winner's puts, both of them: never a mix of the two batches.
    const [x, y] = [await j.get('d1:tool:x'), await j.get('d2:tool:y')] as Array<{ output: number }>;
    expect(x.output).toBe(y.output);
    expect(x.output).toBe(a ? i : -i);
  }
  expect(lost).toBe(ROUNDS);
  expect(deadlocks()).toBe(0);
}, 120_000);

it.skipIf(!PG_URL)('two batches incrementing the same counters in opposite orders, and two incrBy naming one key\'s fields in opposite orders — no deadlock, exact totals', async () => {
  const { j, deadlocks } = await storage();
  for (let i = 0; i < ROUNDS; i++) {
    await Promise.all([
      j.applyBatch({ incrs: [{ key: 'c:a', fields: { n: 1 } }, { key: 'c:b', fields: { n: 1 } }], puts: [{ key: 'c:run:tool:t', value: { i } }] }),
      j.applyBatch({ incrs: [{ key: 'c:b', fields: { n: 1 } }, { key: 'c:a', fields: { n: 1 } }] }),
      j.incrBy('c:f', { p: 1, q: 1 }),
      j.incrBy('c:f', { q: 1, p: 1 }),
    ]);
  }
  expect(await j.getCounters('c:a')).toEqual({ n: 2 * ROUNDS });
  expect(await j.getCounters('c:b')).toEqual({ n: 2 * ROUNDS });
  expect(await j.getCounters('c:f')).toEqual({ p: 2 * ROUNDS, q: 2 * ROUNDS });
  expect(deadlocks()).toBe(0);
}, 120_000);
