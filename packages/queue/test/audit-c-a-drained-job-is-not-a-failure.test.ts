// AUDIT C (red): a SIGTERM drain that reaches a job's durable run is not a failure of the job.
//
// drain.ts promises: "a run's running tool finishes and is recorded, no new step or tool starts, the
// run is released and another process continues it". A queue job's run (`ctx.run`) is released the
// same way — RunDrainedError at its next model step — and the worker reads that throw as the handler
// FAILING: the job is dead-lettered as `failed` (on its last attempt) with the drain's own message
// ("another process continues it") as its error, and nobody continues it.
import { describe, it, expect, afterEach } from 'vitest';
import { InMemoryStorage, beginDrain, endDrain, type Storage } from '@gnldev/durable';
import { enqueue, createWorker, listJobs } from '../src/index.js';

const usage = { inputTokens: 1, outputTokens: 1, totalTokens: 2 };
/** Turn 1: call `send`. Turn 2: answer. */
const model: any = {
  specificationVersion: 'v2', provider: 'probe', modelId: 'm', supportedUrls: {},
  doGenerate: async ({ prompt }: any) => ((prompt ?? []).some((m: any) => m.role === 'tool')
    ? { content: [{ type: 'text', text: 'done' }], finishReason: 'stop', usage, warnings: [] }
    : { content: [{ type: 'tool-call', toolCallId: 'c1', toolName: 'send', input: '{}' }], finishReason: 'tool-calls', usage, warnings: [] }),
  doStream: async () => { throw new Error('no stream'); },
};

afterEach(() => endDrain());

describe('a drain reaching a job run', () => {
  it('leaves the job for another process instead of dead-lettering it as failed', async () => {
    const storage: Storage = new InMemoryStorage();
    const id = await enqueue(storage.work!, 'notify', {});
    const errors: unknown[] = [];
    const worker = createWorker(storage, {
      notify: async (_p, ctx) => {
        await ctx.run({
          model,
          // SIGTERM arrives while the tool body runs: the body finishes, the next model step does not start.
          tools: { send: { execute: async () => { beginDrain(); return { sent: true }; } } } as any,
          prompt: 'go',
        });
      },
    }, { maxAttempts: 1, onError: (e) => errors.push(e) });
    await worker.runOnce();
    const job = (await listJobs(storage.work!)).find((j) => j.id === id)!;
    expect(job.status, 'a drained job was dead-lettered as failed').not.toBe('failed');
    expect(errors.map((e) => (e as Error).name), 'the drain was reported as the job failing').not.toContain('RunDrainedError');
  });
});
