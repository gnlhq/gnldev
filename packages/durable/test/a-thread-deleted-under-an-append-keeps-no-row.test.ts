// A thread deleted while a turn is being appended to it keeps no message that nobody can take back.
//
// A run deleted while it runs takes back what it appended after the deletion (erasure-fence.ts): its
// settle retracts its batches by their markers (`Memory.retract` → `retractBatch`). That holds only if
// a batch's rows and its marker go together — both deleted, or both left. `deleteThread` deleted the
// thread's messages and, several statements later, its batch markers, each statement on its own and
// without the thread's lock. An append that committed in between left its rows and lost its marker:
// the retract found no batch, and the turn stayed in the deleted thread for good. Measured in the
// background-tool suite: a person erased right after a turn ended kept that turn's 4 messages on
// Postgres (2 of 6 runs of a-background-tool-across-processes + a-background-tool-wake together).
//
// Postgres: the deletion is held between its two statements while a turn appends; then the worker's
// settle retracts its batch (runs when GNL_PG_URL is set). Sqlite: several processes on one file, one
// deleting the thread while the others append; after every deletion no row may be left that no marker
// names (before: 3 of 5 deletions left such rows).
import { describe, it, expect, afterAll } from 'vitest';
import pg from 'pg';
import { spawn } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { PostgresStorage } from '../src/postgres-storage.js';
import { eraseSubject, type Memory } from '../src/index.js';
import { runDurable } from '../src/run.js';
import { createMockModel, finalTextResult } from './mock.js';

const PG_URL = process.env.GNL_PG_URL;
const ends: Array<() => Promise<unknown>> = [];
afterAll(async () => { for (const e of ends.reverse()) await e(); });
const gate = () => { let open!: () => void; const p = new Promise<void>((r) => { open = r; }); return { p, open }; };
const msg = (role: string, text: string) => ({ role, text, ts: Date.now(), message: { role, content: text } });

/** A pool whose statements matching an armed pattern wait, once each, until released — on any connection. */
function holdingPool(url: string) {
  const pool = new pg.Pool({ connectionString: url, max: 8 });
  const holds: Array<{ at: RegExp; param?: string; reached: ReturnType<typeof gate>; release: ReturnType<typeof gate>; hit: boolean }> = [];
  const hold = async (sql: string, params?: unknown[]) => {
    const h = holds.find((x) => !x.hit && x.at.test(sql) && (x.param === undefined || (params ?? []).includes(x.param)));
    if (!h) return;
    h.hit = true;
    h.reached.open();
    await h.release.p;
  };
  const connect = pool.connect.bind(pool);
  const wrapped = new WeakSet<object>();
  const wrap = (c: pg.PoolClient) => {
    if (wrapped.has(c)) return c; // a pooled client comes back: wrapped once
    wrapped.add(c);
    const cq = c.query.bind(c) as (sql: string, p?: unknown[]) => Promise<pg.QueryResult>;
    (c as any).query = async (sql: string, p?: unknown[]) => { await hold(String(sql), p); return cq(sql, p); };
    return c;
  };
  (pool as any).connect = async () => wrap(await connect());
  // `pool.query` checks a client out through a callback; one checked out here goes through `hold` too.
  (pool as any).query = async (sql: string, p?: unknown[]) => {
    const c = await (pool as any).connect();
    try { return await c.query(sql, p); } finally { c.release(); }
  };
  return {
    pool,
    /** `param`: only a statement carrying this parameter. */
    arm(at: RegExp, param?: string) {
      const h = { at, param, reached: gate(), release: gate(), hit: false };
      holds.push(h);
      return { reached: h.reached.p, release: () => h.release.open() };
    },
  };
}

/** Until a statement is waiting for an advisory lock (the thread's), or `done` settles. */
async function untilWaitingOrDone(pool: pg.Pool, done: Promise<unknown>): Promise<void> {
  let over = false;
  void done.then(() => { over = true; }, () => { over = true; });
  for (let i = 0; i < 500 && !over; i++) {
    const r = await pool.query(`SELECT count(*)::int AS n FROM pg_locks WHERE locktype = 'advisory' AND NOT granted`);
    if (r.rows[0].n > 0) return;
    await new Promise((res) => setTimeout(res, 10));
  }
}

describe.skipIf(!PG_URL)('a thread deleted under an append (postgres, real)', () => {
  it('the turn that lands during the deletion is still taken back whole by its marker', { timeout: 30_000 }, async () => {
    const h = holdingPool(PG_URL!);
    const s = new PostgresStorage({ pool: h.pool as any });
    ends.push(() => s.close());
    const memory = s.memory!;
    const T = `t-del-${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
    await memory.appendMessagesOnce!(T, [msg('user', 'earlier')], 'mem-appended:r-0');

    // The deletion, held after it took the messages and before it took the batch markers.
    const held = h.arm(/^DELETE FROM gnl_working_memory WHERE scope_id = \$1$/);
    const deleting = memory.deleteThread(T);
    await held.reached;
    // A turn of a run being deleted appends meanwhile (its fence read came before the deletion's fence).
    const appending = memory.appendMessagesOnce!(T, [msg('user', 'question'), msg('assistant', 'answer')], 'mem-appended:r-1');
    // Until it has committed, or is waiting for the thread's lock.
    await untilWaitingOrDone(s.pool, appending);
    held.release();
    await Promise.all([deleting, appending]);

    // The worker's settle (model.ts settleErasedRun): it meets the fence and takes back its batch.
    await memory.retractBatch!(T, 'mem-appended:r-1');
    const left = (await memory.getMessages(T)).items.map((m) => m.text);
    expect(left, 'messages of the deleted thread that no marker names any more').toEqual([]);
  });
});

const tsx = join(dirname(createRequire(import.meta.url).resolve('tsx/package.json')), 'dist/cli.mjs');
const stress = join(dirname(fileURLToPath(import.meta.url)), 'fixtures', 'thread-delete-stress.ts');
const child = (role: string, file: string, ms: number) => new Promise<string>((res, rej) => {
  const p = spawn(process.execPath, [tsx, stress, role, file, String(ms)], { stdio: ['ignore', 'pipe', 'ignore'] });
  let out = '';
  p.stdout.on('data', (d) => { out += String(d); });
  p.once('exit', (code) => (code === 0 ? res(out) : rej(new Error(`${role} exited ${code}`))));
});

/** The conversation over the storage's message table: each batch at most once, and taken back by its marker. */
function storeMemory(store: NonNullable<PostgresStorage['memory']>): Memory {
  const rows = (threadId: string, messages: any[]) => messages.map((message) => ({ threadId, role: message.role, text: JSON.stringify(message.content), ts: Date.now(), message }));
  return {
    async getMessages(threadId) { return (await store.getMessages(threadId, { limit: 500 })).items.map((r) => r.message); },
    async append(threadId, messages) { await store.appendMessages(threadId, rows(threadId, messages)); },
    async appendOnce(threadId, messages, batchKey) { return store.appendMessagesOnce!(threadId, rows(threadId, messages), batchKey); },
    async retract(threadId, batchKey) { await store.retractBatch!(threadId, batchKey); },
  } as Memory;
}

describe.skipIf(!PG_URL)('a person erased while a plain turn is being appended (postgres, real) — no background tool', () => {
  it('the turn that lands during the erasure goes: the run meets its fence and takes it back', { timeout: 30_000 }, async () => {
    const h = holdingPool(PG_URL!);
    const s = new PostgresStorage({ pool: h.pool as any });
    ends.push(() => s.close());
    const id = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
    const who = `alice-${id}`;
    const T = `t-${id}`;
    const runId = `r-${id}`;
    // The turn's answer: its append is held after it took the thread's lock (its fence read came first).
    let appendHeld!: { reached: Promise<void>; release: () => void };
    const model = createMockModel(async () => {
      appendHeld = h.arm(/^INSERT INTO gnl_message_batches/, `mem-appended:${runId}`);
      return finalTextResult('the answer');
    });
    const running = runDurable({ runId, journal: s.runs, model, memory: storeMemory(s.memory!), prompt: 'a question', threadId: T, resourceId: who } as any)
      .catch((e: unknown) => e);
    await new Promise<void>((r) => { const t = setInterval(() => { if (appendHeld) { clearInterval(t); r(); } }, 5); });
    await appendHeld.reached;

    // The erasure: held, once it gets there, between the thread's messages and its batch markers.
    const deleteHeld = h.arm(/^DELETE FROM gnl_working_memory WHERE scope_id = \$1$/);
    const erasing = eraseSubject(s as any, who);
    await Promise.race([deleteHeld.reached, untilWaitingOrDone(s.pool, erasing)]);
    appendHeld.release();
    // Until the turn's batch has committed: under the deletion's statements, or (the deletion waiting
    // for the thread's lock) before them.
    const committed = async () => {
      for (let i = 0; i < 500; i++) {
        if ((await s.pool.query('SELECT 1 FROM gnl_message_batches WHERE thread_id = $1 AND batch_key = $2', [T, `mem-appended:${runId}`])).rows.length) return;
        await new Promise((r) => setTimeout(r, 10));
      }
    };
    await committed();
    deleteHeld.release();
    await erasing;
    await running;

    const left = (await s.memory!.getMessages(T)).items.map((m) => m.role);
    expect(left, 'messages left in the erased person\'s thread').toEqual([]);
  });
});

describe('a thread deleted under appends from other processes (sqlite file)', () => {
  it('no deletion leaves a row that no batch marker names', { timeout: 30_000 }, async () => {
    const file = join(mkdtempSync(join(tmpdir(), 'gnl-thread-del-')), 'm.db');
    const appenders = [1, 2, 3].map(() => child('append', file, 5_000));
    const r = JSON.parse(await child('delete', file, 4_000)) as { deletions: number; unnamedSeen: number };
    await Promise.all(appenders);
    expect(r.deletions, 'deletions made').toBeGreaterThan(0);
    expect(r.unnamedSeen, 'deletions after which a row no marker names was left').toBe(0);
  });
});
