// A process that takes a run holds it only while it executes it: asking how to continue it (`resume`) is part
// of beginning the execution, so a resume that throws goes through the one path a failed launch takes
// (detached.ts execute): a run with a past is parked with its reason (`pending` names it), a run that never
// began has its record removed. The audit's red test (A6) is a run with a past on an in-memory store; these
// are the rule's siblings: a run that never began, a run waiting on a call's outcome, and the audit's case on
// Sqlite and Postgres. Postgres runs when GNL_PG_URL is set.
import { describe, it, expect, vi, beforeAll, afterAll } from 'vitest';
import { InMemoryStorage, DetachedRuns, inMemoryLiveness, type Storage, type Journal } from '../src/index.js';
import { SqliteStorage } from '../src/sqlite-storage.js';
import { PostgresStorage } from '../src/postgres-storage.js';
import { execKey } from '../src/exec-record.js';

beforeAll(() => { vi.spyOn(console, 'warn').mockImplementation(() => {}); });
const ends: Array<() => Promise<unknown>> = [];
afterAll(async () => { for (const e of ends.reverse()) await e(); });

const PG_URL = process.env.GNL_PG_URL;
const STORES: Array<[string, () => Promise<Storage>]> = [
  ['in-memory', async () => new InMemoryStorage()],
  ['sqlite', async () => new SqliteStorage(':memory:')],
];
if (PG_URL) {
  STORES.push(['postgres (real)', async () => {
    // A database of its own: in-memory liveness reads every other process as dead, so `sweep()` below would take
    // another file's runs, and another file's executor these (a session no store holds reads as dead there too).
    const pg = (await import('pg')).default;
    const admin = new pg.Client({ connectionString: PG_URL }); await admin.connect();
    const db = `resume_${unique()}`;
    await admin.query(`CREATE DATABASE ${db}`);
    const url = new URL(PG_URL); url.pathname = `/${db}`;
    const s = new PostgresStorage({ connectionString: url.toString() });
    ends.push(async () => { await s.close(); await admin.query(`DROP DATABASE IF EXISTS ${db}`); await admin.end(); });
    return s;
  }]);
}
const unique = () => `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;

describe.each(STORES)('a failed resume gives the run back — %s', (_name, make) => {
  const executorOn = (journal: Journal, id: string) =>
    new DetachedRuns({ journal, liveness: inMemoryLiveness(id), resume: () => { throw new Error("no agent 'support' here"); }, sweepMs: 0 });

  it('a run that had begun is parked with the reason, not held running', async () => {
    const storage = await make();
    const journal = storage.runs as unknown as Journal;
    const runId = `r-past-${unique()}`;
    await journal.put(execKey(undefined, runId), { v: 1, runId, owner: 'a-process-that-died', status: 'running', at: Date.now() - 60_000, from: 0, meta: { agent: 'support' } });
    await journal.put(`${runId}:outcome`, { status: 'running', at: Date.now() - 60_000 });
    const b = executorOn(journal, `B-${unique()}`);
    await b.sweep();
    const rec = await journal.get<any>(execKey(undefined, runId));
    expect({ status: rec?.status, reason: rec?.reason }).toEqual({ status: 'parked', reason: "could not be continued: no agent 'support' here" });
    expect((await b.pending()).map((p) => p.runId)).toContain(runId);
    await b.close();
  });

  it('its reader is told it waits for an operator, not handed an end with no answer (d25 U6)', async () => {
    const storage = await make();
    const journal = storage.runs as unknown as Journal;
    const runId = `r-told-${unique()}`;
    await journal.put(execKey(undefined, runId), { v: 1, runId, owner: 'a-process-that-died', status: 'running', at: Date.now() - 60_000, from: 0, meta: { agent: 'support' } });
    await journal.put(`${runId}:outcome`, { status: 'running', at: Date.now() - 60_000 });
    const b = executorOn(journal, `B-${unique()}`);
    await b.sweep();
    // The client sending the same request again: the run is parked, so it reads the run's log from the start.
    const started = await b.start({ runId, launch: async () => { throw new Error('a parked run is not launched by a caller'); } });
    expect(started.state).toBe('parked');
    const seen: Array<{ kind: string; data: any }> = [];
    for await (const ev of b.follow({ runId, after: started.from, untilPause: true })) seen.push(ev as any);
    expect(seen.at(-1)).toMatchObject({ kind: 'status', data: { state: 'failed', error: { code: 'run_not_continued' } } });
    expect(seen.at(-1)!.data.error.message).toMatch(/could not be continued — nothing was run again/);
    // Nothing of it was written: the run did not fail, an operator may still continue it.
    expect(await journal.get<any>(`${runId}:outcome`)).toMatchObject({ status: 'running' });
    // …and the operator's list says why it waits, not "waiting on a human (approval)".
    expect((await b.pending()).find((p) => p.runId === runId)?.reason).toBe("could not be continued: no agent 'support' here");
    // A run parked on a human's answer still ends its follow quietly (the question is in its log).
    const asked = `r-asked-${unique()}`;
    await journal.put(execKey(undefined, asked), { v: 1, runId: asked, owner: 'gone', status: 'parked', at: Date.now(), from: 0, meta: { agent: 'support' } });
    const quiet: unknown[] = [];
    for await (const ev of b.follow({ runId: asked, after: 0, untilPause: true })) quiet.push(ev);
    expect(quiet).toEqual([]);
    await b.close();
  });

  it('a run that never began has its record removed: its next caller starts it', async () => {
    const storage = await make();
    const journal = storage.runs as unknown as Journal;
    const runId = `r-none-${unique()}`;
    await journal.put(execKey(undefined, runId), { v: 1, runId, owner: 'a-process-that-died', status: 'running', at: Date.now() - 60_000, from: 0, meta: { agent: 'support' } });
    const b = executorOn(journal, `B-${unique()}`);
    await b.sweep();
    expect(await journal.get(execKey(undefined, runId))).toBeUndefined();
    // Held "running" by B, this caller was attached to an execution that did not exist.
    const started = await b.start({ runId, launch: async () => ({ fullStream: (async function* () { /* nothing */ })() }) });
    expect(started.state).toBe('started');
    await b.close();
  });

  it('a run waiting on a call\'s outcome stays parked on it, its next ask backed off', async () => {
    const storage = await make();
    const journal = storage.runs as unknown as Journal;
    const runId = `r-awaits-${unique()}`;
    const key = `${runId}:tool:call-1`;
    await journal.put(execKey(undefined, runId), { v: 1, runId, owner: 'a-process-that-died', status: 'parked', at: Date.now() - 60_000, from: 0, meta: { agent: 'support' }, reason: "waiting for a call's outcome", awaits: { key, asks: 0, nextAt: Date.now() - 1 } });
    await journal.put(`${runId}:outcome`, { status: 'running', at: Date.now() - 60_000 });
    const b = executorOn(journal, `B-${unique()}`);
    await b.sweep();
    const rec = await journal.get<any>(execKey(undefined, runId));
    expect(rec?.status).toBe('parked');
    expect(rec?.awaits?.key).toBe(key);
    expect(rec?.awaits?.asks).toBe(1);
    expect(rec?.awaits?.nextAt).toBeGreaterThan(Date.now());
    await b.close();
  });
});
