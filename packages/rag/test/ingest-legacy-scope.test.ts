// Invariant: `ingestDocuments`/`deleteDocuments` remove every record that is provably the named
// document's — its trail, or the exact shape 0.9.0 wrote for it — and nothing else, and a batch that
// cannot be written changes nothing.
//
// Measured before this file (review panel, b-ragids / c-rag R1 R2):
//  · a 0.9.0 ONE-chunk document whose id holds '#' or '%' was stored under its raw id; the delete
//    looked under the escaped id, so the old record survived every re-ingest and deleteDocuments;
//  · the 0.9.0 chunk scan stopped at the first position that did not match — `guide`'s chunk 1 had
//    been overwritten by a document called `guide#1`, so guide#2..#5 stayed after a re-ingest;
//  · the one-chunk delete was by id alone, so it took whatever record had that id: another document's
//    current record (`q#x` lives at `q%23x`), an observation vector, another document's 0.9.0 chunk;
//  · an id the store cannot hold (a NUL on Postgres) failed half-way, after earlier documents' old
//    chunks were already deleted.
import { describe, it, expect } from 'vitest';
import { InMemoryStorage, OM_VECTOR_SOURCE } from '@gnldev/durable';
import { SqliteStorage } from '../../durable/src/sqlite-storage.js';
import { InMemoryVectorStore, ingestDocuments, deleteDocuments, type VectorStore } from '../src/index.js';

const embed = async (_t: string) => [1, 1, 1];
const paras = (n: number, tag: string) => Array.from({ length: n }, (_, i) => `${tag} paragraph ${i} ` + 'x'.repeat(80)).join('\n\n');
const opts = { size: 120, overlap: 0 };
const v = [1, 1, 1];

const stores: [string, () => VectorStore][] = [
  ['rag InMemoryVectorStore', () => new InMemoryVectorStore()],
  ['durable InMemoryStorage.vectors', () => new InMemoryStorage().vectors as unknown as VectorStore],
  ['durable SqliteStorage.vectors', () => new SqliteStorage(':memory:').vectors as unknown as VectorStore],
];
const ids = async (s: VectorStore) => (await s.query(v, 1000)).map((h) => h.id).sort();

/** 0.9.0's `chunkDocuments` + `indexDocuments`: one chunk under the raw id, many as `<id>#<n>` with `{ source, chunk }`. */
async function write090(s: VectorStore, id: string, chunks: number, metadata: Record<string, unknown> = {}) {
  if (chunks === 1) return s.upsert([{ id, text: `OLD ${id}`, embedding: v, metadata }]);
  return s.upsert(Array.from({ length: chunks }, (_, n) => ({ id: `${id}#${n}`, text: `OLD ${id} ${n}`, embedding: v, metadata: { ...metadata, source: id, chunk: n } })));
}

describe.each(stores)('0.9.0 records and the delete scope (%s)', (_n, make) => {
  it("a 0.9.0 one-chunk document with '#' or '%' in its id is replaced by a re-ingest and removed by deleteDocuments", async () => {
    const s = make();
    for (const id of ['faq#2024', '100%-guide', 'solo#x', 'q%23x']) await write090(s, id, 1);
    await ingestDocuments(s, embed, [{ id: 'faq#2024', text: 'new' }, { id: '100%-guide', text: 'new' }], opts);
    expect(await ids(s)).toEqual(['100%25-guide', 'faq%232024', 'q%23x', 'solo#x'].sort());
    await deleteDocuments(s, ['solo#x', 'q%23x', 'faq#2024', '100%-guide']);
    expect(await ids(s)).toEqual([]);
  });

  it('the 0.9.0 chunk scan does not stop at an overwritten position', async () => {
    const s = make();
    await write090(s, 'guide', 6);
    await s.upsert([{ id: 'guide#1', text: 'the document called guide#1', embedding: v }]); // 0.9.0 overwrote chunk 1
    await ingestDocuments(s, embed, [{ id: 'guide', text: 'short guide' }], opts);
    expect(await ids(s)).toEqual(['guide', 'guide#1']);
    await deleteDocuments(s, ['guide#1']);
    expect(await ids(s)).toEqual(['guide']);
  });

  it("deleting a document leaves another document's CURRENT record that has the same raw id", async () => {
    const s = make();
    await ingestDocuments(s, embed, [{ id: 'q#x', text: 'the q#x document' }, { id: 'guide', text: paras(3, 'G') }], opts);
    expect(await ids(s)).toEqual(['guide#0', 'guide#1', 'guide#2', 'q%23x']);
    expect(await deleteDocuments(s, ['q%23x', 'guide#1'])).toBe(0);
    expect(await ids(s)).toEqual(['guide#0', 'guide#1', 'guide#2', 'q%23x']);
  });

  it("deleting a document leaves another document's 0.9.0 chunk that has the same raw id", async () => {
    const s = make();
    await write090(s, 'x', 3);
    expect(await deleteDocuments(s, ['x#1'])).toBe(0);
    expect(await ids(s)).toEqual(['x#0', 'x#1', 'x#2']);
  });

  it('deleting a document leaves an observation vector that has the same id', async () => {
    const s = make();
    await s.upsert([{ id: 'obs-3', text: 'what the person said', embedding: v, metadata: { source: OM_VECTOR_SOURCE, threadId: 't', level: 0, obsId: 'obs-3' } }]);
    expect(await deleteDocuments(s, ['obs-3'])).toBe(0);
    expect(await ids(s)).toEqual(['obs-3']);
  });

  it("a 0.9.0 one-chunk document keeps being removed when the user's own metadata has `source`", async () => {
    const s = make();
    await write090(s, 'single', 1, { source: 'confluence', team: 'a' });
    await write090(s, 'notes#7', 1, { source: 'wiki' });
    await deleteDocuments(s, ['single', 'notes#7']);
    expect(await ids(s)).toEqual([]);
  });
});

describe('a batch with an id the store cannot hold changes nothing', () => {
  it.each(stores)('a NUL in a document id is refused before the first delete (%s)', async (_n, make) => {
    const s = make();
    await ingestDocuments(s, embed, [{ id: 'kept', text: paras(3, 'OLD') }], opts);
    const before = await ids(s);
    await expect(ingestDocuments(s, embed, [{ id: 'kept', text: 'new' }, { id: 'bad\u0000id', text: 'x' }], opts)).rejects.toThrow(/NUL|well-formed/);
    expect(await ids(s)).toEqual(before);
  });
});
