// Audit B (queue): a handler that finished after its worker lost the job is kept (`qlate`) — the job RAN.
// The engine's sibling rule for a tool call (durable-tool.ts "A LATE REPORT FIRST") settles the call from
// that evidence before the call is run again or given up. Here: once `qlate` exists, no new attempt may
// start the handler again, and the job must not end `failed`.
import { describe, it, expect } from 'vitest';
import { InMemoryStorage } from '@gnldev/durable';
import { enqueue, createWorker, listJobs } from '../../src/index.js';

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe('a late report of a job that ran', () => {
  it('is read before a new attempt: the handler is not started again, and the job does not end failed', async () => {
    const warn = console.warn; console.warn = () => undefined;
    try {
      const storage = new InMemoryStorage();
      await enqueue(storage.work!, 't', {}, { id: 'ran' });
      let starts = 0;
      let effects = 0;
      let releaseFirst!: () => void;
      // Attempt 1: cut off in the handler (it completes the effect later). Every later attempt finds the
      // effect already there downstream and reports a failure (a duplicate refused by the provider).
      const handlers = {
        t: async () => {
          starts++;
          if (starts === 1) { await new Promise<void>((r) => { releaseFirst = r; }); effects++; return; }
          await sleep(40);
          throw new Error('already exists downstream');
        },
      };
      void createWorker(storage, handlers, { ttlMs: 60, heartbeat: false, maxAttempts: 3 }).runOnce();
      await sleep(150);
      // Attempt 2 takes the job over (attempt 1's lease is stale) and is in flight; attempt 1 finishes now.
      const second = createWorker(storage, handlers, { ttlMs: 60, heartbeat: false, maxAttempts: 3 }).runOnce();
      await sleep(15);
      const secondStarted = starts === 2;
      releaseFirst();
      await second;
      await sleep(50);
      const lateKept = (await storage.work!.get('qlate:ran')) !== undefined;
      // More workers poll the queue.
      for (let i = 0; i < 3; i++) { await createWorker(storage, handlers, { ttlMs: 60, heartbeat: false, maxAttempts: 3 }).runOnce(); await sleep(80); }
      const job = (await listJobs(storage.work!)).find((j) => j.id === 'ran');
      expect({ secondStarted, lateKept, effects, startsAfterTheLateReport: starts - 2, status: job?.status })
        .toEqual({ secondStarted: true, lateKept: true, effects: 1, startsAfterTheLateReport: 0, status: 'done' });
    } finally {
      console.warn = warn;
    }
  });
});
