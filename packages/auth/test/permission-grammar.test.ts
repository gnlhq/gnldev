// The permission grammar (permission.ts), stated as tests: what a permission string means and which
// grants cover it. Every tier decides through `permissionMatches`; @gnldev/auth-ee's
// one-matcher.test.ts checks the tiers against it.
import { describe, it, expect } from 'vitest';
import { permissionMatches, parsePermission, isReadPermission, patternPartMatches, permissionContext, roleAuth, FREE_ROLE_GRANTS, CLIENT_ROLE, END_USER_ROLE, type Principal } from '../src/index.js';

/** Deterministic odd strings: multi-segment, empty segments, no colon, case, wildcards, spaces. */
function oddPermissions(n = 600, seed = 7): string[] {
  const parts = ['runs', 'agents', 'run', 'read', 'READ', 'Read', 'write', 'x', 'y', 'secret', '*', '', ' ', 'read ', 'agents:run', 'cancel', 'r:ead'];
  let s = seed;
  const rnd = () => ((s = (s * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff);
  const out = new Set<string>(['', ':', '::', 'read', ':read', '*:read', 'x:y:read', 'runs:read:secret', 'agents:run:x', 'runs:READ', 'runs:', '*', '*:*', 'admin']);
  while (out.size < n) {
    const k = 1 + Math.floor(rnd() * 4);
    out.add(Array.from({ length: k }, () => parts[Math.floor(rnd() * parts.length)]).join(':'));
  }
  return [...out];
}

describe('the grammar', () => {
  it('splits at the LAST colon: the action is the last segment, the resource the rest', () => {
    expect(parsePermission('billing:invoices:read')).toEqual({ resource: 'billing:invoices', action: 'read' });
    expect(parsePermission('admin')).toEqual({ resource: 'admin', action: undefined });
    expect(parsePermission(':read')).toEqual({ resource: '', action: 'read' });
  });

  it('`*:read` covers exactly the strings ending in ":read" — the free tier\'s old reduction, for every string', () => {
    for (const p of oddPermissions()) expect(isReadPermission(p), p).toBe(p.endsWith(':read'));
  });

  it('`*` covers everything; a permission covers itself', () => {
    for (const p of oddPermissions()) {
      expect(permissionMatches('*', p), p).toBe(true);
      expect(permissionMatches(p, p), p).toBe(true);
    }
  });

  it('DECIDED for 3 segments: `x:*` is every action on `x`, not on `x:y`; `x:y:*` is', () => {
    expect(permissionMatches('x:*', 'x:read')).toBe(true);
    expect(permissionMatches('x:*', 'x:y:read')).toBe(false);
    expect(permissionMatches('x:y:*', 'x:y:read')).toBe(true);
    expect(permissionMatches('*:read', 'x:y:read')).toBe(true);
  });

  it('DECIDED: a grant does not cover a longer permission it is a prefix of (`agents:run` ⊉ `agents:run:x`)', () => {
    expect(permissionMatches('agents:run', 'agents:run:x')).toBe(false);
    expect(permissionMatches('runs:read', 'runs:read:secret')).toBe(false);
    expect(permissionMatches('*:read', 'runs:read:secret')).toBe(false);
  });

  it('case-sensitive; `*` is never a partial wildcard; a bare name is covered only by itself or `*`', () => {
    expect(permissionMatches('*:read', 'runs:READ')).toBe(false);
    expect(permissionMatches('run*:read', 'runs:read')).toBe(false);
    expect(permissionMatches('*:*', 'admin')).toBe(false);
    expect(permissionMatches('admin', 'admin')).toBe(true);
    expect(patternPartMatches('*', undefined)).toBe(false);
  });
});

describe('roleAuth decides with the grammar (FREE_ROLE_GRANTS is the rule, not a description of it)', () => {
  const principalOf = (role: string): Principal => ({ kind: role === CLIENT_ROLE ? 'application' : role === END_USER_ROLE ? 'subject' : 'operator', id: 'p', roles: [role] });
  const f = roleAuth({ admin: { token: 'A'.repeat(32) } })!;

  it('PROPERTY: for every free role and every odd permission, roleAuth answers what its map answers through the matcher', async () => {
    const differ: string[] = [];
    for (const role of Object.keys(FREE_ROLE_GRANTS)) {
      for (const p of oddPermissions()) {
        const req = new Request('http://x/p', { method: 'POST' });
        const byMap = FREE_ROLE_GRANTS[role]!.some((g) => permissionMatches(g, p));
        const byRoleAuth = (await f.authorize(principalOf(role), req, permissionContext(req, p))).allow;
        if (byMap !== byRoleAuth) differ.push(`${role} ${JSON.stringify(p)}: map ${byMap}, roleAuth ${byRoleAuth}`);
      }
    }
    expect(differ).toEqual([]);
  });

  it('refusal statuses are unchanged: a read refused is 401, a write 403 with the class named', async () => {
    const req = new Request('http://x/p', { method: 'POST' });
    expect(await f.authorize(principalOf('viewer'), req, permissionContext(req, 'agents:run'))).toMatchObject({ allow: false, status: 403, reason: 'unauthorized (admin required)' });
    expect(await f.authorize(principalOf(CLIENT_ROLE), req, permissionContext(req, 'users:write'))).toMatchObject({ allow: false, status: 403, reason: 'unauthorized (client credentials cannot users:write)' });
    expect(await f.authorize({ kind: 'operator', roles: ['nobody'] }, req, permissionContext(req, 'runs:read'))).toMatchObject({ allow: false, status: 401 });
    expect(await f.authorize(null, req, permissionContext(req, 'runs:read'))).toMatchObject({ allow: false, status: 401 });
  });

  it('way through for a coarse check: no permission → the action on every resource (`*:read` / `*:write`)', async () => {
    const req = new Request('http://x/p');
    expect((await f.authorize(principalOf('viewer'), req, { path: '/p', method: 'GET', action: 'read' })).allow).toBe(true);
    expect((await f.authorize(principalOf(CLIENT_ROLE), req, { path: '/p', method: 'POST', action: 'write' })).allow).toBe(false);
    expect((await f.authorize(principalOf('admin'), req, { path: '/p', method: 'POST', action: 'write' })).allow).toBe(true);
  });

  it('SIBLING: a role named like an Object.prototype member grants nothing and does not throw', async () => {
    const req = new Request('http://x/p');
    for (const role of ['constructor', '__proto__', 'toString', 'hasOwnProperty']) {
      expect((await f.authorize({ kind: 'operator', roles: [role] }, req, permissionContext(req, 'runs:read'))).allow, role).toBe(false);
    }
  });
});
