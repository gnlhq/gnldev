// Invariant: after `ingestDocuments`/`deleteDocuments`, each named document's stored chunks are
// exactly its current ones, and NO OTHER record changes — not another document, not a record the
// user labelled with their own metadata, not another organization's document.
//
// Before this, a document's identity lived in the user's own `metadata.source`: `deleteDocuments(['handbook'])`
// deleted every record the user had labelled `source: 'handbook'`; the chunk id `guide#1` was also
// what a document literally named `guide#1` was stored under, so ingesting `guide` overwrote it; and
// a root ingest on a vector store that does not declare `deleteOutsideOrganizations` deleted the
// same-id document inside every organization (review panel: acme 1 → 0).
//
// Now the trail is reserved metadata (`__gnlDoc`, `__gnlChunk`) the user's metadata never shares,
// chunk ids escape `#`/`%` in the document id so no document id is another's chunk id, and a root
// write that cannot stay outside the organizations is refused before anything is deleted.
import { describe, it, expect } from 'vitest';
import { InMemoryStorage, withOrgStorage } from '@gnldev/durable';
import { SqliteStorage } from '../../durable/src/sqlite-storage.js';
import { InMemoryVectorStore, chunkDocuments, indexDocuments, ingestDocuments, deleteDocuments, type VectorStore } from '../src/index.js';

const embed = async (_t: string) => [1, 1, 1];
const paras = (n: number, tag: string) => Array.from({ length: n }, (_, i) => `${tag} paragraph ${i} ` + 'x'.repeat(80)).join('\n\n');
const opts = { size: 120, overlap: 0 };

const stores: [string, () => VectorStore][] = [
  ['rag InMemoryVectorStore', () => new InMemoryVectorStore()],
  ['durable InMemoryStorage.vectors', () => new InMemoryStorage().vectors as unknown as VectorStore],
  ['durable SqliteStorage.vectors', () => new SqliteStorage(':memory:').vectors as unknown as VectorStore],
];
const all = async (s: VectorStore) => (await s.query([1, 1, 1], 100)).map((h) => ({ id: h.id, text: h.text, metadata: h.metadata ?? {} })).sort((a, b) => a.id.localeCompare(b.id));

describe.each(stores)('a document is identified by the framework, not by the user\'s metadata (%s)', (_n, make) => {
  it("a document named like another's chunk ('guide#1') survives that document's ingest, and the reverse", async () => {
    const s = make();
    await ingestDocuments(s, embed, [{ id: 'guide#1', text: 'SECTION-DOC short' }], opts);
    await ingestDocuments(s, embed, [{ id: 'guide', text: paras(3, 'GUIDE') }], opts);
    expect((await all(s)).some((r) => r.text.includes('SECTION-DOC'))).toBe(true);
    await ingestDocuments(s, embed, [{ id: 'guide#1', text: 'SECTION-DOC edited' }], opts);
    expect((await all(s)).filter((r) => r.text.includes('GUIDE'))).toHaveLength(3);
    expect((await all(s)).filter((r) => r.text.includes('SECTION-DOC')).map((r) => r.text)).toEqual(['SECTION-DOC edited']);
  });

  it("deleteDocuments(['handbook']) removes the document 'handbook' and nothing the user labelled source:'handbook'", async () => {
    const s = make();
    await indexDocuments(s, embed, [
      { id: 'p1', text: 'policy one', metadata: { source: 'handbook' } },
      { id: 'p2', text: 'policy two', metadata: { source: 'handbook' } },
    ]);
    await ingestDocuments(s, embed, [{ id: 'handbook', text: paras(3, 'COVER') }], opts);
    expect(await deleteDocuments(s, ['handbook'])).toBe(3);
    expect((await all(s)).map((r) => r.id)).toEqual(['p1', 'p2']);
  });

  it("re-ingesting 'handbook' does not delete what the user labelled source:'handbook' either", async () => {
    const s = make();
    await indexDocuments(s, embed, [{ id: 'p1', text: 'policy one', metadata: { source: 'handbook' } }]);
    await ingestDocuments(s, embed, [{ id: 'handbook', text: 'cover v1' }], opts);
    await ingestDocuments(s, embed, [{ id: 'handbook', text: paras(2, 'COVER') }], opts);
    expect((await all(s)).filter((r) => r.id === 'p1')).toHaveLength(1);
  });

  it("the user's own `source` and `chunk` survive ingest, on one chunk and on many", async () => {
    const s = make();
    await ingestDocuments(s, embed, [
      { id: 'one', text: 'tiny', metadata: { source: 'confluence', chunk: 'mine' } },
      { id: 'many', text: paras(2, 'M'), metadata: { source: 'confluence', chunk: 'mine' } },
    ], opts);
    for (const r of await all(s)) {
      expect(r.metadata.source).toBe('confluence');
      expect(r.metadata.chunk).toBe('mine');
    }
  });

  it("'%' and '#' in document ids never make two documents share a chunk id", async () => {
    const s = make();
    const ids = ['a#0', 'a%230', 'a', 'a%', 'a#', 'a%23'];
    await ingestDocuments(s, embed, ids.map((id) => ({ id, text: paras(2, `DOC<${id}>`) })), opts);
    await ingestDocuments(s, embed, ids.map((id) => ({ id, text: paras(2, `DOC<${id}>`) })), opts);
    for (const id of ids) expect((await all(s)).filter((r) => r.text.includes(`DOC<${id}>`))).toHaveLength(2);
    await deleteDocuments(s, ['a#0']);
    expect(await all(s)).toHaveLength(10);
  });

  it("a document may be called 'observational-memory': observation vectors carry no trail, so none is taken", async () => {
    const s = make();
    await s.upsert([{ id: 'om:t:0:0', text: 'an observation', metadata: { source: 'observational-memory', threadId: 't' }, embedding: [1, 1, 1] }]);
    await ingestDocuments(s, embed, [{ id: 'observational-memory', text: 'a doc' }]);
    await deleteDocuments(s, ['observational-memory']);
    expect((await all(s)).map((r) => r.text)).toEqual(['an observation']);
  });
});

describe('vectors written by 0.9.0 (trail in `source`/`chunk`, one-chunk documents under their bare id)', () => {
  /** What 0.9.0's `indexDocuments(store, embed, chunkDocuments(docs))` stored. */
  const v090 = (id: string, n: number, text: string) => n === 1
    ? [{ id, text: `${text} 0`, embedding: [1, 1, 1] }]
    : Array.from({ length: n }, (_, i) => ({ id: `${id}#${i}`, text: `${text} ${i}`, metadata: { source: id, chunk: i }, embedding: [1, 1, 1] }));

  it.each(stores)('re-ingest removes a 0.9.0 multi-chunk document entirely, even when it shrinks (%s)', async (_n, make) => {
    const s = make();
    await s.upsert(v090('doc', 5, 'OLD'));
    await ingestDocuments(s, embed, [{ id: 'doc', text: paras(2, 'NEW') }], opts);
    const got = await all(s);
    expect(got).toHaveLength(2);
    expect(got.every((r) => r.text.includes('NEW'))).toBe(true);
  });

  it.each(stores)('a 0.9.0 one-chunk document (bare id) is replaced when it grows (%s)', async (_n, make) => {
    const s = make();
    await s.upsert(v090('doc', 1, 'OLD'));
    await ingestDocuments(s, embed, [{ id: 'doc', text: paras(3, 'NEW') }], opts);
    expect((await all(s)).every((r) => r.text.includes('NEW'))).toBe(true);
  });

  it.each(stores)('deleteDocuments removes 0.9.0 chunks too, and a user record merely labelled source:doc stays (%s)', async (_n, make) => {
    const s = make();
    await s.upsert([...v090('doc', 3, 'OLD'), { id: 'mine', text: 'mine', metadata: { source: 'doc', chunk: 0 }, embedding: [1, 1, 1] }]);
    expect(await deleteDocuments(s, ['doc'])).toBe(3);
    expect((await all(s)).map((r) => r.id)).toEqual(['mine']);
  });
});

describe('a root write that cannot stay outside the organizations is refused', () => {
  /** The same store, through an adapter that does not declare `deleteOutsideOrganizations`. */
  const undeclared = (raw: VectorStore): VectorStore => ({ upsert: (i) => raw.upsert(i), query: (...a) => raw.query(...a), delete: (w) => raw.delete!(w) });

  it("root ingest on such a store deletes nothing of acme's and says how through", async () => {
    const storage = new InMemoryStorage();
    const raw = storage.vectors as unknown as VectorStore;
    const acme = withOrgStorage(storage, 'acme', { allowUnregistered: true }).vectors as unknown as VectorStore;
    await ingestDocuments(acme, embed, [{ id: 'handbook', text: 'ACME CONFIDENTIAL handbook' }]);
    await expect(ingestDocuments(undeclared(raw), embed, [{ id: 'handbook', text: 'root public handbook' }])).rejects.toThrow(/deleteOutsideOrganizations[\s\S]*give the documents a `namespace`/);
    await expect(deleteDocuments(undeclared(raw), ['handbook'])).rejects.toThrow(/deleteOutsideOrganizations[\s\S]*give the documents a `namespace`/);
    expect((await all(raw)).filter((r) => r.text.includes('ACME'))).toHaveLength(1);
    expect((await all(raw)).filter((r) => r.text.includes('root'))).toHaveLength(0); // refused before writing
  });

  it('the same store is fine with an explicit namespace, and through an organization view', async () => {
    const storage = new InMemoryStorage();
    const raw = storage.vectors as unknown as VectorStore;
    await ingestDocuments(undeclared(raw), embed, [{ id: 'handbook', text: 'kb handbook', namespace: 'kb' }]);
    const acmeView = withOrgStorage(storage, 'acme', { allowUnregistered: true }).vectors as unknown as VectorStore;
    await ingestDocuments(acmeView, embed, [{ id: 'handbook', text: 'ACME handbook' }]);
    expect(await deleteDocuments(undeclared(raw), ['handbook'], { namespace: 'kb' })).toBe(1);
    expect((await all(raw)).map((r) => r.text)).toEqual(['ACME handbook']);
  });

  it('a declaring store keeps working at the root, and leaves acme alone', async () => {
    const storage = new InMemoryStorage();
    const raw = storage.vectors as unknown as VectorStore;
    const acme = withOrgStorage(storage, 'acme', { allowUnregistered: true }).vectors as unknown as VectorStore;
    await ingestDocuments(acme, embed, [{ id: 'handbook', text: 'ACME CONFIDENTIAL handbook' }]);
    await ingestDocuments(raw, embed, [{ id: 'handbook', text: 'root public handbook' }]);
    await deleteDocuments(raw, ['handbook']);
    expect((await all(raw)).map((r) => r.text)).toEqual(['ACME CONFIDENTIAL handbook']);
  });
});

describe('chunkDocuments', () => {
  it('stamps the reserved trail, and leaves the metadata the user gave as it was', () => {
    const [only] = chunkDocuments([{ id: 'doc', text: 'short', metadata: { lang: 'en', source: 'wiki' } }]);
    expect(only).toEqual({ id: 'doc', text: 'short', metadata: { lang: 'en', source: 'wiki', __gnlDoc: 'doc', __gnlChunk: 0 } });
  });
});
