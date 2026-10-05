// @gnldev/cache — cross-run content-hash cache built on top of CacheStore. Key is run-independent (`<ns>:<hash>`)
// → a result computed in one run is reused across OTHER runs. (Within-run reuse is already
// journal replay; this closes the across-run gap — e.g. the same RAG query in two runs → embed once.)
//
// BEST-EFFORT: Cache is an optional accelerator → a store error (e.g. cache storage down) does NOT BLOW UP the run.
// get error → miss, set error → no-op, getOrCompute → still computes. (run/memory stays STRICT.)
// Value is wrapped in `{ v }` → distinguishes a cached `undefined` from "not present".
// VISIBILITY: `stats()` returns in-process hit/miss counters + known key count; `invalidate(key?)`
// deletes a single key or (best-effort, since CacheStore doesn't offer enumeration, only what this instance knows about)
// deletes all of them (the Studio Cache view wraps these — see packages/studio/src/server.ts StudioCache).
//
// SINGLE-FLIGHT (per process, per store object): concurrent getOrCompute misses for the same key share
// ONE compute — see `flightsFor`. The store port (get/set/delete) has no atomic claim, so this is not a
// cross-process lock; two processes on one database each compute once (see README "Concurrent misses").
// Every caller gets the STORE's copy of the value, as a hit does — the one that computed it and the ones
// that joined: read back after the write, so the store's codec is the one copy rule and a joiner cannot
// see what another caller did to its object. When the store cannot answer, a structuredClone stands in.
// An invalidate() drops the flight in progress: a caller after it computes again, and the earlier
// compute's value is returned to its own callers and never stored.
//
// LOUD WIRING: best-effort covers a store that is DOWN, not a store that is WRONG. `createCache` checks
// the argument once (`resolveStore`) and refuses anything that cannot hold a value — before, a journal
// or the whole storage was accepted, every call failed inside the swallowing wrappers, and the cache
// silently computed every time.
import { argsHash, requireCapability, portOf } from '@gnldev/durable';
import type { CacheStore, Storage } from '@gnldev/durable';
import { refuseUnknownNames } from '@gnldev/options';
import { CREATE_CACHE_OPTS_NAMES, CACHE_SET_NAMES } from './option-names.js';

export interface CacheSetOptions {
  /** Time-to-live (ms). Applied if the storage supports the 'ttl' capability. */
  ttlMs?: number;
}

export interface CacheOptions {
  /** Called on a store error (best-effort: the error is swallowed, the run continues). */
  onError?: (op: 'get' | 'set' | 'delete', err: unknown) => void;
}

/** Hit/miss counters for the Studio Cache view (see `stats()`). */
export interface CacheStats {
  /** Answers served without computing: a store hit, or joining a concurrent compute of the same key. */
  hits: number;
  /** Misses that ran compute() (plus `get` misses). */
  misses: number;
  /** hits / (hits+misses); 0 if there are no requests at all. */
  hitRate: number;
  /** Count of keys this instance KNOWS ABOUT (touched via get/set/getOrCompute) — since CacheStore
   *  doesn't offer enumeration, this is NOT the store's ACTUAL total size (see `invalidate()`). */
  size: number;
}

export interface Cache {
  get<T = unknown>(key: unknown): Promise<T | undefined>;
  set(key: unknown, value: unknown, opts?: CacheSetOptions): Promise<void>;
  /**
   * Returns the cached value if present; otherwise (or on a store error) runs compute(), stores it, and
   * returns it. Concurrent misses for the same key in this process share one compute() (single-flight):
   * the callers that joined get its value, or its rejection — a rejection is never stored, so the next
   * call after it settles computes again. Every caller gets its own copy, the one the store hands out.
   * A compute that started before `invalidate(key)` is not joined by a later call, and not stored.
   */
  getOrCompute<T>(key: unknown, compute: () => Promise<T> | T, opts?: CacheSetOptions): Promise<T>;
  /** In-process hit/miss counters + known key count (best-effort, NOT persistent —
   *  resets if the process restarts; the store's job is storing values, not counting). */
  stats(): CacheStats;
  /**
   * If key is given, deletes only that key from the store; if not (best-effort), deletes all keys
   * this instance KNOWS ABOUT — since CacheStore doesn't offer key enumeration (listKeys), this is
   * NOT THE SAME THING as clearing the entire store (only covers keys this process has seen through
   * this cache instance). Store errors are swallowed (same `onError` channel — 'delete').
   * Returns the number of keys deleted.
   */
  invalidate(key?: unknown): Promise<number>;
}

/**
 * The one entry-point check: a `Storage` is accepted for its `cache` port (refused with CapabilityError
 * if it has none, the same rule as @gnldev/memory and @gnldev/queue), a `CacheStore` is accepted if it
 * has get/set/delete, anything else is refused with what is missing and what to pass instead.
 */
function resolveStore(arg: CacheStore | Storage): CacheStore {
  // The one reading of "the storage, or its port" (@gnldev/durable portOf), shared with queue and events.
  return portOf(arg, 'cache', 'createCache');
}

/**
 * In-flight computes, per store object then per namespaced key. Module-level so that two cache
 * instances over the same store in one process (two modules, two `createCache` calls) still share a
 * flight; a WeakMap so a dropped store takes its entries with it.
 */
const FLIGHTS = new WeakMap<CacheStore, Map<string, Promise<unknown>>>();
function flightsFor(store: CacheStore): Map<string, Promise<unknown>> {
  let m = FLIGHTS.get(store);
  if (!m) { m = new Map(); FLIGHTS.set(store, m); }
  return m;
}

export function createCache(storeOrStorage: CacheStore | Storage, namespace = 'default', opts: CacheOptions = {}): Cache {
  refuseUnknownNames('createCache', opts, CREATE_CACHE_OPTS_NAMES);
  const store = resolveStore(storeOrStorage);
  const flights = flightsFor(store);
  const keyOf = (key: unknown) => `${namespace}:${argsHash(key)}`;
  let hits = 0;
  let misses = 0;
  const known = new Set<string>(); // full (namespaced) keys this instance has seen → basis for invalidate()

  async function safeGet<T>(k: string): Promise<{ v: T } | undefined> {
    try {
      return await store.get<{ v: T }>(k);
    } catch (err) {
      opts.onError?.('get', err); // cache down → miss
      return undefined;
    }
  }
  async function safeSet(k: string, value: unknown, set?: CacheSetOptions): Promise<void> {
    try {
      await store.set(k, value, set);
      known.add(k);
    } catch (err) {
      opts.onError?.('set', err); // cache down → no-op
    }
  }
  async function safeDelete(k: string): Promise<boolean> {
    try {
      await store.delete(k);
      known.delete(k);
      return true;
    } catch (err) {
      opts.onError?.('delete', err); // cache down → no-op
      return false;
    }
  }

  return {
    async get<T = unknown>(key: unknown): Promise<T | undefined> {
      const k = keyOf(key);
      const rec = await safeGet<T>(k);
      if (rec === undefined) { misses++; return undefined; }
      hits++;
      known.add(k); // was readable → exists in store, now known
      return rec.v;
    },
    async set(key: unknown, value: unknown, set?: CacheSetOptions): Promise<void> {
      refuseUnknownNames('cache.set', set, CACHE_SET_NAMES);
      await safeSet(keyOf(key), { v: value }, set);
    },
    async getOrCompute<T>(key: unknown, compute: () => Promise<T> | T, set?: CacheSetOptions): Promise<T> {
      refuseUnknownNames('cache.getOrCompute', set, CACHE_SET_NAMES);
      const k = keyOf(key);
      // Checked before AND after the store read: a flight started while this call awaited `get`
      // must be joined, not raced (the window is the whole round trip to the store).
      let flight = flights.get(k);
      if (flight === undefined) {
        const hit = await safeGet<T>(k);
        if (hit !== undefined) { hits++; known.add(k); return hit.v; }
        flight = flights.get(k);
      }
      if (flight !== undefined) {
        // Served without computing, read back from the store so it is the store's copy, as a hit is;
        // when the store cannot answer, a structuredClone of the flight's value (never the object itself).
        const v = (await flight) as T;
        hits++;
        const back = await safeGet<T>(k);
        if (back) return back.v;
        try { return structuredClone(v); } catch { return v; } // the store could not answer: a copy, as it would have
      }
      misses++;
      // Declared first: the compute compares the map's flight with its own promise after it settles.
      let own!: Promise<unknown>;
      own = (async () => {
        // Yield once before compute(): a compute that throws SYNCHRONOUSLY would otherwise reach the
        // `finally` below before `flights.set` runs, and the rejected flight would stay in the map.
        await undefined;
        try {
          const v = await compute();
          // Invalidated while computing → what was computed is from before; served to this caller only.
          if (flights.get(k) === own) { await safeSet(k, { v }, set); return ((await safeGet<unknown>(k)) ?? { v }).v; }
          return v;
        } finally {
          if (flights.get(k) === own) flights.delete(k); // settled either way → a rejection is shared by the joiners, never kept
        }
      })();
      flights.set(k, own);
      return own as Promise<T>;
    },
    stats(): CacheStats {
      const total = hits + misses;
      return { hits, misses, hitRate: total === 0 ? 0 : hits / total, size: known.size };
    },
    async invalidate(key?: unknown): Promise<number> {
      if (key !== undefined) {
        flights.delete(keyOf(key)); // a compute in flight started before this: not joined, not stored
        return (await safeDelete(keyOf(key))) ? 1 : 0;
      }
      let n = 0;
      for (const k of [...known]) {
        flights.delete(k);
        if (await safeDelete(k)) n++;
      }
      return n;
    },
  };
}
