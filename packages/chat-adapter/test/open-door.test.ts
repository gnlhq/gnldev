// A standalone chat door with no `identify` gets the protections a providerless REST API has.
//
// Measured by the round-2 review (door-exposure.mjs, a real loopback socket, the quickstart shape):
//   · a cross-site `text/plain` POST — a plain <form> on any site, no CORS preflight — ran the model and
//     appended to the thread (200);
//   · a DNS-rebound page (Host: evil.example, Sec-Fetch-Site: same-origin) replayed a run and read the
//     thread's earlier messages back in the response (200, SECRET-A in the body).
// Invariant: a door with no identity refuses exactly what makeGate refuses on REST — a cross-site state
// change and a request addressed by a name somebody else could point here — with the same way through
// (`allowedHosts` / GNL_ALLOWED_HOSTS), and nothing a developer does on localhost changes.
// K1 = the panel's cases; K2/K3 = siblings.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { InMemoryJournal, BasicMemory } from '@gnldev/durable';
import { createChatRoute } from '../src/index.js';

const usage = { inputTokens: 1, outputTokens: 1, totalTokens: 2 };
function echoModel(prompts: string[]): any {
  return {
    specificationVersion: 'v2', provider: 'mock', modelId: 'm', supportedUrls: {},
    doGenerate: async () => { throw new Error('no gen'); },
    doStream: async (o: any) => {
      const p = JSON.stringify(o.prompt);
      prompts.push(p);
      return {
        stream: new ReadableStream({
          start(c) {
            for (const x of [{ type: 'stream-start', warnings: [] }, { type: 'text-start', id: '1' }, { type: 'text-delta', id: '1', delta: 'ECHO:' + p }, { type: 'text-end', id: '1' }, { type: 'finish', finishReason: 'stop', usage }]) c.enqueue(x);
            c.close();
          },
        }),
      };
    },
  };
}

const msg = (tid: string, id: string, text: string) => JSON.stringify({ id: tid, threadId: tid, messages: [{ id, role: 'user', parts: [{ type: 'text', text }] }] });
const send = (app: any, headers: Record<string, string>, body: string) =>
  app.fetch(new Request('http://localhost/agents/a/chat', { method: 'POST', headers, body }));

function setup(opts: Record<string, unknown> = {}) {
  const prompts: string[] = [];
  const journal = new InMemoryJournal();
  const app = createChatRoute({ journal, memoryFactory: (j: any) => new BasicMemory(j), agents: { a: { model: echoModel(prompts) } } } as any, opts as any);
  return { app, prompts };
}

beforeEach(() => { vi.spyOn(console, 'warn').mockImplementation(() => {}); });
afterEach(() => { delete process.env.GNL_ALLOWED_HOSTS; vi.restoreAllMocks(); });

describe('createChatRoute with no identify', () => {
  it('K1: a cross-site text/plain POST is refused before the model runs (403 cross_site_refused, naming identify)', async () => {
    const { app, prompts } = setup();
    const r = await send(app, { host: 'localhost:4111', origin: 'https://evil.example', 'sec-fetch-site': 'cross-site', 'content-type': 'text/plain;charset=UTF-8' }, msg('T1', 'm3', 'append attacker text'));
    expect(r.status).toBe(403);
    const body = await r.json();
    expect(body.code).toBe('cross_site_refused');
    expect(body.error).toContain('identify');
    expect(prompts).toHaveLength(0);
  });

  it('K1: a rebound page (Host evil.example, same-origin) cannot replay a run and read the thread', async () => {
    const { app, prompts } = setup();
    const seed = await send(app, { host: 'localhost:4111', 'content-type': 'application/json' }, msg('T1', 'm1', 'SECRET-A my card is 4111'));
    expect(seed.status).toBe(200);
    await seed.text();
    const r = await send(app, { host: 'evil.example:4111', origin: 'http://evil.example:4111', 'sec-fetch-site': 'same-origin', 'content-type': 'application/json' }, msg('T1', 'm1', 'anything'));
    expect(r.status).toBe(403);
    const text = await r.text();
    expect(text).not.toContain('SECRET-A');
    const body = JSON.parse(text);
    expect(body.code).toBe('host_not_allowed');
    expect(body.error).toContain("allowedHosts: ['evil.example'] in the createChatRoute options");
    expect(prompts).toHaveLength(1);
  });

  it('K2: what a developer does locally still works — localhost, 127.0.0.1, a Vite UI on another port (same-site), in-process fetch with no Host', async () => {
    const { app } = setup();
    for (const [i, headers] of [
      { host: 'localhost:4111', 'content-type': 'application/json', 'sec-fetch-site': 'same-origin' },
      { host: '127.0.0.1:4111', 'content-type': 'application/json' },
      { host: 'localhost:4111', origin: 'http://localhost:5173', 'sec-fetch-site': 'same-site', 'content-type': 'application/json' },
      { 'content-type': 'application/json' },
    ].entries()) {
      const r = await send(app, headers as Record<string, string>, msg(`L${i}`, 'm', 'hi'));
      expect(r.status, JSON.stringify(headers)).toBe(200);
      await r.text();
    }
  });

  it('K2: the way through the 403 names works — allowedHosts, and GNL_ALLOWED_HOSTS', async () => {
    const opt = setup({ allowedHosts: ['.ngrok-free.app'] });
    const r1 = await send(opt.app, { host: 'abc.ngrok-free.app', 'content-type': 'application/json' }, msg('N1', 'm', 'hi'));
    expect(r1.status).toBe(200);
    await r1.text();
    const env = setup();
    process.env.GNL_ALLOWED_HOSTS = 'api';
    const r2 = await send(env.app, { host: 'api:3000', 'content-type': 'application/json' }, msg('N2', 'm', 'hi'));
    expect(r2.status).toBe(200);
    await r2.text();
  });

  it('K3: an allowedHosts entry that can never match throws where the route is built', () => {
    expect(() => setup({ allowedHosts: ['*'] })).toThrow('allowedHosts: true');
  });

  it('K3: with identify the application owns the boundary — neither check runs (identify: () => undefined included)', async () => {
    const { app, prompts } = setup({ identify: () => undefined });
    const r = await send(app, { host: 'evil.example:4111', origin: 'https://evil.example', 'sec-fetch-site': 'cross-site', 'content-type': 'text/plain' }, msg('I1', 'm', 'hi'));
    expect(r.status).toBe(200);
    await r.text();
    expect(prompts).toHaveLength(1);
  });
});
