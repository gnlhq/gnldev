// k5 (5e-1b, 5f-1): the queue's upgrade steps, `queueUpgrade` — `queue/lanes` moves the jobs 0.16 and
// earlier enqueued (the one `qjob` log) into this version's lanes and ready set and leaves the old log;
// `queue/lanes-cleanup` (once every 0.16 process is gone) deletes the old log and its cursors.
//
// Invariant: after `queue/lanes` every job 0.16 left pending runs exactly once, nothing it finished runs
// again, and `getJob` / `cancelJob` find every old job by the id 0.16 returned — while the old log and
// 0.16's cursor stay as they were; run again, each step finds nothing pending and writes nothing; `plan`
// (the dry run) reports what it would do and writes nothing; killed half-way (SIGKILL), the store refuses
// a worker until the step is run again, which completes it with the same result. Until then this
// version's worker does not start on the store, and says what to run.
//
// The 0.16 store is what the 0.16.0 code itself wrote (`fixtures/k5-q016-writer.mjs`), from two sources:
//   · fixture — written once and committed (packages/upgrade-tests/fixtures/0.16.0, generate/0.16.0.mjs):
//     SQLite files; Postgres and MySQL dumps and MongoDB canonical Extended JSON, each loaded into a fresh
//     database (GNL_PG_URL, GNL_MYSQL_URL, GNL_MONGO_URL). Runs on every test run.
//   · live — written now, from an `npm install` of the published packages outside the workspace
//     (GNL_016_ROOT): every backend, MySQL and MongoDB included, and the deploy window, which runs a
//     0.16.0 worker and producer in a child:
//
//   mkdir -p /tmp/gnl-016 && cd /tmp/gnl-016 && echo '{"type":"module"}' > package.json \
//     && npm install @gnldev/durable@0.16.0 @gnldev/queue@0.16.0 pg@^8 mysql2@^3 mongodb@^6
//   GNL_016_ROOT=/tmp/gnl-016 [GNL_PG_URL=…] [GNL_MYSQL_URL=…] [GNL_MONGO_URL=…] npx vitest run packages/queue/test/k5-queue-upgrade.test.ts
import { describe, it, expect, afterAll } from 'vitest';
import { mkdtempSync, rmSync, appendFileSync, readFileSync, copyFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { execFileSync, spawn } from 'node:child_process';
import { InMemoryStorage, type Storage, type WorkStore, type LogRecord } from '@gnldev/durable';
import { SqliteStorage } from '@gnldev/durable/sqlite';
import * as Q from '../src/index.js';

const q = Q as any;
const here = dirname(fileURLToPath(import.meta.url));
const ROOT_016 = process.env.GNL_016_ROOT;
const PG_URL = process.env.GNL_PG_URL;
const MYSQL_URL = process.env.GNL_MYSQL_URL;
const MONGO_URL = process.env.GNL_MONGO_URL;
const WRITER = join(here, 'fixtures', 'k5-q016-writer.mjs');
const PROC = join(here, 'fixtures', 'k5-queue-upgrade-proc.ts');
const FLEET = join(here, 'fixtures', 'k5-q016-fleet.mjs');
const tsxLoader = join(dirname(createRequire(import.meta.url).resolve('tsx/package.json')), 'dist', 'loader.mjs');
const fromDurable = (m: string) => createRequire(join(here, '..', '..', 'durable', 'package.json'))(m);
const tag = () => `k5qu_${process.pid}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`;
const ends: Array<() => Promise<void>> = [];
afterAll(async () => { for (const e of ends.reverse()) await e().catch(() => {}); });

/** The steps `queueUpgrade` contributes to a store, as `registerUpgradeSteps` builds them: `queue/lanes`, `queue/lanes-cleanup`. */
const stepOf = (storage: Storage) => [q.queueUpgrade(storage)].flat()[0];
const cleanupOf = (storage: Storage) => [q.queueUpgrade(storage)].flat()[1];

/** Runs `runOnce` until nothing is ready; the payload names it ran, in order. */
async function drainNames(storage: Storage): Promise<string[]> {
  const ran: string[] = [];
  const w = q.createWorker(storage, { t: async (p: { n: string; fail?: boolean }) => { if (p.fail) throw new Error('boom'); ran.push(p.n); } }, { ttlMs: 10_000, maxAttempts: 1, heartbeat: false });
  try { while (await w.runOnce()) { /* next */ } } finally { await w.close(); }
  return ran;
}

// ─── Without a 0.16 store ───────────────────────────────────────────────────────────────────────

describe('queueUpgrade — the steps', () => {
  it('two steps: queue/lanes (a plain upgrade runs it) after the schema, then queue/lanes-cleanup once every older process is gone', () => {
    const steps = [q.queueUpgrade(new InMemoryStorage())].flat();
    expect(steps.map((s: any) => s.name)).toEqual(['queue/lanes', 'queue/lanes-cleanup']);
    const [lanes, cleanup] = steps;
    expect(lanes.afterOlderGone).toBeUndefined();
    expect(lanes.requires).toEqual(['schema']);
    expect(cleanup.afterOlderGone).toBe(true);
    expect(cleanup.requires).toEqual(['queue/lanes']);
    for (const s of steps) for (const f of ['plan', 'pending', 'run']) expect(typeof s[f]).toBe('function');
  });

  it('a store this version wrote is pending neither, and its data is at the version the package expects', async () => {
    const storage = new InMemoryStorage();
    await q.enqueue(storage.work, 't', { n: 'x' }, { orgId: 'acme' });
    const writes = countWrites(storage.work!);
    expect(await stepOf(storage).pending()).toBe(false);
    expect(await cleanupOf(storage).pending()).toBe(false);
    expect(await stepOf(storage).plan()).toEqual({ dataVersion: 3, packageVersion: 3, jobs: 0, ready: 0 });
    expect(await cleanupOf(storage).plan()).toEqual({ dataVersion: 3, packageVersion: 3, jobs: 0, ready: 0, removed: 0 });
    expect(await stepOf(storage).run()).toEqual({ dataVersion: 3, packageVersion: 3, jobs: 0, ready: 0 });
    expect(await cleanupOf(storage).run()).toEqual({ dataVersion: 3, packageVersion: 3, jobs: 0, ready: 0, removed: 0 });
    expect(writes()).toBe(0);
  });
});

describe('moveLegacyJob — one job of the earlier log into its lane (what the step, and a worker in a deploy window, call)', () => {
  const legacy = async (work: WorkStore, id: string, rec: Record<string, unknown>): Promise<LogRecord<any>> => {
    await work.append('qjob', rec, id);
    return (await work.list<any>('qjob')).items.find((r) => r.id === id)!;
  };

  it('a pending job: found by its id, run once — however many times it is moved', async () => {
    const storage = new InMemoryStorage();
    const rec = await legacy(storage.work!, '~o~acme::j1', { type: 't', payload: { n: 'j1' }, orgId: 'acme' });
    expect(await q.moveLegacyJob(storage.work, rec)).toBe('ready');
    expect(await q.moveLegacyJob(storage.work, rec)).toBe('ready');
    expect((await q.getJob(storage.work, '~o~acme::j1'))?.status).toBe('pending');
    await storage.work!.deletePrefix!('qjob'); // the log retired: the worker no longer refuses the store
    expect(await drainNames(storage)).toEqual(['j1']);
    expect((await q.getJob(storage.work, '~o~acme::j1'))?.status).toBe('done');
  });

  it('a finished job: moved without a turn — it does not run again', async () => {
    const storage = new InMemoryStorage();
    const rec = await legacy(storage.work!, 'old-done', { type: 't', payload: { n: 'old-done' } });
    await storage.work!.put('qdone:old-done', { at: 1 });
    expect(await q.moveLegacyJob(storage.work, rec)).toBe('finished');
    await storage.work!.deletePrefix!('qjob');
    expect(await drainNames(storage)).toEqual([]);
    expect((await q.getJob(storage.work, 'old-done'))?.status).toBe('done');
  });
});

// ─── The deploy window (5e-2): an earlier producer still writes the old log ────────────────────

describe('the deploy window — after queue/lanes, a job an earlier producer appends to the old log', () => {
  /** What a 0.16 producer appends: a record of the one log, nothing else. */
  const oldEnqueue = (work: WorkStore, n: string, orgId?: string) =>
    work.append('qjob', { type: 't', payload: { n }, ...(orgId ? { orgId } : {}) }, orgId ? `~o~${orgId}::${n}` : n);

  it('is moved by this version\'s worker and runs once; the old log is left for 0.16\'s workers', async () => {
    const storage = new InMemoryStorage();
    await oldEnqueue(storage.work!, 'before');
    expect(await stepOf(storage).run()).toMatchObject({ dataVersion: 1, jobs: 1, ready: 1 });
    await oldEnqueue(storage.work!, 'late1');
    await oldEnqueue(storage.work!, 'late2', 'acme');
    expect(await stepOf(storage).pending()).toBe(false); // v2: the store is moved; what is late, the worker moves
    expect([...(await drainNames(storage))].sort()).toEqual(['before', 'late1', 'late2']);
    expect(await drainNames(storage)).toEqual([]);
    expect(await qjobCount(storage.work!)).toBe(3);
    expect((await q.getJob(storage.work, '~o~acme::late2'))?.status).toBe('done');
  });

  it('more than a page of late jobs: each moved and run once, the move cursor past every full page', async () => {
    const storage = new InMemoryStorage();
    await stepOf(storage).run();
    await storage.work!.put('qversion', { version: 2 }); // a store queue/lanes moved (nothing was there to move)
    for (let i = 0; i < 130; i++) await oldEnqueue(storage.work!, `l${i}`, i % 2 ? 'acme' : undefined);
    const ran = await drainNames(storage);
    expect(ran).toHaveLength(130);
    expect(new Set(ran).size).toBe(130);
    expect(await storage.work!.get('qmovecursor')).toBeDefined();
    expect(await drainNames(storage)).toEqual([]);
  });

  it('queue/lanes ends while an earlier producer appends faster than it moves; what it left, the worker moves', async () => {
    const storage = new InMemoryStorage();
    for (let i = 0; i < 60; i++) await oldEnqueue(storage.work!, `p${i}`);
    // A producer that appends a full page for every page the step reads (MongoDB under load, measured).
    const list = storage.work!.list.bind(storage.work!);
    let extra = 0;
    (storage.work as any).list = async (ns: string, o?: any) => {
      const page = await list(ns, o);
      if (ns === 'qjob' && o?.limit === 50 && extra < 5000) for (let i = 0; i < 50; i++) await oldEnqueue(storage.work!, `x${extra++}`);
      return page;
    };
    const r = await stepOf(storage).run();
    expect(extra).toBeLessThan(5000); // it stopped, not the producer
    expect(r.jobs).toBeGreaterThanOrEqual(60);
    (storage.work as any).list = list;
    expect(await stepOf(storage).pending()).toBe(false);
    const ran = await drainNames(storage);
    expect(ran).toHaveLength(60 + extra);
    expect(new Set(ran).size).toBe(60 + extra);
  });

  it('after queue/lanes-cleanup (v3) the worker no longer reads the old log; a job written there after it shows the cleanup pending again', async () => {
    const storage = new InMemoryStorage();
    await oldEnqueue(storage.work!, 'a');
    await stepOf(storage).run();
    await cleanupOf(storage).run();
    const w = q.createWorker(storage, { t: async () => {} }, { ttlMs: 30, heartbeat: false });
    await w.runOnce(); // asks the data version once: v3
    const list = storage.work!.list.bind(storage.work!);
    let oldLogReads = 0;
    (storage.work as any).list = (ns: string, o?: unknown) => { if (ns === 'qjob') oldLogReads++; return list(ns, o as any); };
    for (let i = 0; i < 5; i++) { await new Promise((r) => setTimeout(r, 15)); await w.runOnce(); }
    await w.drain();
    expect(oldLogReads).toBe(0);
    await w.close();
    // An earlier producer the operator thought gone: the data says v2 again, and the cleanup is pending.
    await oldEnqueue(storage.work!, 'too-late');
    expect(await cleanupOf(storage).pending()).toBe(true);
    expect(await drainNames(storage)).toEqual(['too-late']); // a worker started now moves it
  });
});

// ─── A store 0.16.0 wrote, on each backend ──────────────────────────────────────────────────────

interface Notes016 { ids: string[]; names: string[]; ran: string[]; doneIds: string[]; deadId: string; qcursor: string | null }
/** The old log's records and 0.16.0's cursor, when it wrote one (it advances past a full page of finished jobs only). */
const oldKeys = (n: Notes016) => n.ids.length + (n.qcursor === null ? 0 : 1);
interface Backend016 { target: string; open(): Promise<Storage> }
type Mk = () => Promise<Backend016>;

async function opened(s: Storage): Promise<Storage> {
  await (s as any).init?.();
  ends.push(async () => { await (s as any).close?.(); });
  return s;
}
const BACKENDS: Array<[string, Mk]> = [
  ['sqlite', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'k5qu-'));
    ends.push(async () => rmSync(dir, { recursive: true, force: true }));
    const file = join(dir, 'q.db');
    return { target: file, open: () => opened(new SqliteStorage(file) as unknown as Storage) };
  }],
];
if (PG_URL) BACKENDS.push(['postgres', async () => {
  const { PostgresStorage } = await import('@gnldev/durable/postgres');
  const schema = tag();
  const admin = new (fromDurable('pg').Client)({ connectionString: PG_URL });
  await admin.connect(); await admin.query(`CREATE SCHEMA ${schema}`); await admin.end();
  ends.push(async () => {
    const a = new (fromDurable('pg').Client)({ connectionString: PG_URL });
    await a.connect(); await a.query(`DROP SCHEMA ${schema} CASCADE`); await a.end();
  });
  const u = new URL(PG_URL);
  u.searchParams.set('options', `-c search_path=${schema}`);
  return { target: u.toString(), open: () => opened(new PostgresStorage({ connectionString: u.toString() }) as unknown as Storage) };
}]);
if (MYSQL_URL) BACKENDS.push(['mysql', async () => {
  const { MysqlStorage } = await import('@gnldev/durable/mysql');
  const db = tag();
  const my = fromDurable('mysql2/promise');
  const admin = await my.createConnection(MYSQL_URL); await admin.query(`CREATE DATABASE ${db}`); await admin.end();
  ends.push(async () => { const a = await my.createConnection(MYSQL_URL); await a.query(`DROP DATABASE IF EXISTS ${db}`); await a.end(); });
  const u = new URL(MYSQL_URL);
  u.pathname = `/${db}`;
  return { target: u.toString(), open: () => opened(new MysqlStorage({ connectionString: u.toString() }) as unknown as Storage) };
}]);
if (MONGO_URL) BACKENDS.push(['mongo', async () => {
  const { MongoStorage } = await import('@gnldev/durable/mongo');
  const u = new URL(MONGO_URL);
  u.pathname = `/${tag()}`;
  ends.push(async () => {
    const c = new (fromDurable('mongodb').MongoClient)(MONGO_URL);
    try { await c.db(u.pathname.slice(1)).dropDatabase(); } finally { await c.close(); }
  });
  return { target: u.toString(), open: () => opened(new MongoStorage({ connectionString: u.toString() }) as unknown as Storage) };
}]);

/**
 * The committed 0.16.0 stores (packages/upgrade-tests/fixtures/0.16.0): `queue` — 19 jobs, 4 taken by
 * 0.16.0's worker; `queue-many` — 173 jobs, 60 taken, 0.16.0's `qcursor` written. The live writer is run
 * with the same scenario (generate/0.16.0.mjs runs the same writer).
 */
type Variant = 'queue' | 'queue-many';
const VARIANT_ENV: Record<Variant, Record<string, string>> = { queue: {}, 'queue-many': { Q016_SYSTEM: '160', Q016_RUN: '60' } };
const FIXTURES_016 = join(here, '..', '..', 'upgrade-tests', 'fixtures', '0.16.0');
const fixtureNotes = (kind: string, v: Variant): Notes016 => JSON.parse(readFileSync(join(FIXTURES_016, `notes-${kind}.json`), 'utf8')).notes[v];
/** A fresh copy of a committed fixture, in a store of its own. */
async function fixture016(kind: string, v: Variant): Promise<Backend016> {
  if (kind === 'sqlite') {
    const dir = mkdtempSync(join(tmpdir(), 'k5qu-fx-'));
    ends.push(async () => rmSync(dir, { recursive: true, force: true }));
    const file = join(dir, 'q.db');
    copyFileSync(join(FIXTURES_016, `${v}.db`), file);
    return { target: file, open: () => opened(new SqliteStorage(file) as unknown as Storage) };
  }
  if (kind === 'mysql') {
    // MySQL: the dump's statements in a fresh database (they name no database).
    const { MysqlStorage } = await import('@gnldev/durable/mysql');
    const my = fromDurable('mysql2/promise');
    const db = tag();
    const admin = await my.createConnection(MYSQL_URL); await admin.query(`CREATE DATABASE ${db}`); await admin.end();
    ends.push(async () => { const a = await my.createConnection(MYSQL_URL); await a.query(`DROP DATABASE IF EXISTS ${db}`); await a.end(); });
    const u = new URL(MYSQL_URL!);
    u.pathname = `/${db}`;
    const loader = await my.createConnection({ uri: u.toString(), multipleStatements: true });
    await loader.query(readFileSync(join(FIXTURES_016, `mysql-${v}.sql`), 'utf8')); await loader.end();
    return { target: u.toString(), open: () => opened(new MysqlStorage({ connectionString: u.toString() }) as unknown as Storage) };
  }
  if (kind === 'mongo') {
    // MongoDB: canonical Extended JSON (generate/0.16.0.mjs) — per collection a line with its indexes, then its documents.
    const { MongoStorage } = await import('@gnldev/durable/mongo');
    const { MongoClient, BSON } = fromDurable('mongodb');
    const u = new URL(MONGO_URL!);
    u.pathname = `/${tag()}`;
    const c = new MongoClient(MONGO_URL);
    try {
      const d = c.db(u.pathname.slice(1));
      ends.push(async () => { const x = new MongoClient(MONGO_URL); try { await x.db(u.pathname.slice(1)).dropDatabase(); } finally { await x.close(); } });
      let coll: string | undefined;
      const docs = new Map<string, unknown[]>();
      for (const line of readFileSync(join(FIXTURES_016, `mongo-${v}.ejson`), 'utf8').split('\n').filter(Boolean)) {
        const x = BSON.EJSON.parse(line, { relaxed: false });
        if (typeof x.collection === 'string' && Array.isArray(x.indexes)) {
          coll = x.collection;
          await d.createCollection(coll!);
          const specs = x.indexes.filter((i: { name: string }) => i.name !== '_id_');
          if (specs.length) await d.collection(coll!).createIndexes(specs);
          docs.set(coll!, []);
        } else docs.get(coll!)!.push(x);
      }
      for (const [name, list] of docs) if (list.length) await d.collection(name).insertMany(list as any[], { ordered: true });
    } finally { await c.close(); }
    return { target: u.toString(), open: () => opened(new MongoStorage({ connectionString: u.toString() }) as unknown as Storage) };
  }
  // Postgres: the dump in a fresh database (its statements name the `public` schema).
  const { PostgresStorage } = await import('@gnldev/durable/postgres');
  const pg = fromDurable('pg');
  const db = tag();
  const admin = new pg.Client({ connectionString: PG_URL });
  await admin.connect(); await admin.query(`CREATE DATABASE ${db}`); await admin.end();
  ends.push(async () => {
    const a = new pg.Client({ connectionString: PG_URL });
    await a.connect(); await a.query(`DROP DATABASE IF EXISTS ${db} WITH (FORCE)`); await a.end();
  });
  const u = new URL(PG_URL!);
  u.pathname = `/${db}`;
  const loader = new pg.Client({ connectionString: u.toString() });
  await loader.connect(); await loader.query(readFileSync(join(FIXTURES_016, `postgres-${v}.sql`), 'utf8')); await loader.end();
  return { target: u.toString(), open: () => opened(new PostgresStorage({ connectionString: u.toString() }) as unknown as Storage) };
}
type Source = 'fixture' | 'live';
/** A store 0.16.0 wrote (committed, or its own code in a child now), opened with this version's, its store steps run (`gnl upgrade` runs them first). */
async function store016(kind: string, mk: Mk, src: Source, v: Variant = 'queue'): Promise<{ storage: Storage; notes: Notes016; b: Backend016; kind: string }> {
  let b: Backend016;
  let notes: Notes016;
  if (src === 'fixture') {
    b = await fixture016(kind, v);
    notes = fixtureNotes(kind, v);
  } else {
    b = await mk();
    const out = execFileSync(process.execPath, [WRITER, kind, b.target], { env: { ...process.env, ...VARIANT_ENV[v], GNL_016_ROOT: ROOT_016! }, stdio: ['ignore', 'pipe', 'ignore'] });
    notes = JSON.parse(out.toString()) as Notes016;
  }
  const storage = await b.open();
  await (storage as any).upgrade?.();
  return { storage, notes, b, kind };
}
const pendingOn016 = (n: Notes016) => n.names.filter((_, i) => !n.doneIds.includes(n.ids[i]!) && n.ids[i] !== n.deadId);
const qjobCount = async (work: WorkStore) => (await work.list('qjob', { limit: 1000 })).items.length;

const SOURCES: Array<[string, Mk, Source]> = [];
for (const [name, mk] of BACKENDS) {
  SOURCES.push([name, mk, 'fixture']); // every backend has a committed 0.16.0 store (5g-2)
  if (ROOT_016) SOURCES.push([name, mk, 'live']);
}
for (const [name, mk, src] of SOURCES) {
  const store016of = (v: Variant = 'queue') => store016(name, mk, src, v);
  describe(`queueUpgrade on a store 0.16.0 wrote (${name}, ${src})`, () => {
    it('the fixture is what it claims: 0.16.0 ran three, dead-lettered one, left the rest pending in the one log', async () => {
      const { storage, notes } = await store016of();
      expect(notes.ran).toEqual(['s0', 's1', 's2']);
      expect(notes.doneIds).toHaveLength(3);
      expect(await storage.work!.get(`qfail:${notes.deadId}`)).toBeDefined();
      expect(await qjobCount(storage.work!)).toBe(notes.ids.length);
    });

    it('before the step: this version\'s worker does not start, and names the data version and what to run', async () => {
      const { storage } = await store016of();
      const w = q.createWorker(storage, { t: async () => {} }, { heartbeat: false });
      await expect(w.runOnce()).rejects.toThrow(/data is at v1.*needs v2.*Run `gnl upgrade` once/s);
      await expect(w.drain()).rejects.toThrow(/Run `gnl upgrade` once/);
      await w.close();
    });

    it('the dry run reports what the step would move and writes nothing', async () => {
      const { storage, notes } = await store016of();
      const s = stepOf(storage);
      expect(await s.pending()).toBe(true);
      const pending = pendingOn016(notes).length;
      const writes = countWrites(storage.work!);
      expect(await s.plan()).toEqual({ dataVersion: 1, packageVersion: 3, jobs: notes.ids.length, ready: pending });
      expect(await s.plan()).toEqual({ dataVersion: 1, packageVersion: 3, jobs: notes.ids.length, ready: pending });
      // The cleanup's plan counts the whole old log and 0.16's cursor.
      expect(await cleanupOf(storage).plan()).toEqual({ dataVersion: 1, packageVersion: 3, jobs: notes.ids.length, ready: pending, removed: oldKeys(notes) });
      expect(await s.pending()).toBe(true);
      expect(writes()).toBe(0);
      expect(await qjobCount(storage.work!)).toBe(notes.ids.length);
      for (const id of notes.ids) expect(await q.getJob(storage.work, id)).toBeUndefined(); // no lane written
      expect(await storage.work!.get('qversion')).toBeUndefined();
    });

    it('after queue/lanes: every pending job runs once, nothing finished runs again, getJob and cancelJob find the old ids, the old log is left; a second run is a no-op', async () => {
      const { storage, notes } = await store016of();
      const s = stepOf(storage);
      const pending = pendingOn016(notes);
      const qcursor = await storage.work!.get('qcursor');
      expect(qcursor ?? null).toEqual(notes.qcursor);
      expect(await s.run()).toEqual({ dataVersion: 1, packageVersion: 3, jobs: notes.ids.length, ready: pending.length });
      // Left as 0.16.0's workers read it: every record, and their cursor.
      expect(await qjobCount(storage.work!)).toBe(notes.ids.length);
      expect(await storage.work!.get('qcursor')).toEqual(qcursor);
      expect(await s.pending()).toBe(false);
      expect(await s.plan()).toEqual({ dataVersion: 2, packageVersion: 3, jobs: 0, ready: 0 });
      expect(await cleanupOf(storage).pending()).toBe(true);
      // Every old job, by the id 0.16.0 returned: its status as 0.16.0 left it.
      for (const [i, id] of notes.ids.entries()) {
        const want = notes.doneIds.includes(id) ? 'done' : id === notes.deadId ? 'failed' : 'pending';
        expect([notes.names[i], (await q.getJob(storage.work, id))?.status]).toEqual([notes.names[i], want]);
      }
      // Cancelled by its old id: it does not run.
      const cancelled = notes.ids[notes.names.indexOf('globex3')]!;
      expect(await q.cancelJob(storage.work, cancelled)).toBe(true);
      expect(await q.cancelJob(storage.work, notes.doneIds[0])).toBe(false);
      // The second run, before the worker: nothing to move, nothing written (the port's writes counted).
      const writes = countWrites(storage.work!);
      expect(await s.run()).toEqual({ dataVersion: 2, packageVersion: 3, jobs: 0, ready: 0 });
      expect(writes()).toBe(0);
      const ran = await drainNames(storage);
      expect([...ran].sort()).toEqual(pending.filter((n) => n !== 'globex3').sort());
      expect(await drainNames(storage)).toEqual([]);
      expect((await q.getJob(storage.work, cancelled))?.status).toBe('cancelled');
      expect((await q.getJob(storage.work, notes.ids[notes.names.indexOf('fixed')]!))?.status).toBe('done');
    });

    it('queue/lanes-cleanup: the old log and its cursor go, v3 is recorded, every answer stays; a second run writes nothing', async () => {
      const { storage, notes } = await store016of('queue-many'); // 0.16.0 wrote its qcursor here
      const pending = pendingOn016(notes);
      expect(notes.qcursor).not.toBeNull();
      await stepOf(storage).run();
      expect(await storage.work!.get('qcursor')).toEqual(notes.qcursor); // queue/lanes left it for 0.16.0's workers
      const before = await Promise.all(notes.ids.map(async (id) => (await q.getJob(storage.work, id))?.status));
      const c = cleanupOf(storage);
      // The old log, 0.16.0's cursor, and this version's move cursor (written past a full page of 50).
      expect(await storage.work!.get('qmovecursor')).toBeDefined();
      expect(await c.run()).toEqual({ dataVersion: 2, packageVersion: 3, jobs: 0, ready: 0, removed: oldKeys(notes) + 1 });
      expect(await storage.work!.get('qmovecursor')).toBeUndefined();
      expect(await qjobCount(storage.work!)).toBe(0);
      expect(await storage.work!.get('qcursor')).toBeUndefined();
      expect(await storage.work!.get('qversion')).toEqual({ version: 3 });
      expect(await c.pending()).toBe(false);
      expect(await Promise.all(notes.ids.map(async (id) => (await q.getJob(storage.work, id))?.status))).toEqual(before);
      const writes = countWrites(storage.work!);
      expect(await c.run()).toEqual({ dataVersion: 3, packageVersion: 3, jobs: 0, ready: 0, removed: 0 });
      expect(await stepOf(storage).run()).toEqual({ dataVersion: 3, packageVersion: 3, jobs: 0, ready: 0 });
      expect(writes()).toBe(0);
      expect([...(await drainNames(storage))].sort()).toEqual([...pending].sort());
    });

    it.skipIf(!ROOT_016)('the deploy window: a 0.16.0 worker and producer keep running after queue/lanes, beside this version\'s worker — every job runs exactly once', async () => {
      const { storage, notes, b, kind } = await store016of();
      expect(await stepOf(storage).run()).toMatchObject({ dataVersion: 1 });
      const dir = mkdtempSync(join(tmpdir(), 'k5qu-win-'));
      ends.push(async () => rmSync(dir, { recursive: true, force: true }));
      const runLog = join(dir, 'run.log');
      const w = q.createWorker(storage, {
        t: async (p: { n: string; fail?: boolean }) => { if (p.fail) throw new Error('boom'); appendFileSync(runLog, `${p.n} new\n`); await new Promise((r) => setTimeout(r, 5 + Math.floor(Math.random() * 20))); },
      }, { pollMs: 20, ttlMs: 3000, concurrency: 2, maxAttempts: 1 });
      w.start();
      const child = await new Promise<{ ids: string[] }>((resolve, reject) => {
        const p = spawn(process.execPath, [FLEET, kind, b.target, runLog, '60'], { env: { ...process.env, GNL_016_ROOT: ROOT_016! }, stdio: ['ignore', 'pipe', 'pipe'] });
        let out = ''; let err = '';
        p.stdout!.on('data', (d: Buffer) => { out += d.toString(); });
        p.stderr!.on('data', (d: Buffer) => { err += d.toString(); });
        p.on('exit', (code) => (code === 0 ? resolve(JSON.parse(out)) : reject(new Error(`0.16.0 fleet exited ${code}: ${err}`))));
      });
      // The old process is gone; this version's worker takes what is left (moved within ttlMs/3).
      const until = Date.now() + 30_000;
      const statusOf = async () => Promise.all(child.ids.map(async (id) => (await q.getJob(storage.work, id))?.status));
      while ((await statusOf()).some((st) => st !== 'done') && Date.now() < until) await new Promise((r) => setTimeout(r, 200));
      await w.close();
      expect(await statusOf()).toEqual(child.ids.map(() => 'done'));
      const lines = readFileSync(runLog, 'utf8').split('\n').filter(Boolean);
      const byName = new Map<string, string[]>();
      for (const l of lines) { const [n, who] = l.split(' '); byName.set(n!, [...(byName.get(n!) ?? []), who!]); }
      const windowJobs = [...byName].filter(([n]) => n.startsWith('w'));
      expect(windowJobs).toHaveLength(60);
      expect(windowJobs.filter(([, who]) => who.length !== 1)).toEqual([]);
      // What 0.16.0 left pending before the deploy ran once too, and nothing it finished ran again.
      expect([...byName.keys()].filter((n) => !n.startsWith('w')).sort()).toEqual(pendingOn016(notes).sort());
      expect([...byName.values()].every((who) => who.length === 1)).toBe(true);
    }, 90_000);

    it('killed half-way (SIGKILL): the store still refuses a worker; run again, every job runs exactly once', async () => {
      const { storage, notes, b, kind } = await store016of('queue-many');
      const pending = pendingOn016(notes);
      const KILL_AFTER = 40;
      const moved = await new Promise<number>((resolve, reject) => {
        const p = spawn(process.execPath, ['--import', tsxLoader, PROC, kind, b.target], { stdio: ['ignore', 'pipe', 'pipe'] });
        let n = 0; let err = '';
        p.stdout!.on('data', (d: Buffer) => { n += d.toString().split('m').length - 1; if (n >= KILL_AFTER) p.kill('SIGKILL'); });
        p.stderr!.on('data', (d: Buffer) => { err += d.toString(); });
        p.on('exit', (code, sig) => (sig === 'SIGKILL' ? resolve(n) : reject(new Error(`the step finished before the kill (code ${code}): ${err}`))));
      });
      expect(moved).toBeGreaterThanOrEqual(KILL_AFTER);
      expect(moved).toBeLessThan(notes.ids.length);
      // Half-way: the old log is still there, so the worker still refuses — no job runs from half a move.
      expect(await qjobCount(storage.work!)).toBe(notes.ids.length);
      const w = q.createWorker(storage, { t: async () => {} }, { heartbeat: false });
      await expect(w.runOnce()).rejects.toThrow(/Run `gnl upgrade` once/);
      await w.close();
      const s = stepOf(storage);
      expect(await s.pending()).toBe(true);
      // What the killed run moved is found in its lane and not counted again.
      const r = await s.run();
      expect(r.dataVersion).toBe(1);
      expect(r.jobs).toBeGreaterThan(0);
      expect(r.jobs).toBeLessThanOrEqual(notes.ids.length - KILL_AFTER + 1);
      expect(await s.pending()).toBe(false);
      const ran = await drainNames(storage);
      expect(ran).toHaveLength(pending.length);
      expect([...ran].sort()).toEqual([...pending].sort());
      expect(await drainNames(storage)).toEqual([]);
    }, 120_000);
  });
}

// ─── 5g-1: queue/lanes-cleanup refuses while a worker of the earlier version is live ────────────────
//
// A 0.16.0 worker announces itself in `__qworkers__` as it polls: `owner → { at, ttlMs }` (0.16.0's
// dist, `setPresence`), live while `at + ttlMs` has not passed. This version's worker writes the same
// entry and its package's data version (`packageVersion`); an entry without it is the earlier version's.
// The cleanup deletes the log such a worker reads from its cursor, so it stops while one is live — and
// only while: an entry nobody renews (a killed process, a hand-written one) expires by its own ttl.

const PRESENCE = '__qworkers__';
/** A store with an old log that `queue/lanes` moved (v2): the cleanup is pending. */
async function movedStore(mk: Mk): Promise<{ storage: Storage; b: Backend016 }> {
  const b = await mk();
  const storage = await b.open();
  await (storage as any).upgrade?.();
  await storage.work!.append('qjob', { type: 't', payload: { n: 'old' } }, 'old');
  await stepOf(storage).run();
  expect(await cleanupOf(storage).pending()).toBe(true);
  return { storage, b };
}
/** What a 0.16.0 worker writes for itself (its dist: `setPresence(work, owner, { at: Date.now(), ttlMs })`). */
const presence016 = async (work: WorkStore, owner: string, at: number, ttlMs: number) => {
  const cur = ((await work.get<Record<string, unknown>>(PRESENCE)) ?? {});
  await work.put(PRESENCE, { ...cur, [owner]: { at, ttlMs } });
};
const untilTrue = async (f: () => Promise<boolean>, ms: number) => {
  const end = Date.now() + ms;
  while (!(await f())) { if (Date.now() > end) throw new Error('timed out'); await new Promise((r) => setTimeout(r, 50)); }
};

for (const [name, mk] of BACKENDS) {
  describe(`queue/lanes-cleanup and the earlier version's live workers (${name})`, () => {
    it('a live 0.16 worker: the dry run names it, the run refuses with how many, when last seen and what to do — and deletes nothing', async () => {
      const { storage } = await movedStore(mk);
      const at = Date.now();
      await presence016(storage.work!, 'w-old1', at, 60_000);
      await presence016(storage.work!, 'w-old2', at - 1000, 60_000);
      const c = cleanupOf(storage);
      const plan = await c.plan();
      expect(plan).toMatchObject({ dataVersion: 2, packageVersion: 3, olderWorkers: 2 });
      expect(String(plan.refusal)).toMatch(/2 workers of an earlier version.*last seen/s);
      await expect(c.run()).rejects.toThrow(/queue\/lanes-cleanup refused: 2 workers of an earlier version .*poll this store.*last seen .*Stop them.*run it again/s);
      expect(await qjobCount(storage.work!)).toBe(1);
      expect(await c.pending()).toBe(true);
      expect(await storage.work!.get('qversion')).toEqual({ version: 2 });
    });

    it('this version\'s live worker does not hold it back; its entry carries the data version its package speaks', async () => {
      const { storage } = await movedStore(mk);
      const w = q.createWorker(storage, { t: async () => {} }, { owner: 'w-new', pollMs: 20, ttlMs: 60_000 });
      w.start();
      try {
        await untilTrue(async () => (await storage.work!.get<any>(PRESENCE))?.['w-new'] !== undefined, 5000);
        expect((await storage.work!.get<any>(PRESENCE))['w-new']).toMatchObject({ ttlMs: 60_000, packageVersion: 3 });
        expect((await cleanupOf(storage).plan()).olderWorkers).toBeUndefined();
        expect(await cleanupOf(storage).run()).toMatchObject({ dataVersion: 2, removed: 1 });
      } finally { await w.close(); }
    });

    it('an entry nobody renews (a killed process) holds it back only until its ttl; a forged one from the future or a malformed one not at all', async () => {
      const { storage } = await movedStore(mk);
      await presence016(storage.work!, 'w-dead', Date.now(), 800);
      await expect(cleanupOf(storage).run()).rejects.toThrow(/1 worker of an earlier version/);
      await new Promise((r) => setTimeout(r, 900));
      await presence016(storage.work!, 'w-future', Date.now() + 3_600_000, 1000);
      const cur = (await storage.work!.get<Record<string, unknown>>(PRESENCE)) ?? {};
      await storage.work!.put(PRESENCE, { ...cur, 'w-junk': { at: 'soon', ttlMs: 'forever' }, 'w-nan': { at: Number.NaN, ttlMs: 1 } });
      expect((await cleanupOf(storage).plan()).olderWorkers).toBeUndefined();
      expect(await cleanupOf(storage).run()).toMatchObject({ removed: 1 });
      expect(await cleanupOf(storage).pending()).toBe(false);
    });

    it.skipIf(!ROOT_016)('a real 0.16.0 worker: refused while it polls; gone by SIGTERM, the cleanup runs', async () => {
      const { storage, b } = await movedStore(mk);
      const child = await worker016(name, b.target, 3000);
      try {
        await expect(cleanupOf(storage).run()).rejects.toThrow(/1 worker of an earlier version/);
        expect(await qjobCount(storage.work!)).toBe(1);
      } finally { await child.stop('SIGTERM'); }
      // 0.16.0's close takes its entry back: no wait for its ttl.
      expect(Object.keys((await storage.work!.get<Record<string, unknown>>(PRESENCE)) ?? {})).toEqual([]);
      expect(await cleanupOf(storage).run()).toMatchObject({ removed: 1 });
      expect(await storage.work!.get('qversion')).toEqual({ version: 3 });
    }, 60_000);

    it.skipIf(!ROOT_016)('a real 0.16.0 worker killed (SIGKILL): refused until its entry expires, then the cleanup runs', async () => {
      const { storage, b } = await movedStore(mk);
      const child = await worker016(name, b.target, 2000);
      await child.stop('SIGKILL');
      await expect(cleanupOf(storage).run()).rejects.toThrow(/1 worker of an earlier version/);
      await untilTrue(async () => (await cleanupOf(storage).plan()).olderWorkers === undefined, 10_000);
      expect(await cleanupOf(storage).run()).toMatchObject({ removed: 1 });
    }, 60_000);
  });
}

/** One 0.16.0 worker in a child (fixtures/k5-q016-worker.mjs), polling `target`; resolved once its presence is written. */
async function worker016(kind: string, target: string, ttlMs: number): Promise<{ stop(sig: 'SIGTERM' | 'SIGKILL'): Promise<void> }> {
  const p = spawn(process.execPath, [join(here, 'fixtures', 'k5-q016-worker.mjs'), kind, target, String(ttlMs)], { env: { ...process.env, GNL_016_ROOT: ROOT_016! }, stdio: ['ignore', 'pipe', 'pipe'] });
  const exited = new Promise<void>((r) => p.on('exit', () => r()));
  ends.push(async () => { if (p.exitCode === null && p.signalCode === null) { p.kill('SIGKILL'); await exited; } });
  await new Promise<void>((resolve, reject) => {
    let err = '';
    p.stdout!.on('data', (d: Buffer) => { if (d.toString().includes('READY')) resolve(); });
    p.stderr!.on('data', (d: Buffer) => { err += d.toString(); });
    p.on('exit', (code) => reject(new Error(`0.16.0 worker exited ${code} before ready: ${err}`)));
  });
  return { stop: async (sig) => { p.kill(sig); await exited; } };
}

/** Counts the writing port calls made on `work` from now on; returns the reader. */
function countWrites(work: WorkStore): () => number {
  let n = 0;
  for (const m of ['put', 'append', 'appendReady', 'appendMany', 'ackOnce', 'putIfMatch', 'deletePrefix', 'deleteIdPrefix', 'dropReady']) {
    const f = (work as any)[m];
    if (typeof f !== 'function') continue;
    (work as any)[m] = (...a: unknown[]) => { n++; return f.apply(work, a); };
  }
  return () => n;
}
