// `adoptIntoOrg` moves the root's data into an organization. When the organization already held an
// entry under an adopted id, the stores disagreed (audit AR-2b):
//  - InMemory silently OVERWROTE it: an organization thread's owner record became the root's person
//    (`orgUser` → `rootUser`), and an organization's usage counter lost its own total;
//  - Sqlite and Postgres failed with a raw UNIQUE / 23505 error.
// The rule now, the same on every store (adoption.ts `onAdoptionCollision`):
//  - a record (journal record, run, thread and its rows, meta, a log record's id) REFUSES the adoption
//    before anything moves, with `AdoptionConflictError` naming the colliding ids — no store overwrites;
//  - a counter is SUMMED into the organization's, in the same transaction as the move;
//  - a content-addressed cache entry is the organization's already: the root's copy is dropped.
// Stores: InMemory, Sqlite, Postgres on pg-mem; with GNL_PG_URL also a real Postgres, one schema per
// store in that database, dropped at the end.
import { describe, it, expect, afterAll } from 'vitest';
import { newDb } from 'pg-mem';
import pg from 'pg';
import {
  InMemoryStorage, toJournal, withOrg, admitThreadRun, threadOwnerOf, ORG_RECORD_PRE, AdoptionConflictError, ADOPTION_ERROR_CODES,
  type Storage,
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
    const schema = `adoptconflict_${process.pid}_${Date.now().toString(36)}_${seq++}`;
    const admin = new pg.Pool({ connectionString: PG_URL, max: 1 });
    const pool = new pg.Pool({ connectionString: PG_URL, max: 4, options: `-c search_path=${schema}` });
    for (const p of [admin, pool]) p.on('error', () => {});
    await admin.query(`CREATE SCHEMA ${schema}`);
    ends.push(async () => { await pool.end().catch(() => {}); await admin.query(`DROP SCHEMA ${schema} CASCADE`); await admin.end(); });
    return new PostgresStorage({ pool });
  }]);
}

async function world(make: () => Promise<Storage>) {
  const s = await make();
  const root = toJournal(s.runs) as any;
  await root.put(`${ORG_RECORD_PRE}acme`, { id: 'acme' });
  return { s, root, acme: withOrg(root, 'acme') as any };
}

/** The refusal adoption gives, or the raw error / `'ok'` it gave instead. */
async function adopt(s: Storage, dryRun = false): Promise<AdoptionConflictError | string> {
  try {
    await s.adoptIntoOrg!('acme', { allowInFlight: true, dryRun });
    return 'ok';
  } catch (e) {
    if (e instanceof AdoptionConflictError) return e;
    return `raw: ${String((e as Error).message).slice(0, 80)}`;
  }
}

for (const [name, make] of STORES) {
  describe(`adoption never overwrites what the organization holds — ${name}`, () => {
    it('a thread both scopes own: refused by name, nothing moved, the organization\'s owner stays', async () => {
      const { s, root, acme } = await world(make);
      await admitThreadRun(root, undefined, 'T', user('rootUser'));
      await admitThreadRun(acme, undefined, 'T', user('orgUser'));
      await root.put('plain', { v: 1 }); // movable data beside the collision
      for (const dryRun of [true, false]) {
        const r = await adopt(s, dryRun);
        expect(r, `dryRun=${dryRun}`).toBeInstanceOf(AdoptionConflictError);
        const e = r as AdoptionConflictError;
        expect(e.code).toBe(ADOPTION_ERROR_CODES.AdoptionConflictError);
        expect(e.detail.keys).toContain('org:acme:thread:T:owner');
        expect(e.detail.orgId).toBe('acme');
      }
      expect(await threadOwnerOf(acme, undefined, 'T')).toEqual({ exists: true, owner: 'orgUser' });
      expect(await threadOwnerOf(root, undefined, 'T')).toEqual({ exists: true, owner: 'rootUser' });
      expect(await root.get('plain'), 'nothing moved').toEqual({ v: 1 });
      expect(await acme.get('plain')).toBeUndefined();
    });

    it('a run id both scopes hold (different records): refused, naming the run', async () => {
      const { s, root, acme } = await world(make);
      await root.put('R:model:0', { text: 'root' });
      await acme.put('R:model:1', { text: 'org' });
      const r = await adopt(s);
      expect(r).toBeInstanceOf(AdoptionConflictError);
      expect((r as AdoptionConflictError).detail.keys).toEqual(['org:acme:R']);
      expect(await root.get('R:model:0')).toEqual({ text: 'root' });
    });

    it('a memory thread both scopes hold: refused', async () => {
      const { s } = await world(make);
      const t = { resourceId: 'u', createdAt: 1, updatedAt: 1 };
      await s.memory!.upsertThread({ id: 't1', ...t });
      await s.memory!.upsertThread({ id: 'org:acme:t1', ...t });
      const r = await adopt(s);
      expect(r).toBeInstanceOf(AdoptionConflictError);
      expect((r as AdoptionConflictError).detail.keys).toEqual(['org:acme:t1']);
    });

    it('the list is capped and counted', async () => {
      const { s, root, acme } = await world(make);
      for (let i = 0; i < 25; i++) {
        await root.put(`k${String(i).padStart(2, '0')}`, { i });
        await acme.put(`k${String(i).padStart(2, '0')}`, { i });
      }
      const r = await adopt(s);
      expect(r).toBeInstanceOf(AdoptionConflictError);
      expect((r as AdoptionConflictError).detail.count).toBe(25);
      expect((r as AdoptionConflictError).detail.keys).toHaveLength(20);
    });

    it('a usage counter both scopes hold is summed into the organization\'s', async () => {
      const { s, root, acme } = await world(make);
      await root.incrBy('__usage__:2026-10', { tokens: 5, runs: 1 });
      await acme.incrBy('__usage__:2026-10', { tokens: 7 });
      expect(await adopt(s)).toBe('ok');
      expect(await acme.getCounters('__usage__:2026-10')).toEqual({ tokens: 12, runs: 1 });
      expect(await root.getCounters('__usage__:2026-10')).toBeUndefined();
    });

    it('a cache entry both scopes hold stays the organization\'s; the root\'s copy goes', async () => {
      const { s } = await world(make);
      await s.cache!.set('h1', { v: 'root' });
      await s.cache!.set('org:acme:h1', { v: 'org' });
      expect(await adopt(s)).toBe('ok');
      expect(await s.cache!.get('org:acme:h1')).toEqual({ v: 'org' });
      expect(await s.cache!.get('h1')).toBeUndefined();
    });
  });
}
