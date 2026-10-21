// An end user's token signed by an identity provider — Auth0, Clerk, Supabase, WorkOS… — checked
// against the provider's JWKS (`endUsers.jwks`). Measured before (raporlar/2026-10-21-auth-providers):
// a static `publicKey` breaks the day the provider rotates, and Supabase's ES256 keys were refused.
// What holds: the key comes from the provider, the algorithm from the key, the holder is always a
// `subject` of the configured organization; a rotation is picked up on the next token; an outage
// serves the last good keys for a bounded time and then fails closed.
import { describe, it, expect } from 'vitest';
import { generateKeyPairSync, createSign, createHmac, sign as rawSign, type KeyObject } from 'node:crypto';
import { roleAuth } from '../src/role-auth.js';

const b64 = (o: unknown) => Buffer.from(JSON.stringify(o)).toString('base64url');
const nowSec = () => Math.floor(Date.now() / 1000);
const claims = (extra: object = {}) => ({ sub: 'auth0|123', iss: 'https://tenant.auth0.com/', aud: ['https://api.example', 'https://tenant.auth0.com/userinfo'], iat: nowSec(), exp: nowSec() + 3600, ...extra });

function token(alg: 'RS256' | 'ES256' | 'EdDSA', key: KeyObject, kid: string | undefined, body: object = claims()) {
  const input = `${b64({ alg, typ: 'JWT', ...(kid ? { kid } : {}) })}.${b64(body)}`;
  const sig = alg === 'RS256' ? createSign('RSA-SHA256').update(input).sign(key)
    : alg === 'ES256' ? createSign('SHA256').update(input).sign({ key, dsaEncoding: 'ieee-p1363' })
      : rawSign(null, Buffer.from(input), key);
  return `${input}.${sig.toString('base64url')}`;
}
const jwk = (k: KeyObject, kid: string) => ({ ...k.export({ format: 'jwk' }), kid, use: 'sig' });
const rsa = () => generateKeyPairSync('rsa', { modulusLength: 2048 });

/** An identity provider's JWKS endpoint the test controls. */
function provider(keys: object[]) {
  const state = { keys, fetches: 0, down: false };
  const doFetch = (async (url: string) => {
    expect(url).toBe('https://tenant.auth0.com/.well-known/jwks.json');
    state.fetches++;
    if (state.down) return new Response('down', { status: 503 });
    return new Response(JSON.stringify({ keys: state.keys }), { status: 200 });
  }) as unknown as typeof fetch;
  return { state, doFetch };
}
const ask = (auth: ReturnType<typeof roleAuth>, t: string) => auth!.authenticate(new Request('http://x/agents', { headers: { authorization: `Bearer ${t}` } }));

describe('endUsers.jwks: an identity provider signs, GNL checks against its published keys', () => {
  it('Auth0-shaped (RS256, kid, issuer and audience pinned): the holder is a subject of the configured organization', async () => {
    const k = rsa();
    const idp = provider([jwk(k.publicKey, 'kid-1')]);
    const auth = roleAuth({ endUsers: { jwks: { url: 'https://tenant.auth0.com/.well-known/jwks.json', fetch: idp.doFetch }, issuer: 'https://tenant.auth0.com/', audience: 'https://api.example', orgId: 'acme' } });
    expect(await ask(auth, token('RS256', k.privateKey, 'kid-1', claims({ kind: 'operator', roles: ['admin'], orgId: 'other' })))).toMatchObject({ kind: 'subject', id: 'auth0|123', orgId: 'acme' });
    expect(await ask(auth, token('RS256', k.privateKey, 'kid-1', claims({ aud: 'https://another.api' })))).toBeNull();
    expect(await ask(auth, token('RS256', k.privateKey, 'kid-1', claims({ iss: 'https://evil.example/' })))).toBeNull();
  });

  it('Supabase signing keys (ES256) and an Ed25519 key, from the same kind of JWKS', async () => {
    const ec = generateKeyPairSync('ec', { namedCurve: 'P-256' });
    const ed = generateKeyPairSync('ed25519');
    const idp = provider([jwk(ec.publicKey, 'ec-1'), jwk(ed.publicKey, 'ed-1')]);
    const auth = roleAuth({ endUsers: { jwks: { url: 'https://tenant.auth0.com/.well-known/jwks.json', fetch: idp.doFetch } } });
    expect((await ask(auth, token('ES256', ec.privateKey, 'ec-1')))?.id).toBe('auth0|123');
    expect((await ask(auth, token('EdDSA', ed.privateKey, 'ed-1')))?.id).toBe('auth0|123');
    // The key named decides: an ES256 signature under the Ed25519 key's kid is nobody.
    expect(await ask(auth, token('ES256', ec.privateKey, 'ed-1'))).toBeNull();
  });

  it('the header cannot pick the algorithm: HS256 keyed with the published public key, and a kid nobody published, are nobody', async () => {
    const k = rsa();
    const idp = provider([jwk(k.publicKey, 'kid-1')]);
    const auth = roleAuth({ endUsers: { jwks: { url: 'https://tenant.auth0.com/.well-known/jwks.json', fetch: idp.doFetch } } });
    const pem = k.publicKey.export({ type: 'spki', format: 'pem' }) as string;
    const input = `${b64({ alg: 'HS256', typ: 'JWT', kid: 'kid-1' })}.${b64(claims())}`;
    expect(await ask(auth, `${input}.${createHmac('sha256', pem).update(input).digest('base64url')}`)).toBeNull();
    expect(await ask(auth, token('RS256', rsa().privateKey, 'kid-9'))).toBeNull();
    expect(await ask(auth, token('RS256', rsa().privateKey, 'kid-1'))).toBeNull(); // right kid, wrong signer
  });

  it('a rotation is picked up on the next token; requests at once share one fetch', async () => {
    const [k1, k2] = [rsa(), rsa()];
    const idp = provider([jwk(k1.publicKey, 'kid-1')]);
    let t = 1_000_000;
    const auth = roleAuth({ endUsers: { jwks: { url: 'https://tenant.auth0.com/.well-known/jwks.json', fetch: idp.doFetch, now: () => t } } });
    const first = await Promise.all(Array.from({ length: 10 }, () => ask(auth, token('RS256', k1.privateKey, 'kid-1'))));
    expect(first.every((p) => p?.id === 'auth0|123')).toBe(true);
    expect(idp.state.fetches).toBe(1);
    idp.state.keys = [jwk(k1.publicKey, 'kid-1'), jwk(k2.publicKey, 'kid-2')];
    t += 31_000; // past refetchMs (30 s), well inside the 10-minute TTL
    expect((await ask(auth, token('RS256', k2.privateKey, 'kid-2')))?.id).toBe('auth0|123');
    expect(idp.state.fetches).toBe(2);
  });

  it('an outage serves the last good keys up to maxStaleMs, then fails closed', async () => {
    const k = rsa();
    const idp = provider([jwk(k.publicKey, 'kid-1')]);
    let t = 1_000_000;
    const auth = roleAuth({ endUsers: { jwks: { url: 'https://tenant.auth0.com/.well-known/jwks.json', fetch: idp.doFetch, now: () => t, maxStaleMs: 60 * 60_000 } } });
    expect(await ask(auth, token('RS256', k.privateKey, 'kid-1'))).not.toBeNull();
    idp.state.down = true;
    t += 30 * 60_000; // past the TTL, inside the stale bound
    expect(await ask(auth, token('RS256', k.privateKey, 'kid-1'))).not.toBeNull();
    t += 31 * 60_000; // past the stale bound
    expect(await ask(auth, token('RS256', k.privateKey, 'kid-1'))).toBeNull();
  });

  it('a JWKS that never answered is nobody, not an error page', async () => {
    const idp = provider([]);
    idp.state.down = true;
    const auth = roleAuth({ endUsers: { jwks: { url: 'https://tenant.auth0.com/.well-known/jwks.json', fetch: idp.doFetch } } });
    expect(await ask(auth, token('RS256', rsa().privateKey, 'kid-1'))).toBeNull();
  });

  it('the lifetime rule still holds: an Auth0 default 24-hour token needs isRevoked, as any end-user token does', async () => {
    const k = rsa();
    const idp = provider([jwk(k.publicKey, 'kid-1')]);
    const day = claims({ exp: nowSec() + 86_400 });
    const plain = roleAuth({ endUsers: { jwks: { url: 'https://tenant.auth0.com/.well-known/jwks.json', fetch: idp.doFetch } } });
    expect(await ask(plain, token('RS256', k.privateKey, 'kid-1', day))).toBeNull();
    const revocable = roleAuth({ endUsers: { jwks: { url: 'https://tenant.auth0.com/.well-known/jwks.json', fetch: idp.doFetch }, maxTtlSec: 86_400, isRevoked: () => false } });
    expect((await ask(revocable, token('RS256', k.privateKey, 'kid-1', day)))?.id).toBe('auth0|123');
  });

  it('refuses a configuration that names two key sources, a JWKS address that is not http(s), and a misspelled cache rule', () => {
    expect(() => roleAuth({ endUsers: { jwks: 'https://tenant.auth0.com/.well-known/jwks.json', publicKey: 'x' } })).toThrow(/one of `secret`, `publicKey` and `jwks`/);
    expect(() => roleAuth({ endUsers: { jwks: 'tenant.auth0.com/jwks.json' } })).toThrow(/http\(s\) address/);
    expect(() => roleAuth({ endUsers: { jwks: { url: 'https://x/jwks', ttlMS: 1 } as never } })).toThrow(/ttlMS.*ttlMs/);
  });
});
