// Every options object @gnldev/events reads refuses a name it does not take (@gnldev/options).
import { describe, it, expect } from 'vitest';
import { InMemoryStorage } from '@gnldev/durable';
import { emit, createConsumer } from '../src/index.js';

const work = () => (new InMemoryStorage() as any).work;

describe('@gnldev/events: a misspelled option is refused', () => {
  it.each([
    ['emit', () => emit(work(), 'topic', {}, { maxdepth: 2 } as any), /emit: `maxdepth` .* did you mean `maxDepth`\?/],
    ['createConsumer', () => createConsumer(work(), 'topic', async () => undefined, { name: 'c', leaseMS: 5 } as any), /createConsumer: `leaseMS` .* did you mean `leaseMs`\?/],
  ])('%s', async (_n, build, message) => {
    await expect((async () => build())()).rejects.toThrow(message);
  });
});
