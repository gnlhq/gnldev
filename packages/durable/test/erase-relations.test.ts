// A run's person and thread, and a thread owner record's person, are columns the ADAPTER fills in the
// write that puts the record (`runRelationsOf`, `ownerColumnOf`); a row with NULL is "not placed yet"
// and every lookup reads it and decides from the record. These are the promises that design has to
// keep, on every store that has the columns and on the ones that do not:
//
//  S1 erasing a person removes every run of theirs — on threads, without a thread, on a cloned
//     sub-thread, and runs written the way an OLDER process writes them (no columns) — and nothing of
//     anyone else;
//  S2 a person's run list ("my runs") is exactly their runs, unplaced ones included, page after page,
//     in both orders; a thread's run list likewise;
//  S3 the same inside an organization, and an organization's person is not the root's;
//  S4 a thread owner record an older process wrote (no owner column) is still found by the erasure;
//  S5 a writer that is not the engine (a raw `put` of a run's `:input`, of an owner record) is found;
//  S6 an erasure whose run listing fails THROWS — it used to report success with nothing erased;
//  S7 runs derived from another — a fork, a rollover — are the person's too and go with them.
//
// The world is the same on every store. The "older process" writes with the exact statements of the
// previous version (no relation columns), from its own connection where the store has one. Nothing
// here runs the `relations` upgrade step before asking: correctness must not depend on it. A last case
// runs it and asks again — the same answers, now from placed rows.
//
// Stores: InMemory, Sqlite (a file, the older process on a second connection), Postgres on pg-mem.
// With GNL_PG_URL also a real Postgres, in a database this file creates and drops.
import { describe, it, expect, afterAll, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRequire } from 'node:module';
import { newDb } from 'pg-mem';
import pg from 'pg';
import {
  InMemoryStorage, toJournal, eraseSubject, purgeResource, admitThreadRun, threadOwnerKey, memKey, forkRun, rolloverRun,
  withOrg, ORG_RECORD_PRE, stampFormat, THREAD_RECORDS_KEY, type Storage,
} from '../src/index.js';
import { claimRunOwner, user } from '../src/run-identity.js';
import { SqliteStorage } from '../src/sqlite-storage.js';
import { PostgresStorage } from '../src/postgres-storage.js';
import { serialize } from '../src/serialize.js';
import { RELATIONS_PENDING_ADVICE } from '../src/upgrade.js';
import { OLD, oldSqlitePut, oldPgPut } from './older-writer.js';

const { DatabaseSync } = createRequire(import.meta.url)('node:sqlite') as { DatabaseSync: new (path: string) => any };
const PG_URL = process.env.GNL_PG_URL;

const ends: Array<() => Promise<void> | void> = [];
afterAll(async () => { for (const e of ends.reverse()) await e(); });

interface Backend {
  storage: Storage;
  /** A process of the previous version writing one key: its statements, no relation columns. */
  oldPut(key: string, value: unknown): Promise<void>;
  /** `gnl_runs.resource_id` of a run, where the store has the column (`null` = not placed). */
  placedPerson?(runId: string): Promise<string | null | undefined>;
  relations: boolean;
  /**
   * false: the SQL cannot compare rows — `(created_at, run_id) > (…)`, the keyset a run list pages by
   * when it walks (pg-mem; see storage-backend.test.ts). Paged walks are proven on the real backends.
   */
  rowValues?: boolean;
  /** Sqlite: the file. */
  file?: string;
  /** Postgres (real): the schema this backend's pools are on. */
  schema?: string;
  /** false: the store cannot keep the relation columns true (no triggers: pg-mem) and never places or reads them. */
  guarded?: boolean;
  /** Postgres: a statement on the store's database, from the older process's connection. */
  sql?(text: string): Promise<{ rows: any[] }>;
}

function sqliteBackend(): Backend {
  const dir = mkdtempSync(join(tmpdir(), 'gnl-relations-'));
  const file = join(dir, 'shared.db');
  const storage = new SqliteStorage(file);
  const old = new DatabaseSync(file);
  old.exec('PRAGMA busy_timeout = 5000');
  ends.push(() => { old.close(); storage.close?.(); rmSync(dir, { recursive: true, force: true }); });
  return {
    storage,
    relations: true,
    file,
    async oldPut(key, value) { oldSqlitePut(old, key, value); },
    async placedPerson(runId) {
      return (old.prepare('SELECT resource_id FROM gnl_runs WHERE run_id = ?').get(runId) as { resource_id: string | null } | undefined)?.resource_id;
    },
  };
}

function pgBackend(storagePool: any, oldPool: any): Backend {
  const storage = new PostgresStorage({ pool: storagePool });
  return {
    storage,
    relations: true,
    async oldPut(key, value) {
      await storage.init();
      await oldPgPut(oldPool, key, value);
    },
    async placedPerson(runId) {
      const r = await oldPool.query('SELECT resource_id FROM gnl_runs WHERE run_id = $1', [runId]);
      return r.rows[0]?.resource_id;
    },
    sql: (text) => oldPool.query(text),
  };
}

let realDb: { admin: pg.Pool; url: string; name: string } | undefined;
let schemaSeq = 0;
async function realPgBackend(): Promise<Backend> {
  if (!realDb) {
    const name = `gnl_relations_${process.pid}_${Date.now().toString(36)}`;
    const admin = new pg.Pool({ connectionString: PG_URL, max: 1 });
    admin.on('error', () => {});
    await admin.query(`CREATE DATABASE ${name}`);
    const u = new URL(PG_URL!);
    u.pathname = `/${name}`;
    realDb = { admin, url: u.toString(), name };
    ends.push(async () => {
      await admin.query(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`);
      await admin.end();
    });
  }
  const schema = `s${schemaSeq++}`;
  const setup = new pg.Pool({ connectionString: realDb.url, max: 1 });
  await setup.query(`CREATE SCHEMA ${schema}`);
  await setup.end();
  const pool = new pg.Pool({ connectionString: realDb.url, max: 4, options: `-c search_path=${schema}` });
  const oldPool = new pg.Pool({ connectionString: realDb.url, max: 2, options: `-c search_path=${schema}` });
  for (const p of [pool, oldPool]) p.on('error', () => {});
  ends.push(async () => { await oldPool.end(); await pool.end(); });
  return { ...pgBackend(pool, oldPool), schema };
}

const BACKENDS: Array<[string, () => Promise<Backend>]> = [
  ['InMemory', async () => {
    const storage = new InMemoryStorage();
    // No columns, no rows to place: an older process writes exactly what this one does.
    return { storage, relations: false, oldPut: (k, v) => storage.runs.put(k, v) };
  }],
  ['Sqlite', async () => sqliteBackend()],
  // pg-mem has no triggers, so it never trusts the relation columns and walks (see PrefixShape.relationGuard).
  ['Postgres (pg-mem)', async () => { const { Pool } = newDb().adapters.createPg(); const pool = new Pool(); return { ...pgBackend(pool, pool), rowValues: false, guarded: false }; }],
];
if (PG_URL) BACKENDS.push(['Postgres (real)', realPgBackend]);

const input = (fields: Record<string, unknown>) => stampFormat({ at: 1, ...fields });

/** Every key and its value as text — what an erasure leaves behind. */
async function dump(storage: Storage): Promise<string[]> {
  const j = toJournal(storage.runs);
  const keys = await j.listKeys('');
  return Promise.all(keys.map(async (k) => `${k}=${JSON.stringify(await j.get(k))}`));
}

/** Every run whose `:input` names `who`, decided from the records by a full walk — the expected answer. */
async function runsNamedBy(storage: Storage, who: string): Promise<string[]> {
  const j = toJournal(storage.runs);
  const out: string[] = [];
  let cursor: string | undefined;
  do {
    const page = await j.listRunsPaged!({ limit: 100, ...(cursor ? { cursor } : {}) });
    for (const r of page.items) if ((await j.get<{ resourceId?: string }>(`${r.runId}:input`))?.resourceId === who) out.push(r.runId);
    cursor = page.nextCursor;
  } while (cursor);
  return out.sort();
}

/** A run list walked to its end, page by page. */
async function walk(storage: Storage, q: { resourceId?: string; threadId?: string; order?: 'asc' | 'desc' }, limit = 2): Promise<string[]> {
  const j = toJournal(storage.runs);
  const out: string[] = [];
  let cursor: string | undefined;
  do {
    const page = await j.listRunsPaged!({ ...q, limit, ...(cursor ? { cursor } : {}) });
    out.push(...page.items.map((r) => r.runId));
    cursor = page.nextCursor;
  } while (cursor);
  return out;
}

/**
 * The world. Every secret names whose it is, so what survives is read off the dump. `AYSE` is the root
 * ayse's; `ACME-AYSE` is ayse's in organization acme (somebody else); `GLOBEX-AYSE` in globex; `BOB` and
 * `EVIL` are other people.
 */
async function world(b: Backend): Promise<{ forkId: string; rolloverId: string }> {
  const s = b.storage;
  await s.init?.();
  const j = toJournal(s.runs);
  const mem = s.memory; // a store without a memory port keeps its threads in the journal
  const born = async (journal: any, runId: string, who: string, secret: string, threadId?: string) => {
    if (threadId) await admitThreadRun(journal, undefined, threadId, user(who));
    await claimRunOwner(journal, runId, user(who), threadId ? { threadId } : {});
    await journal.put(`${runId}:model:0`, { role: 'assistant', content: [{ type: 'text', text: `${secret} said something` }] });
  };
  // S1 — runs the engine wrote: on two threads, without a thread, on a cloned sub-thread.
  for (let i = 0; i < 4; i++) await born(j, `ay-r${i}`, 'ayse', 'AYSE', `ay-th-${i % 2}`);
  await born(j, 'ay-nothread', 'ayse', 'AYSE');
  await mem?.upsertThread({ id: 'ay-th-0', resourceId: 'ayse', createdAt: 1, updatedAt: 1 });
  await mem?.upsertThread({ id: 'ay-th-1', resourceId: 'ayse', createdAt: 1, updatedAt: 1 });
  await mem?.upsertThread({ id: 'ay-clone', resourceId: 'ayse', parentThreadId: 'ay-th-0', createdAt: 2, updatedAt: 2 });
  await born(j, 'ay-clone-r', 'ayse', 'AYSE', 'ay-clone');
  // S1/S4 — what an OLDER process wrote after this version's columns existed: runs and an owner record
  // with no columns, and the journal-kept messages of that thread (BasicMemory).
  await b.oldPut('ay-old1:input', input({ resourceId: 'ayse', threadId: 'ay-old-th' }));
  await b.oldPut('ay-old1:model:0', { text: 'AYSE old process' });
  await b.oldPut('ay-old2:input', input({ resourceId: 'ayse' }));
  await b.oldPut('ay-old2:model:0', { text: 'AYSE old process, no thread' });
  await b.oldPut(threadOwnerKey('ay-old-th'), { at: 1, resourceId: 'ayse' });
  await b.oldPut(memKey('ay-old-th', 'messages'), [{ role: 'user', text: 'AYSE kept in the journal' }]);
  // …and a thread only its record leads to: no run of hers on it, no memory store row.
  await b.oldPut(threadOwnerKey('ay-old-only-th'), { at: 1, resourceId: 'ayse' });
  await b.oldPut(memKey('ay-old-only-th', 'messages'), [{ role: 'user', text: 'AYSE reached by its owner record alone' }]);
  // S5 — a writer that is not the engine, through this version's adapter.
  await j.put('ext-1:input', input({ resourceId: 'ayse', threadId: 'ext-th' }));
  await j.put('ext-1:model:0', { text: 'AYSE from another writer' });
  await j.put(threadOwnerKey('ext-th'), { at: 1, resourceId: 'ayse' });
  await j.put(memKey('ext-th', 'messages'), [{ role: 'user', text: 'AYSE another writer kept this' }]);
  // S7 — a fork and a rollover of ayse's runs.
  const forkId = (await forkRun(j as any, 'ay-r0', 1, 'ay-fork')).newRunId;
  const rolloverId = (await rolloverRun(j, 'ay-r1')).newRunId;
  // Other people: bob (engine and older process), a namesake whose id starts with bob's.
  await born(j, 'bob-r1', 'bob', 'BOB', 'bob-th');
  await b.oldPut('bob-old:input', input({ resourceId: 'bob', threadId: 'bob-th' }));
  await b.oldPut('bob-old:model:0', { text: 'BOB old process' });
  await born(j, 'evil-r1', 'bob:evil', 'EVIL', 'evil-th');
  // S3 — the same id in two organizations: somebody else in each, and not the root's ayse.
  for (const org of ['acme', 'globex']) {
    await j.put(ORG_RECORD_PRE + org, { label: org });
    const oj = withOrg(j, org);
    const tag = `${org.toUpperCase()}-AYSE`;
    await born(oj, `${org}-ay-1`, 'ayse', tag, `${org}-th`);
    await b.oldPut(`org:${org}:${org}-ay-old:input`, input({ resourceId: 'ayse', threadId: `${org}-th` }));
    await b.oldPut(`org:${org}:${org}-ay-old:model:0`, { text: `${tag} old process` });
    await b.oldPut(`org:${org}:${threadOwnerKey(`${org}-old-th`)}`, { at: 1, resourceId: 'ayse' });
    await b.oldPut(`org:${org}:${memKey(`${org}-old-th`, 'messages')}`, [{ role: 'user', text: `${tag} kept in the journal` }]);
  }
  return { forkId, rolloverId };
}

/** The rows carrying `tag` as a whole word: `AYSE` is not found inside `ACME-AYSE`. */
const has = (rows: string[], tag: string) => rows.filter((r) => new RegExp(`(^|[^A-Z-])${tag} `).test(r));

for (const [name, make] of BACKENDS) {
  describe(`a person's runs and threads, by relation — ${name}`, () => {
    it('places what this version writes, leaves what an older process writes unplaced (the world the scenarios run on)', async () => {
      const b = await make();
      await world(b);
      if (!b.relations) return;
      expect(await b.placedPerson!('ay-r0')).toBe('ayse');
      expect(await b.placedPerson!('ext-1')).toBe('ayse');      // S5: placed by the adapter, not the engine
      expect(await b.placedPerson!('ay-fork')).toBe('ayse');    // S7
      expect(await b.placedPerson!('ay-old1')).toBeNull();      // the older process's: not placed
      expect(await b.placedPerson!('bob-old')).toBeNull();
    });

    it('S2: my runs — exactly the person\'s runs, unplaced ones included, page after page, in both orders; a thread\'s likewise', async () => {
      const b = await make();
      if (b.rowValues === false) return;
      const { forkId, rolloverId } = await world(b);
      const expected = await runsNamedBy(b.storage, 'ayse');
      // The expectation is the records' own answer; it holds the runs this test is about.
      for (const id of ['ay-old1', 'ay-old2', 'ext-1', 'ay-nothread', 'ay-clone-r', forkId, rolloverId]) expect(expected).toContain(id);
      const asc = await walk(b.storage, { resourceId: 'ayse' });
      expect([...asc].sort()).toEqual(expected);
      expect(new Set(asc).size).toBe(asc.length);                 // no run twice across pages
      const desc = await walk(b.storage, { resourceId: 'ayse', order: 'desc' });
      expect(desc).toEqual([...asc].reverse());
      expect((await walk(b.storage, { threadId: 'ay-old-th' })).sort()).toEqual(['ay-old1']);
      expect((await walk(b.storage, { threadId: 'ay-th-0' })).sort()).toEqual(['ay-fork', 'ay-r0', 'ay-r2']);
      expect((await walk(b.storage, { resourceId: 'bob' })).sort()).toEqual(['bob-old', 'bob-r1']);
    });

    it('S1, S4, S5, S7: erasing a person removes every run and thread of theirs — older process\'s included — and nothing of anyone else', async () => {
      const b = await make();
      await world(b);
      const before = await dump(b.storage);
      expect(has(before, 'AYSE').length).toBeGreaterThan(10);
      const report = await eraseSubject(b.storage, 'ayse');
      const after = await dump(b.storage);
      expect(has(after, 'AYSE'), JSON.stringify(has(after, 'AYSE'))).toEqual([]);
      expect(after.filter((r) => r.includes('"resourceId":"ayse"') && !r.startsWith('org:'))).toEqual([]);
      // S4/S5: the owner records went, with the journal-kept threads they lead to.
      for (const t of ['ay-old-th', 'ay-old-only-th', 'ext-th']) {
        expect(after.some((r) => r.startsWith(`${threadOwnerKey(t)}=`))).toBe(false);
        expect(after.some((r) => r.startsWith(`${memKey(t, 'messages')}=`))).toBe(false);
      }
      // A thread whose record names ayse and that no store held is reported, never silently dropped —
      // on a store without a memory, the engine's threads (their messages lived nowhere here).
      expect(report.unreachedThreads).toEqual(b.storage.memory ? [] : ['ay-clone', 'ay-th-0', 'ay-th-1']);
      // Nothing of anyone else: every other person's row is still there, byte for byte.
      for (const tag of ['BOB', 'EVIL', 'ACME-AYSE', 'GLOBEX-AYSE']) expect(has(after, tag)).toEqual(has(before, tag));
    });

    it('S3: erasing a person inside an organization takes theirs there, and neither the root\'s namesake nor another organization\'s', async () => {
      const b = await make();
      await world(b);
      const before = await dump(b.storage);
      await eraseSubject(b.storage, 'ayse', { orgId: 'acme' });
      const after = await dump(b.storage);
      expect(has(after, 'ACME-AYSE')).toEqual([]);
      expect(after.some((r) => r.startsWith(`org:acme:${threadOwnerKey('acme-old-th')}=`))).toBe(false);
      for (const tag of ['AYSE', 'GLOBEX-AYSE', 'BOB']) expect(has(after, tag)).toEqual(has(before, tag));
      // The organization's own listing of its person, unplaced runs included, before and after.
      const acme = withOrg(toJournal(b.storage.runs), 'acme');
      expect((await acme.listRunsPaged!({ resourceId: 'ayse', limit: 10 })).items).toEqual([]);
      const globex = withOrg(toJournal(b.storage.runs), 'globex');
      expect((await globex.listRunsPaged!({ resourceId: 'ayse', limit: 10 })).items.map((r) => r.runId).sort()).toEqual(['globex-ay-1', 'globex-ay-old']);
    });

    it('S4b: an owner record an older process REWROTE to another person is found by that person\'s erasure', async () => {
      const b = await make();
      await b.storage.init?.();
      const j = toJournal(b.storage.runs);
      // This version writes the record (placed under ayse); an older process then hands the thread to
      // carl with its own statement, which rewrites the value and knows nothing of the owner column.
      await j.put(threadOwnerKey('mv-th'), { at: 1, resourceId: 'ayse' });
      await j.put(memKey('mv-th', 'messages'), [{ role: 'user', text: 'CARL kept on a moved thread' }]);
      await b.oldPut(threadOwnerKey('mv-th'), { at: 2, resourceId: 'carl' });
      await eraseSubject(b.storage, 'carl');
      const after = await dump(b.storage);
      expect(after.some((r) => r.startsWith(`${threadOwnerKey('mv-th')}=`))).toBe(false);
      expect(has(after, 'CARL')).toEqual([]);
    });

    it('S1b: a run whose :input an older process REWROTE to another person and thread is that person\'s and that thread\'s', async () => {
      const b = await make();
      await b.storage.init?.();
      const j = toJournal(b.storage.runs);
      await j.put('rw1:input', input({ resourceId: 'ayse', threadId: 'rw-t1' }));    // this version: placed ayse / rw-t1
      await j.put('rw1:model:0', { text: 'CARL said this on a rewritten run' });
      await b.oldPut('rw1:input', input({ resourceId: 'carl', threadId: 'rw-t2' })); // an older process's statement
      expect(await walk(b.storage, { resourceId: 'carl' })).toEqual(['rw1']);
      expect(await walk(b.storage, { threadId: 'rw-t2' })).toEqual(['rw1']);
      expect(await walk(b.storage, { resourceId: 'ayse' })).toEqual([]);
      await eraseSubject(b.storage, 'carl');
      expect(has(await dump(b.storage), 'CARL')).toEqual([]);
    });

    it('S1c: an unversioned :input put over a placed one names whom the listing says it names', async () => {
      const b = await make();
      await b.storage.init?.();
      const j = toJournal(b.storage.runs);
      await j.put('rw2:input', input({ resourceId: 'ayse' }));
      await j.put('rw2:input', { resourceId: 'carl', threadId: 'rw-t9' });          // 0.6-shaped, through this version
      // The filter-before-slice contract: a filtered listing is the unfiltered one, filtered.
      const all = (await j.listRunsPaged!({ limit: 50 })).items;
      for (const who of ['carl', 'ayse']) {
        expect(await walk(b.storage, { resourceId: who })).toEqual(all.filter((r) => r.resourceId === who).map((r) => r.runId));
      }
      expect(await walk(b.storage, { resourceId: 'ayse' })).toEqual([]);
    });

    it('a tool record whose key ends in :input is r9\'s, not a run of its own — through applyBatch too', async () => {
      const b = await make();
      await b.storage.init?.();
      const j = toJournal(b.storage.runs);
      await j.put('r9:input', input({ resourceId: 'ayse' }));
      await j.applyBatch!({ puts: [{ key: 'r9:tool:call:input', value: input({ resourceId: 'ayse', status: 'ok' }) }] } as never);
      expect((await j.listRunsPaged!({ limit: 50 })).items.map((r) => r.runId)).toEqual(['r9']);
      expect(await walk(b.storage, { resourceId: 'ayse' })).toEqual(['r9']);
    });

    it('a run with no :input stays unplaced (no record says whose it is), and an :input that comes later is found and erased', async () => {
      const b = await make();
      await b.storage.init?.();
      const j = toJournal(b.storage.runs);
      await j.put('nx:model:0', { text: 'a step of a run driven without run()' });
      await b.oldPut('ox:model:0', { text: 'the same, by an older process' });
      if (b.relations) {
        expect(await b.placedPerson!('nx')).toBeNull();
        expect(await b.placedPerson!('ox')).toBeNull();
        // Nothing for the step to place, and so nothing pending: no command would place these.
        expect((await b.storage.upgrade!({ dryRun: true })).steps.find((x) => x.name === 'relations')?.pending).toBe(false);
      }
      await b.oldPut('ox:input', input({ resourceId: 'carl', threadId: 'ox-t' }));
      await b.oldPut('ox:model:1', { text: 'CARL wrote on ox' });
      expect(await walk(b.storage, { resourceId: 'carl' })).toEqual(['ox']);
      await eraseSubject(b.storage, 'carl');
      expect(has(await dump(b.storage), 'CARL')).toEqual([]);
    });

    it('S8: the thread gate sees a run an older process moved onto a thread with no record — another person is refused', async () => {
      const b = await make();
      await b.storage.init?.();
      const j = toJournal(b.storage.runs);
      await j.put('seed:input', input({ resourceId: 'zed' }));                        // the scope is not empty
      await j.put('rw3:input', input({ resourceId: 'carl', threadId: 'rw-tA' }));
      await b.oldPut('rw3:input', input({ resourceId: 'carl', threadId: 'rw-tB' }));
      await expect(admitThreadRun(j, undefined, 'rw-tB', user('dave'))).rejects.toThrow();
    });

    if (name !== 'InMemory') {
      it('the relations step places the older rows; every answer is the same before and after it, and it is idempotent', async () => {
        const b = await make();
        if (b.rowValues === false) return;
        await world(b);
        const myRuns = await walk(b.storage, { resourceId: 'ayse' });
        const ownerKeys = await toJournal(b.storage.runs).listOwnerRecords!('ayse', { prefix: 'thread:' });
        const dry = await b.storage.upgrade!({ dryRun: true });
        expect(dry.steps.find((s) => s.name === 'relations')?.pending).toBe(true);
        const ran = await b.storage.upgrade!({ only: ['relations'] });
        const detail = ran.steps.find((s) => s.name === 'relations')!.detail as { runs: number; owners: number };
        expect(detail.runs).toBeGreaterThanOrEqual(5);              // ay-old1, ay-old2, bob-old, the two organizations'
        expect(detail.owners).toBeGreaterThanOrEqual(3);            // ay-old-th, acme's and globex's
        expect(await b.placedPerson!('ay-old1')).toBe('ayse');
        expect(await b.placedPerson!('bob-old')).toBe('bob');
        expect(await walk(b.storage, { resourceId: 'ayse' })).toEqual(myRuns);
        expect((await toJournal(b.storage.runs).listOwnerRecords!('ayse', { prefix: 'thread:' })).sort()).toEqual([...ownerKeys].sort());
        expect((await b.storage.upgrade!({ dryRun: true })).steps.find((s) => s.name === 'relations')?.pending).toBe(false);
        const again = await b.storage.upgrade!({ only: ['relations'] });
        expect(again.steps.find((s) => s.name === 'relations')?.ran).toBe(false);
      });
    }
  });
}

describe('a store with runs from before the columns says so at boot — the slow lookups and the one command', () => {
  const warned = async (open: () => Promise<unknown>) => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try { await open(); return warn.mock.calls.some((c) => c[0] === RELATIONS_PENDING_ADVICE); } finally { warn.mockRestore(); }
  };

  it('Sqlite: an older process\'s run → the next open warns; once placed, or on a fresh file, it does not', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'gnl-relations-warn-'));
    const file = join(dir, 'shared.db');
    const open = () => { const st = new SqliteStorage(file); ends.push(() => st.close?.()); return st; };
    ends.push(() => rmSync(dir, { recursive: true, force: true }));
    let first!: SqliteStorage;
    expect(await warned(async () => { first = open(); })).toBe(false);
    const old = new DatabaseSync(file);
    ends.push(() => old.close());
    const now = Date.now();
    old.prepare(OLD.sqliteJournal).run('w-old:input', 'w-old', 'input', 0, serialize(input({ resourceId: 'ayse' })), now);
    old.prepare(OLD.sqliteRun).run('w-old', now, now);
    expect(await warned(async () => open())).toBe(true);
    await first.upgrade!({ only: ['relations'] });
    expect(await warned(async () => open())).toBe(false);
  });

  it.runIf(!!PG_URL)('Postgres (real): likewise at its first query', async () => {
    const b = await realPgBackend();
    const pool = (b.storage as unknown as { pool: pg.Pool }).pool;
    expect(await warned(() => b.storage.init!())).toBe(false);
    await b.oldPut('w-old:input', input({ resourceId: 'ayse' }));
    expect(await warned(() => new PostgresStorage({ pool }).init())).toBe(true);
    await b.storage.upgrade!({ only: ['relations'] });
    expect(await warned(() => new PostgresStorage({ pool }).init())).toBe(false);
  });
});

describe('Sqlite: guards dropped by hand are not trusted on the next open, and the relations step repairs what they missed', () => {
  it('R2-F3 (Sqlite)', async () => {
    const b = sqliteBackend();
    const j = toJournal(b.storage.runs);
    await j.put('g1:input', input({ resourceId: 'ayse', threadId: 'g-t1' }));
    const file = b.file!;
    const hand = new DatabaseSync(file);
    ends.push(() => hand.close());
    for (const t of ['gnl_owner_unplace', 'gnl_run_unplace_insert', 'gnl_run_unplace_update']) hand.exec(`DROP TRIGGER ${t}`);
    await b.oldPut('g1:input', input({ resourceId: 'carl', threadId: 'g-t2' }));      // missed: no guard
    const next = new SqliteStorage(file);
    ends.push(() => next.close?.());
    expect(await walk(next, { resourceId: 'carl' })).toEqual(['g1']);
    expect((await next.upgrade!({ dryRun: true })).steps.find((x) => x.name === 'relations')?.pending).toBe(true);
    await next.upgrade!({ only: ['relations'] });
    expect(await b.placedPerson!('g1')).toBe('carl');
    expect(await walk(next, { resourceId: 'ayse' })).toEqual([]);
  });
});

describe('Sqlite: verify-relations sets right a placement written behind the triggers\' back', () => {
  it('a row placed by hand under the wrong person is placed again from its record', async () => {
    const b = sqliteBackend();
    const j = toJournal(b.storage.runs);
    await j.put('h1:input', input({ resourceId: 'carl', threadId: 'h-t' }));
    const hand = new DatabaseSync(b.file!);
    ends.push(() => hand.close());
    hand.exec(`UPDATE gnl_runs SET resource_id = 'ayse', thread_id = 'x' WHERE run_id = 'h1'`);
    expect(await walk(b.storage, { resourceId: 'carl' })).toEqual([]);   // what a bypass leaves
    await b.storage.upgrade!({ only: ['verify-relations'] });
    expect(await b.placedPerson!('h1')).toBe('carl');
    expect(await walk(b.storage, { resourceId: 'carl' })).toEqual(['h1']);
  });
});

describe('4A-F5: the relations step runs a page again when Postgres aborts it for a deadlock', () => {
  it('one 40P01 on a page: the step still places every run', async () => {
    const { Pool } = newDb().adapters.createPg();
    const raw = new Pool();
    let left = 1;
    const fail = (q: (...a: any[]) => any) => async (...a: any[]) => {
      if (left > 0 && typeof a[0] === 'string' && a[0].includes('SET resource_id = CASE run_id')) {
        left--;
        throw Object.assign(new Error('deadlock detected'), { code: '40P01' });
      }
      return q(...a);
    };
    const pool = {
      query: fail(raw.query.bind(raw)),
      connect: async () => { const c = await raw.connect(); (c as any).query = fail(c.query.bind(c)); return c; },
      on: () => {}, end: () => raw.end(), options: { max: 4 },
    };
    const b = pgBackend(pool, raw);
    await b.oldPut('dl1:input', input({ resourceId: 'ayse' }));
    const r = await b.storage.upgrade!({ only: ['relations'] });
    expect(left).toBe(0);                                                   // the abort happened
    expect((r.steps.find((x) => x.name === 'relations')!.detail as { runs: number }).runs).toBe(1);
    expect(await b.placedPerson!('dl1')).toBe('ayse');
  });
});

describe('4B-F3: a custom journal written to the older listing contract (no threadId filter) gets exact answers', () => {
  // A third-party journal: listRunsPaged honours the filters it knew before this release and ignores threadId.
  const olderContract = () => {
    const inner = new InMemoryStorage();
    const runs = new Proxy(inner.runs, {
      get(t, k, r) {
        // RunJournal.listRuns — what toJournal pages through — passing on only the filters it knew.
        if (k === 'listRuns') return (q: Record<string, unknown> = {}) => { const { threadId: _ignored, ...rest } = q; return t.listRuns(rest as never); };
        const v = Reflect.get(t, k, r);
        return typeof v === 'function' ? v.bind(t) : v;
      },
    });
    return { ...inner, runs, memory: inner.memory } as unknown as InstanceType<typeof InMemoryStorage>;
  };

  for (const scope of ['root', 'acme'] as const) it(`the thread gate admits bob on a new thread, and erasing ayse removes her thread (${scope}, a scope from before thread records)`, async () => {
    const s = olderContract();
    const root = toJournal(s.runs);
    if (scope === 'acme') await root.put(ORG_RECORD_PRE + 'acme', { label: 'acme' });
    const j = scope === 'acme' ? withOrg(root, 'acme') : root;
    // What an older version left: a run of ayse's on tA, its journal-kept messages, no owner record, no mark.
    await j.put('a1:input', input({ resourceId: 'ayse', threadId: 'tA' }));
    await j.put(memKey('tA', 'messages'), [{ role: 'user', text: 'AYSE on tA' }]);
    await j.deletePrefix!(THREAD_RECORDS_KEY);
    expect(await j.get(THREAD_RECORDS_KEY)).toBeUndefined();
    await expect(admitThreadRun(j, undefined, 'tB', user('bob'))).resolves.toBeTruthy();
    expect(((await j.get(threadOwnerKey('tB'))) as { resourceId?: string } | undefined)?.resourceId).toBe('bob');
    await eraseSubject(s as never, 'ayse', scope === 'acme' ? { orgId: 'acme' } : {});
    expect(await j.get(memKey('tA', 'messages'))).toBeUndefined();
  });
});

describe('4B-F4 (Sqlite): a guard trigger with another body is replaced on open, and what it missed is repaired', () => {
  it('a hand-edited run guard', async () => {
    const b = sqliteBackend();
    await toJournal(b.storage.runs).put('g1:input', input({ resourceId: 'ayse', threadId: 'g-t1' }));
    const hand = new DatabaseSync(b.file!);
    ends.push(() => hand.close());
    hand.exec(`DROP TRIGGER gnl_run_unplace_update`);
    hand.exec(`CREATE TRIGGER gnl_run_unplace_update AFTER UPDATE OF value ON gnl_run_journal BEGIN SELECT 1; END`);
    await b.oldPut('g1:input', input({ resourceId: 'carl', threadId: 'g-t2' }));
    expect(await b.placedPerson!('g1')).toBe('ayse');
    const next = new SqliteStorage(b.file!);
    ends.push(() => next.close?.());
    expect((hand.prepare(`SELECT sql FROM sqlite_master WHERE name = 'gnl_run_unplace_update'`).get() as { sql: string }).sql).toContain('SET resource_id = NULL');
    expect(await walk(next, { resourceId: 'carl' })).toEqual(['g1']);
    await next.upgrade!({ only: ['relations'] });
    expect(await b.placedPerson!('g1')).toBe('carl');
  });
});

describe('S6: an erasure whose run listing fails throws — it does not report success', () => {
  it('purgeResource rejects when the person\'s run listing fails, and the run is still there to retry', async () => {
    const s = new InMemoryStorage();
    const j = toJournal(s.runs);
    await claimRunOwner(j, 'r1', user('ayse'));
    await j.put('r1:model:0', { text: 'AYSE' });
    const failing = new Proxy(j, {
      get(t, p) {
        if (p === 'listRunsPaged') return async () => { throw new Error('connection reset while listing'); };
        const v = Reflect.get(t, p, t);
        return typeof v === 'function' ? v.bind(t) : v;
      },
    });
    await expect(purgeResource(failing, 'ayse')).rejects.toThrow(/connection reset/);
    expect(await j.get('r1:model:0')).toEqual({ text: 'AYSE' });
  });
});

if (PG_URL) {
  describe('Postgres (real): the schema step adds an index an existing table lacks', () => {
    it('reports the missing relation indexes and builds them CONCURRENTLY, then the schema is whole', async () => {
      const b = await realPgBackend();
      const pgs = b.storage as PostgresStorage;
      await pgs.init();
      await b.sql!('DROP INDEX gnl_runs_resource');
      await b.sql!('DROP INDEX gnl_run_journal_owner');
      const before = await pgs.checkSchema();
      expect(before.ok).toBe(false);
      expect(before.missingIndexes!.sort()).toEqual(['gnl_run_journal_owner', 'gnl_runs_resource']);
      const ran = await pgs.upgrade({ only: ['schema'] });
      const statements = (ran.steps.find((x) => x.name === 'schema')!.detail as { statements: string[] }).statements;
      expect(statements).toHaveLength(2);
      for (const st of statements) expect(st).toMatch(/^CREATE INDEX CONCURRENTLY IF NOT EXISTS gnl_(runs_resource|run_journal_owner) /);
      expect((await pgs.checkSchema()).ok).toBe(true);
      const valid = await b.sql!(`SELECT c.relname, i.indisvalid FROM pg_index i JOIN pg_class c ON c.oid = i.indexrelid WHERE c.relnamespace = current_schema()::regnamespace AND c.relname IN ('gnl_runs_resource', 'gnl_run_journal_owner') ORDER BY 1`);
      expect(valid.rows).toEqual([{ relname: 'gnl_run_journal_owner', indisvalid: true }, { relname: 'gnl_runs_resource', indisvalid: true }]);
    });

    it('4B-F5: a role refused pg_index does not get the schema reported whole', async () => {
      const b = await realPgBackend();
      await (b.storage as PostgresStorage).init();
      const role = `gnl_rel_idx_${process.pid}_${b.schema}`;
      const admin = new pg.Pool({ connectionString: realDb!.url, max: 1 });
      admin.on('error', () => {});
      await admin.query(`CREATE ROLE ${role} LOGIN PASSWORD 'x'`);
      await admin.query(`GRANT USAGE ON SCHEMA ${b.schema} TO ${role}`);
      await admin.query(`GRANT SELECT ON ALL TABLES IN SCHEMA ${b.schema} TO ${role}`);
      await admin.query(`REVOKE SELECT ON pg_catalog.pg_index FROM PUBLIC`);
      ends.push(async () => {
        await admin.query(`GRANT SELECT ON pg_catalog.pg_index TO PUBLIC`).catch(() => {});
        await admin.query(`DROP OWNED BY ${role}`).catch(() => {});
        await admin.query(`DROP ROLE IF EXISTS ${role}`).catch(() => {});
        await admin.end();
      });
      const u = new URL(realDb!.url); u.username = role; u.password = 'x';
      const ro = new pg.Pool({ connectionString: u.toString(), max: 1, options: `-c search_path=${b.schema}` });
      ro.on('error', () => {});
      ends.push(() => ro.end());
      const check = await new PostgresStorage({ pool: ro }).checkSchema();
      await admin.query(`GRANT SELECT ON pg_catalog.pg_index TO PUBLIC`);
      expect(check.ok).toBe(false);
    });

    it('an INVALID index (a concurrent build that failed) is reported missing and rebuilt, not taken as present', async () => {
      const b = await realPgBackend();
      const pgs = b.storage as PostgresStorage;
      await pgs.init();
      // What a failed CREATE INDEX CONCURRENTLY leaves behind: the index in the catalog, not valid.
      await b.sql!(`UPDATE pg_index SET indisvalid = false, indisready = false WHERE indexrelid = 'gnl_runs_resource'::regclass`);
      const before = await pgs.checkSchema();
      expect(before.ok).toBe(false);
      expect(before.missingIndexes).toEqual(['gnl_runs_resource']);
      expect((await pgs.upgrade({ dryRun: true })).steps.find((x) => x.name === 'schema')?.pending).toBe(true);
      await pgs.upgrade({ only: ['schema'] });
      expect((await pgs.checkSchema()).ok).toBe(true);
      const valid = await b.sql!(`SELECT i.indisvalid FROM pg_index i WHERE i.indexrelid = 'gnl_runs_resource'::regclass`);
      expect(valid.rows).toEqual([{ indisvalid: true }]);
    });
  });
}

if (PG_URL) {
  describe('Postgres (real): the guards hold whatever the writer\'s search_path, and a store found unguarded repairs itself', () => {
    const rewrite = (b: Backend, schema: string) => b.sql!(
      `UPDATE ${schema}.gnl_run_journal SET value = '${serialize(input({ resourceId: 'carl', threadId: 'g-t2' })).replace(/'/g, "''")}' WHERE key = 'g1:input'`,
    );

    it('R2-F1b: a write to another schema\'s journal unplaces THAT schema\'s run', async () => {
      const b0 = await realPgBackend();
      const b1 = await realPgBackend();
      for (const b of [b0, b1]) await toJournal(b.storage.runs).put('g1:input', input({ resourceId: 'ayse', threadId: 'g-t1' }));
      await rewrite(b0, b1.schema!);                       // a session on s<b0> writing s<b1> by name
      expect(await walk(b1.storage, { resourceId: 'carl' })).toEqual(['g1']);
      expect(await walk(b0.storage, { resourceId: 'ayse' })).toEqual(['g1']);
    });

    it('R2-F1a: a writer with an empty search_path (a data-only restore) can write an :input', async () => {
      const b = await realPgBackend();
      await b.storage.init!();
      const bare = new pg.Pool({ connectionString: realDb!.url, max: 1, options: '-c search_path=' });
      bare.on('error', () => {});
      ends.push(() => bare.end());
      // The rows a data-only restore copies: the journal's, then the runs'.
      const now = Date.now();
      await bare.query(
        `INSERT INTO ${b.schema}.gnl_run_journal (key, run_id, kind, suspended, value, created_at) VALUES ($1, $2, $3, false, $4, $5)`,
        ['g2:input', 'g2', 'input', serialize(input({ resourceId: 'carl' })), now],
      );
      await bare.query(
        `INSERT INTO ${b.schema}.gnl_runs (run_id, model_steps, tool_calls, suspended_count, status, created_at, updated_at) VALUES ($1, 0, 0, 0, 'completed', $2, $2)`,
        ['g2', now],
      );
      expect(await walk(b.storage, { resourceId: 'carl' })).toEqual(['g2']);
    });

    it('4A-F1: at REPEATABLE READ, a rewrite that waited on the relations step is refused or found — never left under the old person', async () => {
      const b = await realPgBackend();
      const rr = '-c default_transaction_isolation=repeatable\\ read';
      const pools = ['storage', 'writer', 'probe'].map((name) => {
        const p = new pg.Pool({ connectionString: realDb!.url, max: name === 'storage' ? 4 : 1, options: `-c search_path=${b.schema} ${rr}`, application_name: `rr4a_${name}_${b.schema}` });
        p.on('error', () => {});
        ends.push(() => p.end());
        return p;
      });
      const [raw, writer, probe] = pools as [pg.Pool, pg.Pool, pg.Pool];
      // The step, paused right before its CASE UPDATE — after it has read the page's :input rows FOR SHARE.
      let atGate!: () => void;
      const reached = new Promise<void>((r) => { atGate = r; });
      let release!: () => void;
      const gate = new Promise<void>((r) => { release = r; });
      const pause = (q: (...a: any[]) => any) => async (...a: any[]) => {
        if (typeof a[0] === 'string' && a[0].includes('SET resource_id = CASE run_id')) { atGate(); await gate; }
        return q(...a);
      };
      const gated = {
        query: pause(raw.query.bind(raw)),
        connect: async () => { const c = await raw.connect(); const q = c.query.bind(c); (c as any).query = pause(q); return c; },
        on: () => {}, end: () => raw.end(), options: { max: 4 },
      };
      const s = new PostgresStorage({ pool: gated as never });
      await s.init();
      const now = Date.now();
      await writer.query(OLD.pgJournal, ['r1:input', 'r1', 'input', false, serialize(input({ resourceId: 'ayse', threadId: 'rr-t1' })), now]);
      await writer.query(OLD.pgRun, ['r1', now, now]);
      await writer.query(OLD.pgJournal, ['r1:model:0', 'r1', 'model', false, serialize({ text: 'CARL said it on r1' }), now]);
      const step = s.upgrade({ only: ['relations'] });
      await reached;
      const w = writer.query(OLD.pgJournal, ['r1:input', 'r1', 'input', false, serialize(input({ resourceId: 'carl', threadId: 'rr-t2' })), Date.now()])
        .then(() => 'written', (e: Error) => e.message);
      for (let i = 0; i < 200; i++) {
        const r = await probe.query(`SELECT 1 FROM pg_stat_activity WHERE application_name = $1 AND wait_event_type = 'Lock'`, [`rr4a_writer_${b.schema}`]);
        if (r.rows.length) break;
        await new Promise((r2) => setTimeout(r2, 10));
      }
      release();
      await step;
      const outcome = await w;
      // Whatever the writer's outcome, the run is listed under the person its record names now.
      const rec = await toJournal(s.runs).get<{ resourceId: string; threadId: string }>('r1:input');
      expect(outcome === 'written' || /could not serialize/.test(outcome)).toBe(true);
      expect(await walk(s, { resourceId: rec!.resourceId })).toEqual(['r1']);
      expect(await walk(s, { threadId: rec!.threadId })).toEqual(['r1']);
      if (outcome === 'written') {
        await eraseSubject(s, 'carl');
        expect(await toJournal(s.runs).get('r1:model:0')).toBeUndefined();
      }
    });

    it('4A-F2: a write the triggers never saw (replica role) is set right by verify-relations, which runs only when named', async () => {
      const b = await realPgBackend();
      const j = toJournal(b.storage.runs);
      await j.put('g1:input', input({ resourceId: 'ayse', threadId: 'g-t1' }));
      await j.put('g1:model:0', { text: 'CARL said it after the move' });
      const replica = new pg.Pool({ connectionString: realDb!.url, max: 1, options: `-c search_path=${b.schema} -c session_replication_role=replica` });
      replica.on('error', () => {});
      ends.push(() => replica.end());
      await replica.query(`UPDATE gnl_run_journal SET value = $1 WHERE key = 'g1:input'`, [serialize(input({ resourceId: 'carl', threadId: 'g-t2' }))]);
      expect(await b.placedPerson!('g1')).toBe('ayse');                      // the bypass: the column still says ayse
      const all = await b.storage.upgrade!({ dryRun: true });
      expect(all.steps.find((x) => x.name === 'verify-relations')?.pending).toBe(false);       // never pending on its own
      expect((await b.storage.upgrade!()).steps.find((x) => x.name === 'verify-relations')?.ran).toBe(false);
      await b.storage.upgrade!({ only: ['verify-relations'] });
      expect(await b.placedPerson!('g1')).toBe('carl');
      expect(await walk(b.storage, { resourceId: 'carl' })).toEqual(['g1']);
      expect(await walk(b.storage, { resourceId: 'ayse' })).toEqual([]);
      await eraseSubject(b.storage, 'carl');
      expect(await j.get('g1:model:0')).toBeUndefined();
    });

    it('4A-F2 (R3): a trigger left as ENABLE REPLICA does not count as a guard; the next boot re-enables it and repairs', async () => {
      const b = await realPgBackend();
      await toJournal(b.storage.runs).put('g1:input', input({ resourceId: 'ayse', threadId: 'g-t1' }));
      await b.sql!('ALTER TABLE gnl_run_journal ENABLE REPLICA TRIGGER gnl_run_unplace');
      await rewrite(b, b.schema!);                                           // an ordinary session: the 'R' trigger does not fire
      const pool = (b.storage as unknown as { pool: pg.Pool }).pool;
      const next = new PostgresStorage({ pool });
      await next.init();
      expect((await b.sql!(`SELECT tgenabled::text AS e FROM pg_trigger WHERE tgname = 'gnl_run_unplace' AND tgrelid = 'gnl_run_journal'::regclass`)).rows).toEqual([{ e: 'O' }]);
      expect(await walk(next, { resourceId: 'carl' })).toEqual(['g1']);
      await next.upgrade({ only: ['relations'] });
      expect(await b.placedPerson!('g1')).toBe('carl');
    });

    it('4B-F4: a guard function another role owns, with a body that is not this version\'s, is not trusted', async () => {
      const b = await realPgBackend();
      await toJournal(b.storage.runs).put('g1:input', input({ resourceId: 'ayse', threadId: 'g-t1' }));
      const role = `gnl_rel_app_${process.pid}_${b.schema}`;
      const admin = new pg.Pool({ connectionString: realDb!.url, max: 1, options: `-c search_path=${b.schema}` });
      admin.on('error', () => {});
      await admin.query(`CREATE ROLE ${role} LOGIN PASSWORD 'x'`);
      ends.push(async () => { await admin.query(`DROP OWNED BY ${role}`).catch(() => {}); await admin.query(`DROP ROLE IF EXISTS ${role}`).catch(() => {}); await admin.end(); });
      await admin.query(`GRANT USAGE, CREATE ON SCHEMA ${b.schema} TO ${role}`);
      for (const r of (await admin.query(`SELECT tablename FROM pg_tables WHERE schemaname = $1`, [b.schema])).rows) await admin.query(`ALTER TABLE ${b.schema}.${r.tablename} OWNER TO ${role}`);
      await admin.query(`ALTER FUNCTION ${b.schema}.gnl_owner_unplace() OWNER TO ${role}`);
      // The run guard: still postgres's, and with a body that guards nothing.
      await admin.query(`CREATE OR REPLACE FUNCTION ${b.schema}.gnl_run_unplace() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RETURN NULL; END $$`);
      const u = new URL(realDb!.url); u.username = role; u.password = 'x';
      const app = new pg.Pool({ connectionString: u.toString(), max: 2, options: `-c search_path=${b.schema}` });
      app.on('error', () => {});
      ends.push(() => app.end());
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
      const s = new PostgresStorage({ pool: app });
      let said: string[] = [];
      try { await s.init(); said = warn.mock.calls.map((c) => String(c[0])); } finally { warn.mockRestore(); }
      expect(said.some((m) => m.includes('are not this version'))).toBe(true);
      await rewrite(b, b.schema!);                       // the no-op body leaves the column on ayse
      expect(await b.placedPerson!('g1')).toBe('ayse');
      expect(await walk(s, { resourceId: 'carl' })).toEqual(['g1']);   // not trusted: read from the records
    });

    for (const how of ['DISABLE TRIGGER gnl_run_unplace', 'DROP TRIGGER gnl_run_unplace ON']) {
      it(`R2-F3: a guard an operator turned off (${how.split(' ')[0]}) is not trusted, and the next boot\'s relations step repairs what it missed`, async () => {
        const b = await realPgBackend();
        const j = toJournal(b.storage.runs);
        await j.put('g1:input', input({ resourceId: 'ayse', threadId: 'g-t1' }));
        await b.sql!(how.startsWith('DROP') ? `${how} gnl_run_journal` : `ALTER TABLE gnl_run_journal ${how}`);
        await rewrite(b, b.schema!);                        // missed: no guard at that moment
        const pool = (b.storage as unknown as { pool: pg.Pool }).pool;
        const next = new PostgresStorage({ pool });          // the next boot
        await next.init();
        const waiting = new PostgresStorage({ pool });       // another process, booted before the repair
        await waiting.init();
        expect(await walk(next, { resourceId: 'carl' })).toEqual(['g1']);       // not trusted until repaired
        expect((await next.upgrade({ dryRun: true })).steps.find((x) => x.name === 'relations')?.pending).toBe(true);
        await next.upgrade({ only: ['relations'] });
        expect(await b.placedPerson!('g1')).toBe('carl');
        // R3-F5: the process that booted while the repair was pending trusts the columns again once it is done.
        const shape = () => (waiting as unknown as { prefixShape: { relationGuard?: boolean } }).prefixShape.relationGuard;
        expect(shape()).toBe(false);
        expect(await walk(waiting, { resourceId: 'carl' })).toEqual(['g1']);
        expect(shape()).toBe(true);
        const after = new PostgresStorage({ pool });
        await after.init();
        expect(await walk(after, { resourceId: 'carl' })).toEqual(['g1']);
        expect(await walk(after, { resourceId: 'ayse' })).toEqual([]);
      });
    }
  });
}

