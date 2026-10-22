// ES256 (ECDSA P-256, RFC 7518 §3.4) — how Supabase's signing keys, the default for its new projects,
// sign a user's token. Before this, `endUsers: { publicKey }` refused every such token (measured:
// raporlar/2026-10-21-auth-providers). The rule the other key types follow holds here too: the
// algorithm comes from the key the deployment gave, never from the token's header.
import { describe, it, expect } from 'vitest';
import { generateKeyPairSync, createSign, createHmac, type KeyObject } from 'node:crypto';
import { verifyJwt } from '../src/jwt.js';
import { roleAuth } from '../src/role-auth.js';

const b64 = (o: unknown) => Buffer.from(JSON.stringify(o)).toString('base64url');
const now = Math.floor(Date.now() / 1000);
const claims = { sub: '7c9e6679-7425-40de-944b-e07fc1f90ae7', aud: 'authenticated', role: 'authenticated', iat: now, exp: now + 3600 };
const ec = generateKeyPairSync('ec', { namedCurve: 'P-256' });
const pem = (k: KeyObject) => k.export({ type: 'spki', format: 'pem' }) as string;

function es256(key: KeyObject, body: object = claims, header: object = { alg: 'ES256', typ: 'JWT', kid: 'k1' }, encoding: 'ieee-p1363' | 'der' = 'ieee-p1363') {
  const input = `${b64(header)}.${b64(body)}`;
  return `${input}.${createSign('SHA256').update(input).sign({ key, dsaEncoding: encoding }).toString('base64url')}`;
}
const verify = (token: string, publicKey = pem(ec.publicKey)) => verifyJwt(token, { publicKey }, Date.now());

describe('an ES256 token is verified against a P-256 key, and only that way', () => {
  it('a token signed with the key is the user it names', () => {
    expect(verify(es256(ec.privateKey))?.id).toBe(claims.sub);
  });

  it('through roleAuth endUsers: a subject of the configured organization, whatever role the token claims', async () => {
    const auth = roleAuth({ endUsers: { publicKey: pem(ec.publicKey), orgId: 'acme' } });
    const p = await auth.authenticate(new Request('http://x/agents', { headers: { authorization: `Bearer ${es256(ec.privateKey, { ...claims, kind: 'operator', orgId: 'other' })}` } }));
    expect(p).toMatchObject({ kind: 'subject', id: claims.sub, orgId: 'acme' });
  });

  it('a token signed by another P-256 key is nobody', () => {
    const other = generateKeyPairSync('ec', { namedCurve: 'P-256' });
    expect(verify(es256(other.privateKey))).toBeNull();
  });

  it('a changed payload under the original signature is nobody', () => {
    const [h, , s] = es256(ec.privateKey).split('.');
    expect(verify(`${h}.${b64({ ...claims, sub: 'someone-else' })}.${s}`)).toBeNull();
  });

  it('the header cannot pick the algorithm: a valid EC signature under another alg, HS256 keyed with the public key, and none are nobody', () => {
    // Signed with the REAL key over a header naming another algorithm: only the rule "the algorithm
    // comes from the key" refuses these — the signature itself checks out.
    for (const alg of ['RS256', 'ES384', 'ES512']) expect(verify(es256(ec.privateKey, claims, { alg, typ: 'JWT' }))).toBeNull();
    const input = `${b64({ alg: 'HS256', typ: 'JWT' })}.${b64(claims)}`;
    expect(verify(`${input}.${createHmac('sha256', pem(ec.publicKey)).update(input).digest('base64url')}`)).toBeNull();
    expect(verify(`${b64({ alg: 'none', typ: 'JWT' })}.${b64(claims)}.`)).toBeNull();
  });

  it('a DER-encoded signature is not the JOSE form, and is nobody', () => {
    expect(verify(es256(ec.privateKey, claims, undefined, 'der'))).toBeNull();
  });

  it('a key on another curve (P-384) verifies nothing: only ES256 is supported for EC keys', () => {
    const p384 = generateKeyPairSync('ec', { namedCurve: 'P-384' });
    const input = `${b64({ alg: 'ES256', typ: 'JWT' })}.${b64(claims)}`;
    // SHA-256 over a P-384 key: an "ES256" signature on the wrong curve — valid as ECDSA, not ES256.
    const sig = createSign('SHA256').update(input).sign({ key: p384.privateKey, dsaEncoding: 'ieee-p1363' }).toString('base64url');
    expect(verify(`${input}.${sig}`, pem(p384.publicKey))).toBeNull();
  });
});
