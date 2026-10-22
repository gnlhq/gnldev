// The REST stores (Qdrant, Chroma, Weaviate, Elasticsearch, OpenSearch) call their server through one transport (rest-call.ts).
// Before it had a deadline, a server that took the connection and never answered held a query forever:
// measured, all three still waiting after 20 s (raporlar/2026-10-21-rest-timeout). Now one call may take
// `timeoutMs` (default 30 s), from sending it to the answer's last byte.
import { describe, it, expect, afterEach } from 'vitest';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { QdrantVectorStore } from '../src/qdrant-vector-store.js';
import { ChromaVectorStore } from '../src/chroma-vector-store.js';
import { WeaviateVectorStore } from '../src/weaviate-vector-store.js';
import { ElasticsearchVectorStore, OpenSearchVectorStore } from '../src/search-vector-store.js';

type Make = (url: string, extra?: { apiKey?: string; timeoutMs?: number }) => { query: (v: number[], k: number) => Promise<unknown[]> };
const STORES: Array<[string, Make]> = [
  ['Qdrant', (url, extra) => new QdrantVectorStore({ url, ...extra })],
  ['Chroma', (url, extra) => new ChromaVectorStore({ url, ...extra })],
  ['Weaviate', (url, extra) => new WeaviateVectorStore({ url, ...extra })],
  ['Elasticsearch', (url, extra) => new ElasticsearchVectorStore({ url, ...extra })],
  ['OpenSearch', (url, { apiKey, ...extra } = {}) => new OpenSearchVectorStore({ url, ...extra, ...(apiKey ? { auth: { username: 'u', password: apiKey } } : {}) })],
];

const servers: http.Server[] = [];
afterEach(async () => {
  for (const s of servers.splice(0)) { s.closeAllConnections(); await new Promise<void>((r) => s.close(() => r())); }
});
async function serve(handler: http.RequestListener): Promise<string> {
  const server = http.createServer(handler);
  servers.push(server);
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}
const timed = async (p: Promise<unknown>) => {
  const t = performance.now();
  const out = await p.then(() => 'answered', (e: Error) => e.message);
  return { out, ms: performance.now() - t };
};

describe.each(STORES)('%s — a call has a deadline', (name, make) => {
  it('a server that takes the connection and never answers fails the call at timeoutMs, without the key', async () => {
    const url = await serve(() => { /* never answers */ });
    const { out, ms } = await timed(make(url, { apiKey: 'secret-key-777777', timeoutMs: 300 }).query([1, 0], 1));
    expect(out).toMatch(new RegExp(`^@gnldev/rag: ${name} GET \\S+ timed out after 300 ms$`));
    expect(out).not.toContain('secret-key-777777');
    expect(ms).toBeGreaterThanOrEqual(290);
    expect(ms).toBeLessThan(2000);
  });

  it('the deadline covers the whole answer: a server that sends a byte at a time is cut too', async () => {
    const url = await serve((_req, res) => {
      res.writeHead(200, { 'content-type': 'application/json' });
      const drip = setInterval(() => res.write(' '), 50); // JSON whitespace, forever
      res.on('close', () => clearInterval(drip));
    });
    const { out, ms } = await timed(make(url, { timeoutMs: 400 }).query([1, 0], 1));
    expect(out).toMatch(/timed out after 400 ms$/);
    expect(ms).toBeLessThan(2000);
  });

  it('a server that answers inside the deadline is answered, call after call on one connection', async () => {
    // 404 for the collection: it does not exist yet, so a query answers nothing.
    const url = await serve((_req, res) => setTimeout(() => { res.writeHead(404, { 'content-type': 'application/json' }); res.end('{}'); }, 100));
    const store = make(url, { timeoutMs: 1000 });
    for (let i = 0; i < 3; i++) expect(await store.query([1, 0], 1)).toEqual([]);
    // An earlier call's timer must not cut a later one: wait past the first call's deadline, then call again.
    await new Promise((r) => setTimeout(r, 1100));
    expect(await store.query([1, 0], 1)).toEqual([]);
  });

  it('refuses a timeoutMs that is not a number of milliseconds above 0', () => {
    for (const bad of [0, -1, Number.NaN, Number.POSITIVE_INFINITY, '5000']) {
      expect(() => make('http://127.0.0.1:1', { timeoutMs: bad as never })).toThrow(new RegExp(`${name} \`timeoutMs\` is a number of milliseconds above 0`));
    }
  });
});
