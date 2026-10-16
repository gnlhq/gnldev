// Upgrade from 0.10.0: the store 0.10.0 left (fixtures/0.10.0, written by generate/0.10.0.mjs with the
// published 0.10.0 — runs of every kind, an erased person, an organization; see generate/runs.mjs),
// opened by the current code. 0.10.0 → this version is the release's one breaking upgrade: the run
// table's four status flags become `status`/`outcome` (the `run-status` step), and the store is refused
// until that step has run. What has to hold, on Sqlite and on a real Postgres:
//
//   U1 opening the store, asking any port, `gnl upgrade --list`, and an `--only` that is refused change
//      nothing; the refusal names every step the named one waits on;
//   U2 after `gnl upgrade`, every answer — every run's status, person, thread and agent; each status
//      filter; counts; a person's runs; a thread's runs and owner; the thread gate for four callers on
//      every thread; usage — is the answer of a store this version wrote with the same history, in the
//      root scope and the organization's; a second upgrade finds nothing to do;
//   U3 the shortest stop — `--only run-status,schema` — leaves a store that already answers all of that
//      exactly, before `thread-records` and `relations` run (they run later, while this version serves);
//   U4 what a user does next — approve, approve again, re-run finished runs, resume a canceled one, an
//      intruder, a new run — does what it does on that store: every side effect once.
//
// Postgres runs with GNL_INTEGRATION=1 against GNL_PG_URL (a URL that may CREATE DATABASE), as the other
// real-backend tests here; its databases are named GNL_TEST_DB_PREFIX (default `gnl_upgrade_`) + a suffix.
import { copyFileSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import * as durable from '@gnldev/durable';
import { SqliteStorage } from '@gnldev/durable/sqlite';
import { PostgresStorage } from '@gnldev/durable/postgres';
import { AgentMemory } from '@gnldev/memory';
import { z } from 'zod';
import { writeRuns, probeRuns, continueRuns } from '../../generate/runs.mjs';

const FIXTURES = fileURLToPath(new URL('../../fixtures/0.10.0/', import.meta.url));
const m = { durable, AgentMemory, z };
const written0100 = JSON.parse(readFileSync(join(FIXTURES, 'notes-sqlite.json'), 'utf8')).notes.written;
const require = createRequire(import.meta.url);
const { DatabaseSync } = require('node:sqlite') as typeof import('node:sqlite');

const RUN_PG = process.env.GNL_INTEGRATION === '1' && !!process.env.GNL_PG_URL;
const PG_URL = process.env.GNL_PG_URL ?? '';
const DB_PREFIX = process.env.GNL_TEST_DB_PREFIX ?? 'gnl_upgrade_';

const cleanups: Array<() => Promise<void> | void> = [];
afterEach(async () => {
  while (cleanups.length) await cleanups.pop()!();
});

/** A store and what can be asked of it from outside the code under test. */
interface Backend {
  name: string;
  /** The 0.10.0 store, loaded fresh from the fixture: a new storage object on it each call. */
  old(): Promise<{ open(): durable.Storage; snapshot(): Promise<string> }>;
  /** A new, empty store this version writes. */
  fresh(): Promise<durable.Storage>;
}

const steps = (r: durable.UpgradeReport, what: 'ran' | 'pending') => r.steps.filter((x) => (what === 'ran' ? x.ran : x.pending)).map((x) => x.name);

const sqlite: Backend = {
  name: 'Sqlite',
  async old() {
    const dir = mkdtempSync(join(tmpdir(), 'gnl-upgrade-0100-'));
    const file = join(dir, 'runs.db');
    copyFileSync(join(FIXTURES, 'runs.db'), file);
    const opened: durable.Storage[] = [];
    cleanups.push(async () => { for (const s of opened) await s.close?.(); rmSync(dir, { recursive: true, force: true }); });
    return {
      open() { const s = new SqliteStorage(file); opened.push(s); return s; },
      async snapshot() {
        const db = new DatabaseSync(file);
        try {
          const objects = db.prepare(`SELECT type, name, sql FROM sqlite_master ORDER BY type, name`).all() as Array<{ type: string; name: string }>;
          const rows = Object.fromEntries(objects.filter((o) => o.type === 'table').map((o) => [o.name, db.prepare(`SELECT * FROM "${o.name}" ORDER BY 1`).all()]));
          return JSON.stringify({ objects, rows });
        } finally {
          db.close();
        }
      },
    };
  },
  async fresh() {
    const dir = mkdtempSync(join(tmpdir(), 'gnl-upgrade-fresh-'));
    const s = new SqliteStorage(join(dir, 'runs.db'));
    cleanups.push(async () => { await s.close(); rmSync(dir, { recursive: true, force: true }); });
    return s;
  },
};

async function pgDatabase(): Promise<{ url: string; query(sql: string): Promise<any[]> }> {
  const pg = require('pg');
  const admin = new pg.Client({ connectionString: PG_URL });
  await admin.connect();
  const db = `${DB_PREFIX}${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 7)}`;
  await admin.query(`CREATE DATABASE ${db}`);
  const u = new URL(PG_URL);
  u.pathname = `/${db}`;
  const client = new pg.Client({ connectionString: u.toString() });
  await client.connect();
  cleanups.push(async () => {
    await client.end();
    await admin.query(`DROP DATABASE IF EXISTS ${db} WITH (FORCE)`);
    await admin.end();
  });
  return { url: u.toString(), query: async (sql) => (await client.query(sql)).rows };
}

const postgres: Backend = {
  name: 'Postgres',
  async old() {
    const db = await pgDatabase();
    await db.query(readFileSync(join(FIXTURES, 'postgres-runs.sql'), 'utf8'));
    const opened: durable.Storage[] = [];
    cleanups.push(async () => { for (const s of opened) await s.close?.(); });
    return {
      open() { const s = new PostgresStorage({ connectionString: db.url }); opened.push(s); return s; },
      async snapshot() {
        const out: Record<string, unknown> = {
          columns: await db.query(`SELECT table_name, column_name, data_type, is_nullable, column_default FROM information_schema.columns WHERE table_schema = 'public' ORDER BY 1, 2`),
          indexes: await db.query(`SELECT indexname, indexdef FROM pg_indexes WHERE schemaname = 'public' ORDER BY 1`),
          triggers: await db.query(`SELECT tgname FROM pg_trigger WHERE NOT tgisinternal ORDER BY 1`),
          functions: await db.query(`SELECT proname FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace WHERE n.nspname = 'public' ORDER BY 1`),
        };
        for (const { t } of await db.query(`SELECT table_name AS t FROM information_schema.tables WHERE table_schema = 'public' ORDER BY 1`)) {
          out[t] = await db.query(`SELECT * FROM "${t}" ORDER BY 1`);
        }
        return JSON.stringify(out);
      },
    };
  },
  async fresh() {
    const db = await pgDatabase();
    const s = new PostgresStorage({ connectionString: db.url });
    cleanups.push(async () => { await s.close(); });
    return s;
  },
};

/** A store this version wrote with the same history — what every answer of the upgraded store is compared with. */
async function freshWith(b: Backend): Promise<durable.Storage> {
  const s = await b.fresh();
  await s.init?.();
  const hooks: { stop?: () => Promise<void> } = {};
  const out = await writeRuns(m, s, hooks);
  cleanups.push(() => hooks.stop?.()); // before the store closes: the run left `running` holds a claim it renews
  expect(out, 'the current code answers the history as 0.10.0 did').toEqual(written0100);
  return s;
}

for (const b of [sqlite, ...(RUN_PG ? [postgres] : [])]) {
  describe(`upgrade from 0.10.0 — ${b.name}`, () => {
    it('U1: opening it, every port, `gnl upgrade --list` and a refused `--only` change nothing; the refusal names the whole chain', async () => {
      const old = await b.old();
      const before = await old.snapshot();
      const s = old.open();
      const refused = /format of an earlier version/;
      await expect(s.init?.() ?? Promise.resolve()).rejects.toThrow(refused);
      await expect(durable.toJournal(s.runs).get('r-done-alice:input')).rejects.toThrow(refused);
      await expect(durable.toJournal(s.runs).put('probe:model:0', { text: 'x' })).rejects.toThrow(refused);
      await expect(s.runs.listRuns()).rejects.toThrow(refused);
      await expect(s.memory!.getThread('t-alice-1')).rejects.toThrow(refused);
      await expect(s.work!.get('k')).rejects.toThrow(refused);
      const dry = await s.upgrade!({ dryRun: true });
      expect(steps(dry, 'pending')).toEqual(['run-status', 'schema', 'thread-records', 'relations']);
      await expect(s.upgrade!({ only: ['schema'] })).rejects.toThrow(/'schema' needs 'run-status' first[\s\S]*--only run-status,schema\b/);
      await expect(s.upgrade!({ only: ['thread-records'] })).rejects.toThrow(/needs 'run-status' and 'schema' first[\s\S]*--only run-status,schema,thread-records/);
      expect(await old.snapshot()).toEqual(before);
    });

    it('U2: after `gnl upgrade` every answer is the answer of a store this version wrote with the same history; a second upgrade finds nothing', async () => {
      const old = await b.old();
      const ran = await old.open().upgrade!();
      expect(steps(ran, 'ran')).toEqual(['run-status', 'schema', 'thread-records', 'relations']);
      const fresh = await freshWith(b);
      const upgraded = old.open();
      expect(await probeRuns(m, upgraded)).toEqual(await probeRuns(m, fresh));
      expect(steps(await old.open().upgrade!({ dryRun: true }), 'pending')).toEqual([]);
    });

    it('U3: the shortest stop (`--only run-status,schema`) leaves a store that answers exactly; the rest runs while it serves', async () => {
      const old = await b.old();
      const first = await old.open().upgrade!({ only: ['run-status', 'schema'] });
      expect(steps(first, 'ran')).toEqual(['run-status', 'schema']);
      const fresh = await freshWith(b);
      const serving = old.open();
      expect(await probeRuns(m, serving)).toEqual(await probeRuns(m, fresh));
      const rest = await old.open().upgrade!();
      expect(steps(rest, 'ran')).toEqual(expect.arrayContaining(['relations']));
      expect(steps(await old.open().upgrade!({ dryRun: true }), 'pending')).toEqual([]);
      expect(await probeRuns(m, serving)).toEqual(await probeRuns(m, fresh));
    });

    it('U4: what a user does next does on the upgraded store what it does on the new one — every side effect once', async () => {
      const old = await b.old();
      await old.open().upgrade!();
      const fresh = await freshWith(b);
      const next = await continueRuns(m, old.open());
      expect(next).toEqual(await continueRuns(m, fresh));
      // One payment per approved run (alice's, dave's), whatever was asked twice; nothing finished ran again.
      expect(next.effects).toEqual(['pay:{"amt":5}', 'pay:{"amt":5}']);
    });
  });
}
