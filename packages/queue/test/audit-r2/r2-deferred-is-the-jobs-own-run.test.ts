// AUDIT ROUND 2 (red): attemptEndOf (durable outcome.ts) reads ANY RunBusyError refused at lock acquisition
// as "the unit's run is executing elsewhere" → 'deferred' → the attempt is given back. It does not ask WHOSE
// run was busy. A handler whose own code did its work and then called another run (busy for good: a frozen
// holder) is never counted: it runs again on every poll, past maxAttempts, and never dead-letters.
import { describe, it, expect } from 'vitest';
import { InMemoryStorage, acquireRunLock, runDurable, toJournal, type Storage } from '@gnldev/durable';
import { enqueue, createWorker, listJobs } from '../../src/index.js';

const usage = { inputTokens: 1, outputTokens: 1, totalTokens: 2 };
const answer: any = {
  specificationVersion: 'v2', provider: 'probe', modelId: 'm', supportedUrls: {},
  doGenerate: async () => ({ content: [{ type: 'text', text: 'ok' }], finishReason: 'stop', usage, warnings: [] }),
  doStream: async () => { throw new Error('no stream'); },
};

describe("a deferral is the job's own run executing elsewhere, nothing else", () => {
  it('a handler refused by ANOTHER busy run counts its attempts and stops at maxAttempts', async () => {
    const storage: Storage = new InMemoryStorage();
    const id = await enqueue(storage.work!, 't', {});
    // Some other run the handler depends on is held by a live (frozen) holder for good.
    expect(await acquireRunLock(toJournal(storage.runs), 'report-of-the-day', 'elsewhere', 600_000)).not.toBeNull();
    let effects = 0;
    const worker = createWorker(storage, {
      t: async () => {
        effects++; // the handler's own work (an email, a write) — done before the call below
        await runDurable({ journal: toJournal(storage.runs), runId: 'report-of-the-day', model: answer, prompt: 'go', resourceId: 'u', lock: { owner: 'here', ttlMs: 1_000 } } as never);
      },
    }, { maxAttempts: 2, retryDelayMs: 0 } as never);
    for (let i = 0; i < 6; i++) await worker.runOnce();
    const j = (await listJobs(storage.work!)).find((x) => x.id === id)!;
    expect({ status: j.status, attempts: j.attempts, effects }).toEqual({ status: 'failed', attempts: 2, effects: 2 });
  });
});
