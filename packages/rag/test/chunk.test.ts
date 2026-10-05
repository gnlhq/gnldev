// chunkText/chunkDocuments — the common document.chunk() shape.
import { describe, it, expect } from 'vitest';
import { chunkText, chunkDocuments, InMemoryVectorStore, indexDocuments } from '../src/index.js';

const PARA = (n: number, ch = 'a') => ch.repeat(n);

describe('chunkText — recursive (default)', () => {
  it('short text is one chunk; empty text is zero chunks', () => {
    expect(chunkText('hello world')).toEqual([{ text: 'hello world' }]);
    expect(chunkText('   \n ')).toEqual([]);
  });

  it('prefers paragraph boundaries: chunks are not cut mid-paragraph', () => {
    const text = `${PARA(400, 'a')}\n\n${PARA(400, 'b')}\n\n${PARA(400, 'c')}`;
    const chunks = chunkText(text, { size: 500, overlap: 0 });
    // 400+400 > 500 → each paragraph in its own chunk (greedy merge can't fit them).
    expect(chunks.map((c) => c.text)).toEqual([PARA(400, 'a'), PARA(400, 'b'), PARA(400, 'c')]);
  });

  it('a paragraph exceeding the size is split by the next separator (sentence); target size is not exceeded', () => {
    const sent = 'This is a sentence. '.repeat(60).trim(); // ~1000+ characters, single paragraph
    const chunks = chunkText(sent, { size: 300, overlap: 0 });
    expect(chunks.length).toBeGreaterThan(2);
    for (const c of chunks) expect(c.text.length).toBeLessThanOrEqual(300);
    expect(chunks.map((c) => c.text).join(' ').replace(/\s+/g, ' ')).toContain('This is a sentence');
  });

  it('overlap: each chunk (except the first) starts with the tail of the previous one', () => {
    const text = `${PARA(200, 'a')}\n\n${PARA(200, 'b')}\n\n${PARA(200, 'c')}`;
    // `size` counts the overlap: 200 + 50 fits in 250 (at 220 the overlap pushed chunks to 250).
    const chunks = chunkText(text, { size: 250, overlap: 50 });
    expect(chunks.length).toBe(3);
    expect(chunks[1]!.text.startsWith('a'.repeat(50))).toBe(true);
    expect(chunks[2]!.text.startsWith('b'.repeat(50))).toBe(true);
  });

  it('hard cut when there is no natural boundary (no infinite loop)', () => {
    const chunks = chunkText('x'.repeat(1000), { size: 300, overlap: 0 });
    expect(chunks.length).toBe(4);
    expect(chunks[0]!.text.length).toBe(300);
  });

  it('invalid options fail early: overlap >= size', () => {
    expect(() => chunkText('abc', { size: 100, overlap: 100 })).toThrow(/overlap < size/);
  });
});

describe('chunkText — markdown', () => {
  it('heading hierarchy is added as a breadcrumb; sections are chunked separately', () => {
    const md = `# Setup\nintro text\n## Docker\n${'d'.repeat(100)}\n## Local\nlocal text\n# FAQ\nquestion answer`;
    const chunks = chunkText(md, { strategy: 'markdown', size: 500, overlap: 0 });
    const headings = chunks.map((c) => c.heading);
    expect(headings).toEqual(['Setup', 'Setup > Docker', 'Setup > Local', 'FAQ']);
    expect(chunks[1]!.text).toContain('d'.repeat(100));
  });

  it('a large section is split recursively, all chunks carry the same breadcrumb', () => {
    const md = `## Section\n${'This is a sentence. '.repeat(80)}`;
    const chunks = chunkText(md, { strategy: 'markdown', size: 300, overlap: 0 });
    expect(chunks.length).toBeGreaterThan(1);
    for (const c of chunks) expect(c.heading).toBe('Section');
  });
});

describe('chunkText — character', () => {
  it('fixed window + overlap (stride = size - overlap)', () => {
    const chunks = chunkText('abcdefghij', { strategy: 'character', size: 4, overlap: 1 });
    expect(chunks.map((c) => c.text)).toEqual(['abcd', 'defg', 'ghij']);
  });
});

describe('chunkDocuments', () => {
  it('chunk ids are deterministic (`id#i`); metadata is inherited + the reserved __gnlDoc/__gnlChunk trail', () => {
    const docs = [
      { id: 'doc1', text: `${PARA(300)}\n\n${PARA(300, 'b')}`, metadata: { lang: 'tr' } },
      { id: 'doc2', text: 'short text' },
    ];
    const out = chunkDocuments(docs, { size: 350, overlap: 0 });
    expect(out.map((d) => d.id)).toEqual(['doc1#0', 'doc1#1', 'doc2']); // short doc not split, as-is
    expect(out[0]!.metadata).toEqual({ lang: 'tr', __gnlDoc: 'doc1', __gnlChunk: 0 });
    expect(out[1]!.metadata).toEqual({ lang: 'tr', __gnlDoc: 'doc1', __gnlChunk: 1 });
    expect(out[2]!.metadata).toEqual({ __gnlDoc: 'doc2', __gnlChunk: 0 }); // one chunk carries the trail too
  });

  it('end-to-end with indexDocuments: chunks land in the store and are queryable', async () => {
    const store = new InMemoryVectorStore();
    // Fake embed: direction based on 'b' density — chunks can be told apart.
    const embed = async (t: string) => {
      const b = (t.match(/b/g) ?? []).length / Math.max(1, t.length);
      return [1 - b, b];
    };
    const docs = chunkDocuments([{ id: 'kb', text: `${PARA(300, 'a')}\n\n${PARA(300, 'b')}` }], { size: 350, overlap: 0 });
    await indexDocuments(store, embed, docs);
    const hits = await store.query(await embed('bbbb'), 1);
    expect(hits[0]!.id).toBe('kb#1'); // b-dense chunk
    expect((hits[0]!.metadata as any).__gnlDoc).toBe('kb');
  });
});

describe('the overlap is fitted under size, not reserved', () => {
  const sentence = (i: number) => `Sentence number ${i} says something about the order and the payment.`;
  const para = (n: number, from: number) => Array.from({ length: n }, (_, k) => sentence(from + k)).join(' ');

  it('a paragraph a little under size is one chunk, not two (the chunk count does not double)', () => {
    const paras = Array.from({ length: 20 }, (_, i) => para(16, i * 16)); // ~1,100 characters each
    expect(paras.every((p) => p.length > 1000 && p.length < 1200)).toBe(true);
    const chunks = chunkText(paras.join('\n\n'));
    expect(chunks.length).toBeLessThanOrEqual(paras.length + 1);
    expect(Math.max(...chunks.map((c) => c.text.length))).toBeLessThanOrEqual(1200);
  });

  it('no chunk is longer than size and none repeats more than overlap, on prose with no paragraph breaks', () => {
    const text = para(400, 0);
    for (const [size, overlap] of [[1200, 120], [250, 50], [200, 50]] as const) {
      const chunks = chunkText(text, { size, overlap }).map((c) => c.text);
      expect(Math.max(...chunks.map((c) => c.length)), `${size}/${overlap}`).toBeLessThanOrEqual(size);
      for (let i = 1; i < chunks.length; i++) {
        let shared = 0;
        for (let k = Math.min(chunks[i - 1]!.length, chunks[i]!.length); k > 0; k--) if (chunks[i - 1]!.endsWith(chunks[i]!.slice(0, k))) { shared = k; break; }
        expect(shared, `${size}/${overlap} #${i}`).toBeLessThanOrEqual(overlap);
      }
    }
  });
});
