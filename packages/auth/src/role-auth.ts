// Free default auth provider: four credential CLASSES, bearer + basic.
// (The paid @gnldev/auth-ee implements the same AuthProvider with SSO/RBAC.)
//
// The classes exist because "admin" was doing two unrelated jobs, and measurement showed the cost of
// each. (1) An application's day-to-day calls — running an agent, sending a prompt — required the
// `admin` token, the SAME token that cancels runs, reads the whole organization's history and reads
// `/usage`. A customer's backend therefore carried the deployment's management key to do routine work.
// (2) The operator who runs the PLATFORM belongs to no single organization by construction, so the
// org-isolation fail-closed rule (server/studio `orgIsolationActive`) denied it along with the
// accidental unbound admin it was written to stop — 39 tests across 11 files were that persona.
//
//   superAdmin  the platform operator. Unbound BY DESIGN → carries `platform-admin` (scope.ts).
//   admin       an organization's manager. Studio, governance, everything inside one org.
//   client      an application's server-to-server credential. Runs agents; manages nothing.
//   viewer      read-only.
//   endUsers    not a credential in this file: a token the APPLICATION signs for one logged-in user
//               (`signSubjectToken`). Its holder is that user — `kind: 'subject'` — and nobody else.
//
// `client` is deliberately a WHITELIST, not "admin minus a few things": a write whose permission this
// file does not name is denied. A route added later without a name costs a 403 (visible, reported)
// instead of silently widening what every deployed application credential can reach.
import { createHash } from 'node:crypto';
import type { AuthProvider, Principal, Decision, AuthContext, Cred } from './types.js';
import { safeEqual } from './safe-equal.js';
import { grantsAllow, isReadPermission } from './permission.js';
import { PLATFORM_ADMIN_ROLE, subjectIdProblem } from './scope.js';
import { refuseUnknownNames, optionNames } from '@gnldev/options';
import { verifyJwt, b64uDecode, MIN_SUBJECT_SECRET_BYTES, MAX_SUBJECT_TTL_SEC, MAX_REVOCABLE_SUBJECT_TTL_SEC } from './jwt.js';
import { jwksSource, type JwksSourceOptions } from './jwks.js';

/** The reserved role naming the application credential class (see `CLIENT_WRITES`). */
export const CLIENT_ROLE = 'client';

/**
 * The ONLY writes an application credential may perform — running work, and stopping work it started.
 * Everything else (organization/user/pricing/policy administration, the agent registry, retention)
 * belongs to `admin`.
 *
 * Named permissions only: `AuthContext.permission` is set by the gate's `allowP`, so a route gated
 * with the coarse `allow(req, 'write')` arrives here with `permission: undefined` and is DENIED for
 * this class. That is the point — see the whitelist note in the module header.
 */
export const CLIENT_WRITES: ReadonlySet<string> = new Set([
  'agents:run',
  'workflow:run',
  'run:cancel',
]);

/** The role an `endUsers` token carries. Its writes are `CLIENT_WRITES`: run work, stop work. */
export const END_USER_ROLE = 'end-user';

/**
 * What `roleAuth` grants each of its roles, written as permission patterns (`resource:action`, `*` a
 * wildcard; the grammar is permission.ts's) — the form an RBAC provider evaluates. It IS the rule:
 * `roleAuth.authorize` below reads this map with `permissionMatches`, the matcher the paid tier uses,
 * so the paid tier can START from it instead of restating it.
 *
 * It exists because restating it went wrong: @gnldev/auth-ee's default RBAC map listed viewer, member,
 * admin and platform-admin, and not `client` or `end-user`. With a valid licence the free provider
 * becomes the identity chain's fallback, so the same application credential and the same end-user token
 * reached the paid tier — and were refused `agents:run` and every read that roleAuth allows them.
 * @gnldev/auth-ee's `DEFAULT_ROLE_GRANTS` now spreads this map, and its conformance test walks every role
 * here against every permission a host asks for (and checks this map answers exactly what roleAuth does).
 *
 *   admin               everything (`*`)
 *   client, end-user    every read, and the writes in `CLIENT_WRITES`
 *   viewer              every read
 *
 * `platform-admin` is absent on purpose: here it is a SCOPE grant carried beside `admin` (see scope.ts),
 * and on its own it grants roleAuth nothing.
 */
export const FREE_ROLE_GRANTS: Readonly<Record<string, readonly string[]>> = Object.freeze({
  admin: Object.freeze(['*']),
  [CLIENT_ROLE]: Object.freeze(['*:read', ...CLIENT_WRITES]),
  [END_USER_ROLE]: Object.freeze(['*:read', ...CLIENT_WRITES]),
  viewer: Object.freeze(['*:read']),
});

/**
 * Is this check a write, for the refusal's status (403 "you may not" vs 401 "who are you")? A named
 * permission says so itself — the grammar's reads are what `*:read` covers — and a coarse check says
 * it in `action`.
 */
function isWrite(ctx: AuthContext): boolean {
  return ctx.permission !== undefined ? !isReadPermission(ctx.permission) : ctx.action === 'write';
}

/**
 * Who may verify an end user's token, and where that user lives.
 *
 * The application signs a short-lived token for its logged-in user (`signSubjectToken`) and hands it to
 * the user's browser or app, which calls GNL with it directly. Only `sub` is read. KIND, ROLES and
 * ORGANIZATION come from here, never from the token: a claim is whatever the signer wrote, and the
 * point of this class is that the holder cannot be more than one user of one organization.
 */
export interface EndUserTokens {
  /** HS256 secret the application signs with. */
  secret?: string;
  /** Or a public key (PEM or base64url SPKI; RS256/ES256/Ed25519), when the application signs asymmetrically. */
  publicKey?: string;
  /**
   * Or the identity provider's JWKS — its address (`https://<tenant>.auth0.com/.well-known/jwks.json`),
   * or the address with cache rules (`JwksSourceOptions`). The key a token names (`kid`) is fetched,
   * cached, and fetched again when the provider rotates (see `jwksSource`). For a provider that signs
   * your users' tokens: Auth0, Clerk, Supabase signing keys, WorkOS, Firebase, Okta.
   */
  jwks?: string | JwksSourceOptions;
  /** Expected `iss`; unchecked if unset. */
  issuer?: string;
  /** Expected `aud`; unchecked if unset. */
  audience?: string;
  /** The organization every token holder belongs to. Bound here, because a token claim would let the signer pick. */
  orgId?: string;
  /**
   * Longest remaining lifetime a token may claim, in seconds. Default 1 hour (`MAX_SUBJECT_TTL_SEC`),
   * which is also the ceiling unless `isRevoked` is set: a token nothing can take back must die on
   * its own. With `isRevoked`, up to 30 days (`MAX_REVOCABLE_SUBJECT_TTL_SEC`) — for a credential
   * pasted into an MCP client's config, or a link in an email. A token whose `exp` is further out than
   * this is refused.
   */
  maxTtlSec?: number;
  /**
   * Revocation hook, asked on every request AFTER the signature verified. `true` refuses the token.
   * Typical bodies: a `jti` deny-list written at logout, or `iat < loggedOutAt(sub)` (one number per
   * user). A throw refuses (fail-closed). Without it, a token lives until `exp` — at most `maxTtlSec`.
   */
  isRevoked?: (claims: { sub: string; iat?: number; jti?: string }) => boolean | Promise<boolean>;
}

/** Longest `sub` accepted; matches @gnldev/server's resourceId bound. */
/** Why a `sub` cannot be a subject id, or null — the one rule, `subjectIdProblem` (scope.ts). */
const badSubject = (sub: string) => subjectIdProblem(sub);

/** Basic auth header value (same base64 logic as studio basicAuth). */
function basicValue(user: string, pass: string): string {
  return 'Basic ' + Buffer.from(`${user}:${pass}`).toString('base64');
}

/**
 * Stable per-token identity for a class configured with a bearer token and no `user` — i.e. exactly
 * the shape `gnl add host` scaffolds (`{ token: v }`, see packages/cli/src/hosts.ts's `APP_TS`) and
 * the shape `GNL_ADMIN_TOKEN`/`GNL_VIEWER_TOKEN` produce. Without this, such a principal's `id` was
 * always absent, and anything keyed on `Principal.id` — @gnldev/studio's dead-letter-scan admission
 * budget being the measured case (`server.ts`'s `deadScanCaller`) — could not tell two holders of
 * DIFFERENT tokens apart, so the fairness bound it exists for silently did not apply to a single
 * deployment's own admin/viewer tokens.
 *
 * A hash, not the token itself, so that whatever does read it never holds something that unlocks the
 * credential. WHAT READS IT TODAY is exactly one thing: studio's dead-letter admission map
 * (`deadScanCaller`). Audit records (`@gnldev/auth-ee`'s `audit.ts`) and `GET /me` read `principal.id`
 * and do not see this field at all — an earlier draft of this note claimed they did, from when the
 * fingerprint still lived on `id`. It is stated as a fact about today rather than a guarantee: if a
 * surface ever does expose it, the dictionary-attack note below becomes live rather than theoretical.
 * `sha256`, prefixed and NOT truncated: a short/truncated digest of a low-entropy,
 * human-picked token is realistically dictionary-attackable regardless of digest length, so
 * truncating would only look safer; keeping the full 32-byte digest doesn't make that easier than it
 * already is. The `token:` prefix marks the value as SYNTHETIC (never a real username/user-store id)
 * everywhere it surfaces, matching the one already in use for the `platform-admin` role tag.
 *
 * It lands on `credentialId`, NOT on `id`, and every class gets one including `client`. The first
 * attempt put it on `id` and excluded `client` to protect that class's documented contract; measuring
 * the other classes showed the exclusion was aimed at the wrong thing. `resolveResourceId` prefers
 * `principal.id` UNCONDITIONALLY over the subject a request named, so an operator that sent
 * `resourceId: 'user-42'` got the fingerprint back instead — `user-42` and `user-99` in one bucket,
 * silently. The reasoning that made this look safe was that an operator "works across an
 * organization's data by design and names nobody"; that sentence explains why an operator is not
 * REQUIRED to name a subject, not that it never does, and the code accepted one before.
 *
 * `credentialId` has no such reach: it is a budget key, nothing treats it as an owner, so `client` can
 * carry one too — a customer's backend is a legitimate subject for a spending limit while remaining,
 * as designed, no subject at all for memory. `id` keeps its old meaning exactly: the basic-auth `user`
 * when there is one, otherwise absent, and that absence still tells `resolveResourceId` the truth.
 * This also leaves `actorOf`'s `x-gnl-actor` attribution untouched, which the first attempt overrode.
 */
function tokenId(token: string): string {
  return `token:${createHash('sha256').update(token, 'utf8').digest('hex')}`;
}

/** Accepted Authorization header values + bearer token set for a role (for SSE query fallback). */
function credValues(cred?: Cred): { headers: Set<string>; tokens: Set<string> } {
  const headers = new Set<string>();
  const tokens = new Set<string>();
  if (cred?.token) {
    headers.add(`Bearer ${cred.token}`);
    tokens.add(cred.token);
  }
  if (cred?.user && cred?.pass) headers.add(basicValue(cred.user, cred.pass));
  return { headers, tokens };
}

/**
 * Role-based free auth. Each class can be configured with a bearer token and/or basic user+pass (both
 * fall into the same class). If NO class is given, returns `undefined` → OPT-IN: the gate isn't set
 * up, the existing open behavior is preserved.
 *
 * `{ admin, viewer }` behaves exactly as it did before `superAdmin`/`client` existed — the two new
 * classes are additive, and a config that names neither produces byte-identical decisions.
 */
export function roleAuth(cfg: RoleAuthConfig): AuthProvider | undefined {
  refuseUnknownNames('roleAuth', cfg, ROLE_AUTH_NAMES);
  for (const role of ['superAdmin', 'admin', 'client', 'viewer'] as const) refuseUnknownNames(`roleAuth: ${role}`, cfg[role], CRED_NAMES);
  refuseUnknownNames('roleAuth: endUsers', cfg.endUsers, END_USER_TOKEN_NAMES);
  return roleAuthProvider(cfg);
}

/** What `roleAuth` takes: a credential per class of caller, and the end users' token rule. */
export interface RoleAuthConfig {
  /**
   * The PLATFORM operator: sees and manages every organization. Unbound by design, and says so —
   * this class carries the reserved `platform-admin` role, which is what the strict/org-isolation
   * models check. `scope.ts` refuses to INFER the platform scope from a missing `orgId`, because
   * forgetting an orgId would then mint a super-admin; naming the class is that grant made explicit.
   */
  superAdmin?: Cred;
  admin?: Cred;
  /** An application's server-to-server credential: runs agents, manages nothing (see `CLIENT_WRITES`). */
  client?: Cred;
  viewer?: Cred;
  /** End users holding a token your application signed for them. See `EndUserTokens`. */
  endUsers?: EndUserTokens;
}
const ROLE_AUTH_NAMES = optionNames<RoleAuthConfig>()(['superAdmin', 'admin', 'client', 'viewer', 'endUsers']);
const CRED_NAMES = optionNames<Cred>()(['token', 'user', 'pass', 'orgId', 'platformAdmin']);
const END_USER_TOKEN_NAMES = optionNames<EndUserTokens>()(['secret', 'publicKey', 'jwks', 'issuer', 'audience', 'orgId', 'maxTtlSec', 'isRevoked']);

function roleAuthProvider(cfg: RoleAuthConfig): AuthProvider | undefined {
  const superAdmin = credValues(cfg.superAdmin);
  const admin = credValues(cfg.admin);
  const client = credValues(cfg.client);
  const viewer = credValues(cfg.viewer);
  const endUsers = cfg.endUsers;
  const keySources = endUsers ? [endUsers.secret, endUsers.publicKey, endUsers.jwks].filter((k) => k != null).length : 0;
  if (endUsers && keySources === 0) {
    throw new Error('@gnldev/auth: `endUsers` needs `secret`, `publicKey` or `jwks` — without one, no token can be verified.');
  }
  if (keySources > 1) {
    throw new Error('@gnldev/auth: `endUsers` takes one of `secret`, `publicKey` and `jwks` — with two, which one a token was checked against would depend on the order they are tried.');
  }
  const jwks = endUsers?.jwks == null ? undefined
    : jwksSource(typeof endUsers.jwks === 'string' ? { url: endUsers.jwks } : endUsers.jwks, '@gnldev/auth endUsers', 'endUsers.jwks.maxStaleMs');
  if (endUsers?.secret != null && Buffer.byteLength(endUsers.secret, 'utf8') < MIN_SUBJECT_SECRET_BYTES) {
    throw new Error(`@gnldev/auth: \`endUsers.secret\` must be at least ${MIN_SUBJECT_SECRET_BYTES} bytes — a short HMAC key lets whoever guesses it sign any user.`);
  }
  const maxTtlSec = endUsers?.maxTtlSec ?? MAX_SUBJECT_TTL_SEC;
  const ceiling = endUsers?.isRevoked ? MAX_REVOCABLE_SUBJECT_TTL_SEC : MAX_SUBJECT_TTL_SEC;
  if (endUsers && (!(maxTtlSec > 0) || maxTtlSec > ceiling)) {
    throw new Error(endUsers.isRevoked
      ? `@gnldev/auth: \`endUsers.maxTtlSec\` must be in (0, ${ceiling}] (30 days).`
      : `@gnldev/auth: \`endUsers.maxTtlSec\` above ${MAX_SUBJECT_TTL_SEC}s needs \`isRevoked\` — a long-lived token nothing can take back is a leaked credential that stays leaked.`);
  }
  if (superAdmin.headers.size === 0 && admin.headers.size === 0 && client.headers.size === 0 && viewer.headers.size === 0 && !endUsers) {
    return undefined;
  }

  // What verifyJwt reads of the rule: `orgId` and `isRevoked` are this provider's, asked below.
  const { orgId: _orgId, isRevoked: _isRevoked, jwks: _jwks, ...jwtRule } = endUsers ?? {};
  /** The one user a verified token names, or null. Nothing but `sub` is taken from it. */
  const endUserOf = async (req: Request): Promise<Principal | null> => {
    if (!endUsers) return null;
    const h = req.headers.get('authorization');
    const token = h?.startsWith('Bearer ') ? h.slice(7) : undefined;
    if (!token || token.split('.').length !== 3) return null;
    const now = Date.now();
    let claims: Record<string, unknown> | undefined;
    // With a JWKS, the key the token names; the algorithm still comes from that key, not the header.
    let rule = jwtRule;
    if (jwks) {
      let pem: string | undefined;
      try {
        const kid = (JSON.parse(b64uDecode(token.split('.')[0]!).toString('utf8')) as { kid?: unknown }).kid;
        pem = await jwks.pemFor(typeof kid === 'string' ? kid : undefined);
      } catch {
        return null; // no key set to be had (endpoint down past the stale bound): nobody, not an error page
      }
      if (!pem) return null;
      rule = { ...jwtRule, publicKey: pem };
    }
    // `maxTtlSec` (default 1 hour) is enforced by verifyJwt: a token whose exp is further out is refused.
    const verified = verifyJwt(token, { ...rule, maxTtlSec, onClaims: (c) => { claims = c; } }, now);
    if (!verified?.id || !claims) return null;
    if (badSubject(verified.id)) return null;
    if (endUsers.isRevoked) {
      const iat = typeof claims.iat === 'number' ? claims.iat : undefined;
      const jti = typeof claims.jti === 'string' ? claims.jti : undefined;
      try {
        if (await endUsers.isRevoked({ sub: verified.id, ...(iat !== undefined ? { iat } : {}), ...(jti !== undefined ? { jti } : {}) })) return null;
      } catch {
        return null;
      }
    }
    return { kind: 'subject', id: verified.id, roles: [END_USER_ROLE], ...(endUsers.orgId ? { orgId: endUsers.orgId } : {}) };
  };

  // safeEqual loop instead of Set.has (===): so the secret comparison is constant-time (the number of
  // accepted tokens/basics per role is small — loop cost is negligible).
  const matchRole = (req: Request, role: { headers: Set<string>; tokens: Set<string> }): boolean => {
    const h = req.headers.get('authorization') ?? undefined;
    if (h && [...role.headers].some((v) => safeEqual(h, v))) return true;
    /**
     * EventSource can't send headers → ?token= bearer fallback (bearer tokens only).
     * SECURITY NOTE — log-leak risk: a token carried in the query string can leak into web
     * server/proxy access logs, browser history, and (if the URL is shared/redirected) the
     * `Referer` header. This fallback only remains because of the EventSource constraint; prefer
     * @gnldev/studio's short-lived (60s TTL) one-time `POST /auth/sse-ticket` → `?ticket=` flow where
     * possible (see the `/events` endpoint in packages/studio/src/server.ts) — the persistent secret
     * is never carried in the URL.
     */
    // GET only. The constraint this exists for is EventSource, which cannot send headers and only
    // ever issues a GET — so accepting it on POST/DELETE bought nothing, and it authenticated an
    // admin retention purge from a URL, which lands in proxy logs, browser history and `Referer`.
    // The short-lived `?ticket=` flow named above is the preferred path even for the GET.
    if (req.method.toUpperCase() !== 'GET') return false;
    const q = new URL(req.url).searchParams.get('token') ?? undefined;
    return !!q && [...role.tokens].some((v) => safeEqual(q, v));
  };

  /**
   * Principal of the matched class: id + organization bound to the identity (Cred.orgId).
   *
   * `id` is the basic-auth `user` and nothing else — unchanged, pre-existing behavior. A bearer token
   * yields no `id`, and that absence is what tells `resolveResourceId` this deployment has no
   * per-caller subject. `credentialId` is filled separately, for every class, from `tokenId` — a
   * stable fingerprint of the credential that presented itself, for budget/admission keying only (see
   * `tokenId` and the `Principal.credentialId` doc comment for why the two must not be merged).
   *
   * `superAdmin` carries `admin` too, so every existing `roles.includes('admin')` check — here, in
   * @gnldev/server, in @gnldev/studio — keeps working without knowing the class exists; the added
   * `platform-admin` is what widens its SCOPE (scope.ts `principalScope`).
   *
   * The pre-existing `platformAdmin: true` cred flag still injects the same role on any class, so
   * configs written before `superAdmin` existed are unaffected. Prefer the class: it says which
   * credential this IS, rather than adding a privilege to one that reads as an ordinary admin.
   */
  const principalOfRole = (role: 'admin' | 'viewer' | typeof CLIENT_ROLE, cred?: Cred, platform = false): Principal => {
    const roles = role === 'admin' && platform ? ['admin', PLATFORM_ADMIN_ROLE] : [role];
    const credentialId = cred?.token ? tokenId(cred.token) : undefined;
    return {
      // A credential written into the deployment's own config is staff by construction: whoever can
      // edit that file already runs the deployment. `client` is the one class that speaks for
      // somebody else — the application.
      kind: role === CLIENT_ROLE ? 'application' : 'operator',
      roles: cred?.platformAdmin && !roles.includes(PLATFORM_ADMIN_ROLE) ? [...roles, PLATFORM_ADMIN_ROLE] : roles,
      ...(cred?.user ? { id: cred.user } : {}),
      ...(credentialId ? { credentialId } : {}),
      ...(cred?.orgId ? { orgId: cred.orgId } : {}),
    };
  };

  return {
    authenticate(req: Request): Principal | null | Promise<Principal | null> {
      // Most-privileged first: a token configured for two classes resolves to the stronger one, which
      // is the safe direction for `authenticate` (the weaker class would silently under-authorize a
      // credential the host declared as an operator).
      if (superAdmin.headers.size && matchRole(req, superAdmin)) return principalOfRole('admin', cfg.superAdmin, true);
      if (admin.headers.size && matchRole(req, admin)) return principalOfRole('admin', cfg.admin);
      if (client.headers.size && matchRole(req, client)) return principalOfRole(CLIENT_ROLE, cfg.client);
      if (viewer.headers.size && matchRole(req, viewer)) return principalOfRole('viewer', cfg.viewer);
      return endUserOf(req);
    },
    authorize(principal: Principal | null, _req: Request, ctx: AuthContext): Decision {
      const roles = principal?.roles ?? [];
      // No credential (or one that no longer verifies: expired, revoked) is 401 on EVERY route. It was
      // 403 on writes, which told a client holding an expired token "you may not" instead of "who are
      // you" — so a refreshing client could not tell a refresh would help.
      if (!principal) return { allow: false, status: 401, reason: 'unauthorized' };
      // The decision is FREE_ROLE_GRANTS read by the one matcher (permission.ts) — the map and the
      // matcher @gnldev/auth-ee's RBAC starts from, so a licence can only add to it. It was a second,
      // hand-written evaluator ("ends with :read", "is in CLIENT_WRITES") that agreed with the map on
      // the permissions the hosts ask for and disagreed on others (`x:y:read`, `agents:run:x`).
      //
      // A named permission is matched as named, whatever `action` says — as the paid tier does. A
      // coarse check (`allow(req, 'read' | 'write')`, no permission) asks for that action on EVERY
      // resource: `*:read` is covered by `*:read` and `*`, `*:write` by `*` alone — so a route gated
      // coarsely stays admin-only for writes, and an application credential is refused it (the
      // whitelist note in the module header).
      const required = ctx.permission ?? `*:${ctx.action}`;
      if (roles.some((r) => Object.hasOwn(FREE_ROLE_GRANTS, r) && grantsAllow(FREE_ROLE_GRANTS[r]!, required))) return { allow: true };
      if (!isWrite(ctx)) return { allow: false, status: 401, reason: 'unauthorized' };
      if (roles.includes(CLIENT_ROLE) || roles.includes(END_USER_ROLE)) {
        return { allow: false, status: 403, reason: `unauthorized (${roles.includes(END_USER_ROLE) ? "an end user" : "client credentials"} cannot ${ctx.permission ?? 'perform this write'})` };
      }
      return { allow: false, status: 403, reason: 'unauthorized (admin required)' };
    },
    capabilities() {
      return { sso: false, rbac: false, audit: false, multiOrganization: false, users: false };
    },
  };
}
