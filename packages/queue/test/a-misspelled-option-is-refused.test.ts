// Every options object @gnldev/queue reads refuses a name it does not take (@gnldev/options), naming the
// option it is closest to: a misspelled `maxAttempts` or `runAt` would otherwise run the job with the
// defaults — now, with the default number of tries — and say nothing.
import { describe, it, expect } from 'vitest';
import { InMemoryStorage } from '@gnldev/durable';
import { enqueue, retryJob, createWorker, moveJob } from '../src/index.js';

const s = () => new InMemoryStorage() as any;

describe('@gnldev/queue: a misspelled option is refused', () => {
  it.each([
    ['enqueue', () => enqueue(s().work, 'job', {}, { runat: Date.now() } as any), /enqueue: `runat` .* did you mean `runAt`\?/],
    ['retryJob', () => retryJob(s().work, 'id', { newrun: true } as any), /retryJob: `newrun` .* did you mean `newRun`\?/],
    ['createWorker', () => createWorker(s(), {}, { maxAttempt: 3 } as any), /createWorker: `maxAttempt` .* did you mean `maxAttempts`\?/],
    ['moveJob', () => moveJob(s().work, 'id', { orgID: 'a' } as any), /moveJob: `orgID` .* did you mean `orgId`\?/],
  ])('%s', async (_n, build, message) => {
    await expect((async () => build())()).rejects.toThrow(message);
  });
});
