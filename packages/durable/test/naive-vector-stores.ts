// Vector stores that each break ONE rule of the vector kit (vector-conformance.ts), built on a correct
// store (@gnldev/rag's InMemoryVectorStore) with one method overridden — and the scenario that must catch
// it. `a-vector-store-that-breaks-a-rule-is-caught.test.ts` holds the kit to catching each one THERE.
import { InMemoryVectorStore } from '../../rag/src/index.js';
import { VECTOR_ALL_PARTITIONS, vectorMetadataMatches, type VectorStore, type VectorItem } from '../src/index.js';

type Q = Parameters<VectorStore['query']>[2];
const ALL = { [VECTOR_ALL_PARTITIONS]: true } as never;

/** A correct store with `patch` laid over it. */
function over(patch: (inner: InMemoryVectorStore) => Partial<VectorStore>): () => VectorStore {
  return () => {
    const inner = new InMemoryVectorStore();
    const base: VectorStore = {
      rootOutsideOrganizations: true,
      upsert: (i) => inner.upsert(i as never),
      query: (e, k, o) => inner.query(e, k, o as never),
      delete: (w) => inner.delete(w as never),
    };
    return Object.assign(base, patch(inner));
  };
}

/** The filter rule a store gets wrong by containment: an array value matches when the stored array holds its items. */
const contains = (m: Record<string, unknown> = {}, f: Record<string, unknown> = {}) =>
  Object.entries(f).every(([k, v]) => JSON.stringify(m[k]) === JSON.stringify(v) || (Array.isArray(m[k]) && Array.isArray(v) && v.every((x) => (m[k] as unknown[]).includes(x))));

export const NAIVE_VECTOR_STORES: Record<string, { breaks: string; caughtBy: string; make: () => VectorStore }> = {
  CONTROL: { breaks: 'nothing', caughtBy: '', make: over(() => ({})) },
  NV1: { breaks: 'a query ignores the namespace', caughtBy: 'VS6', make: over((inner) => ({ query: (e, k, o) => inner.query(e, k, { ...(o as object), namespace: undefined, ...ALL } as never) })) },
  NV2: { breaks: 'a query ignores visibleTo', caughtBy: 'VS8', make: over((inner) => ({ query: (e, k, o) => inner.query(e, k, { ...(o as object), visibleTo: undefined } as never) })) },
  NV3: { breaks: 'a delete by owner reaches every partition', caughtBy: 'VS10', make: over((inner) => ({ delete: (w) => inner.delete((w.owner !== undefined && w.ids === undefined && w.filter === undefined ? { owner: w.owner, ...ALL } : w) as never) })) },
  NV4: { breaks: 'the filter is applied after ranking', caughtBy: 'VS15', make: over((inner) => ({ query: async (e, k, o?: Q) => (await inner.query(e, k, { ...(o as object), filter: undefined } as never)).filter((m) => vectorMetadataMatches(m.metadata, o?.filter)) })) },
  NV5: { breaks: 'an array filter matches by containment', caughtBy: 'VS12', make: over((inner) => ({ query: async (e, k, o?: Q) => (await inner.query(e, 1e6, { ...(o as object), filter: undefined } as never)).filter((m) => contains(m.metadata, o?.filter)).slice(0, k) })) },
  NV6: { breaks: 'an upsert lets another owner take an id', caughtBy: 'VS2', make: over((inner) => ({ upsert: async (items: VectorItem[]) => { await inner.delete({ ids: items.map((i) => i.id), ...ALL } as never); await inner.upsert(items as never); } })) },
  NV7: { breaks: 'a refused batch leaves its first half', caughtBy: 'VS3', make: over((inner) => ({ upsert: async (items: VectorItem[]) => { for (const it of items) await inner.upsert([it] as never); } })) },
  NV8: { breaks: 'a vector of another length is padded and accepted', caughtBy: 'VS18', make: over((inner) => {
    let dim: number | undefined;
    return { upsert: async (items: VectorItem[]) => { dim ??= items[0]?.embedding.length; await inner.upsert(items.map((it) => ({ ...it, embedding: Array.from({ length: dim! }, (_, i) => it.embedding[i] ?? 0) })) as never); } };
  }) },
  NV9: { breaks: 'equal scores come back in reverse id order', caughtBy: 'VS17', make: over((inner) => ({ query: async (e, k, o) => (await inner.query(e, 1e6, o as never)).sort((a, b) => b.score - a.score || (a.id < b.id ? 1 : a.id > b.id ? -1 : 0)).slice(0, k) })) },
  NV10: { breaks: 'a delete without a condition removes everything', caughtBy: 'VS9', make: over((inner) => ({ delete: async (w) => (w.ids?.length || w.owner !== undefined || (w.filter && Object.keys(w.filter).length) || w.namespace !== undefined) ? inner.delete(w as never) : inner.delete({ ...ALL, filter: { __never: undefined } } as never) })) },
  NV11: { breaks: 'an array filter silently matches nothing', caughtBy: 'VS12', make: over((inner) => ({ query: async (e, k, o?: Q) => { try { return await inner.query(e, k, o as never); } catch (err) { if ((err as Error).name === 'VectorFilterError') return []; throw err; } } })) },
  NV12: { breaks: 'a zero vector scores NaN', caughtBy: 'VS19', make: over((inner) => ({ query: async (e, k, o) => (await inner.query(e, k, o as never)).map((m) => (e.every((x) => x === 0) ? { ...m, score: NaN } : m)) })) },
  NV13: { breaks: 'two owners racing on a new id: the last writer takes it', caughtBy: 'VS5', make: over((inner) => {
    const owners = new Map<string, string | undefined>();
    return { upsert: async (items: VectorItem[]) => {
      for (const it of items) { if (owners.has(it.id) && owners.get(it.id) !== it.owner) throw Object.assign(new Error('owner'), { name: 'VectorOwnerConflictError' }); }
      await new Promise((r) => setTimeout(r, 1)); // checked, then written: the race window
      await inner.delete({ ids: items.map((i) => i.id), ...ALL } as never);
      for (const it of items) owners.set(it.id, it.owner);
      await inner.upsert(items as never);
    } };
  }) },
};
