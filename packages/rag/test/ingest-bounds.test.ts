// Three bounds an ingest and a retrieval keep:
//   - embedding runs at most `concurrency` calls at once, for every function that embeds a batch;
//   - no chunk is longer than the configured `size`, overlap included, for every strategy;
//   - a hit the RAG tool returns names the record and the document it came from.
import { describe, it, expect } from 'vitest';
import { STAFF, runIdentity, toolContextFor } from '@gnldev/durable';
import {
  InMemoryVectorStore, GraphRag, indexDocuments, ingestDocuments, chunkText, chunkDocuments, createRagTool,
  type ChunkOptions, type VectorStore, type VectorMatch,
} from '../src/index.js';

/** An embedder that records the highest number of calls in flight at once. */
function countingEmbed(opts: { failOn?: (n: number) => boolean } = {}) {
  const state = { inFlight: 0, max: 0, calls: 0, afterSettled: 0, settled: false };
  const embed = async (t: string): Promise<number[]> => {
    const n = ++state.calls;
    if (state.settled) state.afterSettled++;
    state.inFlight++;
    state.max = Math.max(state.max, state.inFlight);
    try {
      await new Promise((r) => setTimeout(r, 1));
      if (opts.failOn?.(n)) throw new Error(`embed failed on call ${n}`);
      return [t.length % 7, 1, 0];
    } finally {
      state.inFlight--;
    }
  };
  return { embed, state };
}

const many = (n: number, id = 'd') => Array.from({ length: n }, (_, i) => ({ id: `${id}${i}`, text: `text ${i}` }));
const longDoc = (id: string, chunks: number) => ({ id, text: Array.from({ length: chunks }, (_, i) => `para${i} `.repeat(10).trim()).join('\n\n') });

describe('embedding concurrency is bounded', () => {
  it('indexDocuments: 200 documents never run more than the default 8 embeds at once', async () => {
    const { embed, state } = countingEmbed();
    await indexDocuments(new InMemoryVectorStore(), embed, many(200));
    expect(state.calls).toBe(200);
    expect(state.max).toBeLessThanOrEqual(8);
  });

  it('ingestDocuments: one document of 100 chunks never runs more than the default 8 embeds at once', async () => {
    const { embed, state } = countingEmbed();
    const r = await ingestDocuments(new InMemoryVectorStore(), embed, [longDoc('big', 100)], { size: 80, overlap: 0 });
    expect(r.indexed).toBe(100);
    expect(state.max).toBeLessThanOrEqual(8);
  });

  it('ingestDocuments: the bound holds across documents, not per document', async () => {
    const { embed, state } = countingEmbed();
    await ingestDocuments(new InMemoryVectorStore(), embed, [longDoc('a', 10), longDoc('b', 10), longDoc('c', 10)], { size: 80, overlap: 0, concurrency: 3 });
    expect(state.calls).toBe(30);
    expect(state.max).toBeLessThanOrEqual(3);
    expect(state.max).toBe(3); // and the pool is used, not serialised
  });

  it('`concurrency` is honoured on indexDocuments, and a GraphRag store is fed the same way', async () => {
    const { embed, state } = countingEmbed();
    const graph = new GraphRag();
    await indexDocuments(graph, embed, many(40), { concurrency: 2 });
    expect(state.max).toBe(2);
    expect(graph.stats().nodes).toBe(40);
  });

  it('a small ingest is not slowed: 5 documents still embed all at once', async () => {
    const { embed, state } = countingEmbed();
    await indexDocuments(new InMemoryVectorStore(), embed, many(5));
    expect(state.max).toBe(5);
  });

  it('`concurrency: Infinity` is the old unbounded behaviour, on request', async () => {
    const { embed, state } = countingEmbed();
    await indexDocuments(new InMemoryVectorStore(), embed, many(30), { concurrency: Infinity });
    expect(state.max).toBe(30);
  });

  it('a concurrency that is not a positive integer is refused before anything is embedded', async () => {
    const { embed, state } = countingEmbed();
    for (const c of [0, -1, 1.5, Number.NaN]) {
      await expect(indexDocuments(new InMemoryVectorStore(), embed, many(3), { concurrency: c })).rejects.toThrow(/concurrency/);
      await expect(ingestDocuments(new InMemoryVectorStore(), embed, many(3), { concurrency: c })).rejects.toThrow(/concurrency/);
    }
    expect(state.calls).toBe(0);
  });

  it('an embed failure stops the batch: nothing is written, no new embed starts after the rejection', async () => {
    const { embed, state } = countingEmbed({ failOn: (n) => n === 5 });
    const store = new InMemoryVectorStore();
    await expect(indexDocuments(store, embed, many(100), { concurrency: 4 })).rejects.toThrow(/embed failed/);
    state.settled = true;
    await new Promise((r) => setTimeout(r, 20));
    expect(state.afterSettled).toBe(0);
    expect(state.inFlight).toBe(0); // the rejection waits for the calls already running
    expect(state.calls).toBeLessThan(20);
    expect(await store.query([1, 1, 0], 1000)).toHaveLength(0);
  });

  it('an embed failure on a re-ingest leaves the previous version whole (one version, never a mix)', async () => {
    const store = new InMemoryVectorStore();
    const v1 = { id: 'doc', text: Array.from({ length: 12 }, (_, i) => `old${i} `.repeat(10).trim()).join('\n\n') };
    await ingestDocuments(store, countingEmbed().embed, [v1], { size: 80, overlap: 0 });
    const before = (await store.query([1, 1, 0], 1000)).map((m) => m.text).sort();
    expect(before).toHaveLength(12);

    const { embed, state } = countingEmbed({ failOn: (n) => n === 7 });
    const v2 = { id: 'doc', text: Array.from({ length: 30 }, (_, i) => `new${i} `.repeat(10).trim()).join('\n\n') };
    await expect(ingestDocuments(store, embed, [v2], { size: 80, overlap: 0, concurrency: 3 })).rejects.toThrow(/embed failed/);
    expect(state.max).toBeLessThanOrEqual(3);
    const after = (await store.query([1, 1, 0], 1000)).map((m) => m.text).sort();
    expect(after).toEqual(before);
  });
});

describe('a chunk is never longer than `size`', () => {
  const strategies: NonNullable<ChunkOptions['strategy']>[] = ['recursive', 'markdown', 'character'];
  const inputs: Record<string, string> = {
    'one 10k-character token': 'x'.repeat(10_000),
    'long lines with no spaces': Array.from({ length: 5 }, (_, i) => String(i).repeat(700)).join('\n'),
    'paragraphs that each fill the size': Array.from({ length: 6 }, (_, i) => String.fromCharCode(97 + i).repeat(200)).join('\n\n'),
    'markdown sections': '# A\n' + 'alpha '.repeat(150) + '\n## B\n' + 'beta '.repeat(150) + '\n# C\n' + 'y'.repeat(900),
    'astral unicode': '😀'.repeat(700) + ' ' + 'ğüşıöç'.repeat(150),
    'sentences': 'This is a sentence. '.repeat(200),
  };
  const sizes: { size: number; overlap: number }[] = [
    { size: 200, overlap: 50 },
    { size: 220, overlap: 50 },
    { size: 100, overlap: 99 },
    { size: 64, overlap: 0 },
  ];
  for (const strategy of strategies) {
    for (const [name, text] of Object.entries(inputs)) {
      it(`${strategy}: ${name}`, () => {
        for (const { size, overlap } of sizes) {
          const chunks = chunkText(text, { size, overlap, strategy });
          expect(chunks.length).toBeGreaterThan(0);
          for (const c of chunks) expect(c.text.length, `size ${size} overlap ${overlap}`).toBeLessThanOrEqual(size);
          const docs = chunkDocuments([{ id: 'd', text }], { size, overlap, strategy });
          for (const d of docs) expect(d.text.length, `chunkDocuments size ${size} overlap ${overlap}`).toBeLessThanOrEqual(size);
        }
      });
    }
  }

  it('overlap is kept in full and counted inside the size', () => {
    const text = ['a', 'b', 'c'].map((ch) => ch.repeat(200)).join('\n\n');
    const chunks = chunkText(text, { size: 250, overlap: 50 });
    expect(chunks.map((c) => c.text.length)).toEqual([200, 250, 250]);
    expect(chunks[1]!.text.startsWith('a'.repeat(50))).toBe(true);
  });

  it('a hard cut never splits a surrogate pair', () => {
    for (const strategy of strategies) {
      for (const c of chunkText('😀'.repeat(500), { size: 51, overlap: 7, strategy })) {
        expect(c.text, strategy).not.toMatch(/^[\uDC00-\uDFFF]|[\uD800-\uDBFF]$/);
        expect(c.text.length).toBeLessThanOrEqual(51);
      }
    }
  });

  it('a markdown document of one section that only fits without its heading is still within size', () => {
    const text = '# Title\n' + 'z'.repeat(100);
    const docs = chunkDocuments([{ id: 'd', text }], { size: 100, overlap: 0, strategy: 'markdown' });
    for (const d of docs) expect(d.text.length).toBeLessThanOrEqual(100);
    expect(docs[0]!.metadata?.heading).toBe('Title');
  });

  it('a document that fits keeps its own text and id (unchanged)', () => {
    const docs = chunkDocuments([{ id: 'd', text: '# T\nshort' }], { size: 100, strategy: 'markdown' });
    expect(docs).toHaveLength(1);
    expect(docs[0]!.id).toBe('d');
    expect(docs[0]!.text).toBe('# T\nshort');
  });

  it('size smaller than overlap is refused', () => {
    expect(() => chunkText('abc', { size: 10, overlap: 10 })).toThrow(/overlap/);
    expect(() => chunkText('abc', { size: 10, overlap: 20 })).toThrow(/overlap/);
  });
});

describe('the RAG tool names the record and the document of each hit', () => {
  const ctx = { toolCallId: 'x', messages: [], gnl: toolContextFor(runIdentity(STAFF, 'test')) } as any;
  const embed = async (t: string) => [t.includes('cat') ? 1 : 0, t.includes('dog') ? 1 : 0, 1];

  for (const [name, make] of [['InMemoryVectorStore', () => new InMemoryVectorStore()], ['GraphRag', () => new GraphRag()]] as const) {
    it(`${name}: a chunked document's hits carry its chunk id and the document's id`, async () => {
      const store: VectorStore = make();
      await ingestDocuments(store, embed, [
        { id: 'pets/cat-guide', text: 'cat food.\n\n' + 'cat toys and more cat things. '.repeat(10) },
        { id: 'dogs', text: 'dog walking' },
      ], { size: 120, overlap: 0 });
      const res: any[] = await createRagTool({ store, embed, topK: 3 }).execute!({ query: 'cat' }, ctx) as any;
      expect(res.length).toBeGreaterThan(1);
      for (const h of res) {
        expect(typeof h.id).toBe('string');
        expect(h.documentId).toBe(h.text.includes('cat') ? 'pets/cat-guide' : 'dogs');
      }
      expect(res[0].text).toContain('cat'); // the old fields are still there
      expect(typeof res[0].score).toBe('number');
    });
  }

  it('a record indexed without chunking: its own id is the document id', async () => {
    const store = new InMemoryVectorStore();
    await indexDocuments(store, embed, [{ id: 'faq-7', text: 'cat questions', metadata: { lang: 'en' } }]);
    const [h]: any[] = await createRagTool({ store, embed, topK: 1 }).execute!({ query: 'cat' }, ctx) as any;
    expect(h).toMatchObject({ id: 'faq-7', documentId: 'faq-7', text: 'cat questions', metadata: { lang: 'en' } });
  });

  it('a custom store, and a reranker that reorders, keep the ids paired with their text', async () => {
    const matches: VectorMatch[] = [
      { id: 'r1', text: 'one', score: 0.9, metadata: { __gnlDoc: 'doc-one' } },
      { id: 'r2', text: 'two', score: 0.5 },
    ];
    const store: VectorStore = { upsert: async () => {}, query: async () => matches };
    const rerank = { rerank: async (_q: string, m: VectorMatch[]) => [...m].reverse() };
    const res: any[] = await createRagTool({ store, embed, rerank }).execute!({ query: 'q' }, ctx) as any;
    expect(res.map((h) => [h.id, h.documentId, h.text])).toEqual([['r2', 'r2', 'two'], ['r1', 'doc-one', 'one']]);
  });
});
