// A process that is shutting down takes no new job, finishes the one it holds, and only then says it
// is done (SIGTERM → `drainProcess()`).
//
// The process's drain (`beginDrain`, what a door's `drain()` starts) stopped the run executor only: a
// queue worker in the same process kept claiming jobs after it, and nothing waited for the job a worker
// held — a shutdown that exited when the drain resolved cut that job off mid-handler, and another
// process ran it again.
import { describe, it, expect, afterEach } from 'vitest';
import { InMemoryStorage, beginDrain, endDrain } from '@gnldev/durable';
import * as durable from '@gnldev/durable';
import { createQueue, listJobs } from '../src/index.js';

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function until(cond: () => boolean | Promise<boolean>, ms = 5_000): Promise<boolean> {
  const end = Date.now() + ms;
  while (Date.now() < end) { if (await cond()) return true; await sleep(5); }
  return cond();
}

afterEach(() => endDrain());

describe('a draining process and its queue worker', () => {
  it('takes no job enqueued after the drain began', async () => {
    const storage = new InMemoryStorage();
    const ran: number[] = [];
    const q = createQueue(storage, { t: async (p: { n: number }) => { ran.push(p.n); } }, { pollMs: 5, backoff: false });
    try {
      await q.enqueue('t', { n: 1 });
      expect(await until(() => ran.length === 1)).toBe(true);
      beginDrain();
      await q.enqueue('t', { n: 2 });
      await sleep(200);
      expect(ran, 'a job was taken after the drain began').toEqual([1]);
      expect((await listJobs(storage.work!)).find((j) => j.status === 'pending'), 'the second job waits for another process').toBeTruthy();
    } finally {
      await q.close();
    }
  });

  it('drainProcess() resolves only after the job the worker holds has finished — and takes no next one', async () => {
    const drainProcess = (durable as Record<string, unknown>).drainProcess as undefined | ((o?: { deadlineMs?: number }) => Promise<{ drained: boolean }>);
    expect(typeof drainProcess, 'one shutdown path for the process: @gnldev/durable drainProcess').toBe('function');
    const storage = new InMemoryStorage();
    const log: string[] = [];
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const q = createQueue(storage, {
      t: async (p: { n: number }) => { log.push(`enter ${p.n}`); if (p.n === 1) await gate; log.push(`effect ${p.n}`); },
    }, { pollMs: 5, backoff: false });
    try {
      await q.enqueue('t', { n: 1 });
      expect(await until(() => log.includes('enter 1'))).toBe(true);
      await q.enqueue('t', { n: 2 });
      let resolved = false;
      const drained = drainProcess!({ deadlineMs: 10_000 }).then((r) => { resolved = true; return r; });
      await sleep(100);
      expect(resolved, 'the drain resolved while a job was still in its handler').toBe(false);
      release();
      expect(await drained).toEqual({ drained: true });
      expect(log).toEqual(['enter 1', 'effect 1']);
      const jobs = await listJobs(storage.work!);
      expect(jobs.map((j) => j.status).sort()).toEqual(['done', 'pending']);
    } finally {
      await q.close();
    }
  });

  it('drainProcess() past its deadline resolves { drained: false } — the held job is left to the crash path', async () => {
    const drainProcess = (durable as Record<string, unknown>).drainProcess as undefined | ((o?: { deadlineMs?: number }) => Promise<{ drained: boolean }>);
    expect(typeof drainProcess).toBe('function');
    const storage = new InMemoryStorage();
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    let entered = false;
    const q = createQueue(storage, { t: async () => { entered = true; await gate; } }, { pollMs: 5, backoff: false });
    try {
      await q.enqueue('t', {});
      expect(await until(() => entered)).toBe(true);
      const t0 = Date.now();
      expect(await drainProcess!({ deadlineMs: 150 })).toEqual({ drained: false });
      expect(Date.now() - t0).toBeLessThan(2_000);
    } finally {
      release();
      await q.close();
    }
  });
});
