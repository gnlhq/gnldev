// The REST/Studio gate asks "does this request carry an identity?" PER REQUEST, as a door does.
//
// Invariant: the host rule is skipped only for a request that resolved to a principal the engine holds
// to a name (`carriesIdentity({ principal })`). Before, `makeGate` asked `carriesIdentity({ provider })`
// — a configuration question — so a provider that names identities AND serves anonymous reads skipped
// the rule for every request. Measured (round-5 probe S1-3b): Studio with such a provider answered a
// DNS-rebound `GET /runs` (`Host: evil.example`, no token) with 200 and the run's prompt; 0.9.0 the same.
//
// K1 = the measured case; K2 = siblings (the other entry point, an unnamed object principal, the
// decision record); K3 = what must NOT change (roleAuth's 401, a pair, no provider, the ways through).
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { makeGate, normalizeAuth, roleAuth, type AuthProvider, type AccessDecision, type Principal } from '../src/index.js';

const at = (host: string, method = 'GET', extra: Record<string, string> = {}) =>
  new Request(`http://${host}/api/runs`, {
    method,
    headers: { host, 'sec-fetch-site': 'same-origin', ...extra },
    ...(method === 'GET' ? {} : { body: '{}' }),
  });
const bodyOf = async (res: Response) => (await res.json()) as { error: string; code?: string; host?: string };

/** Names a user for `Bearer U1`, nobody otherwise; allows every read (anonymous ones included). */
const anonymousReads = (who: (req: Request) => Principal | null = (req) => (req.headers.get('authorization') === 'Bearer U1' ? { kind: 'subject', id: 'u1', roles: [] } : null)): AuthProvider => ({
  authenticate: who,
  authorize: (_p, _r, ctx) => ({ allow: ctx.action === 'read' }),
});

beforeEach(() => { vi.spyOn(console, 'warn').mockImplementation(() => {}); });
afterEach(() => { delete process.env.GNL_ALLOWED_HOSTS; vi.restoreAllMocks(); });

describe('K1: a provider that names identities and serves anonymous reads', () => {
  it('an anonymous read addressed to a foreign name is refused host_not_allowed (it was served)', async () => {
    const gate = makeGate(anonymousReads());
    const r = at('evil.example:4747');
    expect(await gate.allow(r, 'read')).toBe(false);
    const res = gate.deny(r, 'read');
    expect(res.status).toBe(403);
    const body = await bodyOf(res);
    expect(body.code).toBe('host_not_allowed');
    expect(body.host).toBe('evil.example');
    expect(body.error).toMatch(/resolved to no caller/);
    // The refusal names its ways through.
    expect(body.error).toContain("allowedHosts: ['evil.example']");
    expect(body.error).toContain('GNL_ALLOWED_HOSTS=evil.example');
    expect(body.error).toMatch(/send a credential/);
  });

  it('way through 1: the name listed in allowedHosts is answered', async () => {
    const gate = makeGate(anonymousReads(), { allowedHosts: ['api.example.com'] });
    expect(await gate.allow(at('api.example.com'), 'read')).toBe(true);
  });

  it('way through 2: GNL_ALLOWED_HOSTS, read per request', async () => {
    const gate = makeGate(anonymousReads());
    process.env.GNL_ALLOWED_HOSTS = '.example.com';
    expect(await gate.allow(at('api.example.com'), 'read')).toBe(true);
  });

  it('way through 3: a request that resolves to a caller is answered under any name', async () => {
    const gate = makeGate(anonymousReads());
    expect(await gate.allow(at('evil.example', 'GET', { authorization: 'Bearer U1' }), 'read')).toBe(true);
  });

  it('localhost and an IP address are answered anonymous, as before', async () => {
    const gate = makeGate(anonymousReads());
    expect(await gate.allow(at('localhost:4747'), 'read')).toBe(true);
    expect(await gate.allow(at('192.168.1.20:4747'), 'read')).toBe(true);
  });
});

describe('K2: siblings of the same question', () => {
  it('allowP asks it too (the entry point 23 routes use)', async () => {
    const gate = makeGate(anonymousReads());
    expect(await gate.allowP(at('evil.example'), 'runs:read')).toBe(false);
    expect(await gate.allowP(at('localhost'), 'runs:read')).toBe(true);
  });

  it('a principal OBJECT the engine names nobody with is no identity ({ kind: subject, id: "" })', async () => {
    const gate = makeGate(anonymousReads(() => ({ kind: 'subject', id: '', roles: [] })));
    expect(await gate.allow(at('evil.example'), 'read')).toBe(false);
    // …while a named one is.
    const named = makeGate(anonymousReads(() => ({ kind: 'operator', roles: ['viewer'] })));
    expect(await named.allow(at('evil.example'), 'read')).toBe(true);
  });

  it('the decision record says refused, not the allowed verdict that came before the host rule', async () => {
    const seen: AccessDecision[] = [];
    const gate = makeGate({ ...anonymousReads(), onDecision: (d) => { seen.push(d); } });
    const r = at('evil.example');
    expect(await gate.allow(r, 'read')).toBe(false);
    await gate.settle(r, gate.deny(r, 'read').status);
    expect(seen).toHaveLength(1);
    expect(seen[0]).toMatchObject({ allowed: false, reason: 'policy', detail: 'host_not_allowed', kind: 'unnamed', status: 403 });
  });
});

describe('K3: what does not change', () => {
  const ADMIN = 'A'.repeat(32);

  it('roleAuth: no token on a foreign name is still 401 "unauthorized" (refused before the host rule could matter)', async () => {
    const gate = makeGate(roleAuth({ admin: { token: ADMIN } }));
    const r = at('api.example.com');
    expect(await gate.allow(r, 'read')).toBe(false);
    const res = gate.deny(r, 'read');
    expect(res.status).toBe(401);
    expect((await bodyOf(res)).code).toBeUndefined();
  });

  it('roleAuth: a token is answered under any name, reads and writes', async () => {
    const gate = makeGate(roleAuth({ admin: { token: ADMIN } }));
    expect(await gate.allow(at('api.example.com', 'GET', { authorization: `Bearer ${ADMIN}` }), 'read')).toBe(true);
    expect(await gate.allowP(at('api.example.com', 'POST', { authorization: `Bearer ${ADMIN}`, 'sec-fetch-site': 'cross-site' }), 'agents:run')).toBe(true);
  });

  it('a { read, write } pair and no provider: refused before the predicate, with their own message', async () => {
    const pair = makeGate(normalizeAuth({ read: () => true, write: () => true }));
    const r = at('evil.example');
    expect(await pair.allow(r, 'read')).toBe(false);
    expect((await bodyOf(pair.deny(r, 'read'))).error).toMatch(/\{ read, write \} pair/);
    const none = makeGate(undefined);
    const r2 = at('evil.example');
    expect(await none.allow(r2, 'read')).toBe(false);
    expect((await bodyOf(none.deny(r2, 'read'))).error).toMatch(/has no auth provider/);
  });

  it('DECIDED: an anonymous write a provider allows is not refused as cross-site (no REST/Studio option could let it through)', async () => {
    // A provider that names identities and allows an anonymous write has said anybody may make it — a
    // public widget on another site included. Doors have `allowCrossSite`; the REST/Studio gate has no
    // such option, so this check stays a configuration question there (see gate.ts `decide`).
    const gate = makeGate({ authenticate: () => null, authorize: () => ({ allow: true }) });
    const r = new Request('http://localhost:4111/api/agents/a/run', { method: 'POST', headers: { host: 'localhost:4111', 'sec-fetch-site': 'cross-site', origin: 'https://widget.example' }, body: '{}' });
    expect(await gate.allowP(r, 'agents:run')).toBe(true);
  });
});
