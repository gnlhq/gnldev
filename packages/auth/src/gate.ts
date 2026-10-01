// The shared gate: hosts (server/studio) don't rewrite allow/deny logic.
//
// Takes a web-standard `Request`, not a framework's context object. A host writing an auth callback
// used to need Hono's `Context` type in its own signature, which quietly tied its Hono version to
// ours — the same coupling the factories dropped when they stopped returning a Hono app. Everything
// the gate reads (method, path, headers, query) is on `Request`; nothing was lost by narrowing.
import type { AuthContext, AuthProvider, Decision, Principal } from './types.js';
import { isCrossSiteStateChange, isHostAllowed, hostnameOf, allowedHostEntry, readAllowedHosts, crossSiteRefusedMessage } from './same-site.js';
import { bindsIdentity, carriesIdentity } from './adapter.js';
import { isReadPermission } from './permission.js';
import { notePrincipal, noteVerdict, markRefusal, settleDecision, authErrorResponse, AUTH_ERROR_CODES } from './decision.js';

/** The way through a cross-site refusal on REST / Studio. */
const CROSS_SITE_WAY = "give it an identity to check — an auth provider that binds one, auth: roleAuth({ admin: { token } }) — or serve the page from this machine (a dev-server proxy to the API)";

export interface Gate {
  /** Is access allowed? true if there's no provider (opt-in: gate not set up → open; see makeGate in production). */
  allow(req: Request, action: 'read' | 'write', resource?: string): Promise<boolean>;
  /**
   * Fine-grained variant of allow(): checks a SPECIFIC permission (e.g. 'agents:run', 'users:write').
   *   • No provider (auth off) → true (unchanged opt-in behavior).
   *   • EE / RBAC provider → the permission is passed through `AuthContext.permission` and matched against
   *     the principal's EFFECTIVE permissions (explicit `permissions[]` ?? role grants) — see rbac.ts.
   *   • Free / read-write provider → the permission is REDUCED to read/write (`isReadPermission`: what
   *     `*:read` covers is a read, else write) and evaluated coarsely. This makes `allowP(req,'X:write') ≡ allow(req,'write')` and
   *     `allowP(req,'*:read') ≡ allow(req,'read')` in the free tier → no regression.
   * A denial records its decision against the request (like allow) so `deny()` can surface status/reason.
   */
  allowP(req: Request, permission: string): Promise<boolean>;
  /** Return the denial. If allow() attached its last decision to the context, use its status/reason. */
  deny(req: Request, action: 'read' | 'write'): Response;
  /**
   * Report the request's outcome to the provider's `onDecision`, once, with the status the caller got.
   * The host calls it when it has answered (see `markRefusal` for the refusals only the host can see).
   * No provider, or none with `onDecision`: nothing. Throws what `onDecision` throws.
   */
  settle(req: Request, status: number): Promise<void>;
}

// Per-request state, keyed by the request itself rather than stashed as a property on it. A Request
// is somebody else's object; writing hidden fields onto it worked, but it also meant two libraries
// could pick the same key. A WeakMap cannot collide and cannot leak — the entry dies with the request.
const principals = new WeakMap<Request, Principal>();
const decisions = new WeakMap<Request, Decision>();
/** Requests refused by the host rule, with the hostname they named — `deny()` answers them with it. */
const hostRefusals = new WeakMap<Request, { name: string; auth: HostRuleAuth }>();
/** Requests refused as a cross-site state change — `deny()` answers them with `cross_site_refused`. */
const crossSiteRefusals = new WeakSet<Request>();

/**
 * The principal authenticated during allow() (within the same request). Hosts derive the organization
 * scope and audit actor from here → closed to header spoofing. Null if allow() hasn't been called yet.
 */
export function principalOf(req: Request): Principal | null {
  return principals.get(req) ?? null;
}

export interface GateOptions {
  /**
   * DELIBERATE permission for a providerless gate in production. Auth stays opt-in; but silent
   * fail-open is impossible under NODE_ENV=production — either a provider is given or this flag is
   * explicitly set to true (audit #2).
   */
  allowOpenAccess?: boolean;
  /**
   * Host names a surface with NO identity to authenticate (no provider, or a `{read,write}` pair) also
   * answers, besides `localhost`, `*.localhost` and any IP address — which it always answers. Any other
   * name is refused 403 `host_not_allowed`: that is what a DNS-rebinding page sends, and it could
   * otherwise read runs and drive writes through the browser of whoever visits it.
   *
   * List the names you really use: a custom dev hostname (`'mybox.test'`), a tunnel or Codespaces
   * domain with a leading dot for every name under it (`'.ngrok-free.app'`, `'.trycloudflare.com'`,
   * `'.app.github.dev'`; `'*.ngrok-free.app'` means the same), a Docker service name (`'api'`). A URL or
   * a `:port` is read as its hostname. An entry that could never match a Host header (`'*'`, a wildcard
   * mid-name, a space) throws where the gate is built, naming the fix. `true` answers every name — for a
   * server behind a proxy that sets its own Host. The `GNL_ALLOWED_HOSTS` environment variable
   * (comma-separated, or `*`) adds to this list and is read when a request is answered, so `gnl dev`,
   * `gnl studio` and your own server all take it with no code change — also when it is loaded (dotenv)
   * after the module that builds the server.
   *
   * With a provider that binds an identity, a request that resolved to a caller is answered under any
   * name (its bearer token is the defence, and a rebound page cannot read it). A request that resolved
   * to NOBODY and that the provider allowed anyway — a provider serving anonymous reads — is held to
   * this list like a surface with no auth: it carries no token for a rebound page to lack.
   */
  allowedHosts?: readonly string[] | true;
}

/**
 * Why the host rule applied: the surface has no auth (`'none'`), its auth names no identity (`'read-write'`:
 * a `{ read, write }` pair or `bindsIdentity: false`), or its provider names identities and this request
 * resolved to none, and was allowed anyway (`'unnamed'`).
 */
export type HostRuleAuth = 'none' | 'read-write' | 'unnamed';

/**
 * Name suffixes of tunnels and hosted dev environments that hand out a NEW name per session: for these the
 * useful entry is the leading-dot domain, not the name in front of the developer today.
 */
const SESSION_NAME_DOMAINS = ['ngrok-free.app', 'ngrok-free.dev', 'ngrok.app', 'ngrok.io', 'trycloudflare.com', 'app.github.dev', 'githubpreview.dev', 'gitpod.io', 'loca.lt', 'devtunnels.ms', 'ts.net'];

/**
 * The sentence a host-rule refusal carries: what is true about this surface, what happened, and the one
 * line that lets the name in.
 *
 * `opts.auth` says why the rule applies — no auth at all, or a `{ read, write }` pair, whose predicates
 * name no identity (a pair is refused too: a predicate is opaque, and a rebound page is same-origin, so it
 * may send any header, a token-shaped one included). `opts.door` is set by a standalone door, for a request
 * its `identify` resolved no principal for (`'createChatRoute'`), and names where its `allowedHosts` goes.
 */
export function hostNotAllowedMessage(hostname: string, opts: { auth?: HostRuleAuth; door?: string } = {}): string {
  const suffix = SESSION_NAME_DOMAINS.find((d) => hostname.endsWith(`.${d}`));
  const entry = suffix ? `.${suffix}` : hostname;
  const where = opts.door ? `the ${opts.door} options` : 'the createRestApi / createStudioApp options';
  const what = opts.door
    ? `this request carried no identity the ${opts.door} door resolved (it has no \`identify\`, or \`identify\` answered nothing for it), so it is answered only when addressed as localhost or by an IP address`
    : opts.auth === 'read-write'
      ? `this server's auth names no identity (a { read, write } pair, or a provider with bindsIdentity: false) — so, like a server with no auth, it answers only requests addressed to it as localhost or by an IP address`
      : opts.auth === 'unnamed'
        ? `this request resolved to no caller (the auth provider named nobody for it) and the provider allowed it anyway — so, like a request to a server with no auth, it is answered only when addressed as localhost or by an IP address`
        : `this server has no auth provider, so it answers only requests addressed to it as localhost or by an IP address`;
  return (
    `${what}, and this one was addressed to "${hostname}" (the shape of a DNS-rebinding page). ` +
    `If that name is yours — a LAN hostname, a tunnel, Codespaces, a Docker service — list it: ` +
    `allowedHosts: ['${entry}'] in ${where}, or GNL_ALLOWED_HOSTS=${entry} in the environment (gnl dev, gnl studio; read on every request)` +
    (suffix ? `; the leading dot means '${suffix}' and every name under it, which a new tunnel name each session needs` : '') +
    '.' +
    (opts.auth === 'read-write'
      ? ` Or authenticate with a provider that binds an identity — auth: roleAuth({ admin: { token } }) — which answers any name, because a rebound page cannot read its token.`
      : opts.auth === 'unnamed'
        ? ` Or send a credential the provider resolves to a caller (Authorization: Bearer …): a request that carries one is answered under any name, because a rebound page cannot read it.`
        : '') +
    ` See docs/errors/host_not_allowed.md.`
  );
}

/**
 * The host-rule allow-list of one surface: the option, validated where the surface is built (an entry
 * that could never match throws, naming the fix), plus `GNL_ALLOWED_HOSTS`, read when a request is
 * answered. ONE implementation for every surface without an identity — the REST and Studio gate
 * (`makeGate`) and the standalone doors (`openDoorGuard`).
 */
export function hostAllowList(allowedHosts: readonly string[] | true | undefined): () => readonly string[] | true {
  const fromOption: readonly string[] | true =
    allowedHosts === true
      ? true
      : (allowedHosts ?? []).map((raw) => {
          const parsed = allowedHostEntry(raw);
          if ('entry' in parsed) return parsed.entry;
          throw new TypeError(`@gnldev/auth: allowedHosts entry ${JSON.stringify(raw)} can never match a Host header: ${parsed.problem}.`);
        });
  let lastRaw: string | undefined;
  let lastHosts: string[] | true = [];
  return () => {
    if (fromOption === true) return true;
    const raw = process.env.GNL_ALLOWED_HOSTS;
    if (raw !== lastRaw) {
      lastRaw = raw;
      const { hosts, invalid } = readAllowedHosts(raw);
      lastHosts = hosts;
      if (invalid.length) {
        console.warn(`@gnldev/auth: GNL_ALLOWED_HOSTS entries that can never match a Host header were skipped: ${invalid.map((i) => JSON.stringify(i)).join(', ')}. Write a host name ('mybox.test'), a leading-dot domain ('.ngrok-free.app'), or a URL ('http://mybox.test:4111').`);
      }
    }
    return lastHosts === true ? true : [...fromOption, ...lastHosts];
  };
}

/**
 * The context a provider's `authorize` is asked with for one permission. ONE place, because a role must mean
 * the same thing on every door that asks: @gnldev/server's and Studio's gate (`allowP`) and a standalone
 * door handed `authorize` (`authorizeDoorRequest`). The two built it separately for a day.
 *
 * Reduction for a provider that only knows read/write (a `{ read, write }` pair, a hand-written provider):
 * a permission the grant `*:read` covers is a read, everything else is a write — `isReadPermission`, the
 * one matcher's answer (permission.ts), so the reduction and every grant evaluator agree on what a read
 * is. `roleAuth` and an RBAC provider match `permission` itself with that matcher.
 */
export function permissionContext(req: Request, permission: string): { path: string; method: string; action: 'read' | 'write'; permission: string } {
  const action: 'read' | 'write' = isReadPermission(permission) ? 'read' : 'write';
  return { path: new URL(req.url).pathname, method: req.method, action, permission };
}

export function makeGate(provider?: AuthProvider, opts?: GateOptions): Gate {
  // Fail-open audit at SETUP time: in production, a providerless gate can only be set up with the deliberate flag.
  // (If left to request time, the error would blow up on the first request after deploy — an early, clear failure was preferred.)
  if (!provider && process.env.NODE_ENV === 'production' && opts?.allowOpenAccess !== true) {
    throw new Error(
      'auth is required in production; for deliberately open access, set allowOpenAccess: true (see @gnldev/auth makeGate / host options)',
    );
  }
  // Non-production providerless gate: warn ONCE on the first request (no silent openness), then open.
  let warnedOpen = false;
  let warnedCrossSite = false;
  let warnedHost = false;
  // Every host (createRestApi, createStudioApp, `gnl dev`, `gnl studio`, a project's own server) builds
  // its gate through this function, so GNL_ALLOWED_HOSTS reaches all of them with no plumbing — `gnl dev`
  // builds its hosts from the PROJECT's installed packages and could not pass an option through them
  // anyway. It is read per request (memoised on its value): read once at build, a variable that dotenv
  // loaded after the app module was silently ignored.
  const allowedHosts = hostAllowList(opts?.allowedHosts);
  const hostRuleAuth: HostRuleAuth = provider ? 'read-write' : 'none';

  /**
   * Was this request addressed by a name somebody else could point here — against a surface with no
   * identity to ride? Checked on EVERY method, reads included: after a DNS rebind the page is
   * same-origin, so it can read what it is answered. Same identity condition as the cross-site check
   * below, and for the same reason. A request with no Host header is not a browser request over
   * HTTP/1.1 (an in-process `app.fetch`, or HTTP/2, which a browser speaks only over TLS, where a
   * rebound name fails the certificate before any request is sent), so there is nothing to check.
   */
  function hostWithoutIdentity(req: Request, auth: HostRuleAuth = hostRuleAuth): boolean {
    if (auth !== 'unnamed' && carriesIdentity({ provider })) return false;
    const host = req.headers.get('host');
    if (!host || isHostAllowed(host, allowedHosts())) return false;
    const name = hostnameOf(host);
    hostRefusals.set(req, { name, auth });
    // Recorded for `onDecision`: with a provider, the verdict noted before this said allowed.
    markRefusal(req, 'policy', { detail: AUTH_ERROR_CODES.hostNotAllowed });
    if (!warnedHost) {
      warnedHost = true;
      console.warn(`@gnldev/auth: refused a request addressed to "${name}". ${hostNotAllowedMessage(name, { auth })}`);
    }
    return true;
  }

  /**
   * The providerless decision, in ONE place.
   *
   * It was written inline in `allow()` only, so `allowP()` — the fine-grained entry point, and the one
   * 23 endpoints across @gnldev/server and @gnldev/studio actually call — kept an unconditional
   * `return true`. Which meant the cross-site block covered the coarse path and left the specific one
   * open: a page on another site could still drive every endpoint that asks for a named permission.
   * Two copies of a security decision is one copy too many.
   */
  /**
   * Is this request a cross-site state change against a surface with NO IDENTITY to ride?
   *
   * The condition is about identity, not about the presence of a provider — and getting that wrong
   * left a hole. A legacy `{read,write}` pair IS a provider after normalizeAuth, so keying on
   * `!provider` skipped the check for it; but that pair has no principal model at all (its
   * authenticate() is `return null` by construction), so there is no credential a cross-site page
   * could be riding, and its predicate answers on the request alone. Measured: with
   * `{read:()=>true, write:()=>true}` configured, a cross-site `POST /api/retention/sweep` was
   * ALLOWED. examples/app ships exactly that shape, so it was the published example that was open.
   *
   * `carriesIdentity({ provider: undefined })` is false, so the providerless case is covered by the same
   * test — and it is the same function a standalone door asks (`doorGate`), with the principal it resolved.
   */
  function crossSiteWithoutIdentity(req: Request): boolean {
    if (carriesIdentity({ provider }) || !isCrossSiteStateChange(req)) return false;
    crossSiteRefusals.add(req);
    if (!warnedCrossSite) {
      warnedCrossSite = true;
      console.warn(
        '@gnldev/auth: blocked a cross-site write to a surface with no identity to authenticate ' +
        'against. A page on another site attempted a state-changing request. Configure an auth ' +
        'provider that binds an identity if this surface is meant to be reachable by other origins.',
      );
    }
    return true;
  }

  function openSurfaceAllows(req: Request): boolean {
    // The warning is an INSTRUCTION ("for deliberate open access use allowOpenAccess: true"), so it
    // must stop once the instruction has been followed. It did not: the flag suppressed the
    // production throw but not this line, so a developer who set it kept being told to set it — which
    // teaches that the flag is inert and that this package's auth warnings can be ignored. Under
    // NODE_ENV=production the same flag is already accepted as the whole declaration of intent; there
    // is no reason for dev to demand it twice and then not honour it.
    //
    // Openness WITHOUT the flag still warns, every process, exactly as before — that is the case the
    // message was written for.
    if (!warnedOpen && opts?.allowOpenAccess !== true && process.env.NODE_ENV !== 'production') {
      warnedOpen = true;
      console.warn(
        '@gnldev/auth: no provider given → ALL endpoints are open (opt-in gate not set up). Add auth before production; for deliberate open access use allowOpenAccess: true.',
      );
    }
    return true;
  }
  /**
   * One request through the gate, for `allow` and `allowP` alike.
   *
   * WHEN the open-surface checks run depends on what the provider can know:
   *   • no provider, or one with no principal model (`bindsIdentity: false`, a `{ read, write }` pair):
   *     no request can carry an identity, so the host rule and the cross-site check run FIRST, as before;
   *   • a provider that binds identities: the request is authenticated, and the host rule runs for a
   *     request that resolved to nobody the engine holds to a name (`carriesIdentity({ principal })`, the
   *     question a standalone door asks) and that `authorize` ALLOWED. Asked before, with the provider
   *     alone — a configuration question — a provider that serves anonymous reads served them to a
   *     DNS-rebound page: measured, Studio answered `GET /runs` to `Host: evil.example` with no token,
   *     prompts included. A refused request is answered exactly as before (`roleAuth`'s 401 for no
   *     token is unchanged on every host name): nothing was going to be served.
   *
   * The cross-site check is NOT extended the same way. A provider that names identities and allows an
   * anonymous WRITE has said anybody may make it, and a page on another site could be such a caller
   * (a public widget). REST and Studio have no option to say "other sites may embed this" (a door has
   * `allowCrossSite`), so refusing it would leave that deployment with no way through.
   */
  async function decide(req: Request, ctx: AuthContext): Promise<boolean> {
    const binds = bindsIdentity(provider);
    if (!binds && (hostWithoutIdentity(req) || crossSiteWithoutIdentity(req))) return false;
    if (!provider) return openSurfaceAllows(req);
    const principal = await provider.authenticate(req);
    if (principal) principals.set(req, principal);
    const decision = await provider.authorize(principal, req, ctx);
    notePrincipal(req, principal);
    noteVerdict(req, ctx, decision);
    if (!decision.allow) {
      decisions.set(req, decision);
      return false;
    }
    if (binds && !carriesIdentity({ principal }) && hostWithoutIdentity(req, 'unnamed')) return false;
    return true;
  }

  return {
    allow(req, action, resource) {
      return decide(req, { path: new URL(req.url).pathname, method: req.method, action, resource });
    },
    allowP(req, permission) {
      return decide(req, permissionContext(req, permission));
    },
    deny(req, action) {
      const refusedHost = hostRefusals.get(req);
      if (refusedHost !== undefined) {
        return authErrorResponse(AUTH_ERROR_CODES.hostNotAllowed, { error: hostNotAllowedMessage(refusedHost.name, { auth: refusedHost.auth }), host: refusedHost.name });
      }
      if (crossSiteRefusals.has(req)) {
        return authErrorResponse(AUTH_ERROR_CODES.crossSiteRefused, { error: crossSiteRefusedMessage(CROSS_SITE_WAY) });
      }
      const d = decisions.get(req);
      const denied = d && d.allow === false ? d : undefined;
      const status = denied?.status ?? (action === 'write' ? 403 : 401);
      const reason = denied?.reason ?? (action === 'write' ? 'unauthorized (admin required)' : 'unauthorized');
      return Response.json({ error: reason }, { status });
    },
    async settle(req, status) {
      if (!provider?.onDecision) return;
      await settleDecision((d) => provider.onDecision!(d), req, status);
    },
  };
}
