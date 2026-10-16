// AUDIT C (red): cancelJob's contract — "a job running at that moment is not killed — its handler's
// ctx.signal is aborted on the worker's next heartbeat tick, and if the handler completes anyway the
// job is reported `done` (it ran), else `cancelled`". A handler that honours the signal throws; the
// worker counts that as a failed attempt, and on the last one writes a dead letter: the job reads
// `failed`, not `cancelled`.
import { describe, it, expect } from 'vitest';
import { InMemoryStorage, type Storage } from '@gnldev/durable';
import { enqueue, createWorker, cancelJob, listJobs } from '../src/index.js';

describe('a job cancelled while its handler runs', () => {
  it('reads cancelled when the handler stops on ctx.signal', async () => {
    const storage: Storage = new InMemoryStorage();
    const id = await enqueue(storage.work!, 't', {});
    let entered = false;
    const worker = createWorker(storage, {
      t: async (_p, ctx) => {
        entered = true;
        await new Promise<void>((_r, reject) => ctx.signal.addEventListener('abort', () => reject(ctx.signal.reason)));
      },
    }, { maxAttempts: 1, ttlMs: 90 });
    const running = worker.runOnce();
    while (!entered) await new Promise((r) => setTimeout(r, 5));
    expect(await cancelJob(storage.work!, id)).toBe(true);
    await running;
    expect((await listJobs(storage.work!)).find((j) => j.id === id)!.status).toBe('cancelled');
  });
});
