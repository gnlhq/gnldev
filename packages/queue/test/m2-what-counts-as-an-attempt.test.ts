// What counts as an attempt of a job — one answer (@gnldev/durable `attemptEndOf`), the scheduler's too.
// Siblings of audit C4 (a drained job dead-lettered as failed) and C9 (a cancelled job read failed):
//   · a process that cannot judge others right now (LivenessUnavailableError) released the job;
//   · a drain wrapped by a library (`cause`) is still a drain;
//   · a job whose run executes elsewhere (refused at lock acquisition) was deferred;
//   · a job cancelled while its run ran reads `cancelled`, and one whose handler finishes anyway `done`.
// None of them is an attempt: the job stays due (or reads what it is), and `onError` hears nothing.
import { describe, it, expect, afterEach } from 'vitest';
import { InMemoryStorage, LivenessUnavailableError, RunDrainedError, acquireRunLock, beginDrain, endDrain, drainProcess, toJournal, type Storage } from '@gnldev/durable';
import { enqueue, createWorker, cancelJob, listJobs } from '../src/index.js';

const usage = { inputTokens: 1, outputTokens: 1, totalTokens: 2 };
const answer: any = {
  specificationVersion: 'v2', provider: 'probe', modelId: 'm', supportedUrls: {},
  doGenerate: async () => ({ content: [{ type: 'text', text: 'ok' }], finishReason: 'stop', usage, warnings: [] }),
  doStream: async () => { throw new Error('no stream'); },
};
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
afterEach(() => endDrain());

async function statusOf(storage: Storage, id: string) {
  const j = (await listJobs(storage.work!)).find((x) => x.id === id)!;
  return { status: j.status, attempts: j.attempts };
}

describe('what counts as an attempt of a job', () => {
  it('a lost liveness session releases the job: not counted, not reported, run again later', async () => {
    const storage: Storage = new InMemoryStorage();
    const id = await enqueue(storage.work!, 't', {});
    const errors: unknown[] = [];
    let calls = 0;
    const worker = createWorker(storage, { t: async () => { if (++calls === 1) throw new LivenessUnavailableError(); } }, { maxAttempts: 1, onError: (e) => errors.push(e) });
    await worker.runOnce();
    expect(await statusOf(storage, id)).toEqual({ status: 'pending', attempts: 0 });
    expect(errors).toEqual([]);
    await worker.runOnce();
    expect(await statusOf(storage, id)).toEqual({ status: 'done', attempts: 1 });
  });

  it('a drain a library wrapped (`cause`) is still a drain', async () => {
    const storage: Storage = new InMemoryStorage();
    const id = await enqueue(storage.work!, 't', {});
    const worker = createWorker(storage, { t: async () => { throw new Error('the client gave up', { cause: new RunDrainedError(`job:${id}`) }); } }, { maxAttempts: 1 });
    await worker.runOnce();
    expect(await statusOf(storage, id)).toEqual({ status: 'pending', attempts: 0 });
  });

  it('a job whose run executes elsewhere is deferred: refused at lock acquisition, not counted', async () => {
    const storage: Storage = new InMemoryStorage();
    const id = await enqueue(storage.work!, 't', {});
    // Another live holder executes the job's run (`job:<id>`): its run lock is taken.
    expect(await acquireRunLock(toJournal(storage.runs), `job:${id}`, 'elsewhere', 60_000)).not.toBeNull();
    const errors: unknown[] = [];
    const worker = createWorker(storage, {
      t: async (_p, ctx) => { await ctx.run({ model: answer, prompt: 'go', lock: { owner: 'here', ttlMs: 1_000 } } as never); },
    }, { maxAttempts: 1, onError: (e) => errors.push(e) });
    await worker.runOnce();
    expect(await statusOf(storage, id)).toEqual({ status: 'pending', attempts: 0 });
    expect(errors).toEqual([]);
  });

  it('a job cancelled while its run waits on the model reads cancelled; one that finishes anyway reads done', async () => {
    const storage: Storage = new InMemoryStorage();
    const stops = await enqueue(storage.work!, 't', { stop: true }, { id: 'stops' });
    const finishes = await enqueue(storage.work!, 't', { stop: false }, { id: 'finishes' });
    let entered = '';
    const worker = createWorker(storage, {
      t: async (p, ctx) => {
        entered = ctx.jobId;
        if ((p as { stop: boolean }).stop) {
          const slow: any = { ...answer, doGenerate: async (o: any) => { await new Promise((_r, rej) => o.abortSignal?.addEventListener('abort', () => rej(o.abortSignal.reason))); } };
          await ctx.run({ model: slow, prompt: 'go' } as never);
        } else {
          while (!ctx.signal.aborted) await sleep(5);
        }
      },
    }, { maxAttempts: 1, ttlMs: 90 });
    for (const id of [stops, finishes]) {
      entered = '';
      const running = worker.runOnce();
      while (entered !== id) await sleep(5);
      expect(await cancelJob(storage.work!, id)).toBe(true);
      await running;
    }
    expect((await statusOf(storage, stops)).status).toBe('cancelled');
    expect((await statusOf(storage, finishes)).status).toBe('done');
  });

  it('a drain waits for a job taken by a runOnce called by hand (no poll loop)', async () => {
    const storage: Storage = new InMemoryStorage();
    await enqueue(storage.work!, 't', {});
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    let entered = false;
    const worker = createWorker(storage, { t: async () => { entered = true; await gate; } }, { maxAttempts: 1 });
    const running = worker.runOnce();
    while (!entered) await sleep(5);
    expect(await drainProcess({ deadlineMs: 200 })).toEqual({ drained: false });
    release();
    expect(await drainProcess({ deadlineMs: 2_000 })).toEqual({ drained: true });
    await running;
    beginDrain(); // drainProcess began it; afterEach ends it
  });
});
