// Invariant: when `ingestDocuments` resolves or rejects, each named document holds either all of its
// new chunks or all of its previous ones — never a mix of two versions, never nothing (unless the new
// text is empty).
//
// Measured before this file (delete, then upsert, at positional ids `<id>#<i>`):
//  · two concurrent ingests of one document (5 chunks vs 2) left chunks of BOTH versions in 10 of 10
//    runs on the in-memory, SQLite and graph stores (pg-mem kept the wrong version — measured outside
//    this package, which has no pg-mem dependency);
//  · an upsert that failed after the delete left the document with 0 chunks, and the error did not
//    say which document.
import { describe, it, expect } from 'vitest';
import { InMemoryStorage, withOrgStorage } from '@gnldev/durable';
import { SqliteStorage } from '../../durable/src/sqlite-storage.js';
import { InMemoryVectorStore, GraphRag, ingestDocuments, indexDocuments, chunkDocuments, type VectorStore, type DeleteWhere } from '../src/index.js';

const embed = async (t: string) => [1, (t.length % 7) + 1, 2];
const paras = (tag: string, n: number) => Array.from({ length: n }, (_, i) => `${tag} paragraph ${i} ` + 'lorem ipsum '.repeat(15)).join('\n\n');
const opts = { size: 200, overlap: 0 };

const stores: [string, () => Promise<VectorStore>][] = [
  ['rag InMemoryVectorStore', async () => new InMemoryVectorStore()],
  ['rag GraphRag', async () => new GraphRag({ threshold: 0.6 }) as unknown as VectorStore],
  ['durable InMemoryStorage', async () => new InMemoryStorage().vectors as unknown as VectorStore],
  ['durable SqliteStorage', async () => new SqliteStorage(':memory:').vectors as unknown as VectorStore],
];

/** The versions the document's stored chunks belong to, by the tag their text starts with. */
async function versions(s: VectorStore, id = 'h'): Promise<{ tags: string[]; count: number }> {
  const hits = (await s.query([1, 1, 2], 100_000)).filter((m) => m.metadata?.__gnlDoc === id);
  return { tags: [...new Set(hits.map((m) => m.text.slice(0, 4)))].sort(), count: hits.length };
}

describe.each(stores)('ingestDocuments keeps one version (%s)', (_name, make) => {
  it('two concurrent ingests of one document leave exactly one of the two versions, whole', async () => {
    for (let run = 0; run < 5; run++) {
      const s = await make();
      await Promise.all([
        ingestDocuments(s, embed, [{ id: 'h', text: paras('OLD1', 5) }], opts),
        ingestDocuments(s, embed, [{ id: 'h', text: paras('NEW2', 2) }], opts),
      ]);
      const v = await versions(s);
      expect(v.tags).toHaveLength(1);
      expect(v.count).toBe(v.tags[0] === 'OLD1' ? 5 : 2);
    }
  });

  it('a write that fails leaves the previous version whole, and the error names the document', async () => {
    const s = await make();
    await ingestDocuments(s, embed, [{ id: 'h', text: paras('OLD1', 3) }, { id: 'faq', text: paras('FAQ1', 2) }], opts);
    const upsert = s.upsert.bind(s);
    let n = 0;
    s.upsert = async (items) => { if (++n === 2) throw new Error('ECONNRESET (simulated)'); return upsert(items); };
    const err = await ingestDocuments(s, embed, [{ id: 'faq', text: paras('FAQ2', 2) }, { id: 'h', text: paras('NEW2', 4) }], opts).catch((e) => e);
    expect(err.message).toMatch(/could not write document 'h'.*already replaced in this call: 'faq'/);
    expect(err.documentId).toBe('h');
    expect(err.replaced).toEqual(['faq']);
    expect(await versions(s)).toEqual({ tags: ['OLD1'], count: 3 });
    expect(await versions(s, 'faq')).toEqual({ tags: ['FAQ2'], count: 2 });
  });

  it('a cleanup that fails before removing anything undoes the write: the previous version stays whole', async () => {
    const s = await make();
    await ingestDocuments(s, embed, [{ id: 'h', text: paras('OLD1', 3) }], opts);
    const query = s.query.bind(s);
    s.query = async () => { throw new Error('timeout (simulated)'); };
    await expect(ingestDocuments(s, embed, [{ id: 'h', text: paras('NEW2', 2) }], opts)).rejects.toThrow(/could not remove the previous version of document 'h'/);
    s.query = query;
    expect(await versions(s)).toEqual({ tags: ['OLD1'], count: 3 });
  });

  it('a version written by indexDocuments (no generation) is replaced too', async () => {
    const s = await make();
    await indexDocuments(s, embed, chunkDocuments([{ id: 'h', text: paras('OLD1', 4) }], opts));
    await ingestDocuments(s, embed, [{ id: 'h', text: paras('NEW2', 2) }], opts);
    expect(await versions(s)).toEqual({ tags: ['NEW2'], count: 2 });
  });

  it("a re-ingest may change the document's owner (the new version is written beside the old one)", async () => {
    const s = await make();
    await ingestDocuments(s, embed, [{ id: 'h', text: 'OLD1 one chunk', owner: 'alice' }], opts);
    await ingestDocuments(s, embed, [{ id: 'h', text: 'NEW2 one chunk', owner: 'bob' }], opts);
    const hits = (await s.query([1, 1, 2], 100)).filter((m) => m.metadata?.__gnlDoc === 'h');
    expect(hits.map((m) => [m.text.slice(0, 4), m.owner])).toEqual([['NEW2', 'bob']]);
  });
});

describe('the cleanup reads only conditions every store reads the same way', () => {
  // A store written to the 0.9.0 contract serialises `filter` to JSON, so a key whose value is
  // `undefined` disappears and the delete widens. The generation cleanup must not depend on that
  // reading: with it, the document's NEW chunks matched `{ __gnlDoc: 'h' }` and went too.
  class JsonFilterStore extends InMemoryVectorStore {
    override async delete(where: DeleteWhere): Promise<number> {
      return super.delete(where.filter ? { ...where, filter: JSON.parse(JSON.stringify(where.filter)) } : where);
    }
  }
  it('a JSON-filter store keeps the new version whole', async () => {
    const s = new JsonFilterStore();
    await ingestDocuments(s, embed, [{ id: 'h', text: paras('OLD1', 4) }], opts);
    await ingestDocuments(s, embed, [{ id: 'h', text: paras('NEW2', 2) }], opts);
    expect(await versions(s)).toEqual({ tags: ['NEW2'], count: 2 });
  });
});

describe('an organization view: the document is one version whatever namespace it names', () => {
  it('two view ingests naming different namespaces replace each other (the view forces its own)', async () => {
    const storage = new InMemoryStorage();
    const acme = withOrgStorage(storage, 'acme', { allowUnregistered: true }).vectors as unknown as VectorStore;
    await ingestDocuments(acme, embed, [{ id: 'h', text: paras('OLD1', 4), namespace: 'manuals' }], opts);
    await ingestDocuments(acme, embed, [{ id: 'h', text: 'NEW2 one chunk', namespace: 'policies' }], opts);
    expect(await versions(acme)).toEqual({ tags: ['NEW2'], count: 1 });
  });
});
