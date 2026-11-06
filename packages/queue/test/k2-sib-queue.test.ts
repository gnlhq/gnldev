// K2 sibling scenarios (queue worker): the right to execute a job (its lease, its time) reaches the
// handler as ONE signal with its reason, and the reason decides what the attempt was.
//   Q1  maxHoldMs: a handler that obeys ctx.signal is stopped when its time is up; the attempt counts as
//       failed, it is retried, and after maxAttempts the job is dead-lettered.
//   Q2  cancelJob while the handler runs → `cancelled`, the handler ran once, no retry (cancel ≠ lease loss).
//   Q3  the lease is genuinely taken (its token replaced — what another worker's takeover writes): the
//       handler's ctx.signal aborts with a lease reason, and this worker writes no outcome.
import { describe, it, expect, afterAll } from 'vitest';
import type { Storage } from '@gnldev/durable';
import { createDatabaseSync, dropDatabaseSync } from '../../../test/support/pg-admin.js';
import { enqueue, listJobs, createWorker, cancelJob } from '../src/index.js';

const PG_URL = process.env.GNL_PG_URL;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const drops: string[] = [];
afterAll(() => { for (const n of drops) dropDatabaseSync(n); });
let seq = 0;
async function open(): Promise<Storage> {
  const name = `k2q_${process.pid}_${seq++}`; drops.push(name);
  const s = new (await import('@gnldev/durable/postgres')).PostgresStorage({ connectionString: createDatabaseSync(name) }) as unknown as Storage;
  await s.init?.();
  return s;
}
async function until(cond: () => boolean | Promise<boolean>, ms: number) { const end = Date.now() + ms; while (Date.now() < end) { if (await cond()) return true; await sleep(20); } return cond(); }
const waitAbort = (signal: AbortSignal) => new Promise<never>((_, rej) => { if (signal.aborted) rej(signal.reason); signal.addEventListener('abort', () => rej(signal.reason), { once: true }); });

describe.skipIf(!PG_URL)('K2 siblings: queue job execution right', () => {
  it('Q1 maxHoldMs stops an obeying handler; the attempt fails, retries, and dead-letters at maxAttempts', async () => {
    const s = await open();
    const id = await enqueue(s.work!, 't', {});
    const reasons: string[] = [];
    let entered = 0;
    const t0 = Date.now();
    const worker = createWorker(s, {
      t: async (_p: unknown, ctx: { signal: AbortSignal }) => {
        entered++;
        try { await waitAbort(ctx.signal); } catch (e) { reasons.push(String((e as Error)?.message ?? e)); throw e; }
      },
    }, { owner: 'q1', ttlMs: 900, pollMs: 20, backoff: false, maxAttempts: 2, maxHoldMs: 1_200 } as any);
    worker.start();
    const done = await until(async () => (await listJobs(s.work!)).items.find((j) => j.id === id)?.status === 'failed', 15_000);
    const ms = Date.now() - t0;
    await worker.close();
    const job = (await listJobs(s.work!)).items.find((j) => j.id === id);
    console.log('[K2-Q1]', JSON.stringify({ done, ms, entered, reasons, job }));
    await s.close?.();
    expect(done, 'dead-lettered').toBe(true);
    expect(entered).toBe(2);
    expect(reasons).toHaveLength(2);
    for (const r of reasons) expect(r).toMatch(/hold|time/i);
  }, 30_000);

  it('Q2 cancelJob while the handler runs: cancelled, ran once, never retried', async () => {
    const s = await open();
    const id = await enqueue(s.work!, 't', {});
    const reasons: string[] = [];
    let entered = 0;
    const worker = createWorker(s, {
      t: async (_p: unknown, ctx: { signal: AbortSignal }) => {
        entered++;
        try { await waitAbort(ctx.signal); } catch (e) { reasons.push(String((e as Error)?.message ?? e)); throw e; }
      },
    }, { owner: 'q2', ttlMs: 600, pollMs: 20, backoff: false, maxAttempts: 3 });
    worker.start();
    await until(() => entered === 1, 10_000);
    expect(await cancelJob(s.work!, id)).toBe(true);
    await until(async () => (await listJobs(s.work!)).items.find((j) => j.id === id)?.status === 'cancelled', 10_000);
    await sleep(800);
    await worker.close();
    const job = (await listJobs(s.work!)).items.find((j) => j.id === id);
    console.log('[K2-Q2]', JSON.stringify({ entered, reasons, job }));
    await s.close?.();
    expect(job?.status).toBe('cancelled');
    expect(entered).toBe(1);
    expect(reasons[0]).toMatch(/cancel/i);
  }, 30_000);

  it('Q3 the lease taken from under the handler: ctx.signal aborts with a lease reason; no outcome from this worker', async () => {
    const s = await open();
    const id = await enqueue(s.work!, 't', {});
    const reasons: string[] = [];
    let entered = 0;
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    let effects = 0;
    const worker = createWorker(s, {
      t: async (_p: unknown, ctx: { signal: AbortSignal }) => {
        entered++;
        ctx.signal.addEventListener('abort', () => reasons.push(String((ctx.signal.reason as Error)?.message ?? ctx.signal.reason)));
        await gate;
        if (!ctx.signal.aborted) effects++;
      },
    }, { owner: 'q3', ttlMs: 600, pollMs: 20, backoff: false, maxAttempts: 3 });
    worker.start();
    await until(() => entered === 1, 10_000);
    // Another worker's takeover: the lease record now carries a token that is not this worker's.
    const runs: any = s.runs;
    const key = (await runs.listKeys('')).find((k: string) => k.startsWith(`job:${id}:lease`) && k.endsWith(':lock'));
    const cur = await runs.get(key);
    // Its holder is another process: the record names this one no more (k3 — a lock's `proc`/`hold` say
    // whose it is; kept, they would say this process holds it still, and it would take the job again).
    const { proc: _proc, hold: _hold, ...theirs } = cur;
    await runs.put(key, { ...theirs, owner: 'other', token: 'not-yours', expires: Date.now() + 60_000 });
    const aborted = await until(() => reasons.length > 0, 3_000);
    release();
    await sleep(500);
    worker.stop();
    const job = (await listJobs(s.work!)).items.find((j) => j.id === id);
    console.log('[K2-Q3]', JSON.stringify({ key, aborted, reasons, effects, job }));
    await s.close?.();
    expect(aborted, 'ctx.signal aborted when the lease was taken').toBe(true);
    expect(reasons[0]).toMatch(/lease|lock/i);
    expect(effects).toBe(0);
    expect(job?.status).not.toBe('done');
  }, 30_000);
  it('Q4 an obeying handler stopped by a lost lease is not reported as a failure (onError) and spends no attempt', async () => {
    const s = await open();
    const id = await enqueue(s.work!, 't', {});
    let entered = 0;
    const errors: string[] = [];
    let aborted = false;
    const worker = createWorker(s, {
      t: async (_p: unknown, ctx: { signal: AbortSignal }) => {
        entered++;
        await Promise.race([sleep(2_000), waitAbort(ctx.signal).catch((e) => { aborted = true; throw e; })]);
      },
    }, { owner: 'q4', ttlMs: 600, pollMs: 20, backoff: false, maxAttempts: 3, onError: (e) => errors.push(String((e as Error)?.message ?? e)) });
    worker.start();
    await until(() => entered === 1, 10_000);
    const runs: any = s.runs;
    const key = (await runs.listKeys('')).find((k: string) => k.startsWith(`job:${id}:lease`) && k.endsWith(':lock'));
    const cur = await runs.get(key);
    // Its holder is another process: the record names this one no more (k3 — a lock's `proc`/`hold` say
    // whose it is; kept, they would say this process holds it still, and it would take the job again).
    const { proc: _proc, hold: _hold, ...theirs } = cur;
    await runs.put(key, { ...theirs, owner: 'other', token: 'not-yours', expires: Date.now() + 60_000 });
    await sleep(2_500);
    worker.stop();
    const job = (await listJobs(s.work!)).items.find((j) => j.id === id);
    console.log('[K2-Q4]', JSON.stringify({ entered, aborted, errors, job }));
    await s.close?.();
    expect(aborted, 'the handler was stopped').toBe(true);
    expect(errors, 'a lost lease is not the handler failing').toEqual([]);
    expect(job?.status).toBe('pending');
  }, 30_000);
});
