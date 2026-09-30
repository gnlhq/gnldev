// Re-indexing an edited document leaves exactly its new chunks.
//
// `chunkDocuments` promised "re-indexing upserts to the same ids, no duplicate records", and
// `indexDocuments` upserts chunk by chunk. That holds only while the chunk count stays the same.
// Measured before `ingestDocuments`: a 5-chunk document edited down to 2 chunks left chunks #2-#4 of
// the OLD text retrievable, and a many-chunk document edited down to one chunk kept every `#i` beside
// the new bare id — which carried no `source`, so nothing could find it to remove it either. The unit
// of identity is the document; the write was per chunk.
import { describe, it, expect, afterAll } from 'vitest';
import { InMemoryStorage, withOrgStorage } from '@gnldev/durable';
import { SqliteStorage } from '../../durable/src/sqlite-storage.js';
import { InMemoryVectorStore, PostgresVectorStore, chunkDocuments, indexDocuments, ingestDocuments, deleteDocuments, type VectorStore } from '../src/index.js';

const embed = async (t: string) => [t.includes('OLD') ? 1 : 0, t.includes('NEW') ? 1 : 0, 1];
const paras = (n: number, tag: string) => Array.from({ length: n }, (_, i) => `${tag} paragraph ${i} ` + 'x'.repeat(80)).join('\n\n');
const opts = { size: 120, overlap: 0 };
const ALL = [1, 1, 1];

const stores: [string, () => VectorStore][] = [
  ['rag InMemoryVectorStore', () => new InMemoryVectorStore()],
  ['durable InMemoryStorage.vectors', () => new InMemoryStorage().vectors as unknown as VectorStore],
  ['durable SqliteStorage.vectors', () => new SqliteStorage(':memory:').vectors as unknown as VectorStore],
];
// Real pgvector, when the CI integration job provides it (GNL_PGVECTOR_URL) — one table per case.
const PGV = process.env.GNL_PGVECTOR_URL;
const opened: PostgresVectorStore[] = [];
afterAll(async () => { for (const s of opened) await s.close(); });
let table = 0;
if (PGV) stores.push(['PostgresVectorStore (real pgvector)', () => {
  const s = new PostgresVectorStore({ connectionString: PGV, table: `gnl_ingest_${process.pid}_${Date.now()}_${table++}` });
  opened.push(s);
  return s;
}]);

async function texts(store: VectorStore, q = ALL) {
  return (await store.query(q, 100)).map((h) => h.text);
}

for (const [name, make] of stores) {
  describe(`ingestDocuments replaces a document (${name})`, () => {
    it('shrink: 5 chunks -> 2 leaves no chunk of the old text', async () => {
      const store = make();
      await ingestDocuments(store, embed, [{ id: 'doc', text: paras(5, 'OLD') }], opts);
      await ingestDocuments(store, embed, [{ id: 'doc', text: paras(2, 'NEW') }], opts);
      const got = await texts(store);
      expect(got).toHaveLength(2);
      expect(got.every((t) => t.includes('NEW'))).toBe(true);
    });

    it('grow: 2 chunks -> 5 keeps exactly the 5 new ones', async () => {
      const store = make();
      await ingestDocuments(store, embed, [{ id: 'doc', text: paras(2, 'OLD') }], opts);
      await ingestDocuments(store, embed, [{ id: 'doc', text: paras(5, 'NEW') }], opts);
      const got = await texts(store);
      expect(got).toHaveLength(5);
      expect(got.every((t) => t.includes('NEW'))).toBe(true);
    });

    it('same size: 3 -> 3 replaces in place', async () => {
      const store = make();
      await ingestDocuments(store, embed, [{ id: 'doc', text: paras(3, 'OLD') }], opts);
      await ingestDocuments(store, embed, [{ id: 'doc', text: paras(3, 'NEW') }], opts);
      const got = await texts(store);
      expect(got).toHaveLength(3);
      expect(got.every((t) => t.includes('NEW'))).toBe(true);
    });

    it('many -> one: the old `#i` chunks go, the single chunk stays', async () => {
      const store = make();
      await ingestDocuments(store, embed, [{ id: 'doc', text: paras(5, 'OLD') }], opts);
      await ingestDocuments(store, embed, [{ id: 'doc', text: 'NEW tiny' }], opts);
      expect(await texts(store)).toEqual(['NEW tiny']);
    });

    it('one -> many: the old single chunk (bare id) goes', async () => {
      const store = make();
      await ingestDocuments(store, embed, [{ id: 'doc', text: 'OLD tiny' }], opts);
      await ingestDocuments(store, embed, [{ id: 'doc', text: paras(3, 'NEW') }], opts);
      const got = await texts(store);
      expect(got).toHaveLength(3);
      expect(got.every((t) => t.includes('NEW'))).toBe(true);
    });

    it('a document indexed before `source` was stamped (bare id, no metadata) is replaced too', async () => {
      const store = make();
      await indexDocuments(store, embed, [{ id: 'doc', text: 'OLD legacy' }]);
      await ingestDocuments(store, embed, [{ id: 'doc', text: paras(2, 'NEW') }], opts);
      expect((await texts(store)).every((t) => t.includes('NEW'))).toBe(true);
    });

    it('deleted entirely: deleteDocuments removes every chunk, and nothing else', async () => {
      const store = make();
      await ingestDocuments(store, embed, [{ id: 'doc', text: paras(4, 'OLD') }, { id: 'keep', text: 'NEW other' }], opts);
      expect(await deleteDocuments(store, ['doc'])).toBe(4);
      expect(await texts(store)).toEqual(['NEW other']);
    });

    it('another document is untouched by a re-ingest', async () => {
      const store = make();
      await ingestDocuments(store, embed, [{ id: 'a', text: paras(3, 'OLD') }, { id: 'b', text: paras(3, 'OLD') }], opts);
      await ingestDocuments(store, embed, [{ id: 'a', text: 'NEW a' }], opts);
      const got = await texts(store);
      expect(got.filter((t) => t.includes('OLD'))).toHaveLength(3);
      expect(got.filter((t) => t.includes('NEW'))).toEqual(['NEW a']);
    });
  });
}

describe('ingestDocuments stays inside a partition', () => {
  it('a namespace\'s re-ingest does not touch the same id in another namespace', async () => {
    const store = new InMemoryVectorStore();
    await ingestDocuments(store, embed, [{ id: 'doc', text: paras(3, 'OLD'), namespace: 'products' }], opts);
    // Ids are store-wide in this store, so the other namespace's copy has its own id; its chunks carry
    // the same `source` as the ones being replaced.
    await store.upsert([{ id: 'other', text: 'OLD kept', metadata: { source: 'doc' }, namespace: 'support', embedding: [1, 0, 1] }]);
    await ingestDocuments(store, embed, [{ id: 'doc', text: 'NEW one', namespace: 'products' }], opts);
    expect((await store.query(ALL, 100, { namespace: 'support' })).map((h) => h.text)).toEqual(['OLD kept']);
    expect((await store.query(ALL, 100, { namespace: 'products' })).map((h) => h.text)).toEqual(['NEW one']);
  });

  it('a root re-ingest does not touch an organization\'s document of the same id, nor the reverse', async () => {
    const storage = new InMemoryStorage();
    const root = storage.vectors as unknown as VectorStore;
    const acme = withOrgStorage(storage, 'acme').vectors as unknown as VectorStore;
    await ingestDocuments(acme, embed, [{ id: 'doc', text: paras(3, 'OLD') }], opts);
    await ingestDocuments(root, embed, [{ id: 'doc', text: paras(2, 'OLD') }], opts);
    await ingestDocuments(root, embed, [{ id: 'doc', text: 'NEW root' }], opts);
    expect(await texts(acme)).toHaveLength(3);
    await ingestDocuments(acme, embed, [{ id: 'doc', text: 'NEW acme' }], opts);
    expect(await texts(acme)).toEqual(['NEW acme']);
    expect((await root.query(ALL, 100, { namespace: undefined })).filter((h) => h.namespace === undefined).map((h) => h.text)).toEqual(['NEW root']);
  });
});

describe('a store that cannot delete', () => {
  it('is refused with the upsert-only way through named', async () => {
    const inner = new InMemoryVectorStore();
    const noDelete: VectorStore = { upsert: (i) => inner.upsert(i), query: (e, k, o) => inner.query(e, k, o) };
    await expect(ingestDocuments(noDelete, embed, [{ id: 'doc', text: 'x' }])).rejects.toThrow(/indexDocuments\(store, embed, chunkDocuments\(docs\)\)/);
  });

  it('and the way through works: upsert-only indexing of the same documents', async () => {
    const inner = new InMemoryVectorStore();
    const noDelete: VectorStore = { upsert: (i) => inner.upsert(i), query: (e, k, o) => inner.query(e, k, o) };
    await indexDocuments(noDelete, embed, chunkDocuments([{ id: 'doc', text: paras(2, 'NEW') }], opts));
    expect(await texts(noDelete)).toHaveLength(2);
  });
});

describe.skipIf(!PGV)('PostgresVectorStore delete before any write (real pgvector)', () => {
  it('does not create the table at dimension 1, so the first ingest on a fresh database works', async () => {
    const s = new PostgresVectorStore({ connectionString: PGV!, table: `gnl_ingest_fresh_${process.pid}_${Date.now()}` });
    opened.push(s);
    expect(await s.delete({ ids: ['nothing'] })).toBe(0);
    await ingestDocuments(s, embed, [{ id: 'doc', text: 'NEW first' }]);
    expect(await texts(s)).toEqual(['NEW first']);
  });

  it('a new instance over an existing table deletes before it has written', async () => {
    const t = `gnl_ingest_reopen_${process.pid}_${Date.now()}`;
    const first = new PostgresVectorStore({ connectionString: PGV!, table: t });
    opened.push(first);
    await ingestDocuments(first, embed, [{ id: 'doc', text: paras(3, 'OLD') }], opts);
    const second = new PostgresVectorStore({ connectionString: PGV!, table: t });
    opened.push(second);
    await ingestDocuments(second, embed, [{ id: 'doc', text: 'NEW after restart' }], opts);
    expect(await texts(second)).toEqual(['NEW after restart']);
  });
});
