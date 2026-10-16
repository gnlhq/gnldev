// AUDIT ROUND 2 (red): Worker.close() now waits for every job the worker holds (C2). A handler that closes
// its own worker (a "shutdown" job, a maintenance stop) waits for close(), and close() waits for that very
// handler: neither ever settles. Before C2's fix close() returned at once.
import { describe, it, expect } from 'vitest';
import { InMemoryStorage, type Storage } from '@gnldev/durable';
import { enqueue, createWorker } from '../../src/index.js';

describe('closing a worker from inside one of its jobs', () => {
  it('settles (the closing job is not waited for by itself)', async () => {
    const storage: Storage = new InMemoryStorage();
    await enqueue(storage.work!, 'shutdown', {});
    let worker: ReturnType<typeof createWorker>;
    worker = createWorker(storage, { shutdown: async () => { await worker.close(); } }, { maxAttempts: 1 });
    const outcome = await Promise.race([
      worker.runOnce().then(() => 'settled'),
      new Promise((r) => setTimeout(() => r('still waiting after 3s'), 3_000)),
    ]);
    expect(outcome).toBe('settled');
  });
});
