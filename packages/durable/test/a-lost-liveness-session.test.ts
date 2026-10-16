// A process whose liveness session is cut (a terminated backend, a database failover, a partition that
// ended) answers its callers with a retryable refusal, never an internal error, and is serving again
// once it holds a lock of its own anew.
//
// The liveness is one session holding one advisory lock (process-liveness.ts). When that session ends,
// the others read this process as dead from that moment — and may take over what it held. Two rules
// follow. (1) Unknown is never "dead": this process cannot judge another one while it cannot ask, so a
// question about another holder is refused (`LivenessUnavailableError`, 503 with Retry-After at every
// door), not answered `false` (a takeover beside a live holder) nor thrown as a raw driver error (a 500).
// (2) Its old id is dead for good — the others may already have acted on it — so it comes back under a
// NEW id and a new lock, and what was stamped with the old one is no longer its own.
// Postgres runs when GNL_PG_URL is set.
import { describe, it, expect, afterAll, afterEach } from 'vitest';
import pg from 'pg';
import { createGnl, STAFF, requestRefusal } from '../src/index.js';
import { PostgresStorage } from '../src/postgres-storage.js';
import { installProcessLiveness, procLockKey } from '../src/process-liveness.js';
import { streamingModel } from './detached/models.js';

const PG_URL = process.env.GNL_PG_URL;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const ends: Array<() => Promise<unknown>> = [];
afterAll(async () => { for (const e of ends.reverse()) await e().catch(() => undefined); });
afterEach(() => installProcessLiveness(undefined));

/** What a door makes of a call: its refusal status, or 'ok' with the text, or 'internal' (a 500). */
async function outcomeOf(call: () => Promise<any>): Promise<{ kind: 'ok' | 'refused' | 'internal'; status?: number; text?: string; error?: string }> {
  try {
    const r = await call();
    return { kind: 'ok', text: await r.text };
  } catch (e) {
    const refusal = requestRefusal(e);
    if (refusal) return { kind: 'refused', status: refusal.status, error: String((e as Error).message) };
    return { kind: 'internal', error: `${(e as Error)?.name}: ${(e as Error)?.message}` };
  }
}

describe.skipIf(!PG_URL)('a process whose liveness session is cut', () => {
  it('refuses with 503 while it cannot ask, takes nothing over beside a live holder, and serves again under a new id', async () => {
    const admin = new pg.Client({ connectionString: PG_URL });
    await admin.connect();
    ends.push(() => admin.end());
    const db = `ae_lost_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`;
    await admin.query(`CREATE DATABASE ${db}`);
    ends.push(() => admin.query(`DROP DATABASE IF EXISTS ${db} WITH (FORCE)`));
    const url = new URL(PG_URL!); url.pathname = `/${db}`;

    // Process B: alive throughout, answering a long run.
    const storageB = new PostgresStorage({ connectionString: url.toString() });
    ends.push(() => storageB.close());
    const modelB = streamingModel({ words: Array.from({ length: 60 }, (_, i) => `b${i} `), gapMs: 50 });
    const slowWords = Array.from({ length: 40 }, (_, i) => `s${i} `);
    // A slow agent both processes know: whoever executes a run of it is counted.
    const counted = (n: { calls: number }) => { const m = streamingModel({ words: slowWords, gapMs: 50 }); return { ...m, doStream: (o: any) => { n.calls++; return m.doStream(o); } }; };
    const slowB = { calls: 0 };
    const slowA = { calls: 0 };
    const gnlB = createGnl({ storage: storageB, agents: { a: { model: modelB }, slow: { model: counted(slowB) } } } as any);
    const long = await gnlB.stream('a', { runId: 'long', prompt: 'go', caller: STAFF } as any);
    const longText = long.text as Promise<string>;

    // Process A: serving, then its liveness session is terminated by the server.
    const storageA = new PostgresStorage({ connectionString: url.toString() });
    ends.push(() => storageA.close());
    let aCalls = 0;
    const inner = streamingModel({ words: ['a1 ', 'a2 '], gapMs: 5 });
    const modelA = { ...inner, doStream: (o: any) => { aCalls++; return inner.doStream(o); } };
    const gnlA = createGnl({ storage: storageA, agents: { a: { model: modelA }, slow: { model: counted(slowA) } } } as any);
    expect((await outcomeOf(() => gnlA.stream('a', { runId: 'warm', prompt: 'go', caller: STAFF } as any))).kind).toBe('ok');
    const livA = await storageA.processLiveness();
    const oldId = livA.id;
    const held = await admin.query(`SELECT pid FROM pg_locks WHERE locktype = 'advisory' AND ((classid::bigint << 32) | objid::bigint) = $1::bigint AND granted`, [procLockKey(oldId)]);
    expect(held.rows.length, "A's lock is held").toBe(1);
    await admin.query('SELECT pg_terminate_backend($1)', [held.rows[0].pid]);
    await sleep(100);
    const callsBefore = aCalls;

    // Right after the cut: attaching to B's live run, and starting a new (slow) run.
    const attach = await outcomeOf(() => gnlA.stream('a', { runId: 'long', prompt: 'go', caller: STAFF } as any));
    const fresh = await outcomeOf(() => gnlA.stream('slow', { runId: 'n1', prompt: 'go', caller: STAFF } as any));
    for (const o of [attach, fresh]) {
      expect(o.kind, `a door answers 503 or serves — never a 500 (${o.error})`).not.toBe('internal');
      if (o.kind === 'refused') expect(o.status).toBe(503);
    }
    // A run is executed by one process at a time: one started here under the dead id is B's to take
    // over at once (its sweep reads the id as dead) — beside this one.
    await sleep(1_500);
    expect({ a: slowA.calls, b: slowB.calls }, 'n1 executed by one process').not.toEqual({ a: 1, b: 1 });
    expect(slowA.calls + slowB.calls).toBeLessThanOrEqual(1);
    if (fresh.kind === 'ok') expect(fresh.text).toBe(slowWords.join(''));
    // B's live run was never executed here beside B.
    expect(attach.kind === 'ok' ? attach.text : '', 'attached to B, not re-run').not.toMatch(/a1/);

    // Back under a new id, with a lock of its own: a new run is served.
    let served: Awaited<ReturnType<typeof outcomeOf>> | undefined;
    for (let i = 0; i < 60; i++) {
      served = await outcomeOf(() => gnlA.stream('a', { runId: `n2-${i}`, prompt: 'go', caller: STAFF } as any));
      if (served.kind === 'ok') break;
      expect(served.kind, served.error).toBe('refused');
      await sleep(200);
    }
    expect(served!.kind, `serving again (${served!.error})`).toBe('ok');
    expect(served!.text).toBe('a1 a2 ');
    expect(livA.id, 'a new id: the old one is dead for good').not.toBe(oldId);
    const relocked = await admin.query(`SELECT 1 FROM pg_locks WHERE locktype = 'advisory' AND ((classid::bigint << 32) | objid::bigint) = $1::bigint AND granted`, [procLockKey(livA.id)]);
    expect(relocked.rows.length).toBe(1);

    expect(await longText, "B's run answered whole, once").toBe(Array.from({ length: 60 }, (_, i) => `b${i} `).join(''));
    expect(aCalls - callsBefore, "A's model ran only for its own runs").toBeLessThanOrEqual(2);
  }, 60_000);
});

describe('while a process cannot prove its own lock', () => {
  it('its executor starts and takes over nothing, and a door answers 503 with Retry-After', async () => {
    const { InMemoryJournal, DetachedRuns, LivenessUnavailableError } = await import('../src/index.js');
    const journal = new InMemoryJournal();
    let launched = 0;
    // A liveness whose session is gone: it cannot prove itself, nor tell about another process.
    const cut = { id: 'p-cut', confirm: async () => false, isAlive: async () => { throw new LivenessUnavailableError(); }, close: async () => undefined };
    const runs = new DetachedRuns({ journal, liveness: cut as any, resume: () => { throw new Error('no'); }, sweepMs: 0 });
    const err = await runs.start({ runId: 'r', launch: () => { launched++; throw new Error('must not launch'); } } as any).then(() => undefined, (e) => e);
    expect(err).toBeInstanceOf(LivenessUnavailableError);
    expect(launched).toBe(0);
    expect(await journal.listKeys('__exec__'), 'no execution record under an id the others read as dead').toEqual([]);
    expect(await runs.sweep()).toBe(0);
    const refusal = requestRefusal(err);
    expect(refusal?.status).toBe(503);
    expect(refusal?.body.code).toBe('liveness_unavailable');
    expect(refusal?.headers?.['Retry-After']).toBeDefined();
    await runs.close();
  });
});

describe('a tool call claimed under an id this process no longer holds', () => {
  it('is lost: its body does not start (the others read that id as dead)', async () => {
    const { mkdtempSync, rmSync } = await import('node:fs');
    const { tmpdir } = await import('node:os');
    const { join } = await import('node:path');
    const { SqliteStorage } = await import('../src/sqlite-storage.js');
    const { Attempt, AttemptLost } = await import('../src/attempt.js');
    const { bindLiveness, unbindLiveness } = await import('../src/process-liveness.js');
    const dir = mkdtempSync(join(tmpdir(), 'gnl-ae-'));
    const storage = new SqliteStorage(join(dir, 'db.sqlite'));
    // A liveness that came back under a new id after its session was cut.
    const live = { id: 'id-before', confirm: async () => true, isAlive: async () => false, close: async () => undefined };
    bindLiveness(storage.runs, live as any);
    try {
      const stamp = (proc: string) => ({ status: 'running', startedAt: Date.now(), attempts: 1, claimTtlMs: 30_000, idempotencyKey: 'k', proc }) as any;
      const held = new Attempt(storage.runs as any, 'r:tool:c1', undefined, stamp('id-before'), performance.now(), 't', async () => true);
      await expect(held.assertHeld(), 'its own current id: held').resolves.toBeUndefined();
      live.id = 'id-after';
      const stale = new Attempt(storage.runs as any, 'r:tool:c2', undefined, stamp('id-before'), performance.now(), 't', async () => true);
      await expect(stale.assertHeld()).rejects.toBeInstanceOf(AttemptLost);
    } finally {
      unbindLiveness(storage.runs);
      await storage.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
