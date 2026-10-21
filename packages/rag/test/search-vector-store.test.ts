// @gnldev/rag ElasticsearchVectorStore and OpenSearchVectorStore — what the vector kit (durable
// a-vector-store-passes-the-vector-kit.test.ts) does not reach: the transport (credentials go in a header
// and never into a message), the option names, and, against real servers (GNL_ELASTICSEARCH_URL,
// GNL_OPENSEARCH_URL), labels that differ by case or whitespace, a metadata value too long for a term,
// zero vectors, ties past the index's own cut, reads and deletes past one page, two stores making one
// index at once, and an index this store did not make.
import { describe, it, expect, afterAll } from 'vitest';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { ElasticsearchVectorStore, OpenSearchVectorStore } from '../src/search-vector-store.js';

type Make = (url: string, index?: string) => ElasticsearchVectorStore | OpenSearchVectorStore;
const SERVERS: Array<[string, string | undefined, Make]> = [
  ['Elasticsearch', process.env.GNL_ELASTICSEARCH_URL, (url, index) => new ElasticsearchVectorStore({ url, ...(index ? { index } : {}) })],
  ['OpenSearch', process.env.GNL_OPENSEARCH_URL, (url, index) => new OpenSearchVectorStore({ url, ...(index ? { index } : {}) })],
];

describe('ElasticsearchVectorStore / OpenSearchVectorStore — without a server', () => {
  it('refuses a misspelled option, an address that is not http(s) and an index name the server would refuse', () => {
    expect(() => new ElasticsearchVectorStore({ url: 'http://x', indx: 'a' } as never)).toThrow(/indx.*index/);
    expect(() => new OpenSearchVectorStore({ url: 'http://x', apiKey: 'k' } as never)).toThrow(/apiKey/);
    expect(() => new ElasticsearchVectorStore({ url: 'localhost:9200' })).toThrow(/http:\/\/ or https:\/\//);
    expect(() => new OpenSearchVectorStore({ url: 'http://x', index: 'Upper' })).toThrow(/lowercase/);
    expect(() => new ElasticsearchVectorStore({ url: 'http://x', index: '_x' })).toThrow(/lowercase/);
  });

  it('sends the credentials in the Authorization header, and no error message carries them', async () => {
    const seen: Array<string | undefined> = [];
    const server = http.createServer((req, res) => {
      seen.push(req.headers.authorization);
      res.writeHead(500, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: { root_cause: [{ reason: 'boom' }] } }));
    });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
    const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    const es = await new ElasticsearchVectorStore({ url, apiKey: 'es-secret-key-1111' }).query([1, 0], 1).catch((e: Error) => e.message);
    const os = await new OpenSearchVectorStore({ url, auth: { username: 'admin', password: 'os-secret-pass-2222' } }).query([1, 0], 1).catch((e: Error) => e.message);
    await new Promise<void>((r) => server.close(() => r()));
    expect(seen).toEqual(['ApiKey es-secret-key-1111', `Basic ${Buffer.from('admin:os-secret-pass-2222').toString('base64')}`]);
    expect(es).toMatch(/Elasticsearch GET \/gnl_vectors\/_mapping answered 500 "boom"/);
    expect(os).toMatch(/OpenSearch GET \/gnl_vectors\/_mapping answered 500 "boom"/);
    for (const m of [es, os]) for (const secret of ['es-secret-key-1111', 'os-secret-pass-2222', Buffer.from('admin:os-secret-pass-2222').toString('base64')]) expect(m).not.toContain(secret);
  });
});

for (const [name, url, make] of SERVERS) {
  describe.skipIf(!url)(`${name}VectorStore — a real server`, () => {
    const made: string[] = [];
    const index = () => { const i = `stest_${process.pid}_${Date.now().toString(36)}_${made.length}`; made.push(i); return i; };
    const store = (i = index()) => make(url!, i);
    afterAll(async () => { for (const i of made) await fetch(`${url!.replace(/\/+$/, '')}/${i}`, { method: 'DELETE' }); });

    it('labels that differ only by case or whitespace are different labels: id, namespace, owner and a filter value', async () => {
      const s = store();
      await s.upsert([
        { id: 'a', text: 'a', embedding: [1, 0], namespace: 'n', owner: 'u', metadata: { tag: 'x' } },
        { id: ' a', text: ' a', embedding: [1, 0], namespace: 'n', owner: 'u', metadata: { tag: ' x' } },
        { id: 'A', text: 'A', embedding: [1, 0], namespace: 'n', owner: 'u', metadata: { tag: 'X' } },
        { id: 'b', text: 'b', embedding: [1, 0], namespace: 'n ', owner: 'u ' },
      ]);
      expect((await s.query([1, 0], 10, { namespace: 'n' })).map((m) => m.id).sort()).toEqual([' a', 'A', 'a']);
      expect((await s.query([1, 0], 10, { namespace: 'n ' })).map((m) => m.id)).toEqual(['b']);
      expect((await s.query([1, 0], 10, { namespace: 'n', filter: { tag: 'x' } })).map((m) => m.id)).toEqual(['a']);
      expect((await s.query([1, 0], 10, { namespace: 'n ', visibleTo: 'u' })).map((m) => m.id)).toEqual([]);
      expect(await s.delete({ ids: ['a'], namespace: 'n' })).toBe(1);
      expect((await s.query([1, 0], 10, { namespace: 'n' })).map((m) => m.id).sort()).toEqual([' a', 'A']);
    });

    it('a metadata value longer than a keyword term can hold is kept whole and filters exactly', async () => {
      const s = store();
      const long = 'x'.repeat(40_000);
      await s.upsert([{ id: 'l', text: 'l', embedding: [1, 0], metadata: { body: long } }, { id: 'm', text: 'm', embedding: [1, 0], metadata: { body: `${long}y` } }]);
      const hit = await s.query([1, 0], 5, { filter: { body: long } });
      expect(hit.map((m) => m.id)).toEqual(['l']);
      expect(hit[0]!.metadata).toEqual({ body: long });
    });

    it('a zero vector is kept and scores 0, on either side', async () => {
      const s = store();
      await s.upsert([{ id: 'z', text: 'z', embedding: [0, 0, 0] }, { id: 'x', text: 'x', embedding: [1, 0, 0] }]);
      expect((await s.query([1, 0, 0], 5)).map((m) => [m.id, m.score])).toEqual([['x', 1], ['z', 0]]);
      expect((await s.query([0, 0, 0], 5)).map((m) => [m.id, m.score])).toEqual([['x', 0], ['z', 0]]);
    });

    it('ties past the index\'s own cut are still cut by id: 300 equal scores, topK 5 is the five smallest ids', async () => {
      const s = store();
      const ids = Array.from({ length: 300 }, (_, i) => `d${String(i).padStart(3, '0')}`);
      // Written in an order unlike the ids' (every 7th), so neither insertion order nor its reverse is id order.
      await s.upsert(ids.map((_, i) => ids[(i * 7) % 300]!).map((id) => ({ id, text: id, embedding: [1, 0.5, 0.25] })));
      expect((await s.query([1, 0.5, 0.25], 5)).map((m) => m.id)).toEqual(['d000', 'd001', 'd002', 'd003', 'd004']);
    });

    it('a tie decided exactly stays inside the query\'s partition and filter: the five smallest ids of the namespace and tag asked', async () => {
      const s = store();
      const ids = Array.from({ length: 200 }, (_, i) => `t${String(i).padStart(3, '0')}`);
      const shuffled = ids.map((_, i) => ids[(i * 7) % 200]!);
      await s.upsert(['a0', 'a1', 'a2'].map((id) => ({ id, text: id, embedding: [1, 0.5, 0.25], metadata: { tag: 'x' } })));
      await s.upsert(shuffled.map((id, i) => ({ id, text: id, embedding: [1, 0.5, 0.25], namespace: 'ns', metadata: { tag: i % 2 ? 'x' : 'y' } })));
      const tagged = shuffled.filter((_, i) => i % 2).sort().slice(0, 5);
      expect((await s.query([1, 0.5, 0.25], 5, { namespace: 'ns', filter: { tag: 'x' } })).map((m) => m.id)).toEqual(tagged);
    });

    it('a tie between different vectors (equal scores, not copies) is read whole too', async () => {
      const s = store();
      const many = Array.from({ length: 200 }, (_, i) => `v${String(i).padStart(3, '0')}`);
      await s.upsert(many.map((id) => ({ id, text: id, embedding: [1, 0] })));
      await s.upsert(['a0', 'a1', 'a2', 'a3', 'a4'].map((id) => ({ id, text: id, embedding: [0, 1] })));
      expect((await s.query([1, 1], 5)).map((m) => m.id)).toEqual(['a0', 'a1', 'a2', 'a3', 'a4']);
    });

    it('a write, a read and a delete past one page: 1,200 documents in one call, all deleted and counted', async () => {
      const s = store();
      await s.upsert(Array.from({ length: 1200 }, (_, i) => ({ id: `p${i}`, text: `p${i}`, embedding: [1, i / 1200], namespace: 'big' })));
      await s.upsert([{ id: 'keep', text: 'keep', embedding: [1, 0], namespace: 'other' }]);
      expect(await s.delete({ namespace: 'big' })).toBe(1200);
      expect(await s.query([1, 0], 5, { namespace: 'big' })).toEqual([]);
      expect((await s.query([1, 0], 5, { namespace: 'other' })).map((m) => m.id)).toEqual(['keep']);
    });

    it('two stores making one index at once both write, and the index holds both documents', async () => {
      const i = index();
      const [a, b] = [store(i), store(i)];
      await Promise.all([a.upsert([{ id: 'x', text: 'x', embedding: [1, 0, 0] }]), b.upsert([{ id: 'y', text: 'y', embedding: [0, 1, 0] }])]);
      expect((await a.query([1, 1, 0], 5)).map((m) => m.id).sort()).toEqual(['x', 'y']);
    });

    it('a query before the index exists answers nothing, and a delete removes nothing', async () => {
      const s = store();
      expect(await s.query([1, 0, 0], 3)).toEqual([]);
      expect(await s.delete({ ids: ['x'] })).toBe(0);
    });

    it('an index this store did not make is refused by name, not written into', async () => {
      const i = index();
      await fetch(`${url!.replace(/\/+$/, '')}/${i}`, { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ mappings: { properties: { title: { type: 'text' } } } }) });
      await expect(store(i).upsert([{ id: 'x', text: 'x', embedding: [1, 0] }])).rejects.toThrow(new RegExp(`index ${i} exists but was not made by this store`));
    });

    it('metadata of any shape comes back as it was written', async () => {
      const s = store();
      const metadata = { tags: ['a', 'b'], nested: { n: 1, deep: [null, true] }, big: 2 ** 60, s: ' x\n"y"', 'odd key=': 1 };
      await s.upsert([{ id: 'm', text: 'm', embedding: [1, 0], metadata }]);
      expect((await s.query([1, 0], 1))[0]!.metadata).toEqual(metadata);
      expect((await s.query([1, 0], 1, { filter: { 'odd key=': 1 } })).map((m) => m.id)).toEqual(['m']);
    });
  });
}
