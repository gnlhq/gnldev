// When a job may run, how many may run at once, and how to stop one.
//
// Measured on 0.9.x before these options existed:
//   · a failed job was retried on the very next poll — five attempts of a failing call in a few
//     milliseconds, then a dead letter, with no way to wait between them;
//   · `enqueue` had no way to say "not before": a job ran on the next poll, always;
//   · a job could not be cancelled: the only terminal states were done and dead letter;
//   · one worker ran one job at a time, and nothing bounded how many jobs of one type the fleet ran.
import { describe, it, expect, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { InMemoryStorage, acquireRunLock, type Storage } from '@gnldev/durable';
import { SqliteStorage } from '@gnldev/durable/sqlite';
import * as queue from '../src/index.js';
import { enqueue, createWorker, listJobs, retryJob, cancelJob, type JobHandler } from '../src/index.js';

const T0 = Date.UTC(2026, 9, 2, 12, 0, 0);
function frozenClock() {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(T0);
}
afterEach(() => vi.useRealTimers());

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe('K1 — the four reported gaps', () => {
  it('a failed job waits its retry delay before the next attempt', async () => {
    frozenClock();
    const storage = new InMemoryStorage();
    let calls = 0;
    const worker = createWorker(storage, { t: async () => { calls++; throw new Error('boom'); } }, { retryDelayMs: 1_000 });
    await enqueue(storage.work!, 't', {}, { id: 'j' });
    expect(await worker.runOnce()).toBe(true);
    expect(calls).toBe(1);
    // Immediately after the failure the job is not eligible.
    expect(await worker.runOnce()).toBe(false);
    expect(calls).toBe(1);
    vi.setSystemTime(T0 + 1_000);
    expect(await worker.runOnce()).toBe(true);
    expect(calls).toBe(2);
  });

  it('a job enqueued with runAt does not run before that time', async () => {
    frozenClock();
    const storage = new InMemoryStorage();
    let calls = 0;
    const worker = createWorker(storage, { t: async () => { calls++; } });
    await enqueue(storage.work!, 't', {}, { id: 'later', runAt: T0 + 60_000 });
    expect(await worker.runOnce()).toBe(false);
    expect(calls).toBe(0);
    vi.setSystemTime(T0 + 60_000);
    expect(await worker.runOnce()).toBe(true);
    expect(calls).toBe(1);
  });

  it('a queued job can be cancelled and then never runs', async () => {
    const storage = new InMemoryStorage();
    let calls = 0;
    const worker = createWorker(storage, { t: async () => { calls++; } });
    const id = await enqueue(storage.work!, 't', {}, { id: 'c' });
    expect(typeof queue.cancelJob).toBe('function');
    expect(await queue.cancelJob(storage.work!, id)).toBe(true);
    expect(await worker.runOnce()).toBe(false);
    expect(calls).toBe(0);
    expect((await listJobs(storage.work!))[0]!.status).toBe('cancelled');
  });

  it('one worker runs up to `concurrency` jobs at once', async () => {
    const storage = new InMemoryStorage();
    let inFlight = 0;
    let peak = 0;
    const slow: JobHandler = async () => { inFlight++; peak = Math.max(peak, inFlight); await sleep(60); inFlight--; };
    for (const id of ['a', 'b', 'c']) await enqueue(storage.work!, 't', {}, { id });
    const worker = createWorker(storage, { t: slow }, { pollMs: 5, concurrency: 3 });
    worker.start();
    await vi.waitFor(async () => expect((await listJobs(storage.work!)).every((j) => j.status === 'done')).toBe(true), { timeout: 2_000 });
    worker.stop();
    expect(peak).toBe(3);
  });
});

const allDone = async (storage: Storage, n: number) =>
  vi.waitFor(async () => {
    const jobs = await listJobs(storage.work!);
    expect(jobs.length).toBe(n);
    expect(jobs.every((j) => j.status === 'done')).toBe(true);
  }, { timeout: 5_000, interval: 10 });

describe('retry delay — siblings', () => {
  it('the delay holds for EVERY worker on the storage, not just the one that saw the failure', async () => {
    frozenClock();
    const storage = new InMemoryStorage();
    let calls = 0;
    const fail: JobHandler = async () => { calls++; throw new Error('boom'); };
    const w1 = createWorker(storage, { t: fail }, { owner: 'w1', retryDelayMs: 5_000 });
    const w2 = createWorker(storage, { t: fail }, { owner: 'w2', retryDelayMs: 0 });
    await enqueue(storage.work!, 't', {}, { id: 'j' });
    expect(await w1.runOnce()).toBe(true);
    // w2 has no delay of its own, but the delay is the job's (`qnext`), written by the worker that failed it.
    expect(await w2.runOnce()).toBe(false);
    expect(calls).toBe(1);
    expect((await listJobs(storage.work!))[0]!.notBefore).toBe(T0 + 5_000);
    vi.setSystemTime(T0 + 5_000);
    expect(await w2.runOnce()).toBe(true);
    expect(calls).toBe(2);
  });

  it('a delay function sees the attempt number; the last attempt dead-letters without waiting', async () => {
    frozenClock();
    const storage = new InMemoryStorage();
    const seen: number[] = [];
    const worker = createWorker(storage, { t: async () => { throw new Error('boom'); } }, {
      maxAttempts: 3,
      retryDelayMs: (n) => { seen.push(n); return 1_000 * 2 ** (n - 1); },
    });
    await enqueue(storage.work!, 't', {}, { id: 'j' });
    expect(await worker.runOnce()).toBe(true); // attempt 1 → wait 1s
    vi.setSystemTime(T0 + 999);
    expect(await worker.runOnce()).toBe(false);
    vi.setSystemTime(T0 + 1_000);
    expect(await worker.runOnce()).toBe(true); // attempt 2 → wait 2s
    vi.setSystemTime(T0 + 2_999);
    expect(await worker.runOnce()).toBe(false);
    vi.setSystemTime(T0 + 3_000);
    expect(await worker.runOnce()).toBe(true); // attempt 3 → dead letter
    expect(seen).toEqual([1, 2]);
    const [job] = await listJobs(storage.work!);
    expect(job!.status).toBe('failed');
    expect(job!.attempts).toBe(3);
  });

  it('a restarted worker (new process on the same SQLite file) still waits the delay', async () => {
    frozenClock();
    const dir = mkdtempSync(join(tmpdir(), 'gnl-q-delay-'));
    try {
      const file = join(dir, 'q.db');
      let calls = 0;
      const fail: JobHandler = async () => { calls++; throw new Error('boom'); };
      const a = new SqliteStorage(file);
      await enqueue(a.work, 't', {}, { id: 'j' });
      expect(await createWorker(a as unknown as Storage, { t: fail }, { retryDelayMs: 10_000 }).runOnce()).toBe(true);
      await a.close();
      const b = new SqliteStorage(file);
      const restarted = createWorker(b as unknown as Storage, { t: fail });
      expect(await restarted.runOnce()).toBe(false);
      vi.setSystemTime(T0 + 10_000);
      expect(await restarted.runOnce()).toBe(true);
      expect(calls).toBe(2);
      await b.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('runAt — siblings', () => {
  it('a delayed job survives a restart and runs once its time comes, exactly once', async () => {
    frozenClock();
    const dir = mkdtempSync(join(tmpdir(), 'gnl-q-runat-'));
    try {
      const file = join(dir, 'q.db');
      let calls = 0;
      const a = new SqliteStorage(file);
      await enqueue(a.work, 't', {}, { id: 'later', runAt: new Date(T0 + 60_000) });
      expect(await createWorker(a as unknown as Storage, { t: async () => { calls++; } }).runOnce()).toBe(false);
      await a.close();
      vi.setSystemTime(T0 + 60_000);
      const b = new SqliteStorage(file);
      const w = createWorker(b as unknown as Storage, { t: async () => { calls++; } });
      expect(await w.runOnce()).toBe(true);
      expect(await w.runOnce()).toBe(false);
      expect(calls).toBe(1);
      await b.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('a delayed job neither blocks the jobs behind it nor gets skipped by the cursor', async () => {
    frozenClock();
    const storage = new InMemoryStorage();
    const ran: string[] = [];
    const worker = createWorker(storage, { t: async (p) => { ran.push(p.n); } });
    await enqueue(storage.work!, 't', { n: 'later' }, { id: 'later', runAt: T0 + 1_000 });
    // More than one store page (50) behind it, so the cursor has pages it could advance over.
    for (let i = 0; i < 60; i++) await enqueue(storage.work!, 't', { n: `now-${i}` }, { id: `now-${i}` });
    expect(await worker.drain()).toBe(60);
    expect(ran).not.toContain('later');
    vi.setSystemTime(T0 + 1_000);
    expect(await worker.drain()).toBe(1);
    expect(ran.at(-1)).toBe('later');
  });

  it('re-enqueuing the same id keeps the first runAt; an invalid runAt is refused', async () => {
    frozenClock();
    const storage = new InMemoryStorage();
    const worker = createWorker(storage, { t: async () => {} });
    await enqueue(storage.work!, 't', {}, { id: 'x', runAt: T0 + 1_000 });
    await enqueue(storage.work!, 't', {}, { id: 'x' });
    expect(await worker.runOnce()).toBe(false);
    expect((await listJobs(storage.work!))[0]!.notBefore).toBe(T0 + 1_000);
    await expect(enqueue(storage.work!, 't', {}, { runAt: new Date('nope') })).rejects.toThrow(/invalid runAt/);
  });
});

describe('cancelJob — siblings', () => {
  it('a RUNNING job: ctx.signal aborts on the next heartbeat, and the job is cancelled, not retried', async () => {
    const storage = new InMemoryStorage();
    let started!: () => void;
    const running = new Promise<void>((r) => { started = r; });
    let calls = 0;
    const worker = createWorker(storage, {
      t: async (_p, ctx) => {
        calls++;
        started();
        await new Promise<void>((_, reject) => ctx.signal.addEventListener('abort', () => reject(ctx.signal.reason)));
      },
    }, { ttlMs: 30 });
    const id = await enqueue(storage.work!, 't', {}, { id: 'r' });
    const run = worker.runOnce();
    await running;
    expect(await cancelJob(storage.work!, id)).toBe(true);
    expect(await run).toBe(true);
    expect(await worker.runOnce()).toBe(false);
    expect(calls).toBe(1);
    const [job] = await listJobs(storage.work!);
    expect(job!.status).toBe('cancelled');
  });

  it('a running job that completes anyway is reported done — it ran', async () => {
    const storage = new InMemoryStorage();
    let release!: () => void;
    const gate = new Promise<void>((r) => { release = r; });
    let started!: () => void;
    const running = new Promise<void>((r) => { started = r; });
    const worker = createWorker(storage, { t: async () => { started(); await gate; } });
    const id = await enqueue(storage.work!, 't', {}, { id: 'r' });
    const run = worker.runOnce();
    await running;
    expect(await cancelJob(storage.work!, id)).toBe(true);
    release();
    await run;
    expect((await listJobs(storage.work!))[0]!.status).toBe('done');
  });

  it('a job waiting out its retry delay is cancelled for good; finished jobs and repeats are no-ops', async () => {
    frozenClock();
    const storage = new InMemoryStorage();
    let calls = 0;
    const worker = createWorker(storage, { t: async () => { calls++; throw new Error('boom'); }, ok: async () => {} }, { retryDelayMs: 1_000 });
    const id = await enqueue(storage.work!, 't', {}, { id: 'j' });
    const done = await enqueue(storage.work!, 'ok', {}, { id: 'd' });
    await worker.drain();
    expect(await cancelJob(storage.work!, id)).toBe(true);
    expect(await cancelJob(storage.work!, id)).toBe(false); // already cancelled
    expect(await cancelJob(storage.work!, done)).toBe(false); // already done
    expect(await cancelJob(storage.work!, 'no-such-job')).toBe(false);
    vi.setSystemTime(T0 + 10_000);
    expect(await worker.runOnce()).toBe(false);
    expect(calls).toBe(1);
    expect(await retryJob(storage.work!, id)).toBeNull(); // not a dead letter
  });
});

describe('concurrency — siblings', () => {
  it('typeConcurrency bounds a type across two workers; other types are not held back', async () => {
    const storage = new InMemoryStorage();
    const inFlight: Record<string, number> = { t: 0, u: 0 };
    const peak: Record<string, number> = { t: 0, u: 0 };
    const slow = (k: 't' | 'u'): JobHandler => async () => {
      inFlight[k]!++;
      peak[k] = Math.max(peak[k]!, inFlight[k]!);
      await sleep(30);
      inFlight[k]!--;
    };
    for (let i = 0; i < 6; i++) await enqueue(storage.work!, 't', {}, { id: `t${i}` });
    for (let i = 0; i < 6; i++) await enqueue(storage.work!, 'u', {}, { id: `u${i}` });
    const opts = { pollMs: 5, concurrency: 3, typeConcurrency: { t: 1 } };
    const w1 = createWorker(storage, { t: slow('t'), u: slow('u') }, { ...opts, owner: 'w1' });
    const w2 = createWorker(storage, { t: slow('t'), u: slow('u') }, { ...opts, owner: 'w2' });
    w1.start();
    w2.start();
    await allDone(storage, 12);
    w1.stop();
    w2.stop();
    expect(peak.t).toBe(1);
    expect(peak.u).toBeGreaterThan(1);
  });

  it('a slot held by a crashed worker is reclaimed after ttlMs — a crash never leaks capacity', async () => {
    const storage = new InMemoryStorage();
    let calls = 0;
    // A worker that took the only slot and died: its lease is never renewed or released.
    expect(await acquireRunLock(storage.runs as any, 'qslot:t:0', 'dead-worker', 40)).not.toBeNull();
    const worker = createWorker(storage, { t: async () => { calls++; } }, { ttlMs: 40, typeConcurrency: { t: 1 } });
    await enqueue(storage.work!, 't', {}, { id: 'j' });
    expect(await worker.runOnce()).toBe(false);
    await sleep(60);
    expect(await worker.runOnce()).toBe(true);
    expect(calls).toBe(1);
  });

  it('2 workers × 4 slots, 40 jobs: every job runs exactly once', async () => {
    const storage = new InMemoryStorage();
    const runs = new Map<string, number>();
    const h: JobHandler = async (_p, ctx) => { runs.set(ctx.jobId, (runs.get(ctx.jobId) ?? 0) + 1); await sleep(5); };
    for (let i = 0; i < 40; i++) await enqueue(storage.work!, 't', {}, { id: `j${i}` });
    const w1 = createWorker(storage, { t: h }, { pollMs: 2, concurrency: 4, owner: 'w1' });
    const w2 = createWorker(storage, { t: h }, { pollMs: 2, concurrency: 4, owner: 'w2' });
    w1.start();
    w2.start();
    await allDone(storage, 40);
    w1.stop();
    w2.stop();
    expect(runs.size).toBe(40);
    expect([...runs.values()].every((n) => n === 1)).toBe(true);
  });

  it('invalid limits are refused at createWorker', () => {
    const storage = new InMemoryStorage();
    expect(() => createWorker(storage, {}, { concurrency: 0 })).toThrow(/concurrency/);
    expect(() => createWorker(storage, {}, { typeConcurrency: { t: 1.5 } })).toThrow(/typeConcurrency/);
  });
});
