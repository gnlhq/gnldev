// C+ step A2 — a run's status is a column the adapter writes, not four flags decoded on every read.
//
// Up to 0.10 (and on the step-B code, 19b94c3f) `gnl_runs` kept a run's status as four booleans —
// `suspended`, `failed`, `running`, `canceled` — and every listing, count and filter decoded them in the
// precedence `deriveRunStatus` applies, each in its own copy (two SQL CASEs, two TypeScript ternaries, a
// filter per status). Now the row holds the two inputs of the status and the status itself, written in
// the statement that writes the run's counters: `suspended_count`, `outcome` (the `:outcome` record's
// 'running' | 'failed' | 'canceled', NULL otherwise) and `status` (`runStatusOf` of the two). Every reader
// reads `status`. The `run-status` upgrade step moves a store from the flags to the columns and drops the
// flags; until it has run this version refuses the store.
//
// What has to hold, on Sqlite, pg-mem and real Postgres (GNL_PG_URL):
//   Q1 after every step of a scripted history — started, suspended, resumed, failed, canceled while
//      suspended, canceled after failed, failed then suspended then resolved, completed, sub-agents,
//      fork, rollover, a batch, a takeover — the stored status is `deriveRunStatus` of the journal's own
//      records, the stored outcome is the record's, and every listing, count and status filter answers
//      exactly what 19b94c3f (the flags) answered for the same history (BEFORE, captured on that commit);
//   Q2 the rule is one table: `runStatusOf` and the SQL each database evaluates agree on every input, and
//      'completed' decides the same as no outcome at all (why `outcome` stores it as NULL);
//   Q3 the status alone is not enough — two runs with the same status and counter need different
//      statuses after the same write — so the outcome is stored;
//   M1 a store in the flag format is refused, with the one way through (`gnl upgrade`);
//   M2 the `run-status` step gives every run the status the flags decoded to, in every combination;
//      listings and counts answer the same before and after; it runs once (idempotent), and a step
//      killed half-way leaves the store as it was, so running it again is the whole migration;
//   M3 a 0.10 write after the step fails on its first statement — the database's own "column does not
//      exist" — and writes nothing;
//   M4 a process that opened the store before the step serves it once the step has run elsewhere;
//   M5 one `upgrade()` with no boot first (a pending store cannot boot) finishes every step;
//   M6 an earlier version booting after the step puts three flags back (its boot DDL): this version
//      refuses again, and the step drops them without changing a status;
//   M7 (Postgres, which fills page by page) a write an earlier version makes after its run was filled
//      is reconciled in the step's locked transaction.
// Against the real earlier code (19b94c3f, 0.10.0 = 8905dbb2), M1–M3 are proven by the step's evidence
// scripts (raporlar/2026-10-07-db-yapisi/ekler/cplus-a2/), which need those builds.
import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRequire } from 'node:module';
import { newDb } from 'pg-mem';
import pg from 'pg';
import { tool } from 'ai';
import { z } from 'zod';
import { runDurable, cancelAgentRun, forkRun, rolloverRun, createGnl, gnlTool, STAFF, stampFormat, type Storage } from '../src/index.js';
import { SqliteStorage } from '../src/sqlite-storage.js';
import { PostgresStorage } from '../src/postgres-storage.js';
import * as J from '../src/journal.js';
import type { RunStatus } from '../src/journal.js';

const { DatabaseSync } = createRequire(import.meta.url)('node:sqlite') as { DatabaseSync: new (path: string) => any };
const PG_URL = process.env.GNL_PG_URL;
/** Capture mode (run on 19b94c3f to produce BEFORE): write the snapshots here and assert nothing. */
const CAPTURE = process.env.GNL_CAPTURE_STATUS;
/** Present from this version on; absent on the code BEFORE is captured from. */
const A2 = typeof (J as Record<string, unknown>).runStatusOf === 'function';

// Each test's databases, files and pools are closed when it ends, not when the file does: a suite run
// in parallel shares one Postgres `max_connections`, and this file opens a pool per store it reopens.
const ends: Array<() => Promise<void> | void> = [];
afterEach(async () => { for (const e of ends.splice(0).reverse()) await e(); });

interface Backend {
  storage: Storage;
  dialect: 'sqlite' | 'pg';
  /** Raw SQL from a second connection (`?` placeholders on Sqlite, `$n` on Postgres). */
  sql(text: string, params?: unknown[]): Promise<any[]>;
  /** A new storage object on the same database — another process's view. */
  reopen(): Storage;
  real: boolean;
  /**
   * The page size listings are walked with: small, so the cursor path is read too — except on pg-mem,
   * which refuses the keyset's row comparison ("cannot cast type list to list", storage-backend.test.ts).
   */
  page: number;
}

function sqliteBackend(): Backend {
  const dir = mkdtempSync(join(tmpdir(), 'gnl-runstatus-'));
  const file = join(dir, 'runs.db');
  const storage = new SqliteStorage(file);
  const db = new DatabaseSync(file);
  db.exec('PRAGMA busy_timeout = 5000');
  const opened: Storage[] = [storage];
  ends.push(async () => { db.close(); for (const s of opened) await s.close?.().catch(() => {}); rmSync(dir, { recursive: true, force: true }); });
  return {
    storage, dialect: 'sqlite', real: true, page: 7,
    async sql(text, params = []) {
      const st = db.prepare(text);
      return /^\s*(SELECT|PRAGMA)/i.test(text) ? st.all(...params) : (st.run(...params), []);
    },
    reopen() { const s = new SqliteStorage(file); opened.push(s); return s; },
  };
}

function pgMemBackend(): Backend {
  const { Pool } = newDb().adapters.createPg();
  const pool = new Pool();
  return {
    storage: new PostgresStorage({ pool }), dialect: 'pg', real: false, page: 1000,
    async sql(text, params = []) { return (await pool.query(text, params)).rows; },
    reopen() {
      // pg-mem refuses some `CREATE … IF NOT EXISTS` for an object that exists (a table, a sequence —
      // migrate.test.ts's note), so a second storage on one pg-mem database cannot boot; its pool here
      // answers that refusal the way Postgres answers the statement — with nothing.
      const query = (sql: string, params?: unknown[]) => pool.query(sql, params).catch((e: { code?: string }) => {
        if (e?.code === undefined && /^CREATE (TABLE|SEQUENCE) IF NOT EXISTS /.test(sql)) return { rows: [], rowCount: 0 };
        throw e;
      });
      return new PostgresStorage({ pool: { query, connect: () => pool.connect(), end: async () => {} } as never });
    },
  };
}

async function realPgBackend(): Promise<Backend> {
  const admin = new pg.Client({ connectionString: PG_URL });
  await admin.connect();
  const name = `cpm_t_${process.pid}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`;
  await admin.query(`CREATE DATABASE ${name}`);
  const u = new URL(PG_URL!); u.pathname = `/${name}`;
  const pools: pg.Pool[] = [];
  const pool = () => { const p = new pg.Pool({ connectionString: u.toString(), max: 2 }); p.on('error', () => {}); pools.push(p); return p; };
  const raw = pool();
  const storage = new PostgresStorage({ pool: pool() });
  ends.push(async () => { for (const p of pools) await p.end().catch(() => {}); await admin.query(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`); await admin.end(); });
  return {
    storage, dialect: 'pg', real: true, page: 7,
    async sql(text, params = []) { return (await raw.query(text, params)).rows; },
    reopen() { return new PostgresStorage({ pool: pool() }); },
  };
}

const BACKENDS: Array<[string, () => Promise<Backend>]> = [
  ['Sqlite', async () => sqliteBackend()],
  ['Postgres (pg-mem)', async () => pgMemBackend()],
];
if (PG_URL) BACKENDS.push(['Postgres (real)', realPgBackend]);

// ── the scripted history ───────────────────────────────────────────────────────────────────────────
const usage2 = { inputTokens: 1, outputTokens: 1, totalTokens: 2 };
const base = { specificationVersion: 'v2', provider: 'scripted', modelId: 'm', supportedUrls: {}, doStream: async () => { throw new Error('gen-only'); } };
const toolMsgs = (prompt: any) => (prompt ?? []).filter((m: any) => m?.role === 'tool').length;
const payModel = (n: number) => ({
  ...base,
  doGenerate: async ({ prompt }: any) => (toolMsgs(prompt) < n
    ? { content: [{ type: 'tool-call', toolCallId: `c${toolMsgs(prompt)}`, toolName: 'pay', input: JSON.stringify({ k: toolMsgs(prompt) }) }], finishReason: 'tool-calls', usage: usage2, warnings: [] }
    : { content: [{ type: 'text', text: 'done' }], finishReason: 'stop', usage: usage2, warnings: [] }),
}) as any;
const dead = { ...base, doGenerate: async () => { throw new Error('401 invalid api key'); } } as any;
const pay = tool({ description: 'pay', inputSchema: z.object({ k: z.number() }).passthrough(), execute: async () => ({ ok: true }) });
Object.assign(pay, { sideEffect: true });
const tools = { pay: pay as any };
const needsApproval = { guard: () => ({ action: 'require-approval', reason: 'human' }) };
const suspendedRec = { status: 'suspended', output: { __gnl_suspend: { toolCallId: 'c1', toolName: 'pay', reason: 'approve' } } };

async function fanOut(storage: Storage, runId: string, n: number): Promise<void> {
  const usage = { inputTokens: { total: 10, noCache: 10 }, outputTokens: { total: 5, text: 5 } };
  const fin = (r: string) => ({ unified: r, raw: r });
  const mock = (f: (o: any) => Promise<any>) => ({ specificationVersion: 'v4', provider: 'mock', modelId: 'm', supportedUrls: {}, doGenerate: f, doStream: async () => { throw new Error('x'); } }) as any;
  const t = gnlTool({ description: 't', inputSchema: z.object({}).passthrough(), execute: async () => ({ ok: true }) }, { sideEffect: true });
  const parent = mock(async ({ prompt }) => (toolMsgs(prompt) > 0
    ? { content: [{ type: 'text', text: 'ok' }], finishReason: fin('stop'), usage, warnings: [] }
    : { content: Array.from({ length: n }, (_, i) => ({ type: 'tool-call', toolCallId: `p${i}`, toolName: 'agent_w', input: JSON.stringify({ task: `w${i}` }) })), finishReason: fin('tool-calls'), usage, warnings: [] }));
  const w = mock(async ({ prompt }) => (toolMsgs(prompt) >= 2
    ? { content: [{ type: 'text', text: 'done' }], finishReason: fin('stop'), usage, warnings: [] }
    : { content: [{ type: 'tool-call', toolCallId: `c${toolMsgs(prompt)}`, toolName: 't', input: JSON.stringify({ k: toolMsgs(prompt), w: JSON.stringify(prompt).match(/w\d+/)![0] }) }], finishReason: fin('tool-calls'), usage, warnings: [] }));
  await createGnl({ storage, agents: { parent: { model: parent, agents: ['w'] }, w: { model: w, tools: { t } } } } as any)
    .run('parent', { runId, prompt: 'go', caller: STAFF } as any);
}

/**
 * Every way a run's status changes, one named step at a time, on fixed ids. Engine paths where the
 * engine produces the state (runDurable, cancel, fork, rollover, sub-agents); the journal's own write
 * paths (put, putIfMatch, applyBatch) for the states the engine reaches only through a crash or a race.
 */
const STEPS: Array<[string, (s: Storage) => Promise<unknown>]> = [
  ['completed', (s) => runDurable({ runId: 'done', journal: s.runs as any, model: payModel(1), tools, prompt: 'x', resourceId: 'ayse', threadId: 'th-1' } as any)],
  ['started (write-ahead, then a crash)', async (s) => { await s.runs.put('crashed:input', stampFormat({ at: 1, resourceId: 'ayse' })); await s.runs.put('crashed:outcome', { status: 'running', at: 1 }); }],
  ['suspended', (s) => runDurable({ runId: 'wait', journal: s.runs as any, model: payModel(1), tools, prompt: 'x', resourceId: 'bob', ...needsApproval } as any)],
  ['resumed', (s) => runDurable({ runId: 'wait', journal: s.runs as any, model: payModel(1), tools, prompt: 'x', resourceId: 'bob', approvals: { c0: true } } as any)],
  ['failed', (s) => runDurable({ runId: 'fail', journal: s.runs as any, model: dead, prompt: 'x', resourceId: 'ayse' } as any).catch(() => undefined)],
  ['suspended, to be canceled', (s) => runDurable({ runId: 'cs', journal: s.runs as any, model: payModel(1), tools, prompt: 'x', ...needsApproval } as any)],
  ['canceled while suspended', (s) => cancelAgentRun(s.runs as any, 'cs', { reason: 'operator' })],
  ['canceled after failed', (s) => cancelAgentRun(s.runs as any, 'fail', { reason: 'operator' })],
  ['canceled before it started', (s) => cancelAgentRun(s.runs as any, 'never', { reason: 'operator' })],
  ['failed (recorded)', (s) => s.runs.put('fsr:outcome', { status: 'failed', at: 1, error: 'boom' })],
  ['failed, then suspended', (s) => s.runs.put('fsr:tool:c1', suspendedRec)],
  ['failed, suspended, then resolved', (s) => s.runs.put('fsr:tool:c1', { status: 'succeeded', output: { ok: true } })],
  ['two approvals pending', async (s) => { await s.runs.put('two:tool:a', suspendedRec); await s.runs.put('two:tool:b', suspendedRec); }],
  ['one of two resolved', (s) => s.runs.put('two:tool:a', { status: 'succeeded', output: 1 })],
  ['both resolved', (s) => s.runs.put('two:tool:b', { status: 'succeeded', output: 2 })],
  ['running replaced by completed (putIfMatch)', async (s) => {
    await s.runs.put('pim:outcome', { status: 'running', at: 1 });
    await s.runs.putIfMatch!('pim:outcome', { status: 'running', at: 1 }, { status: 'completed', at: 2 });
  }],
  ['a batch: claim suspended + failed outcome', (s) => s.runs.applyBatch!({ claim: { key: 'bat:tool:c1', value: suspendedRec }, puts: [{ key: 'bat:outcome', value: { status: 'failed', at: 1 } }] })],
  ['a batch resolves it', (s) => s.runs.applyBatch!({ puts: [{ key: 'bat:tool:c1', value: { status: 'succeeded', output: 1 } }] })],
  ['takeover suspends a failed run (putIfMatch → recount)', async (s) => {
    await s.runs.put('tko:outcome', { status: 'failed', at: 1 });
    await s.runs.put('tko:tool:c1', { status: 'running', startedAt: 1 });
    await s.runs.putIfMatch!('tko:tool:c1', { status: 'running', startedAt: 1 }, suspendedRec);
  }],
  ['takeover resolves it (putIfMatch → recount)', (s) => s.runs.putIfMatch!('tko:tool:c1', suspendedRec, { status: 'succeeded', output: 1 })],
  ['fork', (s) => forkRun(s.runs as any, 'done', 1, 'done-fork')],
  ['rollover', async (s) => { await rolloverRun(s.runs as any, 'done', { newRunId: 'done-next' } as any); await runDurable({ runId: 'done-next', journal: s.runs as any, model: payModel(0), prompt: 'x', resourceId: 'ayse' } as any); }],
  ['sub-agents', (s) => fanOut(s, 'fan', 2)],
];

interface Snapshot {
  step: string;
  /** Every run and the status listRuns gives it. */
  runs: Record<string, RunStatus>;
  counts: Record<string, number>;
  /** listRuns({ status }) for each status, and listRuns({ statuses: open }) — run ids in listing order. */
  byStatus: Record<string, string[]>;
  open: string[];
}
const ALL: RunStatus[] = ['completed', 'suspended', 'failed', 'running', 'canceled'];
const OPEN: RunStatus[] = ['canceled', 'suspended', 'failed', 'running'];

async function listAll(s: Storage, q: Record<string, unknown> = {}, limit = 7): Promise<J.RunSummary[]> {
  const out: J.RunSummary[] = [];
  let cursor: string | undefined;
  do {
    const p = await s.runs.listRuns({ ...q, limit, ...(cursor ? { cursor } : {}) } as never);
    out.push(...p.items);
    cursor = p.nextCursor;
  } while (cursor);
  return out;
}

async function snapshot(s: Storage, step: string, page: number): Promise<Snapshot> {
  const all = await listAll(s, {}, page);
  const byStatus: Record<string, string[]> = {};
  for (const st of ALL) byStatus[st] = (await listAll(s, { status: st }, page)).map((r) => r.runId);
  const counts = await (s.runs as unknown as J.JournalReader).countRunsByStatus!();
  return {
    step,
    runs: Object.fromEntries(all.map((r) => [r.runId, r.status])),
    counts: Object.fromEntries(Object.entries(counts).filter(([, n]) => n > 0).sort()),
    byStatus,
    open: (await listAll(s, { statuses: OPEN }, page)).map((r) => r.runId),
  };
}

/** What the journal's own records say each run's status and outcome are — the definition, not a column. */
async function fromJournal(b: Backend): Promise<Record<string, { status: RunStatus; outcome: string | null; suspended: number }>> {
  const out: Record<string, { status: RunStatus; outcome: string | null; suspended: number }> = {};
  const ph = b.dialect === 'sqlite' ? '?' : '$1';
  for (const { run_id } of await b.sql('SELECT run_id FROM gnl_runs')) {
    const recs = await b.sql(`SELECT suspended FROM gnl_run_journal WHERE run_id = ${ph}`, [run_id]);
    const suspended = recs.filter((x: any) => !!x.suspended).length;
    const oc = (await b.storage.runs.get<{ status?: J.RunOutcomeRecord['status'] }>(`${run_id}:outcome`))?.status;
    out[run_id] = { status: J.deriveRunStatus(suspended > 0, oc ? { status: oc } : null), outcome: J.storedOutcomeOf(oc), suspended };
  }
  return out;
}

/** The columns as stored. */
async function stored(b: Backend): Promise<Record<string, { status: RunStatus; outcome: string | null; suspended: number }>> {
  const rows = await b.sql('SELECT run_id, status, outcome, suspended_count FROM gnl_runs');
  return Object.fromEntries(rows.map((x: any) => [x.run_id, { status: x.status, outcome: x.outcome ?? null, suspended: Number(x.suspended_count) }]));
}

/**
 * What 19b94c3f (the four flags) answered after each step of STEPS — captured by running this file on
 * that commit (`GNL_CAPTURE_STATUS=<file>`): identical on Sqlite and real Postgres. pg-mem differed in one
 * step on that code — after 'one of two resolved' it read `two` as completed with one approval still
 * pending (its evaluation of 0.10's `suspended = (suspended_count + $n) > 0`); this version reads it
 * suspended there too.
 */
const BEFORE: Snapshot[] = [
  {step:'completed',runs:{done:'completed'},counts:{completed:1},byStatus:{completed:['done'],suspended:[],failed:[],running:[],canceled:[]},open:[]},
  {step:'started (write-ahead, then a crash)',runs:{done:'completed',crashed:'running'},counts:{completed:1,running:1},byStatus:{completed:['done'],suspended:[],failed:[],running:['crashed'],canceled:[]},open:['crashed']},
  {step:'suspended',runs:{done:'completed',crashed:'running',wait:'suspended'},counts:{completed:1,running:1,suspended:1},byStatus:{completed:['done'],suspended:['wait'],failed:[],running:['crashed'],canceled:[]},open:['crashed','wait']},
  {step:'resumed',runs:{done:'completed',crashed:'running',wait:'completed'},counts:{completed:2,running:1},byStatus:{completed:['done','wait'],suspended:[],failed:[],running:['crashed'],canceled:[]},open:['crashed']},
  {step:'failed',runs:{done:'completed',crashed:'running',wait:'completed',fail:'failed'},counts:{completed:2,failed:1,running:1},byStatus:{completed:['done','wait'],suspended:[],failed:['fail'],running:['crashed'],canceled:[]},open:['crashed','fail']},
  {step:'suspended, to be canceled',runs:{done:'completed',crashed:'running',wait:'completed',fail:'failed',cs:'suspended'},counts:{completed:2,failed:1,running:1,suspended:1},byStatus:{completed:['done','wait'],suspended:['cs'],failed:['fail'],running:['crashed'],canceled:[]},open:['crashed','fail','cs']},
  {step:'canceled while suspended',runs:{done:'completed',crashed:'running',wait:'completed',fail:'failed',cs:'canceled'},counts:{canceled:1,completed:2,failed:1,running:1},byStatus:{completed:['done','wait'],suspended:[],failed:['fail'],running:['crashed'],canceled:['cs']},open:['crashed','fail','cs']},
  {step:'canceled after failed',runs:{done:'completed',crashed:'running',wait:'completed',fail:'failed',cs:'canceled'},counts:{canceled:1,completed:2,failed:1,running:1},byStatus:{completed:['done','wait'],suspended:[],failed:['fail'],running:['crashed'],canceled:['cs']},open:['crashed','fail','cs']},
  {step:'canceled before it started',runs:{done:'completed',crashed:'running',wait:'completed',fail:'failed',cs:'canceled',never:'canceled'},counts:{canceled:2,completed:2,failed:1,running:1},byStatus:{completed:['done','wait'],suspended:[],failed:['fail'],running:['crashed'],canceled:['cs','never']},open:['crashed','fail','cs','never']},
  {step:'failed (recorded)',runs:{done:'completed',crashed:'running',wait:'completed',fail:'failed',cs:'canceled',never:'canceled',fsr:'failed'},counts:{canceled:2,completed:2,failed:2,running:1},byStatus:{completed:['done','wait'],suspended:[],failed:['fail','fsr'],running:['crashed'],canceled:['cs','never']},open:['crashed','fail','cs','never','fsr']},
  {step:'failed, then suspended',runs:{done:'completed',crashed:'running',wait:'completed',fail:'failed',cs:'canceled',never:'canceled',fsr:'suspended'},counts:{canceled:2,completed:2,failed:1,running:1,suspended:1},byStatus:{completed:['done','wait'],suspended:['fsr'],failed:['fail'],running:['crashed'],canceled:['cs','never']},open:['crashed','fail','cs','never','fsr']},
  {step:'failed, suspended, then resolved',runs:{done:'completed',crashed:'running',wait:'completed',fail:'failed',cs:'canceled',never:'canceled',fsr:'failed'},counts:{canceled:2,completed:2,failed:2,running:1},byStatus:{completed:['done','wait'],suspended:[],failed:['fail','fsr'],running:['crashed'],canceled:['cs','never']},open:['crashed','fail','cs','never','fsr']},
  {step:'two approvals pending',runs:{done:'completed',crashed:'running',wait:'completed',fail:'failed',cs:'canceled',never:'canceled',fsr:'failed',two:'suspended'},counts:{canceled:2,completed:2,failed:2,running:1,suspended:1},byStatus:{completed:['done','wait'],suspended:['two'],failed:['fail','fsr'],running:['crashed'],canceled:['cs','never']},open:['crashed','fail','cs','never','fsr','two']},
  {step:'one of two resolved',runs:{done:'completed',crashed:'running',wait:'completed',fail:'failed',cs:'canceled',never:'canceled',fsr:'failed',two:'suspended'},counts:{canceled:2,completed:2,failed:2,running:1,suspended:1},byStatus:{completed:['done','wait'],suspended:['two'],failed:['fail','fsr'],running:['crashed'],canceled:['cs','never']},open:['crashed','fail','cs','never','fsr','two']},
  {step:'both resolved',runs:{done:'completed',crashed:'running',wait:'completed',fail:'failed',cs:'canceled',never:'canceled',fsr:'failed',two:'completed'},counts:{canceled:2,completed:3,failed:2,running:1},byStatus:{completed:['done','wait','two'],suspended:[],failed:['fail','fsr'],running:['crashed'],canceled:['cs','never']},open:['crashed','fail','cs','never','fsr']},
  {step:'running replaced by completed (putIfMatch)',runs:{done:'completed',crashed:'running',wait:'completed',fail:'failed',cs:'canceled',never:'canceled',fsr:'failed',two:'completed',pim:'completed'},counts:{canceled:2,completed:4,failed:2,running:1},byStatus:{completed:['done','wait','two','pim'],suspended:[],failed:['fail','fsr'],running:['crashed'],canceled:['cs','never']},open:['crashed','fail','cs','never','fsr']},
  {step:'a batch: claim suspended + failed outcome',runs:{done:'completed',crashed:'running',wait:'completed',fail:'failed',cs:'canceled',never:'canceled',fsr:'failed',two:'completed',pim:'completed',bat:'suspended'},counts:{canceled:2,completed:4,failed:2,running:1,suspended:1},byStatus:{completed:['done','wait','two','pim'],suspended:['bat'],failed:['fail','fsr'],running:['crashed'],canceled:['cs','never']},open:['crashed','fail','cs','never','fsr','bat']},
  {step:'a batch resolves it',runs:{done:'completed',crashed:'running',wait:'completed',fail:'failed',cs:'canceled',never:'canceled',fsr:'failed',two:'completed',pim:'completed',bat:'failed'},counts:{canceled:2,completed:4,failed:3,running:1},byStatus:{completed:['done','wait','two','pim'],suspended:[],failed:['fail','fsr','bat'],running:['crashed'],canceled:['cs','never']},open:['crashed','fail','cs','never','fsr','bat']},
  {step:'takeover suspends a failed run (putIfMatch → recount)',runs:{done:'completed',crashed:'running',wait:'completed',fail:'failed',cs:'canceled',never:'canceled',fsr:'failed',two:'completed',pim:'completed',bat:'failed',tko:'suspended'},counts:{canceled:2,completed:4,failed:3,running:1,suspended:1},byStatus:{completed:['done','wait','two','pim'],suspended:['tko'],failed:['fail','fsr','bat'],running:['crashed'],canceled:['cs','never']},open:['crashed','fail','cs','never','fsr','bat','tko']},
  {step:'takeover resolves it (putIfMatch → recount)',runs:{done:'completed',crashed:'running',wait:'completed',fail:'failed',cs:'canceled',never:'canceled',fsr:'failed',two:'completed',pim:'completed',bat:'failed',tko:'failed'},counts:{canceled:2,completed:4,failed:4,running:1},byStatus:{completed:['done','wait','two','pim'],suspended:[],failed:['fail','fsr','bat','tko'],running:['crashed'],canceled:['cs','never']},open:['crashed','fail','cs','never','fsr','bat','tko']},
  {step:'fork',runs:{done:'completed',crashed:'running',wait:'completed',fail:'failed',cs:'canceled',never:'canceled',fsr:'failed',two:'completed',pim:'completed',bat:'failed',tko:'failed','done-fork':'completed'},counts:{canceled:2,completed:5,failed:4,running:1},byStatus:{completed:['done','wait','two','pim','done-fork'],suspended:[],failed:['fail','fsr','bat','tko'],running:['crashed'],canceled:['cs','never']},open:['crashed','fail','cs','never','fsr','bat','tko']},
  {step:'rollover',runs:{done:'completed',crashed:'running',wait:'completed',fail:'failed',cs:'canceled',never:'canceled',fsr:'failed',two:'completed',pim:'completed',bat:'failed',tko:'failed','done-fork':'completed','done-next':'completed'},counts:{canceled:2,completed:6,failed:4,running:1},byStatus:{completed:['done','wait','two','pim','done-fork','done-next'],suspended:[],failed:['fail','fsr','bat','tko'],running:['crashed'],canceled:['cs','never']},open:['crashed','fail','cs','never','fsr','bat','tko']},
  {step:'sub-agents',runs:{done:'completed',crashed:'running',wait:'completed',fail:'failed',cs:'canceled',never:'canceled',fsr:'failed',two:'completed',pim:'completed',bat:'failed',tko:'failed','done-fork':'completed','done-next':'completed',fan:'completed','agent:fan:p0':'completed','agent:fan:p1':'completed'},counts:{canceled:2,completed:9,failed:4,running:1},byStatus:{completed:['done','wait','two','pim','done-fork','done-next','fan','agent:fan:p0','agent:fan:p1'],suspended:[],failed:['fail','fsr','bat','tko'],running:['crashed'],canceled:['cs','never']},open:['crashed','fail','cs','never','fsr','bat','tko']},
];

if (CAPTURE) {
  describe('capture (19b94c3f)', () => {
    it('writes the snapshots', async () => {
      const out: Record<string, Snapshot[]> = {};
      for (const [name, make] of BACKENDS) {
        const b = await make();
        await b.storage.init?.();
        const snaps: Snapshot[] = [];
        for (const [step, f] of STEPS) { await f(b.storage); snaps.push(await snapshot(b.storage, step, b.page)); }
        out[name] = snaps;
      }
      writeFileSync(CAPTURE, JSON.stringify(out, null, 1));
    }, 120_000);
  });
}

describe.skipIf(CAPTURE !== undefined || !A2)('Q2/Q3: the status rule is one table', () => {
  it('runStatusOf is deriveRunStatus of (count > 0, outcome); a completed outcome decides like none', () => {
    const truth: Array<[number, J.StoredOutcome | null, RunStatus]> = [
      [0, null, 'completed'], [0, 'running', 'running'], [0, 'failed', 'failed'], [0, 'canceled', 'canceled'],
      [1, null, 'suspended'], [1, 'running', 'suspended'], [1, 'failed', 'suspended'], [1, 'canceled', 'canceled'],
      [2, null, 'suspended'], [2, 'failed', 'suspended'], [2, 'canceled', 'canceled'],
    ];
    for (const [n, oc, want] of truth) expect(J.runStatusOf(n, oc), `${n} ${oc}`).toBe(want);
    for (const s of [false, true]) expect(J.deriveRunStatus(s, { status: 'completed' })).toBe(J.deriveRunStatus(s, null));
    expect(J.storedOutcomeOf('completed')).toBeNull();
  });

  for (const [name, make] of BACKENDS) {
    it(`${name}: the SQL each database evaluates (runStatusCaseSql) agrees with runStatusOf on every input`, async () => {
      const b = await make();
      await b.storage.init?.();
      for (const n of [-1, 0, 1, 2]) {
        for (const oc of [null, 'running', 'failed', 'canceled'] as const) {
          const lit = oc === null ? 'NULL' : `'${oc}'`;
          const [row] = await b.sql(`SELECT ${J.runStatusCaseSql(`${n} > 0`, lit)} AS s`);
          expect(row.s, `${n} ${oc}`).toBe(J.runStatusOf(n, oc));
        }
      }
    });
  }

  it('the status alone is not enough: same status and counter, same write, different answers — the outcome decides', async () => {
    const b = sqliteBackend();
    const j = b.storage.runs;
    await j.put('h1:outcome', { status: 'failed', at: 1 });
    for (const r of ['h1', 'h2']) await j.put(`${r}:tool:c1`, suspendedRec);
    const before = await stored(b);
    expect([before.h1!.status, before.h1!.suspended]).toEqual(['suspended', 1]);
    expect([before.h2!.status, before.h2!.suspended]).toEqual(['suspended', 1]);
    for (const r of ['h1', 'h2']) await j.put(`${r}:tool:c1`, { status: 'succeeded', output: 1 });
    const after = await stored(b);
    expect([after.h1!.status, after.h2!.status]).toEqual(['failed', 'completed']);
  });
});

for (const [name, make] of BACKENDS) {
  describe.skipIf(CAPTURE !== undefined || !A2)(`Q1: a run's status column — ${name}`, () => {
    it('after every step: the column is what the journal says, and every read answers what 19b94c3f answered', async () => {
      const b = await make();
      await b.storage.init?.();
      expect(BEFORE.map((x) => x.step)).toEqual(STEPS.map(([step]) => step));
      for (const [i, [step, f]] of STEPS.entries()) {
        await f(b.storage);
        expect(await stored(b), step).toEqual(await fromJournal(b));
        expect(await snapshot(b.storage, step, b.page), step).toEqual(BEFORE[i]);
      }
    }, 60_000);
  });
}

// ── the migration ─────────────────────────────────────────────────────────────────────────────────
/**
 * `gnl_runs` put back into 19b94c3f's shape: its four flags and its flag index, no `status`/`outcome`.
 * By ALTER rather than 19b94c3f's CREATE TABLE: pg-mem keeps a dropped table's primary-key name and
 * refuses the table created again ("relation gnl_runs_pkey already exists").
 */
const OLD_RUNS = {
  pg: [
    `ALTER TABLE gnl_runs ADD COLUMN suspended BOOLEAN NOT NULL DEFAULT false, ADD COLUMN failed BOOLEAN NOT NULL DEFAULT false, ADD COLUMN running BOOLEAN NOT NULL DEFAULT false, ADD COLUMN canceled BOOLEAN NOT NULL DEFAULT false`,
    `DROP INDEX gnl_runs_open`, `DROP INDEX gnl_runs_status`,
    `ALTER TABLE gnl_runs DROP COLUMN status, DROP COLUMN outcome`,
    `CREATE INDEX gnl_runs_open ON gnl_runs (created_at, run_id) WHERE canceled = true OR suspended = true OR failed = true OR running = true`,
  ],
  sqlite: [
    `ALTER TABLE gnl_runs ADD COLUMN suspended INTEGER NOT NULL DEFAULT 0`,
    `ALTER TABLE gnl_runs ADD COLUMN failed INTEGER NOT NULL DEFAULT 0`,
    `ALTER TABLE gnl_runs ADD COLUMN running INTEGER NOT NULL DEFAULT 0`,
    `ALTER TABLE gnl_runs ADD COLUMN canceled INTEGER NOT NULL DEFAULT 0`,
    `DROP INDEX gnl_runs_open`, `DROP INDEX gnl_runs_status`,
    `ALTER TABLE gnl_runs DROP COLUMN status`,
    `ALTER TABLE gnl_runs DROP COLUMN outcome`,
    `CREATE INDEX gnl_runs_open ON gnl_runs (created_at, run_id) WHERE canceled = 1 OR suspended = 1 OR failed = 1 OR running = 1`,
  ],
};
/** 0.10's journal write of a model step on Postgres: its run-row statement names `suspended`. */
const OLD_TOUCH = {
  pg: `INSERT INTO gnl_runs (run_id, model_steps, tool_calls, suspended, suspended_count, created_at, updated_at)
       VALUES ($1,1,0,false,0,$2,$2) ON CONFLICT (run_id) DO UPDATE SET model_steps = gnl_runs.model_steps + 1,
         suspended_count = gnl_runs.suspended_count + 0, suspended = (gnl_runs.suspended_count + 0) > 0, updated_at = $2`,
  sqlite: `INSERT INTO gnl_runs (run_id, model_steps, tool_calls, suspended, suspended_count, created_at, updated_at)
       VALUES (?1,1,0,0,0,?2,?2) ON CONFLICT(run_id) DO UPDATE SET model_steps = gnl_runs.model_steps + 1,
         suspended_count = gnl_runs.suspended_count + 0, suspended = (gnl_runs.suspended_count + 0) > 0, updated_at = ?2`,
};

/** 0.10's decoding of the flags, verbatim (`outcomeOfRow` + `deriveRunStatus` as 19b94c3f had them). */
function oldStatus(r: { suspended: unknown; failed: unknown; running: unknown; canceled: unknown }): { status: RunStatus; outcome: string | null } {
  const outcome = r.canceled ? 'canceled' : r.failed ? 'failed' : r.running ? 'running' : null;
  const status: RunStatus = outcome === 'canceled' ? 'canceled' : r.suspended ? 'suspended' : outcome === 'failed' ? 'failed' : outcome === 'running' ? 'running' : 'completed';
  return { status, outcome };
}

/**
 * A store left by the flag-format code: this version's tables (written by `init`), its `gnl_runs` put
 * back to 19b94c3f's shape, and one run per combination of the four flags (all 16 — including ones 0.10
 * never wrote together, so the rule is proven where 0.10's decoder had to choose) plus a counter that
 * disagrees with its flag.
 */
async function oldStore(b: Backend): Promise<Array<{ id: string; flags: Record<string, boolean>; count: number }>> {
  await b.storage.init?.();
  for (const sql of OLD_RUNS[b.dialect]) await b.sql(sql);
  const rows: Array<{ id: string; flags: Record<string, boolean>; count: number }> = [];
  for (let m = 0; m < 16; m++) {
    const flags = { suspended: !!(m & 1), failed: !!(m & 2), running: !!(m & 4), canceled: !!(m & 8) };
    rows.push({ id: `f${String(m).padStart(2, '0')}`, flags, count: flags.suspended ? 1 : 0 });
  }
  rows.push({ id: 'g-count-without-flag', flags: { suspended: false, failed: false, running: false, canceled: false }, count: 2 });
  for (const [i, r] of rows.entries()) {
    const v = (x: boolean) => (b.dialect === 'pg' ? x : x ? 1 : 0);
    await b.sql(b.dialect === 'pg'
      ? 'INSERT INTO gnl_runs (run_id, model_steps, tool_calls, suspended, suspended_count, failed, running, canceled, created_at, updated_at) VALUES ($1,1,0,$2,$3,$4,$5,$6,$7,$7)'
      : 'INSERT INTO gnl_runs (run_id, model_steps, tool_calls, suspended, suspended_count, failed, running, canceled, created_at, updated_at) VALUES (?,1,0,?,?,?,?,?,?,?)',
    b.dialect === 'pg' ? [r.id, v(r.flags.suspended), r.count, v(r.flags.failed), v(r.flags.running), v(r.flags.canceled), 1000 + i]
      : [r.id, v(r.flags.suspended), r.count, v(r.flags.failed), v(r.flags.running), v(r.flags.canceled), 1000 + i, 1000 + i]);
  }
  return rows;
}

const upgradeRefusal = /format of an earlier version[\s\S]*gnl upgrade/;
/** The dialect a backend name stands for. */
const b0 = (name: string): 'sqlite' | 'pg' => (name.startsWith('Postgres') ? 'pg' : 'sqlite');

for (const [name, make] of BACKENDS) {
  describe.skipIf(CAPTURE !== undefined || !A2)(`M: the run-status step — ${name}`, () => {
    it('M1: a store in the flag format is refused — every port, with the one way through — and `upgrade --list` names the step', async () => {
      const b = await make();
      await oldStore(b);
      const s = b.reopen();
      await expect(s.init?.() ?? Promise.reject(new Error('no init'))).rejects.toThrow(upgradeRefusal);
      await expect(s.runs.get('f00:input')).rejects.toThrow(upgradeRefusal);
      await expect(s.runs.listRuns()).rejects.toThrow(upgradeRefusal);
      if (s.memory) await expect(s.memory.getThread('t')).rejects.toThrow(upgradeRefusal);
      const dry = await s.upgrade!({ dryRun: true });
      const step = dry.steps.find((x) => x.name === 'run-status')!;
      expect(step.pending).toBe(true);
      const plan = (step.detail as { statements: string[] }).statements.join('\n');
      expect(plan).toMatch(/gnl_runs_open/);
      expect(plan).toMatch(/DROP COLUMN/);
      // Nothing else runs ahead of it: the schema step names it.
      await expect(s.upgrade!({ only: ['schema'] })).rejects.toThrow(/'schema' needs 'run-status' first/);
    });

    it('M2: every run keeps the status its flags decoded to; listings and counts answer the same; idempotent', async () => {
      const b = await make();
      const rows = await oldStore(b);
      const want = Object.fromEntries(rows.map((r) => [r.id, oldStatus(r.flags)]));
      const wantCounts: Record<string, number> = {};
      for (const r of Object.values(want)) wantCounts[r.status] = (wantCounts[r.status] ?? 0) + 1;
      const s = b.reopen();
      const ran = await s.upgrade!();
      const step = ran.steps.find((x) => x.name === 'run-status')!;
      expect(step.ran).toBe(true);
      expect((step.detail as { runs: number }).runs).toBe(15); // the 15 rows with a flag; the rest are the default
      const got = Object.fromEntries((await b.sql('SELECT run_id, status, outcome FROM gnl_runs')).map((x: any) => [x.run_id, { status: x.status, outcome: x.outcome ?? null }]));
      expect(got).toEqual(want);
      const cols = b.dialect === 'pg'
        ? (await b.sql(`SELECT column_name AS name FROM information_schema.columns WHERE table_name = 'gnl_runs'`)).map((x: any) => x.name)
        : (await b.sql('PRAGMA table_info(gnl_runs)')).map((x: any) => x.name);
      for (const f of ['suspended', 'failed', 'running', 'canceled']) expect(cols).not.toContain(f);
      expect(cols).toEqual(expect.arrayContaining(['status', 'outcome', 'suspended_count']));
      // Every read answers what the flags did.
      const all = await listAll(s, {}, b.page);
      expect(Object.fromEntries(all.map((r) => [r.runId, r.status]))).toEqual(Object.fromEntries(rows.map((r) => [r.id, want[r.id]!.status])));
      expect(await (s.runs as unknown as J.JournalReader).countRunsByStatus!()).toEqual(wantCounts);
      for (const st of ALL) expect((await listAll(s, { status: st }, b.page)).map((r) => r.runId), st).toEqual(rows.filter((r) => want[r.id]!.status === st).map((r) => r.id));
      expect((await listAll(s, { statuses: OPEN }, b.page)).map((r) => r.runId)).toEqual(rows.filter((r) => want[r.id]!.status !== 'completed').map((r) => r.id));
      // Writes on a migrated row follow the stored outcome: f02 (failed) suspended and resolved reads failed again.
      await s.runs.put('f02:tool:c9', suspendedRec);
      expect((await listAll(s, { status: 'suspended' }, b.page)).map((r) => r.runId)).toContain('f02');
      await s.runs.put('f02:tool:c9', { status: 'succeeded', output: 1 });
      expect((await stored(b)).f02).toEqual({ status: 'failed', outcome: 'failed', suspended: 0 });
      // Once is all: nothing pending, a second run does nothing, the schema is whole.
      const again = await s.upgrade!();
      expect(again.steps.filter((x) => x.ran || x.pending !== false).map((x) => x.name)).toEqual([]);
      expect((await s.checkSchema!()).ok).toBe(true);
    });

    it('M2b: a step that dies half-way leaves the store as it was, and running it again is the whole migration', async () => {
      const b = await make();
      const rows = await oldStore(b);
      const s = b.reopen() as SqliteStorage | PostgresStorage;
      // The step fails on its drop of the flags — after the fill, inside its transaction — as a backend
      // killed there would (57P01). Only for this one call: the next one is the plain migration.
      const kill = (sql: unknown) => {
        if (/^ALTER TABLE gnl_runs DROP COLUMN/.test(String(sql))) throw Object.assign(new Error('killed mid-step'), { code: '57P01' });
      };
      let restore: () => void;
      if (b.dialect === 'sqlite') {
        const db = (s as any).db;
        const prepare = db.prepare;
        db.prepare = (sql: string) => { kill(sql); return prepare.call(db, sql); };
        restore = () => { db.prepare = prepare; };
      } else {
        // The step's own transaction is a connection it checks out (`pool.connect()`, no callback — the
        // callback form is pg's own `pool.query`, left alone); the connection goes back unchanged.
        const pool = (s as any)._pool;
        const connect = pool.connect;
        pool.connect = (...a: unknown[]) => (a.length ? connect.apply(pool, a) : connect.call(pool).then((c: any) => {
          const query = c.query;
          const release = c.release;
          c.query = (sql: unknown, ...rest: unknown[]) => { kill(sql); return query.call(c, sql, ...rest); };
          c.release = (...r: unknown[]) => { c.query = query; c.release = release; return release?.apply(c, r); };
          return c;
        }));
        restore = () => { pool.connect = connect; };
      }
      await expect(s.upgrade!({ only: ['run-status'] })).rejects.toThrow(/killed mid-step/);
      restore();
      if (b.real) {
        // Rolled back: the flags are all there and the store is still refused. (pg-mem's ROLLBACK undoes
        // nothing.) Sqlite did everything in that transaction, so its new columns are gone too; Postgres
        // keeps what it committed before it — the columns and the filled pages, each run filled exactly as
        // its flags say — which is where the next run continues.
        const cols = b.dialect === 'pg'
          ? (await b.sql(`SELECT column_name AS name FROM information_schema.columns WHERE table_name = 'gnl_runs'`)).map((x: any) => x.name)
          : (await b.sql('PRAGMA table_info(gnl_runs)')).map((x: any) => x.name);
        expect(cols).toEqual(expect.arrayContaining(['suspended', 'failed', 'running', 'canceled']));
        if (b.dialect === 'pg') {
          const filled = await b.sql(`SELECT run_id, status, outcome, suspended, failed, running, canceled FROM gnl_runs`);
          expect(filled.every((x: any) => x.status === oldStatus(x).status && (x.outcome ?? null) === oldStatus(x).outcome)).toBe(true);
        } else expect(cols).not.toContain('status');
        await expect(s.runs.listRuns()).rejects.toThrow(upgradeRefusal);
      }
      await s.upgrade!({ only: ['run-status'] });
      const got = Object.fromEntries((await b.sql('SELECT run_id, status, outcome FROM gnl_runs')).map((x: any) => [x.run_id, { status: x.status, outcome: x.outcome ?? null }]));
      expect(got).toEqual(Object.fromEntries(rows.map((r) => [r.id, oldStatus(r.flags)])));
    });

    it('M3: a 0.10 write after the step fails on its first statement and writes nothing', async () => {
      const b = await make();
      await oldStore(b);
      const s = b.reopen();
      await s.upgrade!();
      const before = await stored(b);
      const err = await b.sql(OLD_TOUCH[b.dialect], b.dialect === 'pg' ? ['f01', Date.now()] : ['f01', Date.now()]).then(() => undefined, (e: Error) => e);
      expect(err, 'a 0.10 statement was accepted').toBeInstanceOf(Error);
      expect(String(err!.message)).toMatch(/suspended/);
      if (b.real) expect(String(err!.message)).toMatch(b.dialect === 'pg' ? /column "suspended" of relation "gnl_runs" does not exist/ : /table gnl_runs has no column named suspended/);
      expect(await stored(b)).toEqual(before);
    });

    it('M5: one `upgrade()` with no boot first finishes every step — an organization\'s threads included', async () => {
      // A store whose run-status step is pending cannot be booted first (`init` refuses), so the steps after
      // it boot the adapter themselves: on a linguistic-collation Postgres an unbooted instance's first key
      // range matched nothing, and `thread-records` saw no organization (PostgresStorage.booted).
      const b = await make();
      await oldStore(b);
      const { serialize } = await import('../src/serialize.js');
      // An organization the earlier version registered, and a root scope it had already marked complete —
      // so only the organization's scope is left, and only a step that sees the organization finds it.
      for (const key of ['__org__:acme', 'thread:records:v1']) {
        await b.sql(b.dialect === 'pg'
          ? `INSERT INTO gnl_run_journal (key, run_id, kind, suspended, value, created_at) VALUES ($1, NULL, NULL, false, $2, 1)`
          : `INSERT INTO gnl_run_journal (key, run_id, kind, suspended, value, created_at) VALUES (?, NULL, NULL, 0, ?, 1)`, [key, serialize({ at: 1 })]);
      }
      const s = b.reopen();
      const first = await s.upgrade!();
      expect(first.steps.find((x) => x.name === 'thread-records')!.detail).toMatchObject({ scopes: { acme: expect.anything() } });
      const again = await s.upgrade!({ dryRun: true });
      expect(again.steps.filter((x) => x.pending).map((x) => x.name)).toEqual([]);
    });

    it('M6: an earlier version that boots after the step puts three flags back; this version refuses again, and the step drops them changing no status', async () => {
      // Measured with the real 0.10.0 and 19b94c3f: their boot DDL re-adds `failed`, `running`, `canceled`
      // (`ADD COLUMN IF NOT EXISTS`, all false) — never `suspended`, which every one of their writes names,
      // so they write nothing. Those three, as their boot adds them:
      const b = await make();
      await oldStore(b);
      const s = b.reopen();
      await s.upgrade!();
      const settled = await stored(b);
      for (const f of ['failed', 'running', 'canceled']) {
        await b.sql(b.dialect === 'pg' ? `ALTER TABLE gnl_runs ADD COLUMN IF NOT EXISTS ${f} BOOLEAN NOT NULL DEFAULT false` : `ALTER TABLE gnl_runs ADD COLUMN ${f} INTEGER NOT NULL DEFAULT 0`);
      }
      await expect(b.reopen().runs.listRuns()).rejects.toThrow(upgradeRefusal);
      const again = await b.reopen().upgrade!({ only: ['run-status'] });
      expect(again.steps.find((x) => x.name === 'run-status')).toMatchObject({ ran: true, detail: { runs: 0 } });
      expect(await stored(b)).toEqual(settled);
    });

    it('M7 (Postgres): a write an earlier version makes after its run was filled is reconciled under the lock', async () => {
      // Postgres fills page by page with no table lock, so a 0.10 process left running (against the
      // procedure) can still change flags afterwards; the short locked transaction at the end compares every
      // flagged or filled row with its flags again. The writes land while the new index is being built.
      if (b0(name) !== 'pg') return;
      const b = await make();
      const rows = await oldStore(b);
      const s = b.reopen() as PostgresStorage;
      const pool = (s as any)._pool;
      const query = pool.query;
      let landed = false;
      pool.query = async (sql: unknown, ...rest: unknown[]) => {
        if (!landed && /^CREATE INDEX CONCURRENTLY IF NOT EXISTS gnl_runs_open_status/.test(String(sql))) {
          landed = true;
          await b.sql(`UPDATE gnl_runs SET failed = false, running = true WHERE run_id = 'f02'`); // filled as failed, now running
          await b.sql(`UPDATE gnl_runs SET failed = true WHERE run_id = 'f00'`); // left at the default, now failed
          await b.sql(`UPDATE gnl_runs SET suspended = false, suspended_count = 0 WHERE run_id = 'f01'`); // filled as suspended, now resolved
        }
        return query.call(pool, sql, ...rest);
      };
      const ran = await s.upgrade!({ only: ['run-status'] });
      pool.query = query;
      expect(landed).toBe(true);
      expect(ran.steps[0]!.detail).toMatchObject({ reconciled: 3 });
      const got = await stored(b);
      expect([got.f00, got.f01, got.f02]).toEqual([
        { status: 'failed', outcome: 'failed', suspended: 0 },
        { status: 'completed', outcome: null, suspended: 0 },
        { status: 'running', outcome: 'running', suspended: 0 },
      ]);
      for (const r of rows.filter((x) => !['f00', 'f01', 'f02'].includes(x.id))) expect(got[r.id], r.id).toMatchObject(oldStatus(r.flags));
    });

    it('M4: a process that opened before the step serves the store once the step has run elsewhere', async () => {
      const b = await make();
      await oldStore(b);
      const early = b.reopen();
      await expect(early.runs.listRuns()).rejects.toThrow(upgradeRefusal);
      await b.reopen().upgrade!();
      expect((await listAll(early, {}, b.page)).length).toBe(17);
      await early.runs.put('late:model:0', { text: 'x' });
      expect((await stored(b)).late).toEqual({ status: 'completed', outcome: null, suspended: 0 });
    });
  });
}
