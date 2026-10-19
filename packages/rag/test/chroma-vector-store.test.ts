// @gnldev/rag ChromaVectorStore — what the vector kit (durable a-vector-store-passes-the-vector-kit.test.ts)
// does not reach: the transport (the API key goes in a header and never into a message), the option
// names, and, against a real server (GNL_CHROMA_URL), ties past Chroma's own cut and two stores making
// one collection at once.
import { describe, it, expect, afterAll } from 'vitest';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { ChromaVectorStore } from '../src/chroma-vector-store.js';

const CHROMA_URL = process.env.GNL_CHROMA_URL;
const COLLECTIONS = '/api/v2/tenants/default_tenant/databases/default_database/collections';

describe('ChromaVectorStore — without a server', () => {
  it('refuses a misspelled option, an address that is not http(s) and a name a path could break', () => {
    expect(() => new ChromaVectorStore({ url: 'http://x', colection: 'a' } as never)).toThrow(/colection.*collection/);
    expect(() => new ChromaVectorStore({ url: 'localhost:8000' })).toThrow(/http:\/\/ or https:\/\//);
    expect(() => new ChromaVectorStore({ url: 'http://x', collection: 'a/../b' })).toThrow(/collection name/);
    expect(() => new ChromaVectorStore({ url: 'http://x', tenant: 'a?b' })).toThrow(/tenant name/);
  });

  it('sends the API key as the x-chroma-token header, and no error message carries it', async () => {
    const seen: Array<string | undefined> = [];
    const server = http.createServer((req, res) => {
      seen.push(req.headers['x-chroma-token'] as string | undefined);
      res.writeHead(500, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: 'Internal', message: 'boom' }));
    });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
    const { port } = server.address() as AddressInfo;
    const key = 'ck-secret-key-123456';
    const store = new ChromaVectorStore({ url: `http://127.0.0.1:${port}`, apiKey: key });
    let message = '';
    try { await store.query([1, 0, 0], 3); } catch (e) { message = String((e as Error).message); }
    await new Promise<void>((r) => server.close(() => r()));
    expect(seen.length).toBeGreaterThan(0);
    expect(seen.every((h) => h === key)).toBe(true);
    expect(message).toMatch(/Chroma GET \/api\/v2\/tenants\/default_tenant\/databases\/default_database\/collections\/gnl_vectors answered 500 "boom"/);
    expect(message).not.toContain(key);
  });

  it('an unreachable server is said, without the key', async () => {
    const store = new ChromaVectorStore({ url: 'http://127.0.0.1:1', apiKey: 'ck-secret-key-654321' });
    const e = await store.query([1, 0], 1).catch((x: Error) => x);
    expect(String((e as Error).message)).toMatch(/Chroma GET .*\/collections\/gnl_vectors failed/);
    expect(String((e as Error).message)).not.toContain('ck-secret-key-654321');
  });
});

describe.skipIf(!CHROMA_URL)('ChromaVectorStore — a real server', () => {
  const made: string[] = [];
  const name = () => { const c = `ctest_${process.pid}_${Date.now().toString(36)}_${made.length}`; made.push(c); return c; };
  afterAll(async () => { for (const c of made) await fetch(`${CHROMA_URL!.replace(/\/+$/, '')}${COLLECTIONS}/${c}`, { method: 'DELETE' }); });

  it('ties past Chroma\'s own cut are still cut by id: 300 equal scores, topK 5 is the five smallest ids', async () => {
    const store = new ChromaVectorStore({ url: CHROMA_URL!, collection: name() });
    const ids = Array.from({ length: 300 }, (_, i) => `d${String(i).padStart(3, '0')}`);
    // Written in an order unlike the ids' (every 7th), so neither insertion order nor its reverse is id order.
    const shuffled = ids.map((_, i) => ids[(i * 7) % 300]!);
    for (let i = 0; i < shuffled.length; i += 100) {
      await store.upsert(shuffled.slice(i, i + 100).map((id) => ({ id, text: id, embedding: [1, 0.5, 0.25] })));
    }
    expect((await store.query([1, 0.5, 0.25], 5)).map((m) => m.id)).toEqual(['d000', 'd001', 'd002', 'd003', 'd004']);
  });

  it('two stores making one collection at once both write, and the collection holds both documents', async () => {
    const collection = name();
    const a = new ChromaVectorStore({ url: CHROMA_URL!, collection });
    const b = new ChromaVectorStore({ url: CHROMA_URL!, collection });
    await Promise.all([a.upsert([{ id: 'x', text: 'x', embedding: [1, 0, 0] }]), b.upsert([{ id: 'y', text: 'y', embedding: [0, 1, 0] }])]);
    expect((await a.query([1, 1, 0], 5)).map((m) => m.id).sort()).toEqual(['x', 'y']);
  });

  it('a query before the collection exists answers nothing, and a delete removes nothing', async () => {
    const store = new ChromaVectorStore({ url: CHROMA_URL!, collection: name() });
    expect(await store.query([1, 0, 0], 3)).toEqual([]);
    expect(await store.delete({ ids: ['x'] })).toBe(0);
  });

  it('metadata of any shape comes back as it was written', async () => {
    const store = new ChromaVectorStore({ url: CHROMA_URL!, collection: name() });
    const metadata = { tags: ['a', 'b'], nested: { n: 1, deep: [null, true] }, big: 2 ** 60, s: 'x' };
    await store.upsert([{ id: 'm', text: 'm', embedding: [1, 0], metadata }]);
    expect((await store.query([1, 0], 1))[0]!.metadata).toEqual(metadata);
  });
});
