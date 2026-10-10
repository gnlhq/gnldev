// C+ step B — a run's row is written once per journal write.
//
// Every write of a run touches that run's `gnl_runs` row (its counters, status flags, person and thread,
// and `updated_at`, which the change feed reads). It used to be written 2–3 times per journal write on
// Postgres: a lock-only "no-op" update taken FIRST (`lockRunRow`), then the counter update, and for a
// run's `:input` or outcome record the placement or the flags as separate statements. Each is a new row
// version and a lock on that row for the rest of the transaction. Measured on the 1M-run Postgres, one
// parent step fanning out to 200 sub-agents (5 model steps + 4 side-effect tool calls each): 34 row
// writes per child, 812 on the parent's row (4 per child — every child's tool-call record on the parent
// takes that row), and 36% of active backends sampled waiting on its lock.
//
// What has to hold, held here on Sqlite and real Postgres (GNL_PG_URL), pg-mem where it can:
//   W1 one row write per journal write, and none for a lost claim (counted by a trigger, so a write the
//      database makes on the adapter's behalf — the relation guard — is counted too);
//   W2 a fan-out writes each child's row 18 times for its 5 steps (17 by the adapter, 1 by the
//      relation guard) and the parent's row twice per child;
//   E1 the counters, status, outcome, person and thread are exactly what the previous code left for the
//      same scripted history (suspend, resume, fail, cancel, fork, rollover, sub-agents), and exactly
//      what the journal says;
//   E3 concurrent writers of one new key count it once (T1: the journal row, not the run row, is the lock);
//   E4 a writer that locks in the other order (the run's row, then the record) deadlocks with this one
//      at most once: Postgres aborts one side, and this side retries.
// (E2 — a 0.10 process writing the same run at the same time — is gone with the `run-status` step: a
// 0.10 process can no longer write to a migrated store at all; run-status-columns.test.ts proves it
// fails on its first statement, writing nothing.)
import { describe, it, expect, afterAll } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRequire } from 'node:module';
import { newDb } from 'pg-mem';
import pg from 'pg';
import { tool } from 'ai';
import { z } from 'zod';
import {
  runDurable, cancelAgentRun, forkRun, rolloverRun, createGnl, gnlTool, STAFF, stampFormat, type Storage,
} from '../src/index.js';
import { SqliteStorage } from '../src/sqlite-storage.js';
import { PostgresStorage } from '../src/postgres-storage.js';
import { serialize } from '../src/serialize.js';
import { parseJournalKey, relationsOfInput, deriveRunStatus, storedOutcomeOf } from '../src/journal.js';

const { DatabaseSync } = createRequire(import.meta.url)('node:sqlite') as { DatabaseSync: new (path: string) => any };
const PG_URL = process.env.GNL_PG_URL;

const ends: Array<() => Promise<void> | void> = [];
afterAll(async () => { for (const e of ends.reverse()) await e(); });

interface Backend {
  storage: Storage;
  /** Raw SQL on the store's database from a second connection (`?` placeholders on Sqlite, `$n` on Postgres). */
  sql(text: string, params?: unknown[]): Promise<any[]>;
  /** Count every INSERT/UPDATE of a `gnl_runs` row from here on (a trigger). Absent: pg-mem has no triggers. */
  countRowWrites?(): Promise<(runId: string) => Promise<number>>;
  /** Postgres (real): a second connection, to hold locks by hand in another writer's order (E4). */
  oldConnect?: () => Promise<pg.PoolClient>;
  /** false: concurrent transactions do not block each other on a row (pg-mem), so no race can be proven here. */
  rowLocks?: boolean;
}

/**
 * 0.10.0's journal statement (42ca5edf): the record written with no owner column (that came later) —
 * erase-relations.test.ts's `OLD`. Its run-row statements (`lockRunRow`/`touchRunDelta`) named the
 * status flags, and no longer run against this schema.
 */
const OLD10 = {
  pgJournal: `INSERT INTO gnl_run_journal (key, run_id, kind, suspended, value, created_at) VALUES ($1,$2,$3,$4,$5,$6)
              ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, suspended = EXCLUDED.suspended`,
};
const delta = (key: string, value: unknown, prev: { suspended: unknown } | undefined) => {
  const p = parseJournalKey(key)!;
  const susp = p.kind === 'tool' && (value as { status?: string })?.status === 'suspended';
  const fresh = prev === undefined;
  return { p, susp, m: fresh && p.kind === 'model' ? 1 : 0, t: fresh && p.kind === 'tool' ? 1 : 0, d: (susp ? 1 : 0) - (prev?.suspended ? 1 : 0) };
};

function sqliteBackend(): Backend {
  const dir = mkdtempSync(join(tmpdir(), 'gnl-runrow-'));
  const file = join(dir, 'runs.db');
  const storage = new SqliteStorage(file);
  const db = new DatabaseSync(file);
  db.exec('PRAGMA busy_timeout = 5000');
  ends.push(() => { db.close(); storage.close?.(); rmSync(dir, { recursive: true, force: true }); });
  return {
    storage,
    async sql(text, params = []) { return db.prepare(text).all(...params); },
    async countRowWrites() {
      await storage.init?.();
      db.exec(`CREATE TABLE IF NOT EXISTS test_row_writes (run_id TEXT)`);
      db.exec(`CREATE TRIGGER IF NOT EXISTS test_row_writes_i AFTER INSERT ON gnl_runs BEGIN INSERT INTO test_row_writes VALUES (new.run_id); END`);
      db.exec(`CREATE TRIGGER IF NOT EXISTS test_row_writes_u AFTER UPDATE ON gnl_runs BEGIN INSERT INTO test_row_writes VALUES (new.run_id); END`);
      db.exec('DELETE FROM test_row_writes');
      return async (runId) => Number((db.prepare('SELECT COUNT(*) AS n FROM test_row_writes WHERE run_id = ?').get(runId) as { n: number }).n);
    },
  };
}

async function realPgBackend(): Promise<Backend> {
  const admin = new pg.Client({ connectionString: PG_URL });
  await admin.connect();
  const name = `cpb_t_${process.pid}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`;
  await admin.query(`CREATE DATABASE ${name}`);
  // E4 makes two lock orders meet (see PgRunJournal.writeTx): a deadlock is resolved after
  // deadlock_timeout, 1 s by default — shortened here so it costs the suite milliseconds.
  await admin.query(`ALTER DATABASE ${name} SET deadlock_timeout = '50ms'`);
  const u = new URL(PG_URL!); u.pathname = `/${name}`;
  const pool = new pg.Pool({ connectionString: u.toString(), max: 6 });
  const oldPool = new pg.Pool({ connectionString: u.toString(), max: 6 });
  for (const p of [pool, oldPool]) p.on('error', () => {});
  const storage = new PostgresStorage({ pool });
  ends.push(async () => { await storage.close?.().catch(() => {}); await oldPool.end(); await admin.query(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`); await admin.end(); });
  return {
    storage,
    async sql(text, params = []) { return (await oldPool.query(text, params)).rows; },
    oldConnect: () => oldPool.connect(),
    async countRowWrites() {
      await storage.init?.();
      await oldPool.query(`CREATE TABLE IF NOT EXISTS test_row_writes (run_id TEXT)`);
      await oldPool.query(`CREATE OR REPLACE FUNCTION test_row_write() RETURNS trigger LANGUAGE plpgsql AS $$
        BEGIN INSERT INTO test_row_writes VALUES (NEW.run_id); RETURN NULL; END $$`);
      await oldPool.query(`DROP TRIGGER IF EXISTS test_row_writes ON gnl_runs`);
      await oldPool.query(`CREATE TRIGGER test_row_writes AFTER INSERT OR UPDATE ON gnl_runs FOR EACH ROW EXECUTE FUNCTION test_row_write()`);
      await oldPool.query('DELETE FROM test_row_writes');
      return async (runId) => Number((await oldPool.query('SELECT COUNT(*) AS n FROM test_row_writes WHERE run_id = $1', [runId])).rows[0].n);
    },
  };
}

const BACKENDS: Array<[string, () => Promise<Backend>]> = [
  ['Sqlite', async () => sqliteBackend()],
  ['Postgres (pg-mem)', async () => {
    const { Pool } = newDb().adapters.createPg();
    const pool = new Pool();
    return { storage: new PostgresStorage({ pool }), rowLocks: false, async sql(text, params = []) { return (await pool.query(text, params)).rows; } };
  }],
];
if (PG_URL) BACKENDS.push(['Postgres (real)', realPgBackend]);

// ── scripted models ────────────────────────────────────────────────────────────────────────────────
const usage2 = { inputTokens: 1, outputTokens: 1, totalTokens: 2 };
const base = { specificationVersion: 'v2', provider: 'scripted', modelId: 'm', supportedUrls: {}, doStream: async () => { throw new Error('gen-only'); } };
const toolMsgs = (prompt: any) => (prompt ?? []).filter((m: any) => m?.role === 'tool').length;
/** Calls `pay` `n` times, one call per step, then answers. */
const payModel = (n: number) => ({
  ...base,
  doGenerate: async ({ prompt }: any) => {
    const k = toolMsgs(prompt);
    return k < n
      ? { content: [{ type: 'tool-call', toolCallId: `c${k}`, toolName: 'pay', input: JSON.stringify({ k }) }], finishReason: 'tool-calls', usage: usage2, warnings: [] }
      : { content: [{ type: 'text', text: 'done' }], finishReason: 'stop', usage: usage2, warnings: [] };
  },
}) as any;
const dead = { ...base, doGenerate: async () => { throw new Error('401 invalid api key'); } } as any;
const pay = tool({ description: 'pay', inputSchema: z.object({ k: z.number() }).passthrough(), execute: async () => ({ ok: true }) });
Object.assign(pay, { sideEffect: true });
const tools = { pay: pay as any };

/** The sub-agent fan-out of the hot-row probe: one parent step, `n` children, 5 model steps + 4 side-effect tool calls each. */
async function fanOut(storage: Storage, runId: string, n: number): Promise<void> {
  const usage = { inputTokens: { total: 10, noCache: 10 }, outputTokens: { total: 5, text: 5 } };
  const fin = (r: string) => ({ unified: r, raw: r });
  const mock = (f: (o: any) => Promise<any>) => ({ specificationVersion: 'v4', provider: 'mock', modelId: 'm', supportedUrls: {}, doGenerate: f, doStream: async () => { throw new Error('x'); } }) as any;
  const t = gnlTool({ description: 't', inputSchema: z.object({}).passthrough(), execute: async () => ({ ok: true }) }, { sideEffect: true });
  const parent = mock(async ({ prompt }) => toolMsgs(prompt) > 0
    ? { content: [{ type: 'text', text: 'ok' }], finishReason: fin('stop'), usage, warnings: [] }
    : { content: Array.from({ length: n }, (_, i) => ({ type: 'tool-call', toolCallId: `p${i}`, toolName: 'agent_w', input: JSON.stringify({ task: `w${i}` }) })), finishReason: fin('tool-calls'), usage, warnings: [] });
  const w = mock(async ({ prompt }) => {
    const id = JSON.stringify(prompt).match(/w\d+/)![0];
    const k = toolMsgs(prompt);
    return k >= 4
      ? { content: [{ type: 'text', text: 'done' }], finishReason: fin('stop'), usage, warnings: [] }
      : { content: [{ type: 'tool-call', toolCallId: `c${k}`, toolName: 't', input: JSON.stringify({ k, w: id }) }], finishReason: fin('tool-calls'), usage, warnings: [] };
  });
  await createGnl({ storage, agents: { parent: { model: parent, agents: ['w'] }, w: { model: w, tools: { t } } } } as any)
    .run('parent', { runId, prompt: 'go', caller: STAFF } as any);
}

/** E1's history: every way a run's row changes, on fixed ids, so two versions of the code can be compared row for row. */
async function history(storage: Storage): Promise<void> {
  const journal = storage.runs as any;
  await runDurable({ runId: 'h-done', journal, model: payModel(2), tools, prompt: 'x', resourceId: 'ayse', threadId: 'th-1' } as any);
  const needsApproval = { guard: () => ({ action: 'require-approval', reason: 'human' }) };
  await runDurable({ runId: 'h-resumed', journal, model: payModel(1), tools, prompt: 'x', resourceId: 'bob', ...needsApproval } as any);
  await runDurable({ runId: 'h-resumed', journal, model: payModel(1), tools, prompt: 'x', resourceId: 'bob', approvals: { c0: true } } as any);
  await runDurable({ runId: 'h-waiting', journal, model: payModel(1), tools, prompt: 'x', ...needsApproval } as any);
  await runDurable({ runId: 'h-failed', journal, model: dead, prompt: 'x', resourceId: 'ayse' } as any).catch(() => {});
  await runDurable({ runId: 'h-canceled', journal, model: payModel(1), tools, prompt: 'x', ...needsApproval } as any);
  await cancelAgentRun(journal, 'h-canceled', { reason: 'operator' });
  await cancelAgentRun(journal, 'h-never', { reason: 'operator' });
  await forkRun(journal, 'h-done', 1, 'h-fork');
  await rolloverRun(journal, 'h-done', { newRunId: 'h-next' } as any);
  await runDurable({ runId: 'h-next', journal, model: payModel(1), tools, prompt: 'x', resourceId: 'ayse' } as any);
  await fanOut(storage, 'h-parent', 3);
}

type Row = [string, number, number, number, string | null, string, string | null, string | null];
/** Every run row as [run_id, model_steps, tool_calls, suspended_count, outcome, status, resource_id, thread_id]. */
async function rows(b: Backend): Promise<Row[]> {
  const r = await b.sql('SELECT run_id, model_steps, tool_calls, suspended_count, outcome, status, resource_id, thread_id FROM gnl_runs');
  return r.map((x: any): Row => [x.run_id, Number(x.model_steps), Number(x.tool_calls), Number(x.suspended_count), x.outcome ?? null, x.status, x.resource_id ?? null, x.thread_id ?? null])
    .sort((a, c) => (a[0] < c[0] ? -1 : a[0] > c[0] ? 1 : 0)); // byte order: the databases' collations differ
}

/** The same rows derived from the journal itself: what the counters, status and columns are defined to say. */
async function fromJournal(b: Backend): Promise<Row[]> {
  const out: Row[] = [];
  for (const [runId] of await rows(b)) {
    const recs = await b.sql(b.storage.constructor === SqliteStorage
      ? 'SELECT kind, suspended FROM gnl_run_journal WHERE run_id = ?' : 'SELECT kind, suspended FROM gnl_run_journal WHERE run_id = $1', [runId]);
    const status = (await b.storage.runs.get<{ status?: string }>(`${runId}:outcome`))?.status;
    const input = await b.storage.runs.get(`${runId}:input`);
    const rel = input && typeof input === 'object' && '_v' in input ? relationsOfInput(input) : undefined;
    const susp = recs.filter((x: any) => !!x.suspended).length;
    out.push([runId, recs.filter((x: any) => x.kind === 'model').length, recs.filter((x: any) => x.kind === 'tool').length, susp,
      storedOutcomeOf(status as never), deriveRunStatus(susp > 0, status ? { status: status as never } : null), rel ? rel.resourceId : null, rel ? rel.threadId : null]);
  }
  return out;
}

/**
 * What the PREVIOUS code (282311f2, before step B) left for `history` — captured by running this file's
 * `history` on that commit, on Sqlite and real Postgres (identical on both). Its rows had four status
 * flags (suspended, failed, running, canceled); they are written here as the columns that replaced them
 * — the flags' outcome (`storedOutcomeOf`) and the status 282311f2's reads decoded from them — so a
 * value changed by the `run-status` work shows here as a difference, not as a new expectation.
 */
const BEFORE: Row[] = [
  // run_id, model_steps, tool_calls, suspended_count, outcome, status, resource_id, thread_id   (282311f2's flags)
  ['agent:h-parent:p0', 5, 4, 0, null, 'completed', '', null], // none
  ['agent:h-parent:p1', 5, 4, 0, null, 'completed', '', null], // none
  ['agent:h-parent:p2', 5, 4, 0, null, 'completed', '', null], // none
  ['h-canceled', 1, 1, 1, 'canceled', 'canceled', '', null], // suspended + canceled
  ['h-done', 3, 2, 0, null, 'completed', 'ayse', 'th-1'], // none
  ['h-failed', 0, 0, 0, 'failed', 'failed', 'ayse', null], // failed
  ['h-fork', 1, 1, 0, null, 'completed', 'ayse', 'th-1'], // none
  ['h-never', 0, 0, 0, 'canceled', 'canceled', null, null], // canceled
  ['h-next', 1, 0, 0, null, 'completed', 'ayse', 'th-1'], // none
  ['h-parent', 2, 3, 0, null, 'completed', '', null], // none
  ['h-resumed', 2, 1, 0, null, 'completed', 'bob', null], // none
  ['h-waiting', 1, 1, 1, 'running', 'suspended', '', null], // suspended + running
];

for (const [name, make] of BACKENDS) {
  describe(`a run's row, written once per journal write — ${name}`, () => {
    it('W1: one row write per journal write — model step, claim, result, :input, outcome — and none for a lost claim', async () => {
      const b = await make();
      if (!b.countRowWrites) return; // pg-mem: no triggers to count with
      const writes = await b.countRowWrites();
      const j = b.storage.runs;
      // Every write that lands also moves the run's `updated_at` — the change feed (`listRunsChangedSince`,
      // Studio's /events) announces a run by it, so one write fewer must not mean one announcement fewer.
      const updatedAt = async (runId: string) => Number((await b.sql(`SELECT updated_at FROM gnl_runs WHERE run_id = ${name.startsWith('Postgres') ? '$1' : '?'}`, [runId]))[0]?.updated_at ?? 0);
      const counted = async (runId: string, f: () => Promise<unknown>) => {
        const n0 = await writes(runId);
        const t0 = await updatedAt(runId);
        await new Promise((r) => setTimeout(r, 3)); // updated_at is in ms
        await f();
        const n = (await writes(runId)) - n0;
        if (n > 0) expect(await updatedAt(runId), `${runId}: written, but updated_at did not move`).toBeGreaterThan(t0);
        return n;
      };
      expect(await counted('w1', () => j.put('w1:model:0', { text: 'step' }))).toBe(1);
      expect(await counted('w1', () => j.putIfAbsent!('w1:tool:c1', { status: 'pending' }))).toBe(1);
      expect(await counted('w1', () => j.put('w1:tool:c1', { status: 'succeeded', output: 1 }))).toBe(1);
      expect(await counted('w1', () => j.putIfAbsent!('w1:tool:c1', { status: 'pending' }))).toBe(0); // lost claim: nothing at all
      expect(await counted('w1', () => j.put('w1:outcome', { status: 'running', at: 1 }))).toBe(1);
      // A run's :input: one write by the adapter, plus the relation guard's own unplacing UPDATE of the
      // existing row — the database's write, not the adapter's. Postgres's guard (RUN_UNPLACE) updates
      // the row unconditionally; Sqlite's (RUN_UNPLACE_TRIGGERS) only a placed one, and w1 is not placed yet.
      const guard = name.startsWith('Postgres') ? 1 : 0;
      expect(await counted('w1', () => j.put('w1:input', stampFormat({ at: 1, resourceId: 'ayse', threadId: 't' })))).toBe(1 + guard);
      // A brand-new run's :input: the guard finds no row to unplace.
      expect(await counted('w2', () => j.put('w2:input', stampFormat({ at: 1, resourceId: 'ayse' })))).toBe(1);
      const [row] = (await rows(b)).filter((r) => r[0] === 'w1');
      expect(row).toEqual(['w1', 1, 1, 0, 'running', 'running', 'ayse', 't']);
    });

    it('W2: a sub-agent fan-out writes each child\'s row 18 times for its 5 steps, and the parent\'s twice per child', async () => {
      const b = await make();
      if (!b.countRowWrites) return;
      const writes = await b.countRowWrites();
      await fanOut(b.storage, 'fan', 3);
      const children = (await rows(b)).map((r) => r[0]).filter((id) => id.startsWith('agent:'));
      expect(children).toHaveLength(3);
      const counted = { children: await Promise.all(children.map((c) => writes(c))), parent: await writes('fan') };
      // Per child: 5 model steps (1 each), 4 tool calls (claim + result: 8), :input (claim + rewrite: 2,
      // plus the relation guard unplacing the placed row on the rewrite: 1), outcome (write-ahead +
      // verdict: 2) = 18. Was 35 on Postgres (a lock-only write before every run-scoped write, the
      // :input and outcome rows written twice each) and 22 on Sqlite.
      // Parent: its own 2 model steps, :input (3), outcome (2), and per child its agent tool call — a
      // claim and a result: 2 per child (was 4 on Postgres: each preceded by the lock-only write).
      expect(counted).toEqual({ children: [18, 18, 18], parent: 2 + 3 + 2 + 2 * 3 });
    });

    it('E3: concurrent writers of one NEW key count it once — the journal row is the lock', async () => {
      const b = await make();
      if (b.rowLocks === false) return; // multi-worker.test.ts §T1(e) HONESTY NOTE: pg-mem cannot prove this
      await b.storage.init?.();
      const j = b.storage.runs;
      await Promise.all(Array.from({ length: 8 }, (_, i) => [
        j.put('race:model:0', { i }),
        j.put('race:tool:x', { status: i % 2 ? 'suspended' : 'succeeded', i }),
      ]).flat());
      const [row] = (await rows(b)).filter((r) => r[0] === 'race');
      const [truth] = (await fromJournal(b)).filter((r) => r[0] === 'race');
      expect(row).toEqual(truth);
      expect(row!.slice(1, 3)).toEqual([1, 1]);
    });

    it('E1: the same history leaves the same rows as the previous code, and what the journal says', async () => {
      const b = await make();
      await b.storage.init?.();
      await history(b.storage);
      const got = await rows(b);
      expect(got).toEqual(await fromJournal(b));
      expect(got).toEqual(BEFORE);
    }, 30_000);

    it('E4: the deadlock a writer locking in the other order can cause on the same key is retried here, not surfaced', async () => {
      const b = await make();
      if (!b.oldConnect) return;
      await b.storage.init?.();
      const run = 'dl';
      await b.storage.runs.put(`${run}:model:0`, { first: true }); // the run's row exists
      const old = await b.oldConnect();
      try {
        // The other order — the run's row first, then the record — as 0.10 took it. 0.10's own statements
        // no longer run against this schema (no flag columns: run-status-columns.test.ts), so the run's
        // row is locked here by hand, and the record written with 0.10's journal statement.
        await old.query('BEGIN');
        const now = Date.now();
        await old.query('SELECT 1 FROM gnl_runs WHERE run_id = $1 FOR UPDATE', [run]);
        // This version: the record first (a new key: its INSERT), then the run's row — which the old
        // transaction holds, so it waits there, holding the record.
        const mine = b.storage.runs.put(`${run}:model:1`, { by: 'new' });
        await new Promise((r) => setTimeout(r, 25));
        // The old transaction now wants the record this one holds: a deadlock. This side has waited
        // longer, so Postgres (deadlock_timeout 50 ms here) aborts IT — and it retries.
        const prev = (await old.query('SELECT suspended FROM gnl_run_journal WHERE key = $1', [`${run}:model:1`])).rows[0];
        const { m, t, d } = delta(`${run}:model:1`, { by: 'old' }, prev);
        await old.query(OLD10.pgJournal, [`${run}:model:1`, run, 'model', false, serialize({ by: 'old' }), now]);
        await old.query('UPDATE gnl_runs SET model_steps = model_steps + $2, tool_calls = tool_calls + $3, suspended_count = suspended_count + $4, updated_at = $5 WHERE run_id = $1', [run, m, t, d, now]);
        await old.query('COMMIT');
        await mine; // retried after the abort: no error reaches the caller
      } finally { old.release(); }
      const [row] = (await rows(b)).filter((r) => r[0] === run);
      expect(row!.slice(1, 3)).toEqual([2, 0]); // model:0 and model:1, each counted once
      expect(await b.storage.runs.get(`${run}:model:1`)).toEqual({ by: 'new' }); // the retried write landed last
    });
  });
}
