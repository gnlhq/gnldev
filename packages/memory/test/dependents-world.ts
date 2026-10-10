// One world with everything a run, a thread and a person can own — built the same way on every store —
// and a dump of what is in a store, so two paths that should delete the same things can be compared.
//
// Shared by dependents-model.test.ts (the promises) and the C+ step C probe that measured the copies
// against each other before the model existed (H5).
//
// THE WORLD, in the root scope and again, with the same ids, in organization `acme`:
//   person ayse, thread t-a:
//     r-a1   a turn that calls a sub-agent           → child run agent:r-a1:c-agent_w (on t-a too)
//     r-a2   a turn suspended on an approval (`confirm`)
//     r-a4   a turn whose tool uses the thread idempotency window → xthr:t-a:…
//     r-a1f  a fork of r-a1;  r-a1n  its rollover (both on t-a)
//     messages, thread working memory, observations, an observation vector, om:/mem:/sem: journal state
//   person ayse, no thread: r-a3 (with its own sub-agent child)
//   ayse's person-keyed records (lesson:res:, xid:res:), her working memory, her document, her owned job
//   person bob, thread t-b: r-b1, his document and job — what an erasure of ayse must not touch
//   root only: a platform meta key and an ordinary one (what adoptIntoOrg must and must not move)
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { newDb, DataType } from 'pg-mem';
import pg from 'pg';
import { z } from 'zod';
import {
  InMemoryStorage, createGnl, user, withOrgStorage, toJournal, forkRun, rolloverRun, gnlTool, ownedPrefix, semanticLogKey, memKey,
  workingMemoryScope, VECTOR_ALL_PARTITIONS, ORG_RECORD_PRE, type Storage,
} from '@gnldev/durable';
import { SqliteStorage } from '../../durable/src/sqlite-storage.js';
import { PostgresStorage } from '../../durable/src/postgres-storage.js';
import { memoryPreset } from '../src/index.js';

(globalThis as { AI_SDK_LOG_WARNINGS?: boolean }).AI_SDK_LOG_WARNINGS = false;
const usage = { inputTokens: { total: 1, text: 1 }, outputTokens: { total: 1, text: 1, reasoning: undefined }, totalTokens: 2 };
const stop = { unified: 'stop', raw: 'stop' };
const calls = { unified: 'tool-calls', raw: 'tool-calls' };

/** Calls the tool its last user message names (once — after a tool answer it says 'ok'). */
const mainModel: any = {
  specificationVersion: 'v4', provider: 'mock', modelId: 'main', supportedUrls: {},
  doGenerate: async ({ prompt }: any) => {
    const ms: any[] = prompt ?? [];
    let lu = -1;
    ms.forEach((m, i) => { if (m.role === 'user') lu = i; });
    const answered = ms.slice(lu + 1).some((m) => m.role === 'tool');
    const u = JSON.stringify(lu >= 0 ? ms[lu] : '');
    const call = (toolName: string, input: unknown) => ({ content: [{ type: 'tool-call', toolCallId: `c-${toolName}`, toolName, input: JSON.stringify(input) }], finishReason: calls, usage, warnings: [] });
    if (!answered && u.includes('SUB')) return call('agent_w', { task: 'w0' });
    if (!answered && u.includes('PAY')) return call('pay', { amount: 5 });
    if (!answered && u.includes('NOTE')) return call('note', { text: 'n1' });
    if (!answered && u.includes('CHARGE')) return call('charge', { amount: 7 });
    return { content: [{ type: 'text', text: 'ok' }], finishReason: stop, usage, warnings: [] };
  },
};
const wModel: any = {
  specificationVersion: 'v4', provider: 'mock', modelId: 'w', supportedUrls: {},
  doGenerate: async () => ({ content: [{ type: 'text', text: 'child done' }], finishReason: stop, usage, warnings: [] }),
};
const observer: any = {
  specificationVersion: 'v4', provider: 'mock', modelId: 'obs', supportedUrls: {},
  doGenerate: async () => ({ content: [{ type: 'text', text: 'OBS' }], finishReason: stop, usage, warnings: [] }),
};
const embed = async (t: string[]) => t.map(() => [1, 0, 0]);
/** How many times `charge` really ran — the exactly-once probe. */
export const effects = { charge: 0 };
const pay = gnlTool({ description: 'pay', inputSchema: z.object({ amount: z.number() }), execute: async () => ({ paid: true }) } as any, { sideEffect: true, confirm: true });
const note = gnlTool({ description: 'note', inputSchema: z.object({ text: z.string() }), execute: async () => ({ noted: true }) } as any, { sideEffect: true, idempotencyWindow: 'thread' } as any);
const charge = gnlTool({ description: 'charge', inputSchema: z.object({ amount: z.number() }), execute: async () => { effects.charge++; return { charged: true }; } } as any, { sideEffect: true, idempotencyWindow: 'cross-run' } as any);

/** The memory and engine of one scope, built the way an application builds them. */
export function scopeOf(storage: Storage, org?: string) {
  const view = org ? withOrgStorage(storage, org) : storage;
  const memory: any = memoryPreset(view as any, 'chat', { observationalMemory: { observerModel: observer, omVectors: { store: view.vectors!, embed } } as any });
  const gnl = createGnl({ storage: view, memory, agents: { main: { model: mainModel, agents: ['w'], tools: { pay, note, charge } }, w: { model: wModel } } } as any);
  return { view, memory, gnl, journal: toJournal(view.runs) };
}

/** The world in one scope (root, or an organization's view). Same ids in both. */
export async function world(storage: Storage, org?: string): Promise<void> {
  if (org) await toJournal(storage.runs).put(`${ORG_RECORD_PRE}${org}`, { id: org });
  else { await storage.meta!.set('__eeuser__:u1', 'platform'); await storage.meta!.set('app-setting', 'data'); }
  const { view, memory, gnl, journal: J } = scopeOf(storage, org);
  const ayse = user('ayse', org);
  await gnl.run('main', { runId: 'r-a1', prompt: 'SUB please', threadId: 't-a', caller: ayse });
  await gnl.run('main', { runId: 'r-a2', prompt: 'PAY please', threadId: 't-a', caller: ayse }); // suspends: an approval
  await gnl.run('main', { runId: 'r-a4', prompt: 'NOTE please', threadId: 't-a', caller: ayse }); // xthr: record
  await forkRun(J as any, 'r-a1', 1, 'r-a1f');
  await rolloverRun(J as any, 'r-a1', { newRunId: 'r-a1n' } as any);
  await gnl.run('main', { runId: 'r-a3', prompt: 'SUB no thread', caller: ayse }); // thread-less, with a child
  await gnl.run('main', { runId: 'r-b1', prompt: 'hi', threadId: 't-b', caller: user('bob', org) });
  // Memory-side state of t-a.
  await view.memory!.setWorkingMemory(workingMemoryScope.thread('t-a'), { wm: 'AYSE-THREAD-WM' });
  await view.memory!.setWorkingMemory(workingMemoryScope.resource('ayse'), { wm: 'AYSE-RES-WM' });
  await view.memory!.putObservations('t-a', [{ id: 'o1', text: 'AYSE-OBS', fromSeq: 0, toSeq: 1 } as any]);
  await memory.indexObservationVector('t-a', 0, 1, { id: 'o1', text: 'AYSE-OBS-VEC', fromSeq: 0, toSeq: 1, threadId: 't-a' });
  await J.put('om:t-a:observedSeq', 1);
  await J.put('om:t-a:proc:observe:0', { text: 'AYSE-OBSERVER-OUTPUT' });
  await J.put(memKey('t-a', 'working'), { wm: 'AYSE-BASIC' }); // a journal-kept (BasicMemory) leaf beside it
  await J.put(semanticLogKey('t-a'), { log: 'AYSE-SEM' });
  // Person-keyed families.
  await J.put('lesson:res:ayse:L1', { text: 'AYSE-LESSON' });
  await J.put('xid:res:ayse:pay:0123456789abcdef', { toolName: 'pay' });
  // Documents and owned work.
  await view.vectors!.upsert([{ id: 'doc-a', text: 'AYSE-DOC', embedding: [1, 0, 0], owner: 'ayse' }, { id: 'doc-b', text: 'BOB-DOC', embedding: [1, 0, 0], owner: 'bob' }]);
  await storage.work!.append('jobs', { job: 'AYSE-JOB' }, `${ownedPrefix({ resourceId: 'ayse', ...(org ? { orgId: org } : {}) })}j1`);
  await storage.work!.append('jobs', { job: 'BOB-JOB' }, `${ownedPrefix({ resourceId: 'bob', ...(org ? { orgId: org } : {}) })}j1`);
}

/** Root and acme, the same ids in both. */
export async function bothWorlds(storage: Storage): Promise<void> {
  await world(storage);
  await world(storage, 'acme');
}

export interface Backend { name: string; storage: Storage; raw: () => Promise<string[]> }
const THREADS = ['t-a', 't-b', 'org:acme:t-a', 'org:acme:t-b', 'org:acme2:t-a', 'org:acme2:t-b'];
const PEOPLE = ['ayse', 'bob', 'org:acme:ayse', 'org:acme:bob', 'org:acme2:ayse', 'org:acme2:bob'];
const scoped = (k: string, f: (rest: string) => string) => { const m = /^(org:[^:]+:)(.*)$/.exec(k); return m ? `${m[1]}${f(m[2]!)}` : f(k); };

/**
 * What is in the store, as identities — keys, ids, row presence; no values, no timestamps — through
 * the ports, then every table's rows (the same format on every store), then what each organization
 * reads through its own view. Sorted, so two dumps compare as arrays.
 */
export async function dump(b: Backend): Promise<string[]> {
  const s = b.storage;
  const J: any = toJournal(s.runs);
  const out: string[] = [];
  // Counter rows: InMemory's listKeys reports them, the SQL adapters' does not (gnl_counters) — compared as rows below.
  for (const k of await J.listKeys('')) if (!/^(org:[^:]+:)?(__metrics__:|__usage__)/.test(k)) out.push(`j ${k}`);
  let cursor: string | undefined;
  do {
    const p = await J.listRunsPaged({ limit: 500, ...(cursor ? { cursor } : {}) });
    // `entries`: what readRun hands back for it — the time-travel, cost and child-discovery reads.
    for (const r of p.items) out.push(`run ${r.runId} ${r.status} thread=${r.threadId ?? '-'} person=${r.resourceId ?? '-'} entries=${(await J.readRun(r.runId)).length}`);
    cursor = p.nextCursor;
  } while (cursor);
  for (const t of THREADS) {
    if (await s.memory!.getThread(t)) out.push(`thread ${t}`);
    // Presence, not count: pg-mem's message count differs from the real stores' for the same world.
    if ((await s.memory!.getMessages(t, { limit: 1000 })).items.length) out.push(`messages ${t}`);
    if ((await s.memory!.getObservations(t)).length) out.push(`observations ${t}`);
    const wmKey = scoped(t, workingMemoryScope.thread);
    if ((await s.memory!.getWorkingMemory(wmKey)) !== undefined) out.push(`wm ${wmKey}`);
  }
  for (const p of PEOPLE) {
    const wmKey = scoped(p, workingMemoryScope.resource);
    if ((await s.memory!.getWorkingMemory(wmKey)) !== undefined) out.push(`wm ${wmKey}`);
  }
  for (const v of await s.vectors!.query([1, 0, 0], 1000, { [VECTOR_ALL_PARTITIONS]: true } as any)) out.push(`vec ${v.id} ${v.text}`);
  for (const ns of ['jobs', 'org:acme:jobs', 'org:acme2:jobs']) for (const r of (await s.work!.list(ns, { limit: 1000 })).items) out.push(`work ${ns} ${r.id}`);
  for (const org of ['acme', 'acme2']) {
    const v = withOrgStorage(s, org).memory!;
    for (const t of (await v.listThreads({ limit: 1000 })).items) out.push(`view ${org} lists thread ${t.id}`);
    for (const t of ['t-a', 't-b']) if ((await v.getMessages(t, { limit: 1000 })).items.length) out.push(`view ${org} reads messages ${t}`);
  }
  out.push(...(await b.raw()));
  return [...new Set(out)].sort();
}

/** Every row of every store table, in one format for all stores (identities only). */
function sqlRaw(all: (sql: string) => Promise<any[]>): () => Promise<string[]> {
  return async () => {
    const out: string[] = [];
    for (const r of await all('SELECT run_id, thread_id, resource_id, status FROM gnl_runs')) out.push(`row runs ${r.run_id} ${r.status} t=${r.thread_id ?? 'NULL'} p=${r.resource_id ?? 'NULL'}`);
    for (const r of await all('SELECT DISTINCT key FROM gnl_counters')) out.push(`row counters ${r.key}`);
    for (const r of await all('SELECT id, resource_id, deleted_at FROM gnl_threads')) out.push(`row threads ${r.id} id=${r.id} p=${r.resource_id} ${r.deleted_at == null ? 'live' : 'deleted'}`);
    for (const r of await all('SELECT DISTINCT thread_id FROM gnl_messages')) out.push(`row messages ${r.thread_id}`);
    for (const r of await all('SELECT scope_id FROM gnl_working_memory')) out.push(`row wm ${r.scope_id}`);
    for (const r of await all('SELECT thread_id FROM gnl_observations')) out.push(`row obs ${r.thread_id}`);
    for (const r of await all('SELECT DISTINCT thread_id FROM gnl_message_batches')) out.push(`row batches ${r.thread_id}`);
    for (const r of await all('SELECT id, namespace FROM gnl_vectors')) out.push(`row vectors ${r.id} ns=${r.namespace ?? 'NULL'}`);
    for (const r of await all('SELECT ns, id FROM gnl_work_log')) out.push(`row worklog ${r.ns} ${r.id}`);
    for (const r of await all('SELECT key FROM gnl_work_kv')) out.push(`row workkv ${r.key}`);
    for (const r of await all('SELECT k FROM gnl_meta')) if (r.k !== 'schema_version') out.push(`row meta ${r.k}`);
    return out;
  };
}
/** The same rows out of InMemoryStorage's maps. Its runs have no table: the `run` lines are its rows. */
function memRaw(s: InMemoryStorage): () => Promise<string[]> {
  return async () => {
    const m = s.memory as any, j = (s.runs as any).journal, v = s.vectors as any, w = s.work as any;
    const out: string[] = [];
    for (const k of (j.counters as Map<string, unknown>).keys()) out.push(`row counters ${k}`);
    for (const [k, t] of m.threads as Map<string, any>) out.push(`row threads ${k} id=${t.id} p=${t.resourceId} ${t.deletedAt ? 'deleted' : 'live'}`);
    for (const [k, rows] of m.messages as Map<string, any[]>) if (rows.length) out.push(`row messages ${k}`);
    for (const k of (m.wm as Map<string, unknown>).keys()) out.push(`row wm ${k}`);
    for (const [k, o] of m.obs as Map<string, any[]>) if (o.length) out.push(`row obs ${k}`);
    for (const [k, bs] of m.batches as Map<string, Map<string, unknown>>) if (bs.size) out.push(`row batches ${k}`);
    for (const it of (v.byId as Map<string, any>).values()) out.push(`row vectors ${it.id} ns=${it.namespace ?? 'NULL'}`);
    for (const [ns, recs] of w.logs as Map<string, any[]>) for (const r of recs) out.push(`row worklog ${ns} ${r.id}`);
    for (const k of (w.kv as Map<string, unknown>).keys()) out.push(`row workkv ${k}`);
    for (const k of ((s.meta as any).m as Map<string, unknown>).keys()) out.push(`row meta ${k}`);
    return out;
  };
}

/** A dump compared across stores: `row runs` lines exist only where runs have a table. */
export const portable = (d: string[]): string[] => d.filter((x) => !x.startsWith('row runs '));

const ends: Array<() => Promise<void> | void> = [];
/** Drops every database and file the backends made. Call from `afterAll`. */
export async function closeBackends(): Promise<void> {
  for (const e of ends.splice(0).reverse()) await e();
  if (pgAdmin) { await pgAdmin.end(); pgAdmin = undefined; }
}

let pgAdmin: pg.Client | undefined;
let seq = 0;
export const PG_URL = process.env.GNL_PG_URL;
export const KINDS = ['InMemory', 'Sqlite', 'pg-mem', ...(PG_URL ? ['Postgres'] : [])] as const;

export async function makeBackend(kind: string): Promise<Backend> {
  if (kind === 'InMemory') {
    const s = new InMemoryStorage();
    return { name: kind, storage: s, raw: memRaw(s) };
  }
  if (kind === 'Sqlite') {
    const dir = mkdtempSync(join(tmpdir(), 'gnl-dependents-'));
    const s = new SqliteStorage(join(dir, 'w.db'));
    ends.push(() => { s.close?.(); rmSync(dir, { recursive: true, force: true }); });
    const db = (s as any).db;
    return { name: kind, storage: s as unknown as Storage, raw: sqlRaw(async (q) => db.prepare(q).all()) };
  }
  if (kind === 'pg-mem') {
    // pg-mem has no advisory locks, so PostgresStorage withdraws its memory port there; a no-op lock
    // gives it back (as memory-partition-edges.test.ts does) — one test process, nothing to serialise.
    const db = newDb();
    db.public.registerFunction({ name: 'pg_advisory_xact_lock', args: [DataType.integer, DataType.integer], returns: DataType.integer, implementation: () => 0 });
    const { Pool } = db.adapters.createPg();
    const pool = new Pool();
    const s = new PostgresStorage({ pool } as never);
    await s.init();
    (s as any).advisoryLocks = true;
    (s as any).capabilities.memory = 'full';
    return { name: kind, storage: s as unknown as Storage, raw: sqlRaw(async (q) => (await pool.query(q)).rows) };
  }
  // Real Postgres: a database of its own (cpc_ prefix), dropped by closeBackends.
  if (!pgAdmin) { pgAdmin = new pg.Client({ connectionString: PG_URL }); await pgAdmin.connect(); }
  const dbName = `cpc_dep_${process.pid}_${Date.now().toString(36)}_${seq++}`;
  await pgAdmin.query(`CREATE DATABASE ${dbName}`);
  const u = new URL(PG_URL!); u.pathname = `/${dbName}`;
  const pool = new pg.Pool({ connectionString: u.toString(), max: 4 });
  pool.on('error', () => {});
  const s = new PostgresStorage({ pool });
  await s.init();
  ends.push(async () => { await s.close?.().catch(() => {}); await pgAdmin?.query(`DROP DATABASE IF EXISTS ${dbName} WITH (FORCE)`); });
  return { name: kind, storage: s as unknown as Storage, raw: sqlRaw(async (q) => (await pool.query(q)).rows) };
}
