// K2 (decision 2a): a queue handler that is still running ttlMs after its job's lease was lost (or its
// maxHoldMs ran out) did not observe ctx.signal: ONE warning per loss. Stopping in time, or a cancel,
// warns nothing.
import { describe, it, expect, afterAll, afterEach, vi } from 'vitest';
import type { Storage } from '@gnldev/durable';
import { createDatabaseSync, dropDatabaseSync } from '../../../test/support/pg-admin.js';
import { enqueue, createWorker, cancelJob } from '../src/index.js';

const PG_URL = process.env.GNL_PG_URL;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const drops: string[] = [];
afterAll(() => { for (const n of drops) dropDatabaseSync(n); });
afterEach(() => vi.restoreAllMocks());
let seq = 0;
async function open(): Promise<Storage> {
  const name = `k2u_${process.pid}_${seq++}`; drops.push(name);
  const s = new (await import('@gnldev/durable/postgres')).PostgresStorage({ connectionString: createDatabaseSync(name) }) as unknown as Storage;
  await s.init?.();
  return s;
}
async function until(cond: () => boolean | Promise<boolean>, ms: number) { const end = Date.now() + ms; while (Date.now() < end) { if (await cond()) return true; await sleep(20); } return cond(); }
const leaseKey = async (s: Storage, id: string) => {
  const runs: any = s.runs;
  return (await runs.listKeys('')).find((k: string) => k.startsWith(`job:${id}:lease`) && k.endsWith(':lock')) as string;
};
// What another worker's takeover writes: a lease record carrying a token that is not the holder's.
async function takeLease(s: Storage, id: string, expires: number) {
  const runs: any = s.runs;
  const key = await leaseKey(s, id);
  const cur = await runs.get(key);
  const { proc: _ownProcess, ...rest } = cur; // another worker's process, not this one: an expired lease is free to take
  await runs.put(key, { ...rest, owner: 'other', token: `not-yours-${Math.random()}`, expires });
}
const unheeded = (spy: ReturnType<typeof vi.spyOn>) => spy.mock.calls.map((c) => String(c[0])).filter((m) => /still running/.test(m));

describe.skipIf(!PG_URL)('K2 2a: a handler that ignores ctx.signal gets one warning', () => {
  it('U1 lease lost, handler ignores the signal and runs on past ttlMs: exactly one warning', async () => {
    const spy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const s = await open();
    const id = await enqueue(s.work!, 't', {});
    let entered = 0;
    const worker = createWorker(s, { t: async () => { entered++; await sleep(3_000); } }, { owner: 'u1', ttlMs: 600, pollMs: 20, backoff: false, maxAttempts: 3 });
    worker.start();
    await until(() => entered === 1, 10_000);
    await takeLease(s, id, Date.now() + 60_000);
    await sleep(3_200);
    worker.stop();
    const w = unheeded(spy);
    await s.close?.();
    expect(w).toHaveLength(1);
    expect(w[0]).toContain(id);
    expect(w[0]).toMatch(/lease was lost/);
    // In the queue's words: its handler's signal and ctx.run, which it has.
    expect(w[0]).toMatch(/the handler is still running/);
    expect(w[0]).toMatch(/ctx\.signal may not be observed/);
    expect(w[0]).toMatch(/outside ctx\.run/);
  }, 30_000);

  it('U2 lease lost, handler obeys ctx.signal and returns within ttlMs: no warning', async () => {
    const spy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const s = await open();
    const id = await enqueue(s.work!, 't', {});
    let entered = 0; let aborted = false;
    const worker = createWorker(s, {
      t: async (_p: unknown, ctx: { signal: AbortSignal }) => {
        entered++;
        await new Promise<void>((res) => { ctx.signal.addEventListener('abort', () => { aborted = true; res(); }, { once: true }); setTimeout(res, 5_000); });
      },
    }, { owner: 'u2', ttlMs: 600, pollMs: 20, backoff: false, maxAttempts: 3 });
    worker.start();
    await until(() => entered === 1, 10_000);
    await takeLease(s, id, Date.now() + 60_000);
    await until(() => aborted, 3_000);
    await sleep(1_500); // well past ttlMs after the loss
    worker.stop();
    const w = unheeded(spy);
    await s.close?.();
    expect(aborted).toBe(true);
    expect(w).toHaveLength(0);
  }, 30_000);

  it('U3 maxHoldMs up, handler ignores the signal: exactly one warning naming the time limit', async () => {
    const spy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const s = await open();
    await enqueue(s.work!, 't', {});
    let entered = 0;
    const worker = createWorker(s, { t: async () => { entered++; await sleep(2_500); } }, { owner: 'u3', ttlMs: 600, pollMs: 20, backoff: false, maxAttempts: 1, maxHoldMs: 400 });
    worker.start();
    await until(() => entered === 1, 10_000);
    await sleep(2_800);
    worker.stop();
    const w = unheeded(spy);
    await s.close?.();
    expect(w).toHaveLength(1);
    expect(w[0]).toMatch(/maxHoldMs/);
  }, 30_000);

  it('U4 the same job loses its lease twice (the second attempt too): one warning per loss, none repeated', async () => {
    const spy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const s = await open();
    const id = await enqueue(s.work!, 't', {});
    let entered = 0;
    // Ignores the signal, runs past ttlMs, then fails: the job is taken again (its lease record is expired).
    const worker = createWorker(s, { t: async () => { entered++; await sleep(1_500); throw new Error('late'); } }, { owner: 'u4', ttlMs: 600, pollMs: 20, backoff: false, maxAttempts: 5, onError: () => {} });
    worker.start();
    await until(() => entered === 1, 10_000);
    await takeLease(s, id, 1);
    await until(() => entered === 2, 10_000);
    await takeLease(s, id, 1); // the second attempt loses its lease too
    await sleep(1_000); // past ttlMs after the second loss, before the second handler returns
    const during = unheeded(spy).length;
    await sleep(1_500);
    worker.stop();
    const w = unheeded(spy);
    await s.close?.();
    expect(entered).toBeGreaterThanOrEqual(2);
    expect(during, 'one per loss, said once each').toBe(2);
    expect(w, 'a lost lease already warned about is not warned again').toHaveLength(2);
  }, 40_000);

  it('U5 cancelJob while an ignoring handler runs: a cancel is not a loss, no warning', async () => {
    const spy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const s = await open();
    const id = await enqueue(s.work!, 't', {});
    let entered = 0; let why = '';
    const worker = createWorker(s, { t: async (_p: unknown, ctx: { signal: AbortSignal }) => { entered++; await sleep(2_500); why = String((ctx.signal.reason as { why?: string } | undefined)?.why); } }, { owner: 'u5', ttlMs: 600, pollMs: 20, backoff: false, maxAttempts: 3 });
    worker.start();
    await until(() => entered === 1, 10_000);
    expect(await cancelJob(s.work!, id)).toBe(true);
    await sleep(2_800);
    worker.stop();
    const w = unheeded(spy);
    await s.close?.();
    expect(why, 'the signal did say canceled').toBe('canceled');
    expect(w).toHaveLength(0);
  }, 30_000);
});
