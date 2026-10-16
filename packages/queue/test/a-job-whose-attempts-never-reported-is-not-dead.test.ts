// A job whose attempts never reported is in doubt at maxAttempts, not dead; a late report makes it done.
//
// An attempt counts when it starts, so a job whose workers are cut off from the store while the handler
// runs (a partition) reaches maxAttempts with nothing reported — and was dead-lettered `failed`, while a
// cut-off worker can still finish the handler afterwards. Measured (raporlar/2026-10-12-ag-kopmasi,
// Postgres, 5 partitions in a row): the job dead-lettered, and the handlers then finished it.
// The rule is the one the engine keeps for a tool call: whether it ran is unknown, so it is not called
// failed (`in-doubt`, never started again), and a handler that finishes after its worker lost the job
// records that it ran.
import { describe, it, expect } from 'vitest';
import { InMemoryStorage } from '@gnldev/durable';
import { enqueue, createWorker, listJobs, retryJob } from '../src/index.js';

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe('a job whose attempts never reported', () => {
  it('reaches maxAttempts in doubt — not failed — and a late finish makes it done', async () => {
    const warn = console.warn; console.warn = () => undefined;
    try {
      const storage = new InMemoryStorage();
      await enqueue(storage.work!, 't', {}, { id: 'cut' });
      const finish: Array<() => void> = [];
      let starts = 0;
      // Each attempt's worker is cut off in the handler: it does not return until released.
      const handlers = { t: () => { starts++; return new Promise<void>((r) => finish.push(r)); } };
      for (let i = 0; i < 5; i++) {
        void createWorker(storage, handlers, { ttlMs: 60, heartbeat: false, maxAttempts: 3 }).runOnce();
        await sleep(150);
      }
      expect(starts, 'never started past the ceiling').toBe(3);
      const before = (await listJobs(storage.work!)).find((j) => j.id === 'cut');
      expect(before, 'its outcome is unknown, not failed').toMatchObject({ status: 'in-doubt', attempts: 3 });

      // The first worker's handler finishes after all: the job ran.
      finish[0]!();
      await sleep(50);
      expect((await listJobs(storage.work!)).find((j) => j.id === 'cut')).toMatchObject({ status: 'done' });
      expect(await retryJob(storage.work!, 'cut'), 'a job that ran is not retried').toBeNull();
      // The others finish too: still done, once.
      for (const f of finish.slice(1)) f();
      await sleep(50);
      expect((await listJobs(storage.work!)).find((j) => j.id === 'cut')).toMatchObject({ status: 'done' });
    } finally {
      console.warn = warn;
    }
  });

  it('a handler that finished late while another worker held the job is kept; the job is done at the ceiling, not in doubt', async () => {
    const warn = console.warn; console.warn = () => undefined;
    try {
      const storage = new InMemoryStorage();
      await enqueue(storage.work!, 't', {}, { id: 'early' });
      const finish: Array<() => void> = [];
      let starts = 0;
      const handlers = { t: () => { starts++; return new Promise<void>((r) => finish.push(r)); } };
      void createWorker(storage, handlers, { ttlMs: 60, heartbeat: false, maxAttempts: 3 }).runOnce();
      await sleep(150);
      void createWorker(storage, handlers, { ttlMs: 60, heartbeat: false, maxAttempts: 3 }).runOnce();
      await sleep(20);
      // The first handler finishes while the second worker holds the job: the second settles its own.
      finish[0]!();
      await sleep(20);
      expect((await listJobs(storage.work!)).find((j) => j.id === 'early')?.status).toBe('pending');
      for (let i = 0; i < 3; i++) {
        void createWorker(storage, handlers, { ttlMs: 60, heartbeat: false, maxAttempts: 3 }).runOnce();
        await sleep(150);
      }
      // The late report is read before a new attempt: the job ran, no third start (audit Q1).
      expect(starts).toBe(2);
      expect((await listJobs(storage.work!)).find((j) => j.id === 'early'), 'it ran: done, not in doubt').toMatchObject({ status: 'done' });
    } finally {
      console.warn = warn;
    }
  });

  it('a job whose handler failed (it reported) is still a dead letter at maxAttempts', async () => {
    const warn = console.warn; console.warn = () => undefined;
    try {
      const storage = new InMemoryStorage();
      await enqueue(storage.work!, 't', {}, { id: 'boom' });
      const w = createWorker(storage, { t: async () => { throw new Error('boom'); } }, { heartbeat: false, maxAttempts: 2 });
      await w.runOnce(); await w.runOnce();
      expect((await listJobs(storage.work!)).find((j) => j.id === 'boom')).toMatchObject({ status: 'failed', attempts: 2 });
    } finally {
      console.warn = warn;
    }
  });
});
