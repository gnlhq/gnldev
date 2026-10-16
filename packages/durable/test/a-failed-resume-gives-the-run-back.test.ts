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
    const s = new PostgresStorage({ connectionString: PG_URL });
    ends.push(() => s.close());
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
