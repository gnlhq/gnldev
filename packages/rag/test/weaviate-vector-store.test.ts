// @gnldev/rag WeaviateVectorStore — what the vector kit (durable a-vector-store-passes-the-vector-kit.test.ts)
// does not reach: the transport (the API key goes in a header and never into a message), the option
// names, and, against a real server (GNL_WEAVIATE_URL), labels that differ only by whitespace, ties past
// Weaviate's own cut, reads and deletes past one page, and two stores making one collection at once.
import { describe, it, expect, afterAll } from 'vitest';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { WeaviateVectorStore } from '../src/weaviate-vector-store.js';

const WEAVIATE_URL = process.env.GNL_WEAVIATE_URL;

describe('WeaviateVectorStore — without a server', () => {
  it('refuses a misspelled option, an address that is not http(s) and a collection name Weaviate would change', () => {
    expect(() => new WeaviateVectorStore({ url: 'http://x', colection: 'A' } as never)).toThrow(/colection.*collection/);
    expect(() => new WeaviateVectorStore({ url: 'localhost:8080' })).toThrow(/http:\/\/ or https:\/\//);
    expect(() => new WeaviateVectorStore({ url: 'http://x', collection: 'lower' })).toThrow(/capital letter/);
    expect(() => new WeaviateVectorStore({ url: 'http://x', collection: 'A-b' })).toThrow(/capital letter/);
  });

  it('sends the API key as a bearer token, and no error message carries it', async () => {
    const seen: Array<string | undefined> = [];
    const server = http.createServer((req, res) => {
      seen.push(req.headers.authorization);
      res.writeHead(500, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: [{ message: 'boom' }] }));
    });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
    const { port } = server.address() as AddressInfo;
    const key = 'wv-secret-key-123456';
    const store = new WeaviateVectorStore({ url: `http://127.0.0.1:${port}`, apiKey: key });
    let message = '';
    try { await store.query([1, 0, 0], 3); } catch (e) { message = String((e as Error).message); }
    await new Promise<void>((r) => server.close(() => r()));
    expect(seen.length).toBeGreaterThan(0);
    expect(seen.every((h) => h === `Bearer ${key}`)).toBe(true);
    expect(message).toMatch(/Weaviate GET \/v1\/schema\/GnlVectors answered 500 "boom"/);
    expect(message).not.toContain(key);
  });

  it('an unreachable server is said, without the key', async () => {
    const store = new WeaviateVectorStore({ url: 'http://127.0.0.1:1', apiKey: 'wv-secret-key-654321' });
    const e = await store.query([1, 0], 1).catch((x: Error) => x);
    expect(String((e as Error).message)).toMatch(/Weaviate GET \/v1\/schema\/GnlVectors failed/);
    expect(String((e as Error).message)).not.toContain('wv-secret-key-654321');
  });

  // Weaviate rebuilds its GraphQL schema after a collection is made; until then it answers "Cannot query
  // field" for it (public CI, gnldev#25). A fake server answers that `refusals` times, then a hit.
  async function lagging(refusals: number, message = (c: string) => `Cannot query field "${c}" on type "GetObjectsObj".`) {
    let graphql = 0;
    const server = http.createServer((req, res) => {
      res.writeHead(200, { 'content-type': 'application/json' });
      if (req.method === 'GET' && req.url!.endsWith('/shards')) return res.end(JSON.stringify([{ name: 's1', status: 'READY' }]));
      if (req.method === 'GET') return res.end(JSON.stringify({ class: 'GnlVectors', description: '@gnldev/rag vectors, gnl_dim=2' }));
      graphql++;
      if (graphql <= refusals) return res.end(JSON.stringify({ errors: [{ message: message('GnlVectors') }] }));
      res.end(JSON.stringify({ data: { Get: { GnlVectors: [{ gnl_id: '"x"', text: 'x', gnl_vh: 'h', shared: false, _additional: { id: 'u', distance: 0 } }] } } }));
    });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
    const store = new WeaviateVectorStore({ url: `http://127.0.0.1:${(server.address() as AddressInfo).port}` });
    const out = await store.query([1, 0], 1).then((m) => m.map((x) => x.id), (e: Error) => e.message);
    await new Promise<void>((r) => server.close(() => r()));
    return { out, graphql };
  }

  it('a collection whose index does not exist yet is waited for: its shards are read until READY, then it is queried', async () => {
    // Public CI (gnldev#34): a second maker queried a collection that was in the schema before its index
    // existed — "tried to browse non-existing index". The store reads the shards' status first.
    const seen: string[] = [];
    let shardReads = 0;
    const server = http.createServer((req, res) => {
      seen.push(`${req.method} ${req.url}`);
      if (req.url!.endsWith('/shards')) {
        shardReads++;
        res.writeHead(shardReads === 1 ? 404 : 200, { 'content-type': 'application/json' });
        if (shardReads === 1) return res.end(JSON.stringify({ error: [{ message: 'non-existing index' }] }));
        return res.end(JSON.stringify([{ name: 's1', status: shardReads < 3 ? 'INDEXING' : 'READY' }]));
      }
      res.writeHead(200, { 'content-type': 'application/json' });
      if (req.method === 'GET') return res.end(JSON.stringify({ class: 'GnlVectors', description: '@gnldev/rag vectors, gnl_dim=2' }));
      res.end(JSON.stringify({ data: { Get: { GnlVectors: [] } } }));
    });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
    const store = new WeaviateVectorStore({ url: `http://127.0.0.1:${(server.address() as AddressInfo).port}` });
    expect(await store.query([1, 0], 1)).toEqual([]);
    expect(await store.query([1, 0], 1)).toEqual([]);
    await new Promise<void>((r) => server.close(() => r()));
    expect(shardReads).toBe(3); // until READY, and once per store
    expect(seen.findIndex((l) => l.startsWith('POST /v1/graphql'))).toBeGreaterThan(seen.lastIndexOf('GET /v1/schema/GnlVectors/shards'));
  });

  it('a collection GraphQL does not know yet is asked again: the answer comes once it does', async () => {
    expect(await lagging(3)).toEqual({ out: ['x'], graphql: 4 });
  });

  it('a collection GraphQL never comes to know fails, after a bounded wait, with Weaviate\'s answer', async () => {
    const { out, graphql } = await lagging(Infinity);
    expect(out).toMatch(/Weaviate POST \/v1\/graphql answered "Cannot query field/);
    expect(graphql).toBe(11);
  });

  it('any other GraphQL error fails at once, not asked again', async () => {
    const { out, graphql } = await lagging(Infinity, () => 'invalid where filter');
    expect(out).toMatch(/answered "invalid where filter"/);
    expect(graphql).toBe(1);
  });
});

describe.skipIf(!WEAVIATE_URL)('WeaviateVectorStore — a real server', () => {
  const made: string[] = [];
  const name = () => { const c = `Wtest_${process.pid}_${Date.now().toString(36)}_${made.length}`; made.push(c); return c; };
  afterAll(async () => { for (const c of made) await fetch(`${WEAVIATE_URL!.replace(/\/+$/, '')}/v1/schema/${c}`, { method: 'DELETE' }); });

  it('labels that differ only by whitespace are different labels: id, namespace, owner and a filter value', async () => {
    // Weaviate's exact-match tokenization trims whitespace: stored raw, each pair below would be one value.
    const store = new WeaviateVectorStore({ url: WEAVIATE_URL!, collection: name() });
    await store.upsert([
      { id: 'a', text: 'a', embedding: [1, 0], namespace: 'n', owner: 'u', metadata: { tag: 'x' } },
      { id: ' a', text: ' a', embedding: [1, 0], namespace: 'n', owner: 'u', metadata: { tag: ' x' } },
      { id: 'b', text: 'b', embedding: [1, 0], namespace: 'n ', owner: 'u ' },
    ]);
    expect((await store.query([1, 0], 10, { namespace: 'n' })).map((m) => m.id).sort()).toEqual([' a', 'a']);
    expect((await store.query([1, 0], 10, { namespace: 'n ' })).map((m) => m.id)).toEqual(['b']);
    expect((await store.query([1, 0], 10, { namespace: 'n', filter: { tag: 'x' } })).map((m) => m.id)).toEqual(['a']);
    expect((await store.query([1, 0], 10, { namespace: 'n ', visibleTo: 'u' })).map((m) => m.id)).toEqual([]);
    expect(await store.delete({ ids: ['a'], namespace: 'n' })).toBe(1);
    expect((await store.query([1, 0], 10, { namespace: 'n' })).map((m) => m.id)).toEqual([' a']);
  });

  it('ties past Weaviate\'s own cut are still cut by id: 300 equal scores, topK 5 is the five smallest ids', async () => {
    const store = new WeaviateVectorStore({ url: WEAVIATE_URL!, collection: name() });
    const ids = Array.from({ length: 300 }, (_, i) => `d${String(i).padStart(3, '0')}`);
    // Written in an order unlike the ids' (every 7th), so neither insertion order nor its reverse is id order.
    const shuffled = ids.map((_, i) => ids[(i * 7) % 300]!);
    for (let i = 0; i < shuffled.length; i += 100) {
      await store.upsert(shuffled.slice(i, i + 100).map((id) => ({ id, text: id, embedding: [1, 0.5, 0.25] })));
    }
    expect((await store.query([1, 0.5, 0.25], 5)).map((m) => m.id)).toEqual(['d000', 'd001', 'd002', 'd003', 'd004']);
  });

  it('a tie decided exactly stays inside the query\'s partition and filter: the five smallest ids of the namespace and tag asked', async () => {
    const store = new WeaviateVectorStore({ url: WEAVIATE_URL!, collection: name() });
    const ids = Array.from({ length: 200 }, (_, i) => `t${String(i).padStart(3, '0')}`);
    const shuffled = ids.map((_, i) => ids[(i * 7) % 200]!);
    // Root documents with smaller ids, the same vector: they tie too, and must not come back.
    await store.upsert(['a0', 'a1', 'a2'].map((id) => ({ id, text: id, embedding: [1, 0.5, 0.25], metadata: { tag: 'x' } })));
    await store.upsert(shuffled.map((id, i) => ({ id, text: id, embedding: [1, 0.5, 0.25], namespace: 'ns', metadata: { tag: i % 2 ? 'x' : 'y' } })));
    const tagged = shuffled.filter((_, i) => i % 2).sort().slice(0, 5);
    expect((await store.query([1, 0.5, 0.25], 5, { namespace: 'ns', filter: { tag: 'x' } })).map((m) => m.id)).toEqual(tagged);
  });

  it('a tie between different vectors (equal scores, not copies) is read whole too', async () => {
    const store = new WeaviateVectorStore({ url: WEAVIATE_URL!, collection: name() });
    // Against [1, 1], [1, 0] and [0, 1] score the same. 200 copies of one, and 5 of the other under the
    // smallest ids: the search's first answers are mostly the many, and the answer is the few.
    const many = Array.from({ length: 200 }, (_, i) => `v${String(i).padStart(3, '0')}`);
    await store.upsert(many.map((id) => ({ id, text: id, embedding: [1, 0] })));
    await store.upsert(['a0', 'a1', 'a2', 'a3', 'a4'].map((id) => ({ id, text: id, embedding: [0, 1] })));
    expect((await store.query([1, 1], 5)).map((m) => m.id)).toEqual(['a0', 'a1', 'a2', 'a3', 'a4']);
  });

  it('a write, a read and a delete past one page: 700 documents in one call, all deleted and counted', async () => {
    const store = new WeaviateVectorStore({ url: WEAVIATE_URL!, collection: name() });
    const docs = Array.from({ length: 700 }, (_, i) => ({ id: `p${i}`, text: `p${i}`, embedding: [1, i / 700], namespace: 'big' }));
    await store.upsert(docs);
    await store.upsert([{ id: 'keep', text: 'keep', embedding: [1, 0], namespace: 'other' }]);
    expect(await store.delete({ namespace: 'big' })).toBe(700);
    expect(await store.query([1, 0], 5, { namespace: 'big' })).toEqual([]);
    expect((await store.query([1, 0], 5, { namespace: 'other' })).map((m) => m.id)).toEqual(['keep']);
  });

  it('two stores making one collection at once both write, and the collection holds both documents', async () => {
    const collection = name();
    const a = new WeaviateVectorStore({ url: WEAVIATE_URL!, collection });
    const b = new WeaviateVectorStore({ url: WEAVIATE_URL!, collection });
    await Promise.all([a.upsert([{ id: 'x', text: 'x', embedding: [1, 0, 0] }]), b.upsert([{ id: 'y', text: 'y', embedding: [0, 1, 0] }])]);
    expect((await a.query([1, 1, 0], 5)).map((m) => m.id).sort()).toEqual(['x', 'y']);
  });

  it('a query before the collection exists answers nothing, and a delete removes nothing', async () => {
    const store = new WeaviateVectorStore({ url: WEAVIATE_URL!, collection: name() });
    expect(await store.query([1, 0, 0], 3)).toEqual([]);
    expect(await store.delete({ ids: ['x'] })).toBe(0);
  });

  it('a collection made with `dimension` refuses another length before anything is written, in a new store too', async () => {
    const collection = name();
    const store = new WeaviateVectorStore({ url: WEAVIATE_URL!, collection, dimension: 3 });
    await store.upsert([{ id: 'x', text: 'x', embedding: [1, 0, 0] }]);
    await expect(new WeaviateVectorStore({ url: WEAVIATE_URL!, collection }).upsert([{ id: 'y', text: 'y', embedding: [1, 0] }])).rejects.toThrow(/2-dimension vector/);
  });

  it('metadata of any shape comes back as it was written', async () => {
    const store = new WeaviateVectorStore({ url: WEAVIATE_URL!, collection: name() });
    const metadata = { tags: ['a', 'b'], nested: { n: 1, deep: [null, true] }, big: 2 ** 60, s: ' x\n"y"', 'odd key=': 1 };
    await store.upsert([{ id: 'm', text: 'm', embedding: [1, 0], metadata }]);
    expect((await store.query([1, 0], 1))[0]!.metadata).toEqual(metadata);
    expect((await store.query([1, 0], 1, { filter: { 'odd key=': 1 } })).map((m) => m.id)).toEqual(['m']);
    expect((await store.query([1, 0], 1, { filter: { s: ' x\n"y"' } })).map((m) => m.id)).toEqual(['m']);
  });
});
