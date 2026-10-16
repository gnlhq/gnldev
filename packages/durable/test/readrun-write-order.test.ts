// H7 — `readRun` hands a run's records back in the order they were first written, not in the order of a
// millisecond clock with the key as tie-break.
//
// It used to be `ORDER BY created_at, key`, `created_at` read from the WRITER's clock. Measured on Sqlite,
// pg-mem and a real Postgres (raporlar/2026-10-07-db-yapisi/ekler/h7-readrun-order/):
//   - records of one run written in the same millisecond came back by key: `model:10` before `model:2`,
//     every tool record after every step. A fast run on Sqlite did that with no clock mocked at all.
//     reconstructState then showed all assistant turns, then all tool results, and called settled tool
//     calls pending; forkRun(step 3) copied model:10 instead of model:2; rollover carried the scrambled
//     conversation; compensateRun undid charge → notify → reserve instead of notify → reserve → charge;
//   - a worker whose clock was 5 s behind resumed a run, and its steps came back BEFORE the first worker's.
// The stores now number each new row (`gnl_run_journal.ord`), and readRun orders by that number.
//
// Clock control is `vi.spyOn(Date, 'now')` — the adapters stamp `created_at` with `Date.now()`, so a
// frozen clock is every write in one millisecond, and a clock moved back is a second worker behind.
import { describe, it, expect, afterEach, vi } from 'vitest';
import { newDb } from 'pg-mem';
import pg from 'pg';
import { stepCountIs } from 'ai';
import { InMemoryJournal } from '../src/journal.js';
import { SqliteStorage } from '../src/sqlite-storage.js';
import { PostgresStorage } from '../src/postgres-storage.js';
import { runDurable } from '../src/run.js';
import { reconstructState, forkRun } from '../src/time-travel.js';
import { compensateRun } from '../src/compensation.js';
import { rolloverRun } from '../src/rollover.js';
import { serialize } from '../src/serialize.js';
import { createMockModel, countToolResults, toolCallResult, finalTextResult } from './mock.js';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRequire } from 'node:module';
import { helperPool } from '../../../test/support/pg-admin.js';

const PG_URL = process.env.GNL_PG_URL;
const ends: Array<() => Promise<void> | void> = [];
afterEach(async () => { vi.restoreAllMocks(); for (const e of ends.splice(0).reverse()) await e(); });

async function realPg(): Promise<any> {
  const admin = new pg.Client({ connectionString: PG_URL });
  await admin.connect();
  const name = `h7_t_${process.pid}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`;
  await admin.query(`CREATE DATABASE ${name}`);
  const u = new URL(PG_URL!); u.pathname = `/${name}`;
  const pool = new pg.Pool({ connectionString: u.toString(), max: 2 });
  ends.push(async () => { await pool.end().catch(() => {}); await admin.query(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`); await admin.end(); });
  return new PostgresStorage({ pool }).runs;
}

const STORES: Array<[string, () => Promise<any>]> = [
  ['InMemory', async () => new InMemoryJournal()],
  ['Sqlite', async () => new SqliteStorage(':memory:').runs],
  ['Postgres (pg-mem)', async () => { const { Pool } = newDb().adapters.createPg(); return new PostgresStorage({ pool: new Pool() }).runs; }],
];
if (PG_URL) STORES.push(['Postgres (real)', realPg]);

const STEPS = 12;
const model = () => createMockModel(async ({ prompt }: any) => {
  const n = countToolResults(prompt);
  return n < STEPS - 1 ? toolCallResult('lookup', `call-${n}`, { n }) : finalTextResult('done');
});
const tools = () => ({ lookup: { execute: async ({ n }: any) => ({ n }) } });

/** The order the run wrote: model:0, tool:call-0, model:1, …, model:11. */
const written = (runId: string, steps = STEPS) => {
  const out: string[] = [];
  for (let i = 0; i < steps; i++) {
    out.push(`${runId}:model:${i}`);
    if (i < STEPS - 1 && i < steps) out.push(`${runId}:tool:call-${i}`);
  }
  return out;
};
const keys = async (j: any, runId: string) => (await j.readRun(runId)).map((e: any) => e.key);
const roles = (msgs: any[]) => msgs.map((m) => m.role[0]).join('');

describe.each(STORES)('H7 readRun is first-write order — %s', (_name, make) => {
  it('every record in one millisecond: write order, and the readers that follow it', async () => {
    const j = await make();
    vi.spyOn(Date, 'now').mockReturnValue(1_760_000_000_000);
    await runDurable({ runId: 'r', journal: j, model: model(), tools: tools(), stopWhen: stepCountIs(STEPS + 2), prompt: 'go' });
    vi.restoreAllMocks();
    const entries = await j.readRun('r');
    expect(entries.map((e: any) => e.key)).toEqual(written('r'));
    expect(entries.map((e: any) => e.seq)).toEqual(entries.map((_: unknown, i: number) => i));

    // reconstructState: assistant, tool, assistant, … — and at step 3 only call-1 is still open.
    expect(roles(reconstructState(entries).messages)).toBe('at'.repeat(STEPS - 1) + 'a');
    expect(reconstructState(entries, 3).pending).toEqual([{ toolCallId: 'call-1', toolName: 'lookup' }]);

    // forkRun(step 3) copies steps 0–2 and their tools, interleaved as the source wrote them.
    const fork = await forkRun(j, 'r', 3, 'f');
    expect(fork).toMatchObject({ copiedModel: 3, copiedTool: 3 });
    expect(await keys(j, 'f')).toEqual(['f:model:0', 'f:tool:call-0', 'f:model:1', 'f:tool:call-1', 'f:model:2', 'f:tool:call-2']);
    expect(roles(reconstructState(await j.readRun('f')).messages)).toBe('atatat');
  });

  it('a second worker whose clock is 5 s behind resumes the run: its steps come after the first worker\'s', async () => {
    const j = await make();
    let now = 1_760_000_100_000;
    vi.spyOn(Date, 'now').mockImplementation(() => now++);
    await runDurable({ runId: 'r', journal: j, model: model(), tools: tools(), stopWhen: stepCountIs(4), prompt: 'go' });
    now -= 5_000;
    await runDurable({ runId: 'r', journal: j, model: model(), tools: tools(), stopWhen: stepCountIs(STEPS + 2), prompt: 'go' });
    vi.restoreAllMocks();
    expect(await keys(j, 'r')).toEqual(written('r'));
  });
});

// ── A store written before `ord` ────────────────────────────────────────────────────────────────────
// Its rows hold 0. They keep the order they always had — `(created_at, key)`, same-millisecond ties
// included, which nothing can recover — and every row written after the column, by this version or by
// an older process still running (OLD statements, which name no `ord`), follows them in write order.
const OLD_JOURNAL_DDL = 'CREATE TABLE gnl_run_journal (key TEXT PRIMARY KEY, run_id TEXT, kind TEXT, suspended BOOLEAN NOT NULL DEFAULT false, value TEXT NOT NULL, created_at BIGINT NOT NULL, owner TEXT)';
const { DatabaseSync } = createRequire(import.meta.url)('node:sqlite') as { DatabaseSync: new (path: string) => any };

/**
 * A pg-mem pool for a database that already has tables: pg-mem refuses `CREATE TABLE IF NOT EXISTS` (and
 * `CREATE SEQUENCE IF NOT EXISTS`) for an object that exists, where Postgres does nothing — answered
 * here the way Postgres answers it (run-status-columns.test.ts, `reopen`).
 */
function pgMemOverExisting() {
  const { Pool } = newDb().adapters.createPg();
  const pool = new Pool();
  const query = (sql: string, params?: unknown[]) => pool.query(sql, params).catch((e: { code?: string }) => {
    if (e?.code === undefined && /^CREATE (TABLE|SEQUENCE) IF NOT EXISTS /.test(sql)) return { rows: [], rowCount: 0 };
    throw e;
  });
  return { query, connect: () => pool.connect(), end: async () => {} };
}

interface OldStore {
  /** A raw statement from a connection of its own (`?` on Sqlite, `$n` on Postgres). */
  sql(text: string, params: unknown[]): Promise<void>;
  /** Opens the store with this version's code. */
  open(): Promise<any>;
  /** The placeholder list for n parameters. */
  ph(n: number): string;
}
const OLD_STORES: Array<[string, () => Promise<OldStore>]> = [
  ['Sqlite', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'gnl-h7-'));
    const file = join(dir, 'j.db');
    const db = new DatabaseSync(file);
    db.exec('PRAGMA busy_timeout = 5000');
    db.exec(OLD_JOURNAL_DDL);
    const opened: any[] = [];
    ends.push(() => { db.close(); for (const s of opened) s.close?.(); rmSync(dir, { recursive: true, force: true }); });
    return {
      async sql(text, params) { db.prepare(text).run(...params); },
      async open() { const s = new SqliteStorage(file); opened.push(s); return s; },
      ph: (n) => Array.from({ length: n }, () => '?').join(', '),
    };
  }],
  ['Postgres (pg-mem)', async () => {
    const pool = pgMemOverExisting();
    await pool.query(OLD_JOURNAL_DDL);
    return {
      async sql(text, params) { await pool.query(text, params); },
      async open() { return new PostgresStorage({ pool: pool as never }); },
      ph: (n) => Array.from({ length: n }, (_, i) => `$${i + 1}`).join(', '),
    };
  }],
];
if (PG_URL) OLD_STORES.push(['Postgres (real)', async () => {
  const admin = new pg.Client({ connectionString: PG_URL });
  await admin.connect();
  const name = `h7_u_${process.pid}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`;
  await admin.query(`CREATE DATABASE ${name}`);
  const u = new URL(PG_URL!); u.pathname = `/${name}`;
  // The seed's own pool is not a store's, so it gets the listeners a store gives its pools: the cleanup
  // force-drops the database right after `end()`, which can reach a session still closing (57P01 in CI).
  const raw = helperPool(u.toString());
  const pools = [raw];
  ends.push(async () => { for (const p of pools) await p.end().catch(() => {}); await admin.query(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`); await admin.end(); });
  await raw.query(OLD_JOURNAL_DDL);
  return {
    async sql(text, params) { await raw.query(text, params); },
    async open() { const p = new pg.Pool({ connectionString: u.toString(), max: 2 }); pools.push(p); return new PostgresStorage({ pool: p }); },
    ph: (n) => Array.from({ length: n }, (_, i) => `$${i + 1}`).join(', '),
  };
}]);

describe.each(OLD_STORES)('H7 a store written before `ord` — %s', (name, makeOld) => {
  it('its rows keep their order and come first; every later write follows in write order, an older process\'s too', async () => {
    const old = await makeOld();
    const oldPut = (key: string, at: number) => old.sql(
      `INSERT INTO gnl_run_journal (key, run_id, kind, suspended, value, created_at) VALUES (${old.ph(6)})`,
      [key, 'u', key.includes(':model:') ? 'model' : 'tool', name === 'Sqlite' ? 0 : false, serialize({ k: key }), at],
    );
    // Before the column: step 0 and its tool at t, step 1 and its tool in ONE later millisecond — that
    // tie reads by key (model:1 before tool:b) and stays so: nothing recorded which came first.
    await oldPut('u:model:0', 1000);
    await oldPut('u:tool:z', 1001);
    await oldPut('u:tool:b', 1002);
    await oldPut('u:model:1', 1002);
    const storage = await old.open();
    if (typeof storage.init === 'function') await storage.init();
    const j = storage.runs;
    expect(await keys(j, 'u')).toEqual(['u:model:0', 'u:tool:z', 'u:model:1', 'u:tool:b']);
    // After: this version, with a clock far behind the old rows, then an older process.
    vi.spyOn(Date, 'now').mockReturnValue(10);
    await j.put('u:model:2', { k: 2 });
    await j.put('u:tool:a', { status: 'running' });
    vi.restoreAllMocks();
    await oldPut('u:model:3', 5);
    await j.put('u:tool:a', { status: 'succeeded' }); // an overwrite keeps its place
    expect(await keys(j, 'u')).toEqual(['u:model:0', 'u:tool:z', 'u:model:1', 'u:tool:b', 'u:model:2', 'u:tool:a', 'u:model:3']);
    // Opened again (a restart): the boot adds nothing twice and the order holds.
    const again = await old.open();
    if (typeof again.init === 'function') await again.init();
    expect(await keys(again.runs, 'u')).toEqual(['u:model:0', 'u:tool:z', 'u:model:1', 'u:tool:b', 'u:model:2', 'u:tool:a', 'u:model:3']);
  });
});

describe('H7 the `schema` step carries the sequence default with the column (Postgres, out-of-band upgrade)', () => {
  it('an un-booted store: the step adds `ord`, its sequence and its default — and an older process\'s next write is numbered', async () => {
    const pool = pgMemOverExisting();
    await pool.query(OLD_JOURNAL_DDL);
    await pool.query(`INSERT INTO gnl_run_journal (key, run_id, kind, value, created_at) VALUES ('v:model:0', 'v', 'model', '{}', 5000)`);
    const s = new PostgresStorage({ pool: pool as never });
    const step = (await s.upgrade({ only: ['schema'] })).steps.find((x) => x.name === 'schema')!;
    const stmts = (step.detail?.statements ?? []) as string[];
    const at = stmts.indexOf('ALTER TABLE gnl_run_journal ADD COLUMN IF NOT EXISTS ord BIGINT NOT NULL DEFAULT 0');
    expect(at).toBeGreaterThanOrEqual(0);
    expect(stmts.slice(at + 1, at + 3)).toEqual(['CREATE SEQUENCE IF NOT EXISTS gnl_run_journal_ord', "ALTER TABLE gnl_run_journal ALTER COLUMN ord SET DEFAULT nextval('gnl_run_journal_ord')"]);
    // No boot of this version yet: an older process writes the run's next step with a clock behind.
    await pool.query(`INSERT INTO gnl_run_journal (key, run_id, kind, value, created_at) VALUES ('v:model:1', 'v', 'model', '{}', 1)`);
    const r = await pool.query(`SELECT key, ord FROM gnl_run_journal ORDER BY ord, created_at, key`);
    expect(r.rows.map((x: any) => x.key)).toEqual(['v:model:0', 'v:model:1']);
    expect(Number(r.rows[1].ord)).toBeGreaterThan(0);
  });
});

describe.each(STORES)('H7 readers that act on the order — %s', (_name, make) => {
  // Provider tool-call ids are random: how they sort says nothing about when they were called.
  const ids = ['toolu_9x', 'toolu_2k', 'toolu_5m'];
  const names = ['charge', 'reserve', 'notify'];
  const sagaModel = () => createMockModel(async ({ prompt }: any) => {
    const n = countToolResults(prompt);
    return n < 3 ? toolCallResult(names[n]!, ids[n]!, { id: 'A' }) : finalTextResult('placed');
  });
  const sagaTools = (undone: string[]) => Object.fromEntries(names.map((nm) => [nm, {
    execute: async () => ({ [nm]: true }),
    compensate: async () => { undone.push(nm); return { ok: true }; },
  }]));

  it('compensateRun undoes in reverse execution order (every record in one millisecond)', async () => {
    const j = await make();
    const undone: string[] = [];
    vi.spyOn(Date, 'now').mockReturnValue(1_760_000_200_000);
    await runDurable({ runId: 's', journal: j, model: sagaModel(), tools: sagaTools(undone) as any, stopWhen: stepCountIs(6), prompt: 'order' });
    vi.restoreAllMocks();
    await compensateRun('s', { journal: j, tools: sagaTools(undone) as any });
    expect(undone).toEqual(['notify', 'reserve', 'charge']);
  });

  it('rolloverRun carries the conversation in its order (every record in one millisecond)', async () => {
    const j = await make();
    vi.spyOn(Date, 'now').mockReturnValue(1_760_000_300_000);
    await runDurable({ runId: 'ro', journal: j, model: sagaModel(), tools: sagaTools([]) as any, stopWhen: stepCountIs(6), prompt: 'order' });
    vi.restoreAllMocks();
    const r = await rolloverRun(j, 'ro');
    const shape = (r.messages as any[]).map((m) => (m.role === 'assistant'
      ? `a(${m.content.map((p: any) => p.toolName ?? 'text').join(',')})`
      : m.role === 'tool' ? `t(${m.content[0].toolName})` : m.role[0])).join(' ');
    expect(shape).toBe('u a(charge) t(charge) a(reserve) t(reserve) a(notify) t(notify) a(text)');
  });
});
