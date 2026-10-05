// Every options object @gnldev/cache reads refuses a name it does not take (@gnldev/options).
import { it, expect } from 'vitest';
import { InMemoryStorage } from '@gnldev/durable';
import { createCache } from '../src/index.js';

it('createCache refuses a misspelled option', () => {
  expect(() => createCache(new InMemoryStorage() as any, 'ns', { onErorr: () => undefined } as any)).toThrow(/createCache: `onErorr` .* did you mean `onError`\?/);
});

// A misspelled `ttlMs` cached the value for ever.
it('cache.set and cache.getOrCompute refuse a misspelled option', async () => {
  const cache = createCache(new InMemoryStorage() as any, 'ns');
  await expect(cache.set('k', 1, { ttlMS: 5 } as any)).rejects.toThrow(/cache\.set: `ttlMS` .* did you mean `ttlMs`\?/);
  await expect(cache.getOrCompute('k', () => 1, { ttl: 5 } as any)).rejects.toThrow(/cache\.getOrCompute: `ttl` .* did you mean `ttlMs`\?/);
});
