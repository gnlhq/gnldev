# @gnldev/cache

**Cross-run content-hash cache** on top of a storage's **`cache` port** (`CacheStore`), not the run
journal. The key is run-independent (`<namespace>:<argsHash(key)>`) → a result computed in one run is
**reused in other runs**. (Within-run reuse is already journal replay; this closes the across-run gap.)

**Best-effort by design.** A cache is an accelerator, so a store error never fails the run: a failed
`get` counts as a miss, a failed `set` is a no-op, and `getOrCompute` computes anyway. Pass
`onError` if you want to see those. (`runs`/`memory` stay strict — this leniency is the cache's alone.)

> Install: `pnpm add @gnldev/cache` — or use it from a [repo clone](https://github.com/gnlhq/gnldev): `pnpm install && pnpm -r build`.

```bash
npm i @gnldev/cache   # peer: @gnldev/durable
```

```ts
import { createCache } from '@gnldev/cache';
import { SqliteStorage } from '@gnldev/durable/sqlite';

const storage = new SqliteStorage('runs.db');
const cache = createCache(storage.cache, 'embeddings');   // the CACHE port, not storage.runs

// Same input → embed computed once; later runs read it back from the cache store.
const vec = await cache.getOrCompute({ text: 'hello' }, () => embed('hello'));
```

## API
- `createCache(store: CacheStore | Storage, namespace = 'default', opts?: { onError?(op, err) }) → Cache`
  — pass the storage (its `cache` port is used) or `storage.cache`. Anything that cannot hold a value is
  refused here, not at the first call: a run journal (`storage.runs`) or an object without
  `get`/`set`/`delete` throws a `TypeError` naming what is missing, and a storage with no cache port
  throws `CapabilityError`. Best-effort covers a store that is *down*, not one that is *wrong*.
- `cache.get(key)` · `cache.set(key, value, opts?)` · `cache.getOrCompute(key, compute, opts?)`
  — the trailing `opts` is `{ ttlMs? }`, honoured by stores whose capability is `'ttl'`
  (SQLite/Postgres; `InMemory` is `'full'`).
- `cache.stats() → { hits, misses, hitRate, size }` — **in-process** counters, not persistent: they
  reset when the process does, and `size` is only the keys *this instance* has touched, because
  `CacheStore` offers no enumeration.
- `cache.invalidate(key?) → number` — with a key, deletes that one; without, deletes every key this
  instance knows about. For the same reason as `size`, that is **not** "clear the whole store".

Studio's Cache view is a wrapper over these last two (`packages/studio/src/server.ts`, `StudioCache`).

`key` can be any value (hashed stably with `argsHash`). Values are wrapped as `{ v }` before storing,
which is how a cached `undefined` stays distinguishable from a miss.

## Concurrent misses (single-flight)
Callers that miss the same key at the same time share **one** `compute()`: 10 concurrent
`getOrCompute('k', embed)` calls run `embed` once and all receive its value. If that compute rejects,
every caller that joined it gets the same rejection, nothing is stored, and the next call computes again.
`stats().misses` counts computes; a caller that joined one counts as a hit. Every caller gets its own
copy — the one the store hands out, as on a hit — so what one caller does to its value no other sees. An
`invalidate(key)` drops the compute in flight: a call after it computes again, and the value the earlier
compute returns is not stored.

The guarantee is **per process** (per store object, across every `createCache` over it). The `CacheStore`
port has no atomic claim, so two processes or workers sharing one database each compute once, then read
each other's value afterwards. A slow compute is not cut short by `ttlMs`; the TTL starts when the value
is written.

## How it works
The content-hash key is independent of the run id, so the cache outlives a single run's lifetime. It's
ideal for expensive, pure computations (embed, retrieval, price calculation).

## License

Apache-2.0 — see [LICENSE](./LICENSE).
