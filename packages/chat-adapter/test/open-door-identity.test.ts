// Passing `identify` does not switch off the no-auth protections.
//
// Invariant: a door runs the host rule and the cross-site check unless THIS request resolved to a
// principal through `identify`. An `identify` that answers nothing (for this request, or for every
// request) is no identity. The one opt-out for a public, cross-site-embedded door is `allowCrossSite:
// true`, and it lifts the cross-site check only; the host rule keeps `allowedHosts` / GNL_ALLOWED_HOSTS.
//
// Measured by the round-2 panel (s-d-door.test.ts, door-guard.mjs) before the fix:
//   S-d1 · the 403 told the developer to pass `identify: () => undefined`; with it, a DNS-rebound page
//          (Host: evil.example) replayed a run and read the thread back (200, SECRET-A in the body);
//   S-d2 · an `identify` that answers undefined for a request with no token (the usual anonymous
//          fallthrough) let a cross-site text/plain form POST run the model (200, one model call).
// The rest are the realistic setups that must keep working, each one through the door.
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
      return { stream: new ReadableStream({ start(c) { for (const x of [{ type: 'stream-start', warnings: [] }, { type: 'text-start', id: '1' }, { type: 'text-delta', id: '1', delta: 'ECHO:' + p }, { type: 'text-end', id: '1' }, { type: 'finish', finishReason: 'stop', usage }]) c.enqueue(x); c.close(); } }) };
    },
  };
}
const msg = (tid: string, id: string, text: string) => JSON.stringify({ id: tid, threadId: tid, messages: [{ id, role: 'user', parts: [{ type: 'text', text }] }] });
const send = (app: any, headers: Record<string, string>, body: string) => app.fetch(new Request('http://localhost/agents/a/chat', { method: 'POST', headers, body }));
function setup(opts: Record<string, unknown> = {}) {
  const prompts: string[] = [];
  const app = createChatRoute({ journal: new InMemoryJournal(), memoryFactory: (j: any) => new BasicMemory(j), agents: { a: { model: echoModel(prompts) } } } as any, opts as any);
  return { app, prompts };
}
/** The usual identify: a verified token names a user, a request with none is anonymous. */
const tokenOrAnonymous = (req: Request) => (req.headers.get('authorization') === 'Bearer ok' ? { kind: 'subject' as const, id: 'u1', roles: [] } : undefined);
const json = { 'content-type': 'application/json' };
const crossSiteForm = { host: 'localhost:4111', origin: 'https://evil.example', 'sec-fetch-site': 'cross-site', 'content-type': 'text/plain;charset=UTF-8' };
const rebound = { host: 'evil.example:4111', origin: 'http://evil.example:4111', 'sec-fetch-site': 'same-origin', ...json };

beforeEach(() => { vi.spyOn(console, 'warn').mockImplementation(() => {}); });
afterEach(() => { delete process.env.GNL_ALLOWED_HOSTS; vi.restoreAllMocks(); });

describe('identify that answers nothing is no identity', () => {
  it('S-d1: the cross_site_refused advice no longer names `identify: () => undefined`, and that identify no longer opens the door to a rebound page', async () => {
    const first = setup();
    const refused = await (await send(first.app, crossSiteForm, msg('T', 'm0', 'x'))).json();
    expect(refused.error).not.toContain('() => undefined');
    expect(refused.error).toContain('allowCrossSite: true');
    const { app } = setup({ identify: () => undefined });
    const seed = await send(app, { host: 'localhost:4111', ...json }, msg('T1', 'm1', 'SECRET-A my card is 4111'));
    expect(seed.status).toBe(200);
    await seed.text();
    const r = await send(app, rebound, msg('T1', 'm1', 'anything'));
    const text = await r.text();
    expect(r.status).toBe(403);
    expect(text).not.toContain('SECRET-A');
    expect(JSON.parse(text).code).toBe('host_not_allowed');
  });

  it('S-d2: an anonymous request through an identify that answers undefined cannot drive a cross-site form POST', async () => {
    const { app, prompts } = setup({ identify: tokenOrAnonymous });
    const r = await send(app, crossSiteForm, msg('T2', 'm', 'attacker text'));
    expect(r.status).toBe(403);
    expect((await r.json()).code).toBe('cross_site_refused');
    expect(prompts).toHaveLength(0);
  });

  it('sibling: the same identify, with a verified token, is served cross-site and on any name — the request carries an identity', async () => {
    const { app, prompts } = setup({ identify: tokenOrAnonymous });
    const a = await send(app, { ...crossSiteForm, authorization: 'Bearer ok' }, msg('T3', 'm', 'hi'));
    expect(a.status).toBe(200);
    await a.text();
    const b = await send(app, { ...rebound, authorization: 'Bearer ok' }, msg('T4', 'm', 'hi'));
    expect(b.status).toBe(200);
    await b.text();
    expect(prompts).toHaveLength(2);
  });

  it('sibling: the host rule still names its own way through for an anonymous request (allowedHosts in the createChatRoute options)', async () => {
    const { app } = setup({ identify: tokenOrAnonymous });
    const r = await send(app, rebound, msg('T5', 'm', 'hi'));
    expect(r.status).toBe(403);
    const body = await r.json();
    expect(body.error).toContain("allowedHosts: ['evil.example'] in the createChatRoute options");
    expect(body.error).not.toContain('() => undefined');
  });
});

describe('allowCrossSite: true — the one opt-out for a widget embedded on other sites', () => {
  it('lets a page on a customer site post, anonymously', async () => {
    const { app, prompts } = setup({ identify: tokenOrAnonymous, allowCrossSite: true });
    const r = await send(app, { host: 'localhost:4111', origin: 'https://customer.example', 'sec-fetch-site': 'cross-site', ...json }, msg('W1', 'm', 'hi'));
    expect(r.status).toBe(200);
    await r.text();
    expect(prompts).toHaveLength(1);
  });

  it('does not lift the host rule — a rebound name is still refused, and allowedHosts lets the real name in', async () => {
    const { app } = setup({ allowCrossSite: true });
    const r = await send(app, rebound, msg('W2', 'm', 'hi'));
    expect(r.status).toBe(403);
    expect((await r.json()).code).toBe('host_not_allowed');
    const named = setup({ allowCrossSite: true, allowedHosts: ['chat.example.com'] });
    const ok = await send(named.app, { host: 'chat.example.com', origin: 'https://customer.example', 'sec-fetch-site': 'cross-site', ...json }, msg('W3', 'm', 'hi'));
    expect(ok.status).toBe(200);
    await ok.text();
  });
});

describe('realistic dev setups keep working with no identify', () => {
  const cases: Array<[string, Record<string, string>, Record<string, unknown>]> = [
    ['SPA on localhost:5173 with CORS (same-site)', { host: 'localhost:3000', origin: 'http://localhost:5173', 'sec-fetch-site': 'same-site', 'sec-fetch-mode': 'cors', ...json }, {}],
    ['SPA on 127.0.0.1:5173 calling localhost:3000 (the browser says cross-site)', { host: 'localhost:3000', origin: 'http://127.0.0.1:5173', 'sec-fetch-site': 'cross-site', 'sec-fetch-mode': 'cors', ...json }, {}],
    ['SPA on localhost:5173 calling 127.0.0.1:3000', { host: '127.0.0.1:3000', origin: 'http://localhost:5173', 'sec-fetch-site': 'cross-site', ...json }, {}],
    ['curl / a mobile app (no Origin, no Fetch Metadata)', { host: 'localhost:3000', ...json }, {}],
    ['a phone on the LAN, page and API on the same IP', { host: '192.168.1.20:3000', origin: 'http://192.168.1.20:5173', 'sec-fetch-site': 'same-site', ...json }, {}],
    ['a Docker service name, listed', { host: 'api:3000', ...json }, { allowedHosts: ['api'] }],
    ['an ngrok tunnel, leading-dot entry', { host: 'abc-123.ngrok-free.app', ...json }, { allowedHosts: ['.ngrok-free.app'] }],
    ['an embedded widget on a customer site, allowCrossSite', { host: 'localhost:3000', origin: 'https://shop.customer.example', 'sec-fetch-site': 'cross-site', ...json }, { allowCrossSite: true }],
  ];
  for (const [label, headers, opts] of cases) {
    it(label, async () => {
      const { app, prompts } = setup(opts);
      const r = await send(app, headers, msg(`D-${label.length}`, 'm', 'hi'));
      expect(r.status, await r.clone().text()).toBe(200);
      await r.text();
      expect(prompts).toHaveLength(1);
    });
  }
});

describe('production', () => {
  const withEnv = (fn: () => void) => {
    const prev = process.env.NODE_ENV;
    process.env.NODE_ENV = 'production';
    try { fn(); } finally { process.env.NODE_ENV = prev; }
  };
  it('the refusal to start names a real identify and the REST mount — not `identify: () => undefined`', () => {
    withEnv(() => {
      let message = '';
      try { createChatRoute({ journal: new InMemoryJournal(), agents: {} } as any); } catch (e) { message = (e as Error).message; }
      expect(message).toContain('identify: (req) => principal');
      expect(message).not.toContain('() => undefined');
    });
  });
  it('an identify that answers undefined for an anonymous visitor starts, and its anonymous requests still get the host rule', async () => {
    let app: any;
    withEnv(() => { app = createChatRoute({ journal: new InMemoryJournal(), memoryFactory: (j: any) => new BasicMemory(j), agents: { a: { model: echoModel([]) } } } as any, { identify: tokenOrAnonymous }); });
    const r = await send(app, { host: 'chat.example.com', ...json }, msg('P1', 'm', 'hi'));
    expect(r.status).toBe(403);
    expect((await r.json()).code).toBe('host_not_allowed');
  });
});
