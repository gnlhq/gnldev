// A cached value is a copy on every store: a caller that mutates what it got does not change what
// the next caller gets. The in-memory store kept the object itself — `["a","MUTATED"]` in memory,
// `["a"]` on SQLite for the same code.
import { describe, it, expect } from 'vitest';
import { InMemoryStorage } from '@gnldev/durable';
import { SqliteStorage } from '../../durable/src/sqlite-storage.js';
import { createCache } from '../src/index.js';

describe('a cached value is a copy', () => {
  for (const [name, mk] of [['in-memory', () => new InMemoryStorage()], ['sqlite', () => new SqliteStorage(':memory:')]] as const) {
    it(name, async () => {
      const c: any = createCache(mk() as any, 'ns');
      const first: any = await c.getOrCompute('k', async () => ({ tags: ['a'], at: new Date(0) }));
      first.tags.push('MUTATED');
      const second: any = await c.getOrCompute('k', async () => ({ tags: ['fresh'] }));
      second.tags.push('AGAIN');
      const third: any = await c.getOrCompute('k', async () => ({ tags: ['fresh'] }));
      expect(third.tags).toEqual(['a']);
      expect(third.at).toBeInstanceOf(Date);
    });
  }
});
