// Every options object @gnldev/auth reads refuses a name it does not take (@gnldev/options), naming the
// option it is closest to. Measured before: `endUsers.isuer` accepted a token from any issuer, and
// `endUsers.audiance` from any audience; `roleAuth({ admn })` returned no provider at all, so a door
// built with it ran open; `signSubjectToken(…, { ttl: 60 })` signed a 900-second token; and
// `auth: { read, wirte }` left writes unrestricted — a missing direction is open to everyone.
import { describe, it, expect } from 'vitest';
import { createHmac } from 'node:crypto';
import { roleAuth, verifyJwt, signSubjectToken, subjectTokenEndpoint, makeGate, openSurfaceGuard, doorGate, refuseMisplacedOptions, normalizeAuth } from '../src/index.js';

const S = 'app-signing-secret-at-least-32-bytes!!';
const now = Math.floor(Date.now() / 1000);
const foreign = (() => {
  const enc = (o: unknown) => Buffer.from(JSON.stringify(o)).toString('base64url');
  const input = `${enc({ alg: 'HS256', typ: 'JWT' })}.${enc({ sub: 'u', iss: 'elsewhere', aud: 'other', iat: now, exp: now + 60 })}`;
  return `${input}.${createHmac('sha256', S).update(input).digest('base64url')}`;
})();
const asks = (p: any) => p.authenticate(new Request('http://x', { headers: { authorization: `Bearer ${foreign}` } }));

describe('a misspelled option is refused, never dropped', () => {
  it.each([
    ['roleAuth', () => roleAuth({ admn: { token: 'X' } } as any), /roleAuth: `admn` is not an option — did you mean `admin`\?/],
    ['a credential', () => roleAuth({ admin: { tokn: 'X' } } as any), /roleAuth: admin: `tokn` .* did you mean `token`\?/],
    ['endUsers', () => roleAuth({ endUsers: { secret: S, isuer: 'me' } } as any), /roleAuth: endUsers: `isuer` .* did you mean `issuer`\?/],
    ['verifyJwt', () => verifyJwt(foreign, { secret: S, audiance: 'me' } as any, Date.now()), /verifyJwt: `audiance` .* did you mean `audience`\?/],
    ['verifyJwt claimMap', () => verifyJwt(foreign, { secret: S, claimMap: { ids: 'sub' } } as any, Date.now()), /verifyJwt: claimMap: `ids` .* did you mean `id`\?/],
    ['signSubjectToken', () => signSubjectToken({ sub: 'u' }, S, { ttl: 60 } as any), /signSubjectToken: `ttl` .* did you mean `ttlSec`\?/],
    ['subjectTokenEndpoint', () => subjectTokenEndpoint(() => null, S, { ttlsec: 60 } as any), /subjectTokenEndpoint: `ttlsec` .* did you mean `ttlSec`\?/],
    ['makeGate', () => makeGate(undefined, { allowOpenAcess: true } as any), /makeGate: `allowOpenAcess` .* did you mean `allowOpenAccess`\?/],
    ['openSurfaceGuard', () => openSurfaceGuard({ surface: { door: 'd' }, allowedHost: ['a'] } as any), /openSurfaceGuard: `allowedHost` .* did you mean `allowedHosts`\?/],
    ['doorGate', () => doorGate({ door: 'd', authorise: () => ({ allow: false }), protectionsBanner: false } as any), /doorGate: `authorise` .* did you mean `authorize`\?/],
    ['a {read, write} pair', () => normalizeAuth({ read: () => true, wirte: () => false } as any), /auth: `wirte` .* did you mean `write`\?/],
    ['a door factory', () => refuseMisplacedOptions('createChatRoute', {}, { identfy: 1 }, ['identify', 'authorize']), /createChatRoute: `identfy` .* did you mean `identify`\?/],
  ])('%s', (_n, build, message) => {
    expect(build).toThrow(message);
  });

  it('the issuer and audience rules, spelled right, still refuse a foreign token', async () => {
    expect(await asks(roleAuth({ endUsers: { secret: S, issuer: 'me' } }))).toBeNull();
    expect(await asks(roleAuth({ endUsers: { secret: S, audience: 'me' } }))).toBeNull();
  });

  it('the right names are taken as they are, and an unset one is no name', () => {
    expect(roleAuth({ admin: { token: 'X', orgId: undefined }, endUsers: { secret: S, orgId: 'acme', isRevoked: () => false } })).toBeDefined();
    expect(() => signSubjectToken({ sub: 'u' }, S, { ttlSec: 60, now: Date.now() })).not.toThrow();
    expect(() => makeGate(undefined, { allowOpenAccess: true, allowedHosts: undefined })).not.toThrow();
  });
});
