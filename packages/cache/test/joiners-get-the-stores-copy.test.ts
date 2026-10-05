// Every caller of a single-flight compute gets the store's copy, as a hit does — never another caller's
// object — and invalidate() is not undone by a compute that started before it.
//
// Measured before this (the joiners got the computing caller's object itself):
//   · the caller that computed added to the value, and the callers that joined saw it;
//   · a call after invalidate(key) joined the compute that started before it and got the old value, and
//     that old value was stored after the invalidate;
//   · in a store that keeps JSON text, a joiner got a Date where a hit gets a string — the same call gave
//     two types depending on when it arrived.
import { describe, it, expect } from 'vitest';
import { InMemoryStorage } from '@gnldev/durable';
import type { CacheStore } from '@gnldev/durable';
import { createCache } from '../src/index.js';

class Money { constructor(public n: number) {} }
const shape = (x: any): string => x instanceof Date ? 'Date' : x instanceof Map ? 'Map' : x instanceof Set ? 'Set'
  : Array.isArray(x) ? `[${x.map(shape).join(',')}]` : x && typeof x === 'object' ? `${x.constructor?.name}{${Object.keys(x).sort().map((k) => `${k}:${shape(x[k])}`).join(',')}}` : typeof x;

/** A store that keeps values as JSON text, as a third-party store might. */
function jsonStore(): CacheStore {
  const m = new Map<string, string>();
  return {
    get: async (k: string) => { const s = m.get(k); return s === undefined ? undefined : JSON.parse(s); },
    set: async (k: string, v: unknown) => { m.set(k, JSON.stringify(v)); },
    delete: async (k: string) => { m.delete(k); },
  } as CacheStore;
}

/** Three concurrent calls of one key (the first computes, two join), then a hit. */
async function trio(store: CacheStore, value: () => unknown) {
  const c = createCache(store);
  let release!: () => void;
  const gate = new Promise<void>((r) => (release = r));
  const compute = async () => { await gate; return value(); };
  const calls = [c.getOrCompute<any>('k', compute), c.getOrCompute<any>('k', compute), c.getOrCompute<any>('k', compute)];
  release();
  const [owner, j1, j2] = await Promise.all(calls);
  return { owner, j1, j2, hit: await c.getOrCompute<any>('k', compute) };
}

describe('every caller gets the store\'s copy', () => {
  const value = () => ({ at: new Date(0), m: new Map([['a', 1]]), s: new Set(['x']), money: new Money(3), list: [1, 2] });
  for (const [name, store] of [['in-memory storage', () => new InMemoryStorage().cache!], ['a store that keeps JSON', jsonStore]] as const) {
    it(`${name}: the caller that computed, the callers that joined and a later hit see the same shape`, async () => {
      const r = await trio(store(), value);
      expect(shape(r.j1)).toBe(shape(r.hit));
      expect(shape(r.j2)).toBe(shape(r.hit));
      expect(shape(r.owner)).toBe(shape(r.hit));
    });
  }

  it('what one caller does to its value, no other caller sees', async () => {
    const r = await trio(new InMemoryStorage().cache!, () => ({ list: [1] }));
    r.owner.list.push(9);
    r.j1.list.push(7);
    expect(r.j2.list).toEqual([1]);
    expect(r.j1.list).toEqual([1, 7]);
  });

  it('the same holds when the store is down: each caller gets its own copy', async () => {
    const down = { get: async () => { throw new Error('down'); }, set: async () => { throw new Error('down'); }, delete: async () => {} } as unknown as CacheStore;
    const r = await trio(down, () => ({ list: [1] }));
    r.owner.list.push(9);
    expect(r.j1.list).toEqual([1]);
    expect(r.j2.list).toEqual([1]);
  });
});

describe('invalidate() is not undone by a compute that started before it', () => {
  it('a later call computes again, and the earlier value is not stored', async () => {
    const c = createCache(new InMemoryStorage().cache!);
    let version = 1;
    let started!: () => void;
    const isStarted = new Promise<void>((r) => (started = r));
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const before = c.getOrCompute('k', async () => { const v = version; started(); await gate; return v; });
    await isStarted;
    await c.invalidate('k');
    version = 2;
    const after = c.getOrCompute('k', async () => version);
    release();
    expect(await before).toBe(1);
    expect(await after).toBe(2);
    expect(await c.getOrCompute('k', async () => -1)).toBe(2);
  });
});
