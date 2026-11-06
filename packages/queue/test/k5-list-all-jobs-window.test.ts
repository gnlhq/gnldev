// k5 (5b) cost test, the measurement it rests on: `listAllJobs` reads no record per job, and the count that
// says so is the port calls made while the listing runs.
//
// That count is taken by wrapping the work store, so the wrapper sees every caller of the store, not only
// the listing. `enqueue` arms a one-shot "no worker is consuming this queue" check for 10 s
// (NO_WORKER_NOTICE_MS); when it fires it reads the store — `qdone:`, `qfail:`, `qcancel:` and `__qworkers__`,
// four `get`s. Counted by the window alone, those four were the listing's: the cost test in
// k5-list-all-jobs.test.ts went red with `expected 4 to be +0` on a loaded CI runner where its fixture and its
// pages took 12.7 s, and was green on a fast one (4.7 s). So a count belongs to the async context of the call
// it measures. Fake timers stand in for the slow store, so nothing here waits or depends on load.
import { AsyncLocalStorage } from 'node:async_hooks';
import { describe, it, expect, afterEach, vi } from 'vitest';
import { InMemoryStorage, type WorkStore } from '@gnldev/durable';
import * as Q from '../src/index.js';

const q = Q as any;

/** The `get`s on the work store while `fn` runs: `own` from `fn`'s async context, `others` from anyone else's. */
async function getsWhile(work: WorkStore, fn: () => Promise<void>): Promise<{ own: string[]; others: string[] }> {
  const measured = new AsyncLocalStorage<true>();
  const own: string[] = [];
  const others: string[] = [];
  const get = work.get;
  work.get = ((k: string, ...a: unknown[]) => { (measured.getStore() ? own : others).push(k); return (get as any).call(work, k, ...a); }) as typeof work.get;
  try { await measured.run(true, fn); } finally { work.get = get; }
  return { own, others };
}

async function allPages(work: WorkStore): Promise<number> {
  let n = 0;
  let cursor: string | undefined;
  do {
    const page = await q.listAllJobs(work, { limit: 100, ...(cursor !== undefined ? { cursor } : {}) });
    n += page.items.length;
    cursor = page.nextCursor;
  } while (cursor);
  return n;
}

describe('k5 listAllJobs cost: what the window counts', () => {
  afterEach(() => { vi.useRealTimers(); });

  it('control: a listing that no notice overlaps reads no record per job', async () => {
    vi.useFakeTimers();
    const s = new InMemoryStorage();
    await q.enqueueMany(s.work!, Array.from({ length: 250 }, (_, i) => ({ type: 't', payload: { i } })));
    const { own, others } = await getsWhile(s.work!, async () => { expect(await allPages(s.work!)).toBe(250); });
    expect(own).toEqual([]);
    expect(others).toEqual([]);
  });

  it('a get count around listAllJobs does not include the no-worker notice that fires inside the same window', async () => {
    vi.useFakeTimers();
    const s = new InMemoryStorage();
    await q.enqueueMany(s.work!, Array.from({ length: 250 }, (_, i) => ({ type: 't', payload: { i } })));
    // The fixture took 9.8 s on the slow runner; the window opens before the notice and closes after it.
    await vi.advanceTimersByTimeAsync(q.NO_WORKER_NOTICE_MS - 200);
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      let fired = () => {};
      const noticeFired = new Promise<void>((r) => { fired = r; });
      const window = getsWhile(s.work!, async () => {
        expect(await allPages(s.work!)).toBe(250);
        await noticeFired;
      });
      // Advanced from outside the measured call: a fake clock runs a timer in its caller's context.
      await vi.advanceTimersByTimeAsync(400);
      fired();
      const { own, others } = await window;
      // The notice did fire in the window, through the same store...
      expect(warn).toHaveBeenCalledTimes(1);
      expect(others.map((k) => k.split(':')[0])).toEqual(['qdone', 'qfail', 'qcancel', '__qworkers__']);
      // ...and the count taken of the listing still says it read nothing per job.
      expect(own, 'gets the listing made').toEqual([]);
    } finally { warn.mockRestore(); }
  });
});
