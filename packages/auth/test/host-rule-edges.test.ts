// The host rule's edges (review panel, round 2). Invariant: the host rule refuses exactly the requests a
// DNS-rebound page can make against a surface with no identity, its refusal says what is true about THIS
// server, and every way through it names works in the form a developer is likely to write it.
// K1 = the panel's case; K2/K3 = siblings.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { makeGate, isHostAllowed, hostnameOf, parseAllowedHosts, hostNotAllowedMessage } from '../src/index.js';

const at = (host: string | undefined, method = 'GET', extra: Record<string, string> = {}) =>
  new Request('http://localhost:4747/api/runs', {
    method,
    headers: { ...(host === undefined ? {} : { host }), ...extra },
    ...(method === 'GET' || method === 'HEAD' ? {} : { body: '{}' }),
  });
const bodyOf = async (res: Response) => (await res.json()) as { error: string; code: string; host: string };

beforeEach(() => { vi.spyOn(console, 'warn').mockImplementation(() => {}); });
afterEach(() => { delete process.env.GNL_ALLOWED_HOSTS; vi.restoreAllMocks(); });

describe('(a) a { read, write } pair behind a proxy', () => {
  const token = (req: Request) => req.headers.get('authorization') === 'Bearer s3cret';

  it('K1: the refusal does not claim "no auth provider" — it names the pair, and both ways through', async () => {
    const gate = makeGate({ bindsIdentity: false, authenticate: () => null, authorize: async () => ({ allow: true }) } as any);
    const r = at('api.example.com', 'GET', { authorization: 'Bearer s3cret' });
    expect(await gate.allow(r, 'read')).toBe(false);
    const { error, code } = await bodyOf(gate.deny(r, 'read'));
    expect(code).toBe('host_not_allowed');
    expect(error).not.toContain('has no auth provider');
    expect(error).toMatch(/\{ read, write \} pair/);
    expect(error).toContain("allowedHosts: ['api.example.com']");
    expect(error).toContain('roleAuth');
  });

  it('K1 decided: the rule stays on for a pair — a predicate is opaque, and a rebound page CAN send an Authorization header', async () => {
    // The pair the panel suggested exempting checks a header's PRESENCE; nothing can tell it from one
    // that checks a secret. A rebound page is same-origin, so it may set any header it likes.
    const presence = (req: Request) => req.headers.has('authorization');
    const { normalizeAuth } = await import('../src/index.js');
    const gate = makeGate(normalizeAuth({ read: presence, write: presence }));
    const rebound = at('evil.example:4747', 'GET', { authorization: 'Bearer anything', 'sec-fetch-site': 'same-origin' });
    expect(await gate.allow(rebound, 'read')).toBe(false);
  });

  it('K1 way through (the one the message names): roleAuth binds an identity, so any host is answered with the right token', async () => {
    const { roleAuth } = await import('../src/index.js');
    const gate = makeGate(roleAuth({ admin: { token: 'k-admin-secret-0123456789abcdef' } }));
    expect(await gate.allow(at('api.example.com', 'GET', { authorization: 'Bearer k-admin-secret-0123456789abcdef' }), 'read')).toBe(true);
  });

  it('K2: the providerless message still says "no auth provider" (it is true there)', async () => {
    const gate = makeGate(undefined, { allowOpenAccess: true });
    const r = at('api.example.com');
    await gate.allow(r, 'read');
    expect((await bodyOf(gate.deny(r, 'read'))).error).toContain('has no auth provider');
  });

  it('K2: token is still enough on an allowed host — the pair keeps working on localhost', async () => {
    const { normalizeAuth } = await import('../src/index.js');
    const gate = makeGate(normalizeAuth({ read: token, write: token }));
    expect(await gate.allow(at('localhost:4747', 'GET', { authorization: 'Bearer s3cret' }), 'read')).toBe(true);
  });
});

describe('(b) allowedHosts in the forms developers write', () => {
  const gateWith = (allowedHosts: string[]) => makeGate(undefined, { allowOpenAccess: true, allowedHosts });

  it("K1: '*.ngrok-free.app' means what '.ngrok-free.app' means", async () => {
    expect(await gateWith(['*.ngrok-free.app']).allow(at('abc.ngrok-free.app'), 'read')).toBe(true);
    expect(await gateWith(['*.ngrok-free.app']).allow(at('evilngrok-free.app'), 'read')).toBe(false);
  });

  it("K1: a URL form 'http://myapp.test:4111' means the name 'myapp.test'", async () => {
    expect(await gateWith(['http://myapp.test:4111']).allow(at('myapp.test:4111'), 'read')).toBe(true);
    expect(await gateWith(['https://MyApp.test/']).allow(at('myapp.test'), 'read')).toBe(true);
    expect(await gateWith(['myapp.test:4111']).allow(at('myapp.test:4111'), 'read')).toBe(true);
  });

  it('K2: the same forms through GNL_ALLOWED_HOSTS', async () => {
    process.env.GNL_ALLOWED_HOSTS = '*.ngrok-free.app, http://myapp.test:4111';
    const gate = makeGate(undefined, { allowOpenAccess: true });
    expect(await gate.allow(at('abc.ngrok-free.app'), 'read')).toBe(true);
    expect(await gate.allow(at('myapp.test:4111'), 'read')).toBe(true);
  });

  it.each([
    ['*', 'allowedHosts: true'],
    ['', 'a host name'],
    ['.', 'a host name'],
    ['my app.test', 'a host name'],
    // A mid-name wildcard names the forms that work, never a domain read off the text after the '*'
    // ('a.*.com' would have suggested '.com' — see allowed-hosts-advice.test.ts).
    ['*.*.example.com', 'list each name you use'],
    ['api.*.example.com', 'list each name you use'],
  ])('K3: an entry that can never match (%j) is refused where the gate is built, naming the fix', (entry, fix) => {
    expect(() => gateWith([entry])).toThrow(fix);
  });

  it('K3: parseAllowedHosts normalises the same way (and keeps * as "every name")', () => {
    expect(parseAllowedHosts('*.ngrok-free.app, http://myapp.test:4111')).toEqual(['.ngrok-free.app', 'myapp.test']);
    expect(parseAllowedHosts('api, *')).toBe(true);
  });
});

describe('(c) GNL_ALLOWED_HOSTS is read when a request is answered, not only when the gate is built', () => {
  it('K1: set after the gate was built (dotenv loaded after the app module), it applies', async () => {
    const gate = makeGate(undefined, { allowOpenAccess: true });
    expect(await gate.allow(at('api:3000'), 'read')).toBe(false);
    process.env.GNL_ALLOWED_HOSTS = 'api';
    expect(await gate.allow(at('api:3000'), 'read')).toBe(true);
  });

  it('K2: unset after build, it stops applying (one source of truth: the environment now)', async () => {
    process.env.GNL_ALLOWED_HOSTS = 'api';
    const gate = makeGate(undefined, { allowOpenAccess: true });
    delete process.env.GNL_ALLOWED_HOSTS;
    expect(await gate.allow(at('api:3000'), 'read')).toBe(false);
  });

  it('K3: an entry in the variable that can never match is skipped with a warning naming it, not thrown per request', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    process.env.GNL_ALLOWED_HOSTS = 'api, my app';
    const gate = makeGate(undefined, { allowOpenAccess: true });
    expect(await gate.allow(at('api:3000'), 'read')).toBe(true);
    expect(warn.mock.calls.flat().some((s) => String(s).includes('my app'))).toBe(true);
  });
});

describe('(d) the refusal for a tunnel host suggests the leading-dot domain', () => {
  it.each([
    ['abc123.ngrok-free.app', '.ngrok-free.app'],
    ['x-y.trycloudflare.com', '.trycloudflare.com'],
    ['fluffy-xyz-4111.app.github.dev', '.app.github.dev'],
    ['4111-abc.ws-eu110.gitpod.io', '.gitpod.io'],
  ])('K1: %s → %s', (host, dot) => {
    const msg = hostNotAllowedMessage(host);
    expect(msg).toContain(`allowedHosts: ['${dot}']`);
    expect(msg).toContain(`GNL_ALLOWED_HOSTS=${dot}`);
  });

  it('K2: a plain name keeps the exact-name suggestion', () => {
    expect(hostNotAllowedMessage('mybox.test')).toContain("allowedHosts: ['mybox.test']");
  });

  it('K3: the message says the variable is read per request (so a restart is not what is missing)', () => {
    expect(hostNotAllowedMessage('mybox.test')).toMatch(/GNL_ALLOWED_HOSTS/);
  });
});

describe('(e) hostnameOf / isHostAllowed hygiene', () => {
  it.each(['[::1]evil.com', '[::1]:x@evil', '[::1]:80:80', '..localhost', '.localhost'])('K1: %j is not read as a loopback name', (h) => {
    expect(isHostAllowed(h, [])).toBe(false);
  });

  it('K2: the bracketed forms a browser really sends still pass', () => {
    for (const h of ['[::1]', '[::1]:4747', '[::ffff:127.0.0.1]:80']) expect(isHostAllowed(h, []), h).toBe(true);
    expect(hostnameOf('[::1]:4747')).toBe('[::1]');
  });

  it('K3 decided: no Host header and an empty one pass — no browser sends either, and in-process app.fetch has none', async () => {
    const gate = makeGate(undefined, { allowOpenAccess: true });
    expect(await gate.allow(at(undefined), 'read')).toBe(true);
    expect(await gate.allow(at(''), 'read')).toBe(true);
  });
});

describe('a cross-site refusal on REST / Studio names itself and its way through', () => {
  it('K2 (sibling of the doors): 403 cross_site_refused, naming roleAuth and the same-site proxy', async () => {
    const gate = makeGate(undefined, { allowOpenAccess: true });
    const r = at('localhost:4747', 'POST', { 'sec-fetch-site': 'cross-site', origin: 'https://evil.example' });
    expect(await gate.allow(r, 'write')).toBe(false);
    const res = gate.deny(r, 'write');
    expect(res.status).toBe(403);
    const { code, error } = await bodyOf(res);
    expect(code).toBe('cross_site_refused');
    expect(error).toContain('roleAuth');
    expect(error).toContain('cross_site_refused.md');
  });
});
