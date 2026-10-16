// An attempt is counted when it STARTS, so an attempt the process died in counts too.
//
// Counted when it failed, a job that killed its worker every time — an out-of-memory handler, a kill —
// never reached maxAttempts: measured, started 8 times with maxAttempts 3, attempts 0, still pending,
// and it would have gone on forever. Graphile Worker, SQS (receive count) and Temporal count an attempt
// when it starts as well.
import { describe, it, expect } from 'vitest';
import { InMemoryStorage } from '@gnldev/durable';
import { enqueue, createWorker, listJobs } from '../src/index.js';

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const quiet = async <T>(f: () => Promise<T>) => { const w = console.warn; console.warn = () => undefined; try { return await f(); } finally { console.warn = w; } };

describe('an attempt counts when it starts', () => {
  it('a job whose process dies while it runs is dead-lettered after maxAttempts, not started forever', async () => {
    const storage = new InMemoryStorage();
    await enqueue(storage.work!, 't', {}, { id: 'poison' });
    let starts = 0;
    // The handler never returns: the worker's process is gone. Its lease runs out; the next worker claims.
    const poison = { t: () => { starts++; return new Promise<void>(() => {}); } };
    for (let i = 0; i < 6; i++) {
      void createWorker(storage, poison, { ttlMs: 60, heartbeat: false, maxAttempts: 3 }).runOnce();
      await sleep(150);
    }
    const job = (await listJobs(storage.work!)).find((j) => j.id === 'poison');
    expect(starts).toBe(3);
    // Never started again; whether its last attempt ran is unknown (it never reported), so it is not
    // called failed (a-job-whose-attempts-never-reported-is-not-dead.test.ts).
    expect(job).toMatchObject({ status: 'in-doubt', attempts: 3 });
  });

  it('a crash while a failure is being recorded still leaves the attempt counted', async () => {
    const storage = new InMemoryStorage();
    await enqueue(storage.work!, 't', {}, { id: 'j' });
    // The process stops at the failure's write (a put that never returns), after the start was counted.
    let seen = 0;
    const work = storage.work!;
    const view = Object.create(storage);
    Object.defineProperty(view, 'work', { value: new Proxy(work, { get(t: any, p) {
      const v = t[p];
      if (p === 'put') return (k: string, ...a: unknown[]) => (k.startsWith('qtry:') && ++seen === 2) ? new Promise(() => {}) : v.call(t, k, ...a);
      return typeof v === 'function' ? v.bind(t) : v;
    } }) });
    const failing = { t: async () => { throw new Error('boom'); } };
    void createWorker(view, failing, { ttlMs: 60, heartbeat: false, maxAttempts: 3, retryDelayMs: 60_000 }).runOnce();
    await sleep(150);
    expect((await listJobs(work)).find((j) => j.id === 'j')?.attempts).toBe(1);
  });

  it('attempts a worker before 0.10 recorded (a bare qatt count) still count', async () => {
    const storage = new InMemoryStorage();
    await enqueue(storage.work!, 't', {}, { id: 'old' });
    await storage.work!.put('qatt:old', 2); // written by a 0.9 worker during a rolling deploy
    let calls = 0;
    await quiet(() => createWorker(storage, { t: async () => { calls++; throw new Error('boom'); } }, { heartbeat: false, maxAttempts: 3 }).runOnce());
    expect(calls).toBe(1);
    expect((await listJobs(storage.work!)).find((j) => j.id === 'old')).toMatchObject({ status: 'failed', attempts: 3 });
  });
});
