// @gnldev/cache: concurrent misses share one compute (single-flight, per process per store object), and a
// store that cannot hold a value is refused at createCache instead of silently computing every time.
import { describe, it, expect } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { InMemoryStorage, CapabilityError } from '@gnldev/durable';
import type { CacheStore, Storage } from '@gnldev/durable';
import { SqliteStorage } from '@gnldev/durable/sqlite';
import { createCache } from '../src/index.js';

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const N = 10;

/** A compute that counts its calls and takes `ms` to answer. */
function slow<T>(value: T, ms = 20) {
  const c = { calls: 0, fn: async () => { c.calls++; await sleep(ms); return value; } };
  return c;
}

const kinds: Array<[string, () => Promise<{ store: CacheStore; done: () => Promise<void> }>]> = [
  ['in-memory', async () => ({ store: new InMemoryStorage().cache, done: async () => {} })],
  ['sqlite', async () => {
    const s = new SqliteStorage(':memory:');
    await s.init?.();
    return { store: s.cache, done: async () => { await s.close?.(); } };
  }],
];

describe('single-flight: concurrent misses for one key compute once', () => {
  for (const [kind, make] of kinds) {
    it(`${kind}: ${N} concurrent misses → 1 compute, every caller gets the value, the value is stored`, async () => {
      const { store, done } = await make();
      const cache = createCache(store, 'sf');
      const c = slow('v');
      const out = await Promise.all(Array.from({ length: N }, () => cache.getOrCompute('k', c.fn)));
      expect(c.calls).toBe(1);
      expect(out).toEqual(Array(N).fill('v'));
      expect(cache.stats()).toMatchObject({ misses: 1, hits: N - 1 });
      expect(await createCache(store, 'sf').get('k')).toBe('v'); // stored once, readable by anyone
      await done();
    });
  }

  it('two cache instances over the same store object in one process share the flight', async () => {
    const store = new InMemoryStorage().cache;
    const a = createCache(store, 'sf');
    const b = createCache(store, 'sf');
    const c = slow(1);
    await Promise.all([a.getOrCompute('k', c.fn), b.getOrCompute('k', c.fn), a.getOrCompute('k', c.fn)]);
    expect(c.calls).toBe(1);
  });

  it('different keys, and the same key in different namespaces, stay independent', async () => {
    const store = new InMemoryStorage().cache;
    const a = createCache(store, 'ns-a');
    const b = createCache(store, 'ns-b');
    const seen: string[] = [];
    const fn = (tag: string) => async () => { seen.push(tag); await sleep(10); return tag; };
    const out = await Promise.all([
      a.getOrCompute('x', fn('a:x')), a.getOrCompute('y', fn('a:y')),
      b.getOrCompute('x', fn('b:x')), a.getOrCompute('x', fn('a:x-dup')),
    ]);
    expect(out).toEqual(['a:x', 'a:y', 'b:x', 'a:x']);
    expect(seen.sort()).toEqual(['a:x', 'a:y', 'b:x']);
  });

  it('a compute that rejects: the joined callers share that rejection, nothing is stored, the next call computes again', async () => {
    const store = new InMemoryStorage().cache;
    const cache = createCache(store, 'sf');
    let calls = 0;
    const failing = async () => { calls++; await sleep(10); throw new Error('upstream 503'); };
    const settled = await Promise.allSettled(Array.from({ length: N }, () => cache.getOrCompute('k', failing)));
    expect(calls).toBe(1);
    expect(settled.every((r) => r.status === 'rejected' && /upstream 503/.test(String(r.reason)))).toBe(true);
    expect(await cache.get('k')).toBeUndefined();
    expect(await cache.getOrCompute('k', () => (calls++, 'ok'))).toBe('ok');
    expect(calls).toBe(2);
  });

  it('a compute that throws synchronously does not leave a stuck flight', async () => {
    const cache = createCache(new InMemoryStorage().cache, 'sf');
    const boom = () => { throw new Error('sync boom'); };
    await expect(cache.getOrCompute('k', boom)).rejects.toThrow('sync boom');
    expect(await cache.getOrCompute('k', () => 7)).toBe(7);
  });

  it('a compute slower than ttlMs: joiners still get the value; the TTL counts from the write', async () => {
    const cache = createCache(new InMemoryStorage().cache, 'sf');
    const c = slow('late', 60);
    const out = await Promise.all(Array.from({ length: 3 }, () => cache.getOrCompute('k', c.fn, { ttlMs: 30 })));
    expect(out).toEqual(['late', 'late', 'late']);
    expect(c.calls).toBe(1);
    expect(await cache.get('k')).toBe('late'); // written at the end of the compute, still fresh
    await sleep(45);
    expect(await cache.get('k')).toBeUndefined(); // expired 30ms after the write
  });

  it('store down: concurrent misses still share one compute, and the run does not blow up', async () => {
    const down: CacheStore = {
      async get() { throw new Error('down'); }, async set() { throw new Error('down'); }, async delete() { throw new Error('down'); },
    };
    const cache = createCache(down, 'sf', { onError: () => {} });
    const c = slow(3);
    expect(await Promise.all(Array.from({ length: N }, () => cache.getOrCompute('k', c.fn)))).toEqual(Array(N).fill(3));
    expect(c.calls).toBe(1);
  });

  it('the guarantee is per process: two stores over one SQLite file (= two processes) compute once EACH, not N times', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'gnl-cache-sf-'));
    const file = join(dir, 'c.db');
    const s1 = new SqliteStorage(file); await s1.init?.();
    const s2 = new SqliteStorage(file); await s2.init?.();
    try {
      const c = slow('v', 30);
      const a = createCache(s1.cache!, 'sf');
      const b = createCache(s2.cache!, 'sf');
      await Promise.all([
        ...Array.from({ length: 5 }, () => a.getOrCompute('k', c.fn)),
        ...Array.from({ length: 5 }, () => b.getOrCompute('k', c.fn)),
      ]);
      expect(c.calls).toBe(2);
      expect(await b.getOrCompute('k', c.fn)).toBe('v'); // after both settle, the stored value is shared
      expect(c.calls).toBe(2);
    } finally {
      await s1.close?.(); await s2.close?.();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('wiring: a store that cannot hold a value is refused at createCache', () => {
  it('the run journal (storage.runs) is refused, naming the missing methods and the remedy', () => {
    const storage = new InMemoryStorage();
    expect(() => createCache(storage.runs as unknown as CacheStore, 'ns')).toThrow(/it is a run journal \(storage\.runs\), not the cache port\. Pass the storage, or storage\.cache\./);
  });

  it('an object missing a method is refused, naming it', () => {
    const partial = { async get() { return undefined; }, async set() {} } as unknown as CacheStore;
    expect(() => createCache(partial)).toThrow(/has no delete method — it is not a cache port\. Pass the storage, or storage\.cache\./);
  });

  it('null/undefined is refused (e.g. config.storage.cache on a storage without a cache port)', () => {
    expect(() => createCache(undefined as unknown as CacheStore)).toThrow(/createCache needs the storage or its cache port, got undefined/);
    expect(() => createCache(null as unknown as CacheStore)).toThrow(/got null/);
  });

  it('a storage is accepted for its cache port (in-memory and sqlite) and actually caches', async () => {
    for (const storage of [new InMemoryStorage(), new SqliteStorage(':memory:')] as Storage[]) {
      await storage.init?.();
      const cache = createCache(storage, 'ns');
      let calls = 0;
      await cache.getOrCompute('k', () => (calls++, 1));
      await cache.getOrCompute('k', () => (calls++, 1));
      expect(calls).toBe(1);
      expect(await createCache(storage.cache!, 'ns').get('k')).toBe(1); // same port either way
      await storage.close?.();
    }
  });

  it('a storage with no cache port is refused with CapabilityError (the memory/queue rule)', () => {
    const s = new InMemoryStorage();
    const noCache: Storage = {
      name: 'runs-only', runs: s.runs, meta: s.meta,
      capabilities: { runs: 'full', memory: 'none', vectors: 'none', work: 'none', cache: 'none' },
    };
    expect(() => createCache(noCache)).toThrow(CapabilityError);
    expect(() => createCache(noCache)).toThrow(/does not support the 'cache' store/);
  });
});
