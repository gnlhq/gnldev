// A scope's `thread:records:v1` mark says "every thread HERE has its owner record or mark", so the gate
// may read a thread with neither as new. It is a statement about the data written under that scope,
// and nothing else. `adoptIntoOrg` moves the root's data into an organization, and it used to move the
// root's mark with it as if it were data (it is an ordinary key, not a `__` platform key):
//
//  AR-1 the root (empty, marked by its first contact) gave its mark to an organization holding a thread
//       written before owner records existed (a named run, no record). The thread then read as new, and
//       a stranger was admitted to it and recorded as its owner — the control without adoption refuses.
//       The mirror case is the same rule: an organization marked by its first contact receives the
//       root's unrecorded threads, and its own mark now speaks for data that was not written under it.
//  AR-2 both scopes marked: the root's mark landed on the key the organization's mark holds — a raw
//       UNIQUE / 23505 error on Sqlite and Postgres (nothing moved), a silent overwrite in memory.
//  J3   after AR-1 the organization looked upgraded: `thread-records` did not report it pending.
//
// The rule now: a scope fact never leaves its scope, and the scope that receives data keeps its own
// fact only when the scope that gave the data held it too (two scopes whose every thread has a record
// still have that property together; one that did not, does not). Every store, the same answers.
// Stores: InMemory, Sqlite, Postgres on pg-mem; with GNL_PG_URL also a real Postgres, one schema per
// store in that database, dropped at the end.
import { describe, it, expect, afterAll } from 'vitest';
import { newDb } from 'pg-mem';
import pg from 'pg';
import {
  InMemoryStorage, toJournal, withOrg, admitThreadRun, threadOwnerOf, ORG_RECORD_PRE, THREAD_RECORDS_KEY, stampFormat,
  ThreadOwnerMismatchError, type Storage,
} from '../src/index.js';
import { SqliteStorage } from '../src/sqlite-storage.js';
import { PostgresStorage } from '../src/postgres-storage.js';
import { user } from '../src/run-identity.js';

const PG_URL = process.env.GNL_PG_URL;
const ends: Array<() => Promise<void> | void> = [];
afterAll(async () => { for (const e of ends.reverse()) await e(); });

let seq = 0;
const STORES: Array<[string, () => Promise<Storage>]> = [
  ['InMemory', async () => new InMemoryStorage()],
  ['Sqlite', async () => new SqliteStorage(':memory:')],
  ['Postgres (pg-mem)', async () => new PostgresStorage({ pool: new (newDb().adapters.createPg().Pool)() })],
];
if (PG_URL) {
  STORES.push(['Postgres (real)', async () => {
    const schema = `scopefact_${process.pid}_${Date.now().toString(36)}_${seq++}`;
    const admin = new pg.Pool({ connectionString: PG_URL, max: 1 });
    const pool = new pg.Pool({ connectionString: PG_URL, max: 4, options: `-c search_path=${schema}` });
    for (const p of [admin, pool]) p.on('error', () => {});
    await admin.query(`CREATE SCHEMA ${schema}`);
    ends.push(async () => { await pool.end().catch(() => {}); await admin.query(`DROP SCHEMA ${schema} CASCADE`); await admin.end(); });
    return new PostgresStorage({ pool });
  }]);
}

/** A thread written before owner records existed: ayse's run on `T`, and no record or mark for `T`. */
async function olderThread(j: any): Promise<void> {
  await j.put('old1:input', stampFormat({ at: 1, prompt: 'x', resourceId: 'ayse', threadId: 'T' }));
  await j.put('old1:model:0', { text: 'x' });
}

async function strangerOn(scope: any, threadId: string): Promise<string> {
  try {
    await admitThreadRun(scope, undefined, threadId, user('mallory'));
    return 'ADMITTED';
  } catch (e) {
    if (e instanceof ThreadOwnerMismatchError) return 'refused';
    throw e;
  }
}

async function pendingScopes(storage: Storage): Promise<unknown> {
  const report = await storage.upgrade!({ only: ['thread-records'], dryRun: true });
  const step = report.steps.find((s) => s.name === 'thread-records')!;
  return step.pending ? (step.detail as { scopes: string[] }).scopes : [];
}

for (const [name, make] of STORES) {
  describe(`a scope fact stays with its scope through adoption — ${name}`, () => {
    it('AR-1: the root\'s mark does not make an organization\'s older thread new', async () => {
      const s = await make();
      const root = toJournal(s.runs) as any;
      await root.put(`${ORG_RECORD_PRE}acme`, { id: 'acme' });
      const acme = withOrg(root, 'acme') as any;
      await olderThread(acme);
      await admitThreadRun(root, undefined, 'r-thread', user('u1')); // the root's first contact marks it
      expect(await root.get(THREAD_RECORDS_KEY)).toBeDefined();

      await s.adoptIntoOrg!('acme', { allowInFlight: true });

      expect(await acme.get(THREAD_RECORDS_KEY), 'the organization was never marked, and adoption does not mark it').toBeUndefined();
      expect(await root.get(THREAD_RECORDS_KEY), 'the root keeps its own mark').toBeDefined();
      expect(await strangerOn(acme, 'T')).toBe('refused');
      expect(await threadOwnerOf(acme, undefined, 'T')).toEqual({ exists: true, owner: 'ayse' });
      await s.close?.();
    });

    it('the mirror case: an organization\'s own mark is dropped when the root gives it threads it did not record', async () => {
      const s = await make();
      const root = toJournal(s.runs) as any;
      await root.put(`${ORG_RECORD_PRE}acme`, { id: 'acme' });
      const acme = withOrg(root, 'acme') as any;
      await olderThread(root);
      await threadOwnerOf(acme, undefined, 'never-used'); // a read in the empty organization marks it
      expect(await acme.get(THREAD_RECORDS_KEY)).toBeDefined();

      const dry = await s.adoptIntoOrg!('acme', { allowInFlight: true, dryRun: true });
      expect(await acme.get(THREAD_RECORDS_KEY), 'a dry run changes nothing').toBeDefined();
      const done = await s.adoptIntoOrg!('acme', { allowInFlight: true });
      expect(done.moved, 'the dry run reports what the adoption moves').toEqual(dry.moved);

      expect(await acme.get(THREAD_RECORDS_KEY)).toBeUndefined();
      expect(await strangerOn(acme, 'T')).toBe('refused');
      expect(await threadOwnerOf(acme, undefined, 'T')).toEqual({ exists: true, owner: 'ayse' });
      await s.close?.();
    });

    it('AR-2: both scopes marked — adoption succeeds, the organization stays marked, every thread keeps its owner', async () => {
      const s = await make();
      const root = toJournal(s.runs) as any;
      await root.put(`${ORG_RECORD_PRE}acme`, { id: 'acme' });
      await admitThreadRun(root, undefined, 'r-thread', user('u1'));
      const acme = withOrg(root, 'acme') as any;
      await admitThreadRun(acme, undefined, 'a-thread', user('u2'));
      const acmeMark = await acme.get(THREAD_RECORDS_KEY);
      expect(acmeMark).toBeDefined();
      expect(await root.get(THREAD_RECORDS_KEY)).toBeDefined();

      await s.adoptIntoOrg!('acme', { allowInFlight: true });

      expect(await acme.get(THREAD_RECORDS_KEY), 'the organization\'s own mark, not the root\'s').toEqual(acmeMark);
      expect(await root.get(THREAD_RECORDS_KEY)).toBeDefined();
      expect(await threadOwnerOf(acme, undefined, 'r-thread')).toEqual({ exists: true, owner: 'u1' });
      expect(await threadOwnerOf(acme, undefined, 'a-thread')).toEqual({ exists: true, owner: 'u2' });
      expect(await strangerOn(acme, 'r-thread')).toBe('refused');
      expect(await pendingScopes(s)).toEqual([]);
      await s.close?.();
    });

    it('J3: after adoption the organization reports `thread-records` pending until it is run', async () => {
      const s = await make();
      const root = toJournal(s.runs) as any;
      await root.put(`${ORG_RECORD_PRE}acme`, { id: 'acme' });
      const acme = withOrg(root, 'acme') as any;
      await olderThread(acme);
      await admitThreadRun(root, undefined, 'r-thread', user('u1'));
      await s.adoptIntoOrg!('acme', { allowInFlight: true });

      expect(await pendingScopes(s)).toEqual(['acme']);
      await s.upgrade!({ only: ['thread-records'] });
      expect(await pendingScopes(s)).toEqual([]);
      expect(await acme.get('thread:T:owner')).toMatchObject({ resourceId: 'ayse' });
      expect(await strangerOn(acme, 'T')).toBe('refused');
      await s.close?.();
    });
  });
}
