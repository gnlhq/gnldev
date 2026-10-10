// The ROOT's thread question reads the root's runs only (ADR-0001: "In the root scope, every
// organization's rows are hidden").
//
// An organization's run sits physically in the root journal as `org:<id>:<runId>`, and its summary's
// `threadId` is the BARE id the organization chose. While a scope has no `thread:records:v1` mark, the
// owner of a thread with no record is derived from the runs on it — and the root asked the raw journal,
// which lists every organization's runs too. So:
//
//  F1 an organization's thread `T` decided who may use the ROOT thread `T`: a root user starting `T`
//     (which does not exist at the root) was refused with ThreadOwnerMismatchError, and a ROOT owner
//     record naming the organization's person was written. Through the whole engine (`createGnl`) and
//     through the bare gate (`admitThreadRun`), the door chat and AG-UI call too.
//  F2 a root erasure (`eraseSubject` without `orgId`) asked the same question and saw two owners on a
//     legacy thread (the root person's run and the organization's run on its own `T`): the thread was
//     ruled staff's, the person's journal-kept messages survived, and a staff record was written at the
//     root because of the organization's data.
//
// Controls keep the promises the fix must not weaken: the root still reads ITS OWN legacy runs; an
// organization's gate still reads ITS OWN; a root erasure still leaves every organization's rows alone.
//
// Nothing here runs `storage.upgrade()`: the root is unmarked on purpose, as on a fresh deployment where
// an organization runs first. Stores: InMemory, Sqlite, Postgres on pg-mem; with GNL_PG_URL also a real
// Postgres, in a database this file creates and drops. The "older process" writes with the previous
// version's statements (no relation columns), as in erase-relations.test.ts.
import { describe, it, expect, afterAll } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRequire } from 'node:module';
import { newDb } from 'pg-mem';
import pg from 'pg';
import {
  InMemoryStorage, toJournal, eraseSubject, admitThreadRun, threadOwnerKey, memKey, withOrg, stampFormat,
  scopeConfigToOrg, THREAD_RECORDS_KEY, type Storage,
} from '../src/index.js';
import { createGnl } from '../src/registry.js';
import { user } from '../src/run-identity.js';
import { SqliteStorage } from '../src/sqlite-storage.js';
import { PostgresStorage } from '../src/postgres-storage.js';
import { serialize } from '../src/serialize.js';
import { runIdOfKey, parseJournalKey } from '../src/journal.js';
import { createMockModel, finalTextResult } from './mock.js';

const { DatabaseSync } = createRequire(import.meta.url)('node:sqlite') as { DatabaseSync: new (path: string) => any };
const PG_URL = process.env.GNL_PG_URL;
const ends: Array<() => Promise<void> | void> = [];
afterAll(async () => { for (const e of ends.reverse()) await e(); });

interface Backend {
  storage: Storage;
  /** A process of the previous version writing one key: its statements, no relation columns. */
  oldPut(key: string, value: unknown): Promise<void>;
}

/** The previous version's journal write (see erase-relations.test.ts `OLD`). */
const OLD = {
  sqliteJournal: `INSERT INTO gnl_run_journal (key, run_id, kind, suspended, value, created_at) VALUES (?, ?, ?, ?, ?, ?)
                  ON CONFLICT(key) DO UPDATE SET value = excluded.value, suspended = excluded.suspended`,
  // The run's row in this version's status columns: since the `run-status` step a 0.10 process cannot
  // write here at all (run-status-columns.test.ts); these rows stand for what it wrote before the upgrade
  // and for any writer that knows nothing of the relation columns (a restore, plain SQL).
  sqliteRun: `INSERT INTO gnl_runs (run_id, model_steps, tool_calls, suspended_count, status, created_at, updated_at)
              VALUES (?, 0, 0, 0, 'completed', ?, ?) ON CONFLICT(run_id) DO UPDATE SET updated_at = excluded.updated_at`,
  pgJournal: `INSERT INTO gnl_run_journal (key, run_id, kind, suspended, value, created_at) VALUES ($1,$2,$3,$4,$5,$6)
              ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, suspended = EXCLUDED.suspended`,
  pgRun: `INSERT INTO gnl_runs (run_id, model_steps, tool_calls, suspended_count, status, created_at, updated_at)
          VALUES ($1,0,0,0,'completed',$2,$3) ON CONFLICT (run_id) DO UPDATE SET updated_at = EXCLUDED.updated_at`,
};
const oldRunOf = (key: string, value: unknown) => parseJournalKey(key)?.runId ?? runIdOfKey(key, value);

function sqliteBackend(): Backend {
  const dir = mkdtempSync(join(tmpdir(), 'gnl-root-gate-'));
  const file = join(dir, 'shared.db');
  const storage = new SqliteStorage(file);
  // The older process: its own connection to the same file.
  const db = new DatabaseSync(file);
  db.exec('PRAGMA busy_timeout = 5000');
  ends.push(() => { db.close(); storage.close?.(); rmSync(dir, { recursive: true, force: true }); });
  return {
    storage,
    async oldPut(key, value) {
      await storage.init?.();
      const p = parseJournalKey(key);
      const now = Date.now();
      db.prepare(OLD.sqliteJournal).run(key, p?.runId ?? null, p?.kind ?? null, 0, serialize(value), now);
      const run = oldRunOf(key, value);
      if (run) db.prepare(OLD.sqliteRun).run(run, now, now);
    },
  };
}

function pgBackend(pool: { query(text: string, values?: unknown[]): Promise<unknown> }): Backend {
  const storage = new PostgresStorage({ pool: pool as never });
  return {
    storage,
    async oldPut(key, value) {
      await storage.init();
      const p = parseJournalKey(key);
      const now = Date.now();
      await pool.query(OLD.pgJournal, [key, p?.runId ?? null, p?.kind ?? null, false, serialize(value), now]);
      const run = oldRunOf(key, value);
      if (run) await pool.query(OLD.pgRun, [run, now, now]);
    },
  };
}

let realDb: { url: string } | undefined;
let schemaSeq = 0;
async function realPgBackend(): Promise<Backend> {
  if (!realDb) {
    const name = `gnl_root_gate_${process.pid}_${Date.now().toString(36)}`;
    const admin = new pg.Pool({ connectionString: PG_URL, max: 1 });
    admin.on('error', () => {});
    await admin.query(`CREATE DATABASE ${name}`);
    const u = new URL(PG_URL!);
    u.pathname = `/${name}`;
    realDb = { url: u.toString() };
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
  pool.on('error', () => {});
  ends.push(() => pool.end());
  return pgBackend(pool);
}

const BACKENDS: Array<[string, () => Promise<Backend>]> = [
  ['InMemory', async () => { const storage = new InMemoryStorage(); return { storage, oldPut: (k, v) => storage.runs.put(k, v) }; }],
  ['Sqlite', async () => sqliteBackend()],
  ['Postgres (pg-mem)', async () => { const { Pool } = newDb().adapters.createPg(); return pgBackend(new Pool()); }],
];
if (PG_URL) BACKENDS.push(['Postgres (real)', realPgBackend]);

const input = (fields: Record<string, unknown>) => stampFormat({ at: 1, ...fields });
const echo = () => createMockModel(async () => finalTextResult('ok'));

/** The root's view of a key: what the root itself holds under `key` (no organization prefix). */
const rootGet = async (s: Storage, key: string) => toJournal(s.runs).get<Record<string, unknown>>(key);

/** Every key the store holds, raw. */
const allKeys = async (s: Storage) => (await toJournal(s.runs).listKeys(''))!.slice().sort();

/** Runs `fn`; answers `'admitted'` or the refusal's message. */
async function outcome(fn: () => Promise<unknown>): Promise<string> {
  try { await fn(); return 'admitted'; } catch (e) { return `refused: ${(e as Error).message}`; }
}

for (const [name, make] of BACKENDS) {
  describe(`${name}: the root's thread question reads the root's runs only`, () => {
    it('F1, the whole engine: an organization\'s thread T does not decide who uses the ROOT thread T', async () => {
      const { storage } = await make();
      await storage.init?.();
      const config = { storage, agents: { a: { model: echo() } } };
      await createGnl(scopeConfigToOrg(config, 'acme').config).run('a', { runId: 'acme-r1', prompt: 'hi', threadId: 'T', caller: user('ayse', 'acme') });
      // The root has no thread T: dave opens it.
      const root = createGnl(config);
      expect(await outcome(() => root.run('a', { runId: 'root-r1', prompt: 'hi', threadId: 'T', caller: user('dave') }))).toBe('admitted');
      expect((await rootGet(storage, threadOwnerKey('T')))?.resourceId).toBe('dave');
      // …and it stays his: the root's own ayse (a different person) is refused on it.
      expect(await outcome(() => root.run('a', { runId: 'root-r2', prompt: 'hi', threadId: 'T', caller: user('ayse') }))).toMatch(/refused: .*different resourceId/);
      // Control: the organization's thread is still its own person's, and closed to its other users.
      const acme = createGnl(scopeConfigToOrg(config, 'acme').config);
      expect(await outcome(() => acme.run('a', { runId: 'acme-r2', prompt: 'again', threadId: 'T', caller: user('ayse', 'acme') }))).toBe('admitted');
      expect(await outcome(() => acme.run('a', { runId: 'acme-r3', prompt: 'x', threadId: 'T', caller: user('bob', 'acme') }))).toMatch(/refused: .*different resourceId/);
    });

    it('F1, the bare gate: an older process\'s organization run does not own the root thread, nor write the root\'s record', async () => {
      const b = await make();
      const s = b.storage;
      await s.init?.();
      await b.oldPut('org:globex:g1:input', input({ resourceId: 'carl', threadId: 'TG' }));
      const j = toJournal(s.runs);
      expect(await outcome(() => admitThreadRun(j, undefined, 'TG', user('dave')))).toBe('admitted');
      expect((await rootGet(s, threadOwnerKey('TG')))?.resourceId).toBe('dave');
      // The organization's own gate still reads its own legacy run: carl's thread, closed to bob.
      const gj = withOrg(j, 'globex');
      expect(await outcome(() => admitThreadRun(gj, undefined, 'TG', user('bob', 'globex')))).toMatch(/refused: .*different resourceId/);
      expect((await gj.get<Record<string, unknown>>(threadOwnerKey('TG')))?.resourceId).toBe('carl');
    });

    it('control: the root still reads its OWN legacy runs, with an organization\'s run on the same id beside them', async () => {
      const b = await make();
      const s = b.storage;
      await s.init?.();
      await b.oldPut('r0:input', input({ resourceId: 'carl', threadId: 'TR' }));
      await b.oldPut('org:acme:a0:input', input({ resourceId: 'dave', threadId: 'TR' }));
      const j = toJournal(s.runs);
      expect(await outcome(() => admitThreadRun(j, undefined, 'TR', user('dave')))).toMatch(/refused: .*different resourceId/);
      expect((await rootGet(s, threadOwnerKey('TR')))?.resourceId).toBe('carl');
      expect(await outcome(() => admitThreadRun(j, undefined, 'TR', user('carl')))).toBe('admitted');
    });

    it('a root holding no run of its own is marked complete on first contact, whatever organizations hold', async () => {
      const b = await make();
      const s = b.storage;
      await s.init?.();
      await b.oldPut('org:acme:a0:input', input({ resourceId: 'bob', threadId: 'TX' }));
      const j = toJournal(s.runs);
      await admitThreadRun(j, undefined, 'new-thread', user('dave'));
      expect(await j.get(THREAD_RECORDS_KEY)).toBeDefined();
      // The organization's scope is its own: still unmarked, still read from its runs.
      expect(await withOrg(j, 'acme').get(THREAD_RECORDS_KEY)).toBeUndefined();
    });

    it('F2: a root erasure takes the person\'s legacy thread although an organization has a run on the same id', async () => {
      const b = await make();
      const s = b.storage;
      await s.init?.();
      await b.oldPut('r1:input', input({ resourceId: 'ayse', threadId: 'T' }));
      await b.oldPut(memKey('T', 'messages'), [{ role: 'user', text: 'AYSE kept in the journal' }]);
      await b.oldPut('org:acme:a1:input', input({ resourceId: 'bob', threadId: 'T' }));
      await b.oldPut('org:acme:a1:model:0', { text: 'BOB in acme' });
      await b.oldPut(`org:acme:${memKey('T', 'messages')}`, [{ role: 'user', text: 'BOB in acme kept in the journal' }]);
      const orgBefore = (await allKeys(s)).filter((k) => k.startsWith('org:'));
      await eraseSubject(s, 'ayse');
      const left = await allKeys(s);
      const leftAtRoot = left.filter((k) => !k.startsWith('org:') && k !== THREAD_RECORDS_KEY);
      expect(leftAtRoot).toEqual([]);
      // No record at the root for a thread the root never decided from acme's data.
      expect(await rootGet(s, threadOwnerKey('T'))).toBeUndefined();
      // Root erasure never touches an organization: every acme row is still there, byte for byte the same set.
      expect(left.filter((k) => k.startsWith('org:'))).toEqual(orgBefore);
    });

    it('F2 control, the organization\'s own erasure still sees its own runs', async () => {
      const b = await make();
      const s = b.storage;
      await s.init?.();
      await b.oldPut('r1:input', input({ resourceId: 'bob', threadId: 'T' }));
      await b.oldPut(memKey('T', 'messages'), [{ role: 'user', text: 'ROOT BOB' }]);
      await b.oldPut('org:acme:a1:input', input({ resourceId: 'bob', threadId: 'T' }));
      await b.oldPut(`org:acme:${memKey('T', 'messages')}`, [{ role: 'user', text: 'ACME BOB' }]);
      await eraseSubject(s, 'bob', { orgId: 'acme' });
      const left = await allKeys(s);
      expect(left.filter((k) => k.startsWith('org:acme:') && !k.endsWith(THREAD_RECORDS_KEY))).toEqual([]);
      // …and the root's bob, somebody else, keeps everything.
      expect(left).toContain('r1:input');
      expect(left).toContain(memKey('T', 'messages'));
    });
  });
}

describe('the root\'s first-contact probe is bounded', () => {
  it('a root with one old run under many organization runs: correct gate, bounded reads, left for the upgrade to mark', async () => {
    const storage = new InMemoryStorage();
    const j = toJournal(storage.runs);
    await j.put('r-old:input', input({ resourceId: 'carl', threadId: 'TR' }));
    for (let i = 0; i < 1200; i++) await j.put(`org:acme:a${i}:input`, input({ resourceId: 'bob', threadId: `A${i}` }));
    let reads = 0;
    const paged = j.listRunsPaged!.bind(j);
    const counted = Object.assign(Object.create(Object.getPrototypeOf(j)), j, {
      listRunsPaged: (q: any) => { reads++; return paged(q); },
    });
    // A new root thread: dave opens it, whatever acme's runs say, in at most 1 + 4 raw reads (the thread, the probe).
    expect(await outcome(() => admitThreadRun(counted, undefined, 'fresh', user('dave')))).toBe('admitted');
    expect(reads).toBeLessThanOrEqual(5);
    // The root holds a run, so it stays unmarked (left for the upgrade), and the root's own legacy
    // thread is still decided from its own run.
    expect(await j.get(THREAD_RECORDS_KEY)).toBeUndefined();
    expect(await outcome(() => admitThreadRun(counted, undefined, 'TR', user('dave')))).toMatch(/refused: .*different resourceId/);
  });
});
