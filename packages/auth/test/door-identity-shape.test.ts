// A door skips its open-surface checks (the host rule, the cross-site check) only for a caller the
// engine would hold to a name: `carriesIdentity({ principal })` asks `callerKind(principal)`, nothing else.
//
// Final review, before: `carriesIdentity` read `principal != null`, so ANY object `identify` answered —
// the anonymous visitor's `{ kind: 'subject', id: session?.userId }` with no user, `id: ''`, a reserved
// id, `{}` — counted as an identity. The engine read each of them as `unnamed`, yet a DNS-rebound page
// and a cross-site form each got 200 and ran the model.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { doorGate, carriesIdentity, callerKind, type Principal } from '../src/index.js';

const rebound = () => new Request('http://evil.example:4747/agents/a/chat', { method: 'POST', headers: { host: 'evil.example:4747', 'sec-fetch-site': 'same-origin', 'content-type': 'application/json' }, body: '{}' });
const crossSite = () => new Request('http://localhost:4747/agents/a/chat', { method: 'POST', headers: { host: 'localhost:4747', origin: 'https://evil.example', 'sec-fetch-site': 'cross-site', 'content-type': 'text/plain' }, body: 'x' });
const codeOf = (a: Awaited<ReturnType<ReturnType<typeof doorGate>>>) => ('refused' in a ? a.refused.body.code : undefined);

beforeEach(() => { vi.spyOn(console, 'warn').mockImplementation(() => {}); });
afterEach(() => { vi.restoreAllMocks(); });

// Each shape is what an `identify` really answers; the engine names none of them.
const nobody: Array<[string, unknown]> = [
  ['a subject with id undefined (anonymous visitor: { kind: "subject", id: session?.userId })', { kind: 'subject', id: undefined, roles: [] }],
  ['a subject with id ""', { kind: 'subject', id: '', roles: [] }],
  ['a subject with a reserved id (operator:ops)', { kind: 'subject', id: 'operator:ops', roles: [] }],
  ['a non-principal object ({}, a session stub)', {}],
  ['a subject whose id has a control character', { kind: 'subject', id: 'u1\nadmin', roles: [] }],
  ['a subject whose id is over 200 characters', { kind: 'subject', id: 'u'.repeat(201), roles: [] }],
  ['an unstamped principal with no id', { roles: ['admin'] }],
];

// And the callers the engine does hold to a name: the checks stay off for them.
const named: Array<[string, Principal]> = [
  ['a subject with a valid id', { kind: 'subject', id: 'u-ayse', roles: [] }],
  ['an operator (staff) with a valid id', { kind: 'operator', id: 'ops', roles: ['admin'] }],
  ['an application principal', { kind: 'application', id: 'billing-svc', roles: [] }],
  ['an unstamped principal with a valid id (reads as a subject)', { id: 'u-ayse', roles: [] } as unknown as Principal],
];

describe('carriesIdentity asks callerKind', () => {
  it.each(nobody)('%s: no identity — the same answer the engine gives', (_l, p) => {
    expect(callerKind(p as Principal)).toBe('unnamed');
    expect(carriesIdentity({ principal: p as Principal })).toBe(false);
  });
  it.each(named)('%s: an identity', (_l, p) => {
    expect(callerKind(p)).not.toBe('unnamed');
    expect(carriesIdentity({ principal: p })).toBe(true);
  });
});

describe('a door runs both checks for a caller the engine names nobody', () => {
  it.each(nobody)('%s: rebound host and cross-site form are refused', async (_l, p) => {
    const door = doorGate({ door: 'createChatRoute', identify: () => p as Principal });
    expect(codeOf(await door(rebound()))).toBe('host_not_allowed');
    expect(codeOf(await door(crossSite()))).toBe('cross_site_refused');
  });
  it.each(named)('%s: both checks are skipped (the identity defends the request)', async (_l, p) => {
    const door = doorGate({ door: 'createChatRoute', identify: () => p });
    // `named` is read for an application only (it must name the user it acts for); the others ignore it.
    expect('refused' in (await door(rebound(), { named: 'u-ayse' }))).toBe(false);
    expect('refused' in (await door(crossSite(), { named: 'u-ayse' }))).toBe(false);
  });
  it('the way through for a cookie-only anonymous widget is unchanged: allowCrossSite: true lifts the cross-site check', async () => {
    const door = doorGate({ door: 'createChatRoute', allowCrossSite: true, identify: () => ({ kind: 'subject', id: undefined, roles: [] }) as unknown as Principal });
    expect('refused' in (await door(crossSite()))).toBe(false);
    expect(codeOf(await door(rebound()))).toBe('host_not_allowed');
  });
});
