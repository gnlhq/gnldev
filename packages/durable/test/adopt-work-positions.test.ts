// `adoptIntoOrg` and the work store's READ POSITIONS (the queue's `qcursor`, a consumer's
// `evtcursor:*`) — one rule for every store (`workKeyAdoption`).
//
// Invariant: after an adoption, every record that was unhandled before it is still handed out in the
// organization; and the stores agree on the outcome.
//
// Before, the four stores did three different things with the root's `qcursor` when the organization
// already had one: in-memory and Redis overwrote the organization's (measured: 10 of 10 pending
// organization jobs stranded behind it), SQLite and Postgres refused the whole adoption on a raw UNIQUE
// violation. And a root position is wrong in the organization even when nothing collides: the moved
// log is renumbered after the organization's records, so a root cursor that had passed erased records
// pointed past the renumbered pending ones.
//
// Now a read position is never carried (`resetPositions` names it); the organization keeps its own,
// or reads from the head and skips finished records by their markers. Any other key both sides hold
// refuses the adoption before anything moves, in every store, with the same message.
import { describe, it, expect, vi, beforeAll, afterAll } from 'vitest';
import { newDb } from 'pg-mem';
import { InMemoryStorage, withOrgStorage, inMemoryLiveness, type Storage } from '../src/index.js';
import { SqliteStorage } from '../src/sqlite-storage.js';
import { PostgresStorage } from '../src/postgres-storage.js';
import { enqueue, createWorker, jobEraser } from '../../queue/src/index.js';

beforeAll(() => { vi.spyOn(console, 'warn').mockImplementation(() => {}); });
const ends: Array<() => Promise<unknown>> = [];
afterAll(async () => { for (const e of ends.reverse()) await e(); });
/** Every store here lives in this process (pg-mem included, which cannot say where it connects). */
const inProcess = { liveness: inMemoryLiveness() };

const PG_URL = process.env.GNL_PG_URL;
const STORES: Array<[string, () => Promise<Storage>]> = [
  ['in-memory', async () => new InMemoryStorage()],
  ['sqlite', async () => new SqliteStorage(':memory:')],
  ['postgres (pg-mem)', async () => { const { Pool } = newDb().adapters.createPg(); return new PostgresStorage({ pool: new Pool() }); }],
];
if (PG_URL) {
  STORES.push(['postgres (real)', async () => {
    const pg = (await import('pg')).default;
    const admin = new pg.Client({ connectionString: PG_URL });
    await admin.connect();
    const db = `adopt_pos_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`;
    await admin.query(`CREATE DATABASE ${db}`);
    const url = new URL(PG_URL); url.pathname = `/${db}`;
    const s = new PostgresStorage({ connectionString: url.toString() });
    ends.push(async () => { await s.close(); await admin.query(`DROP DATABASE IF EXISTS ${db}`); await admin.end(); });
    return s;
  }]);
}

const ADOPT = { allowUnregistered: true, allowInFlight: true } as const;

describe.each(STORES)('adoptIntoOrg and read positions — %s', (_name, make) => {
  it('a second adoption into an organization with its own cursor and pending jobs: all of them still run, the root cursor is reset', async () => {
    const s = await make();
    const ran = new Set<string>();
    const h = { t: async (p: { k: string }) => { ran.add(p.k); } };
    for (let i = 0; i < 60; i++) await enqueue(s.work!, 't', { k: `a${i}` }); // > one page (50): a cursor is persisted
    await createWorker(s, h, inProcess).drain();
    for (let i = 0; i < 10; i++) await enqueue(s.work!, 't', { k: `pend${i}` });
    await s.adoptIntoOrg!('acme', ADOPT);
    for (let i = 0; i < 60; i++) await enqueue(s.work!, 't', { k: `b${i}` });
    await createWorker(s, h, inProcess).drain();
    expect(await s.work!.get('qcursor')).toBeTruthy(); // the root has a position of its own again
    const r2 = await s.adoptIntoOrg!('acme', ADOPT);
    expect(r2.resetPositions).toEqual(['qcursor']);
    expect(await s.work!.get('qcursor')).toBeUndefined();
    const org = withOrgStorage(s, 'acme', { allowUnregistered: true } as never);
    const before = new Set(ran);
    await createWorker(org, h, inProcess).drain();
    const pendRan = [...Array(10).keys()].filter((i) => ran.has(`pend${i}`) && !before.has(`pend${i}`));
    expect(pendRan).toHaveLength(10);
    expect(ran.size).toBe(130); // and nothing ran twice into a missing key either
    // 130 jobs, each a run's journal writes: on pg-mem 5.3 s alone, and measured 26.1 s (19b94c3f) / 27.1 s
    // (with the run-status columns, whose upsert carries a CASE) with the durable suite running in parallel
    // — the default 30 s left no room once the whole repository ran beside it.
  }, 60_000);

  it('SIBLING — a FIRST adoption after an erasure in the root: the renumbered pending jobs are not behind the carried cursor', async () => {
    const s = await make();
    const ran: string[] = [];
    const h = { t: async (p: { k: string }) => { ran.push(p.k); } };
    for (let i = 0; i < 60; i++) await enqueue(s.work!, 't', { k: `x${i}` }, { resourceId: 'x' });
    await createWorker(s, h, inProcess).drain();
    expect(await s.work!.get('qcursor')).toBeTruthy();
    await jobEraser(s).erase({ resourceId: 'x' }); // their records are gone: the numbers behind the cursor are spent
    for (let i = 0; i < 10; i++) await enqueue(s.work!, 't', { k: `p${i}` });
    const r = await s.adoptIntoOrg!('acme', ADOPT);
    expect(r.resetPositions).toEqual(['qcursor']);
    ran.length = 0;
    await createWorker(withOrgStorage(s, 'acme', { allowUnregistered: true } as never), h, inProcess).drain();
    expect(ran.sort()).toEqual([...Array(10).keys()].map((i) => `p${i}`).sort());
  });

  it("SIBLING — a consumer's positions (a cursor, and events' '' for 'from the head') are reset the same way; dry run reports them and writes nothing", async () => {
    const s = await make();
    await s.work!.put('evtcursor:orders:mailer', 'w1:7:1:e-7');
    await s.work!.put('evtcursor:orders:audit', '');
    await s.work!.put('org:acme:evtcursor:orders:mailer', 'w1:3:1:e-3');
    const dry = await s.adoptIntoOrg!('acme', { ...ADOPT, dryRun: true });
    expect(dry.resetPositions).toEqual(['evtcursor:orders:audit', 'evtcursor:orders:mailer']);
    expect(await s.work!.get('evtcursor:orders:mailer')).toBe('w1:7:1:e-7');
    const r = await s.adoptIntoOrg!('acme', ADOPT);
    expect(r.resetPositions).toEqual(['evtcursor:orders:audit', 'evtcursor:orders:mailer']);
    expect(await s.work!.get('org:acme:evtcursor:orders:mailer')).toBe('w1:3:1:e-3'); // the organization's own stands
    expect(await s.work!.get('org:acme:evtcursor:orders:audit')).toBeUndefined(); // none carried: from the head
    expect(await s.work!.get('evtcursor:orders:mailer')).toBeUndefined();
  });

  it('SIBLING — any OTHER key both sides hold refuses the adoption, before anything moves, with the same message everywhere', async () => {
    const s = await make();
    await s.work!.put('settings:x', { a: 1 });
    await s.work!.put('org:acme:settings:x', { a: 2 });
    await s.work!.put('qcursor', 'w1:1:1:j');
    await enqueue(s.work!, 't', { k: 'root-job' });
    await expect(s.adoptIntoOrg!('acme', { ...ADOPT, dryRun: true })).rejects.toThrow(/work-store key onto 'org:acme:settings:x'.*Nothing was moved/);
    await expect(s.adoptIntoOrg!('acme', ADOPT)).rejects.toThrow(/work-store key onto 'org:acme:settings:x'.*Nothing was moved/);
    expect(await s.work!.get('settings:x')).toEqual({ a: 1 });
    expect(await s.work!.get('org:acme:settings:x')).toEqual({ a: 2 });
    expect(await s.work!.get('qcursor')).toBe('w1:1:1:j'); // not dropped by the refused run
    expect((await s.work!.list('qjob')).items).toHaveLength(1);
  });
});
