// The preamble every standalone door runs, at its one owner: `doorGate`.
//
// Invariant (D1): "does this request carry an identity, so skip the open-surface checks" has ONE answer,
// `carriesIdentity`, which `makeGate` asks with its provider and a door asks with the principal its
// `identify` resolved for THIS request. An `identify` that answers nothing is no identity: the host rule
// and the cross-site check run. `allowCrossSite: true` lifts the cross-site check only.
//
// Inventory probe k1-identity-skip.ts, before: the door rule was `opts.identify ? skip : openDoorGuard`
// — `identify: () => undefined` refused nothing (rebound refused=false, cross-site refused=false) while
// the REST gate with a `{read,write}` pair (no identity either) refused both.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { doorGate, carriesIdentity, makeGate, normalizeAuth, roleAuth, AUTH_ERROR_STATUS, type Principal } from '../src/index.js';

const rebound = () => new Request('http://evil.example:4747/agents/a/chat', { method: 'POST', headers: { host: 'evil.example:4747', 'sec-fetch-site': 'same-origin', 'content-type': 'application/json' }, body: '{}' });
const crossSite = (origin = 'https://evil.example') => new Request('http://localhost:4747/agents/a/chat', { method: 'POST', headers: { host: 'localhost:4747', origin, 'sec-fetch-site': 'cross-site', 'content-type': 'text/plain' }, body: 'x' });
const user: Principal = { kind: 'subject', id: 'u1', roles: [] };
const refusedCode = (a: Awaited<ReturnType<ReturnType<typeof doorGate>>>) => ('refused' in a ? a.refused.body.code : undefined);

beforeEach(() => { vi.spyOn(console, 'warn').mockImplementation(() => {}); });
afterEach(() => { delete process.env.GNL_ALLOWED_HOSTS; vi.restoreAllMocks(); });

describe('one owner for "this request carries an identity"', () => {
  it('k1-identity-skip, ported: identify: () => undefined refuses what the REST gate with a {read,write} pair refuses', async () => {
    const pair = normalizeAuth({ read: () => true, write: () => true })!;
    const g = makeGate(pair);
    const door = doorGate({ door: 'createChatRoute', identify: () => undefined });
    expect(await g.allow(rebound(), 'write')).toBe(false);
    expect(await g.allow(crossSite(), 'write')).toBe(false);
    expect(refusedCode(await door(rebound()))).toBe('host_not_allowed');
    expect(refusedCode(await door(crossSite()))).toBe('cross_site_refused');
  });

  it('carriesIdentity: a provider that binds identity, or a resolved principal — nothing else', () => {
    expect(carriesIdentity({})).toBe(false);
    expect(carriesIdentity({ principal: undefined })).toBe(false);
    expect(carriesIdentity({ principal: null })).toBe(false);
    expect(carriesIdentity({ principal: user })).toBe(true);
    expect(carriesIdentity({ provider: normalizeAuth({ read: () => true })! })).toBe(false);
    expect(carriesIdentity({ provider: roleAuth({ admin: { token: 't'.repeat(32) } })! })).toBe(true);
  });

  it('a request that resolved to a principal skips both checks; the same door refuses the anonymous one', async () => {
    const door = doorGate({ door: 'createAguiRoute', identify: (req) => (req.headers.get('authorization') === 'Bearer ok' ? user : undefined) });
    const withToken = (r: Request) => { const h = new Headers(r.headers); h.set('authorization', 'Bearer ok'); return new Request(r.url, { method: 'POST', headers: h, body: 'x' }); };
    expect('refused' in (await door(withToken(rebound())))).toBe(false);
    expect('refused' in (await door(withToken(crossSite())))).toBe(false);
    expect(refusedCode(await door(rebound()))).toBe('host_not_allowed');
    expect(refusedCode(await door(crossSite()))).toBe('cross_site_refused');
  });

  it('the refusal status comes from AUTH_ERROR_STATUS, and the cross-site way through names allowCrossSite and the door', async () => {
    const door = doorGate({ door: 'createMcpServer' });
    const a = await door(crossSite());
    if (!('refused' in a)) throw new Error('expected a refusal');
    expect(a.refused.status).toBe(AUTH_ERROR_STATUS.cross_site_refused);
    expect(a.refused.body.error).toContain('allowCrossSite: true in the createMcpServer options');
    expect(a.refused.body.error).not.toContain('() => undefined');
  });
});

describe('allowCrossSite: true', () => {
  it('lifts the cross-site check and nothing else', async () => {
    const door = doorGate({ door: 'createChatRoute', allowCrossSite: true });
    expect('refused' in (await door(crossSite()))).toBe(false);
    expect(refusedCode(await door(rebound()))).toBe('host_not_allowed');
  });
  it('with allowedHosts the widget answers its real name too', async () => {
    const door = doorGate({ door: 'createChatRoute', allowCrossSite: true, allowedHosts: ['evil.example'] });
    expect('refused' in (await door(rebound()))).toBe(false);
  });
});

describe('the production refusal, when the door asks for one', () => {
  it('names a real identify and the REST mount, never identify: () => undefined; an identify that may answer nothing starts', () => {
    const prev = process.env.NODE_ENV;
    process.env.NODE_ENV = 'production';
    try {
      let message = '';
      try { doorGate({ door: 'createChatRoute', restMount: 'createRestApi(config, { auth, surfaces: [chatSurface()] })' }); } catch (e) { message = (e as Error).message; }
      expect(message).toContain('createRestApi(config, { auth, surfaces: [chatSurface()] })');
      expect(message).toContain('identify: (req) => principal');
      expect(message).not.toContain('() => undefined');
      expect(() => doorGate({ door: 'createChatRoute', restMount: 'x', identify: () => undefined })).not.toThrow();
      // A door that names no REST mount (MCP over stdio is a legitimate no-identify deployment) does not throw.
      expect(() => doorGate({ door: 'createMcpServer' })).not.toThrow();
    } finally {
      process.env.NODE_ENV = prev;
    }
  });
});
