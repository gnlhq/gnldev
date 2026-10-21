// The REST API inside the Node frameworks people already run — Express, Fastify (through
// @fastify/middie) and Koa (through koa-connect) — booted for real on a socket, as the README tells a
// reader to bind them (packages/server/README.md, "Binding it to a Node server"). It was measured once
// outside the repository and then not again; a framework release that changes how it hands over a
// request would have gone unnoticed. Two things are held here:
//
// - bound the way the README says, each host lists the agents, runs one, streams one, and its own
//   routes and body parser keep working beside it;
// - each wrong binding the README warns about fails the way the README says it does. If a framework
//   release changes that, the warning is out of date, and this goes red.
import { describe, it, expect, afterEach } from 'vitest';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import express from 'express';
import Fastify from 'fastify';
import middie from '@fastify/middie';
import Koa from 'koa';
import c2k from 'koa-connect';
import bodyParser from 'koa-bodyparser';
import { InMemoryJournal } from '@gnldev/durable';
import { createRestApi } from '../src/index.js';
import { toNodeHandler } from '../src/node.js';

const usage = { inputTokens: 1, outputTokens: 1, totalTokens: 2 };
const stream = (parts: unknown[]) => new ReadableStream({ start(c) { for (const p of parts) c.enqueue(p); c.close(); } });
const model: any = {
  specificationVersion: 'v2', provider: 'm', modelId: 'm', supportedUrls: {},
  doGenerate: async () => ({ content: [{ type: 'text', text: 'hello' }], finishReason: 'stop', usage, warnings: [] }),
  doStream: async () => ({
    stream: stream([{ type: 'stream-start', warnings: [] }, { type: 'text-start', id: '1' }, { type: 'text-delta', id: '1', delta: 'hello' }, { type: 'text-end', id: '1' }, { type: 'finish', finishReason: 'stop', usage }]),
  }),
};
const api = () => toNodeHandler(createRestApi({ journal: new InMemoryJournal(), agents: { a: { model, system: 's', maxSteps: 2 } } } as any, { protectionsBanner: false } as any));

const closers: Array<() => Promise<void>> = [];
afterEach(async () => { for (const close of closers.splice(0)) await close(); });

/** Listens on a free loopback port: a node:http server, or anything with Node's `listen` (Express, Koa). */
async function listen(host: { listen: (...args: any[]) => Server }): Promise<string> {
  const server = await new Promise<Server>((r) => { const s: Server = host.listen(0, '127.0.0.1', () => r(s)); });
  closers.push(() => new Promise<void>((r) => { server.closeAllConnections(); server.close(() => r()); }));
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}
const post = (url: string, body: unknown) => fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });

/** Each host, bound as the README says: the API under /api, then the app's own body parser and an own route that reads a JSON body. */
const HOSTS: Array<[string, () => Promise<string>]> = [
  ['Express', async () => {
    const app = express();
    app.use('/api', api());                       // before express.json(): the README's ordering rule
    app.use(express.json());
    app.post('/app/echo', (req, res) => { res.json({ got: req.body }); });
    return listen(app);
  }],
  ['Fastify', async () => {
    const app = Fastify();
    await app.register(middie);
    app.use('/api', api());                       // middleware, not a route: the README's first rule
    app.post('/app/echo', async (req) => ({ got: req.body }));
    await app.listen({ port: 0, host: '127.0.0.1' });
    closers.push(() => app.close());
    return `http://127.0.0.1:${(app.server.address() as AddressInfo).port}`;
  }],
  ['Koa', async () => {
    const app = new Koa();
    const handler = api();
    // koa-connect waits only for a middleware that declares `next`: the README's Koa rule.
    app.use(async (ctx, next) => {
      if (!ctx.path.startsWith('/api/')) return next();
      ctx.req.url = ctx.req.url!.slice('/api'.length);
      return c2k((req: any, res: any, _next: any) => handler(req, res))(ctx, next);
    });
    app.use(bodyParser());
    app.use(async (ctx) => { if (ctx.path === '/app/echo') ctx.body = { got: (ctx.request as any).body }; });
    return listen(app);
  }],
];

describe.each(HOSTS)('%s, bound as the README says', (_name, boot) => {
  it('lists the agents, runs one and streams one', async () => {
    const base = await boot();
    const list = await fetch(`${base}/api/agents`);
    expect(list.status).toBe(200);
    expect(JSON.stringify(await list.json())).toContain('"a"');

    const run = await post(`${base}/api/agents/a/run`, { runId: 'r1', prompt: 'hi' });
    const runText = await run.text();
    expect(run.status, runText.slice(0, 200)).toBe(200);
    expect(JSON.parse(runText)).toMatchObject({ ok: true, runId: 'r1', text: 'hello' });

    const streamed = await post(`${base}/api/agents/a/stream`, { runId: 's1', prompt: 'hi' });
    const streamText = await streamed.text();
    expect(streamed.status, streamText.slice(0, 200)).toBe(200);
    expect(streamText).toContain('hello');
  });

  it('the app keeps its own routes and its own body parser beside the API', async () => {
    const base = await boot();
    const res = await post(`${base}/app/echo`, { x: 1 });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ got: { x: 1 } });
    expect((await fetch(`${base}/api/no-such-route`)).status).toBe(404);
  });
});

describe('the wrong bindings the README warns about fail the way it says', () => {
  it('Express: a body parser mounted before the API → body_consumed_upstream, not a blamed request', async () => {
    const app = express();
    app.use(express.json());
    app.use('/api', api());
    const res = await post(`${await listen(app)}/api/agents/a/run`, { runId: 'r1', prompt: 'hi' });
    expect(res.status).toBe(500);
    expect((await res.json() as { code?: string }).code).toBe('body_consumed_upstream');
  });

  it('Fastify: bound as a route instead of middleware → every GET passes and a good POST is refused', async () => {
    const app = Fastify();
    const handler = api();
    app.all('/api/*', (req, reply) => {
      req.raw.url = req.raw.url!.slice('/api'.length);
      reply.hijack();
      handler(req.raw, reply.raw);
    });
    await app.listen({ port: 0, host: '127.0.0.1' });
    closers.push(() => app.close());
    const base = `http://127.0.0.1:${(app.server.address() as AddressInfo).port}`;
    expect((await fetch(`${base}/api/agents`)).status).toBe(200);
    const res = await post(`${base}/api/agents/a/run`, { runId: 'r1', prompt: 'hi' });
    // Fastify's own JSON parser drained the stream before the route ran: the bridge says so.
    expect(res.status).toBe(500);
    expect((await res.json() as { code?: string }).code).toBe('body_consumed_upstream');
  });

  it('Koa: a koa-connect middleware that does not declare `next` → Koa answers 404 over it', async () => {
    const app = new Koa();
    const handler = api();
    app.use(c2k((req: any, res: any) => {
      req.url = req.url.replace(/^\/api/, '');
      handler(req, res);
    }));
    const base = await listen(app);
    // koa-connect calls next() straight after a two-parameter middleware, Koa finds no body and sends
    // its own 404 before ours (Koa 3.2: 404 in 5 of 5; Koa 2 also logged ERR_HTTP_HEADERS_SENT).
    const res = await fetch(`${base}/api/agents`);
    expect(res.status).toBe(404);
  });
});
