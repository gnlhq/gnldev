// A surface with no identity answers only requests addressed to this machine.
//
// The cross-site check (same-site.ts) reads `Sec-Fetch-Site`, and after a DNS rebind that header is
// honest and useless: the attacker's page is served from http://evil.example:4747, evil.example is
// then re-pointed at 127.0.0.1, and the page's own fetch('/api/runs') is SAME-ORIGIN to the browser
// (an origin is scheme + host + port, not an IP). The browser sends
//   Host: evil.example:4747   Origin: http://evil.example:4747   Sec-Fetch-Site: same-origin
// Measured before this file existed, over a real loopback socket: the rebound page purged Studio's
// runs (POST /api/retention/sweep), ran an agent on REST (POST /agents/:name/run) and READ the run
// list (GET /api/runs) — reads matter here because the page is same-origin and can see the answer.
//
// What the rebound request cannot change is the Host header: it names the page's origin. So the rule
// is on Host, and it applies to reads as well as writes.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { makeGate, roleAuth, normalizeAuth, isHostAllowed, parseAllowedHosts, AUTH_ERROR_CODES, AUTH_ERROR_STATUS } from '../src/index.js';

const at = (host: string | undefined, method = 'GET', extra: Record<string, string> = {}) =>
  new Request('http://localhost:4747/api/runs', {
    method,
    headers: { ...(host === undefined ? {} : { host }), 'sec-fetch-site': 'same-origin', ...extra },
    ...(method === 'GET' || method === 'HEAD' ? {} : { body: '{}' }),
  });

beforeEach(() => { vi.spyOn(console, 'warn').mockImplementation(() => {}); });
afterEach(() => { delete process.env.GNL_ALLOWED_HOSTS; });

describe('a providerless gate refuses a request addressed by a name this machine does not own', () => {
  it('the rebound request is refused on reads, writes and the permission entry point', async () => {
    const gate = makeGate(undefined, { allowOpenAccess: true });
    expect(await gate.allow(at('evil.example:4747'), 'read')).toBe(false);
    expect(await gate.allow(at('evil.example:4747', 'POST'), 'write')).toBe(false);
    expect(await gate.allowP(at('evil.example:4747', 'POST'), 'runs:purge')).toBe(false);
    expect(await gate.allowP(at('evil.example:4747'), 'runs:read')).toBe(false);
    expect(await gate.allow(at('evil.example:4747', 'HEAD'), 'read')).toBe(false);
  });

  it('the refusal is a 403 with a code, and it names the option and the environment variable', async () => {
    const gate = makeGate(undefined, { allowOpenAccess: true });
    const r = at('Evil.Example:4747');
    expect(await gate.allow(r, 'read')).toBe(false);
    const res = gate.deny(r, 'read');
    expect(res.status).toBe(403);
    const body = (await res.json()) as { error: string; code: string; host: string };
    expect(body.code).toBe('host_not_allowed');
    expect(body.host).toBe('evil.example');
    expect(body.error).toContain('allowedHosts');
    expect(body.error).toContain('GNL_ALLOWED_HOSTS=evil.example');
    expect(AUTH_ERROR_STATUS[AUTH_ERROR_CODES.hostNotAllowed]).toBe(403);
  });

  it('every name that can only mean this machine is allowed', async () => {
    const gate = makeGate(undefined, { allowOpenAccess: true });
    for (const h of [
      'localhost:4747', 'LOCALHOST:4747', 'localhost', 'localhost.:4747', // trailing dot, uppercase, no port
      'app.localhost:4747', 'studio.app.localhost', // RFC 6761: browsers resolve *.localhost to loopback themselves
      '127.0.0.1:4747', '127.5.5.5:4747', '[::1]:4747', '[::1]',
    ]) {
      expect(await gate.allow(at(h), 'read'), h).toBe(true);
      expect(await gate.allow(at(h, 'POST'), 'write'), h).toBe(true);
    }
  });

  it('an IP address is allowed: a rebind needs a DNS name, and an IP literal is not resolved', async () => {
    // A page whose origin is http://192.168.1.20:4747 was served by whatever listens there — this
    // server. No attacker controls what an IP literal resolves to. This is what keeps a LAN address
    // (`gnl dev --host 0.0.0.0 --allow-open-network`, opened from a phone) working with no setting.
    const gate = makeGate(undefined, { allowOpenAccess: true });
    for (const h of ['192.168.1.20:4747', '10.0.0.5', '[fe80::1]:4747', '[2001:db8::1]']) {
      expect(await gate.allow(at(h), 'read'), h).toBe(true);
    }
  });

  it('names that only look local are refused', async () => {
    const gate = makeGate(undefined, { allowOpenAccess: true });
    for (const h of ['localhost.evil.example:4747', '127.0.0.1.evil.example', 'evil-localhost:4747', 'localhostx', '0x7f000001.example']) {
      expect(await gate.allow(at(h), 'read'), h).toBe(false);
    }
  });

  it('a request with no Host header is not a browser request, and is not refused', async () => {
    // Every browser sends Host on HTTP/1.1. In-process callers (`app.fetch(new Request(...))`) send
    // none; so does HTTP/2, which a browser only speaks over TLS, where a rebound name fails the
    // certificate check before any request is made.
    const gate = makeGate(undefined, { allowOpenAccess: true });
    expect(await gate.allow(at(undefined), 'read')).toBe(true);
  });
});

describe('the way through: allowedHosts, or GNL_ALLOWED_HOSTS', () => {
  it('a listed name is served — a custom dev hostname, a tunnel, Codespaces', async () => {
    const gate = makeGate(undefined, { allowOpenAccess: true, allowedHosts: ['mybox.test', '.ngrok-free.app', '.app.github.dev'] });
    expect(await gate.allow(at('mybox.test:4747'), 'read')).toBe(true);
    expect(await gate.allow(at('MYBOX.TEST.'), 'read')).toBe(true);
    // A leading dot lists the domain and every name under it (a tunnel's random subdomain).
    expect(await gate.allow(at('ab12-34.ngrok-free.app'), 'read')).toBe(true);
    expect(await gate.allow(at('ngrok-free.app'), 'read')).toBe(true);
    expect(await gate.allow(at('ideal-space-4747.app.github.dev'), 'read')).toBe(true);
    // ...and nothing else: listing names is not turning the check off.
    expect(await gate.allow(at('evil.example:4747'), 'read')).toBe(false);
    expect(await gate.allow(at('evilngrok-free.app'), 'read')).toBe(false);
  });

  it('`true` answers every name (behind a proxy that sets its own Host, or a Docker service name)', async () => {
    const gate = makeGate(undefined, { allowOpenAccess: true, allowedHosts: true });
    expect(await gate.allow(at('api:4747'), 'read')).toBe(true);
    expect(await gate.allow(at('evil.example'), 'write')).toBe(true);
  });

  it('GNL_ALLOWED_HOSTS is read by the gate itself — every host (gnl dev, gnl studio, your own server) gets it', async () => {
    process.env.GNL_ALLOWED_HOSTS = ' mybox.test , .trycloudflare.com ';
    const gate = makeGate(undefined, { allowOpenAccess: true, allowedHosts: ['other.test'] });
    expect(await gate.allow(at('mybox.test'), 'read')).toBe(true);
    expect(await gate.allow(at('x-y.trycloudflare.com'), 'read')).toBe(true);
    expect(await gate.allow(at('other.test'), 'read')).toBe(true); // the option and the variable add up
    expect(await gate.allow(at('evil.example'), 'read')).toBe(false);
    process.env.GNL_ALLOWED_HOSTS = '*';
    expect(await makeGate(undefined, { allowOpenAccess: true }).allow(at('evil.example'), 'read')).toBe(true);
  });

  it('parseAllowedHosts and isHostAllowed are the same rule the gate uses', () => {
    expect(parseAllowedHosts('a.test, .b.test,,')).toEqual(['a.test', '.b.test']);
    expect(parseAllowedHosts('*')).toBe(true);
    expect(parseAllowedHosts(undefined)).toEqual([]);
    expect(isHostAllowed('evil.example:1', [])).toBe(false);
    expect(isHostAllowed('a.test:1', ['a.test'])).toBe(true);
  });

  it('it says so once, with the way through, rather than failing silently', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const gate = makeGate(undefined, { allowOpenAccess: true });
    await gate.allow(at('evil.example'), 'read');
    await gate.allow(at('evil.example'), 'read');
    const said = warn.mock.calls.flat().filter((s) => String(s).includes('GNL_ALLOWED_HOSTS'));
    expect(said.length).toBe(1);
  });
});

describe('with an identity-binding provider the check does not apply', () => {
  it('the token is the defence; a rebound page cannot read it, and a real API name must keep working', async () => {
    const gate = makeGate(roleAuth({ admin: { token: 'a-long-admin-token-xxxxxxxx' } }), {});
    const withToken = at('api.example.com', 'POST', { authorization: 'Bearer a-long-admin-token-xxxxxxxx' });
    expect(await gate.allow(withToken, 'write')).toBe(true);
    // No token: refused by the provider (401), not by the host rule.
    const bare = at('api.example.com');
    expect(await gate.allow(bare, 'read')).toBe(false);
    expect((await gate.deny(bare, 'read').json() as { code?: string }).code).toBeUndefined();
  });

  it('a {read,write} predicate pair has no identity, so it gets the check (same rule as cross-site)', async () => {
    const gate = makeGate(normalizeAuth({ read: () => true, write: () => true }), {});
    expect(await gate.allow(at('evil.example'), 'read')).toBe(false);
    expect(await gate.allow(at('localhost:4747'), 'read')).toBe(true);
  });
});
