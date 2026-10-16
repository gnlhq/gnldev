// A queue runs its jobs in the process that enqueues them, unless told not to; a job nobody consumes
// is said out loud.
//
// `enqueue` and `createWorker` were two separate calls. An application that enqueued and never
// started a worker anywhere had its jobs wait forever without a word: nothing failed, nothing ran.
// `createQueue` puts the two together — the handlers and the worker that runs them in this process —
// with `worker: false` for an application that runs its workers elsewhere. And a job still waiting
// after a while with no live worker on its store is reported, once per type.
import { describe, it, expect, vi, afterEach } from 'vitest';
import { InMemoryStorage } from '@gnldev/durable';
import { createQueue, createWorker, enqueue, listJobs, NO_WORKER_NOTICE_MS } from '../src/index.js';

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function until(cond: () => boolean | Promise<boolean>, ms = 5_000): Promise<boolean> {
  const end = Date.now() + ms;
  while (Date.now() < end) { if (await cond()) return true; await sleep(5); }
  return cond();
}

afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); });

/** Advances the fake clock, then lets the store's promises settle (setImmediate is not faked). */
async function advance(ms: number): Promise<void> {
  await vi.advanceTimersByTimeAsync(ms);
  for (let i = 0; i < 10; i++) await new Promise((r) => setImmediate(r));
}

describe('createQueue — the worker runs in this process by default', () => {
  it('a job enqueued through the queue runs here, with nothing else started', async () => {
    const storage = new InMemoryStorage();
    const ran: number[] = [];
    const q = createQueue(storage, { t: async (p: { n: number }) => { ran.push(p.n); } }, { pollMs: 5 });
    try {
      await q.enqueue('t', { n: 1 });
      expect(await until(() => ran.length === 1), 'the embedded worker ran the job').toBe(true);
      expect((await listJobs(storage.work!))[0]).toMatchObject({ status: 'done' });
    } finally {
      await q.close();
    }
  });

  it('worker: false runs nothing here — the jobs wait for a worker elsewhere, which runs them', async () => {
    const storage = new InMemoryStorage();
    const ran: string[] = [];
    const q = createQueue(storage, { t: async () => { ran.push('here'); } }, { worker: false, pollMs: 5 });
    try {
      expect(q.worker).toBeUndefined();
      await q.enqueue('t', {});
      await sleep(100);
      expect(ran).toEqual([]);
      const elsewhere = createWorker(storage, { t: async () => { ran.push('elsewhere'); } });
      expect(await elsewhere.drain()).toBe(1);
      expect(ran).toEqual(['elsewhere']);
    } finally {
      await q.close();
    }
  });

  it('a misspelled option is refused', () => {
    expect(() => createQueue(new InMemoryStorage(), {}, { workr: false } as any)).toThrow(/worker/);
  });
});

describe('a job nobody consumes is reported', () => {
  it('no worker anywhere: one warning per type, naming it, once the job has waited', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval'] });
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const storage = new InMemoryStorage();
    await enqueue(storage.work!, 'send-report', {});
    await enqueue(storage.work!, 'send-report', {});
    await advance(NO_WORKER_NOTICE_MS - 1);
    expect(warn).not.toHaveBeenCalled();
    await advance(2);
    const said = warn.mock.calls.map((c) => String(c[0])).filter((m) => m.includes('no worker'));
    expect(said).toHaveLength(1);
    expect(said[0]).toMatch(/'send-report'/);
  });

  it('a live worker: no warning; once it stopped, a waiting job is reported again', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval'] });
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const storage = new InMemoryStorage();
    // A worker takes every job it sees (a type it has no handler for is dead-lettered), so "consumed"
    // means "a live worker exists on this store".
    const q = createQueue(storage, { 'send-report': async () => { await new Promise(() => {}); } }, { pollMs: 5 });
    await q.enqueue('send-report', {}); // taken by its worker and held (the handler never returns)
    await advance(NO_WORKER_NOTICE_MS + 10);
    expect(warn.mock.calls.filter((c) => String(c[0]).includes('no worker'))).toEqual([]);
    q.worker!.stop(); // gone (its held job never ends, so close() would wait for it)
    await enqueue(storage.work!, 'index-docs', {});
    await advance(NO_WORKER_NOTICE_MS + 10);
    const said = warn.mock.calls.map((c) => String(c[0])).filter((m) => m.includes('no worker'));
    expect(said).toHaveLength(1);
    expect(said[0]).toMatch(/'index-docs'/);
  });

  it('a job that finished before the wait is over is not reported', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval'] });
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const storage = new InMemoryStorage();
    await enqueue(storage.work!, 't', {});
    await createWorker(storage, { t: async () => {} }).drain(); // ran once, by a worker that is gone
    await advance(NO_WORKER_NOTICE_MS + 10);
    expect(warn.mock.calls.filter((c) => String(c[0]).includes('no worker'))).toEqual([]);
  });
});
