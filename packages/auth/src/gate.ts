// The shared gate: hosts (server/studio) don't rewrite allow/deny logic.
//
// Takes a web-standard `Request`, not a framework's context object. A host writing an auth callback
// used to need Hono's `Context` type in its own signature, which quietly tied its Hono version to
// ours — the same coupling the factories dropped when they stopped returning a Hono app. Everything
// the gate reads (method, path, headers, query) is on `Request`; nothing was lost by narrowing.
import { refuseUnknownNames, optionNames } from '@gnldev/options';
import type { AuthContext, AuthProvider, Decision, Principal } from './types.js';
import { bindsIdentity } from './adapter.js';
import { openSurfaceGuard, type HostRuleAuth, type OpenSurfaceRefusal } from './open-surface.js';
import { isReadPermission } from './permission.js';
import { notePrincipal, noteVerdict, settleDecision, authErrorResponse } from './decision.js';

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
/** Requests an open-surface protection refused (`openSurfaceGuard`) — `deny()` answers them with it. */
const openRefusals = new WeakMap<Request, OpenSurfaceRefusal>();

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
  /**
   * `true` for a surface pages on other sites are meant to call with no identity — a public widget
   * embedded on a customer's website. Lifts the cross-site check only; the host rule stays. The same
   * option, with the same meaning, as a standalone door's (`createChatRoute`, `createAguiRoute`,
   * `createMcpServer`) — both are read by `openSurfaceGuard`. A request that resolves to a caller is never
   * cross-site-checked, so a surface whose callers all send a credential needs no option.
   */
  allowCrossSite?: boolean;
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
  refuseUnknownNames('makeGate', opts, GATE_NAMES);
  // Fail-open audit at SETUP time: in production, a providerless gate can only be set up with the deliberate flag.
  // (If left to request time, the error would blow up on the first request after deploy — an early, clear failure was preferred.)
  if (!provider && process.env.NODE_ENV === 'production' && opts?.allowOpenAccess !== true) {
    throw new Error(
      'auth is required in production; for deliberately open access, set allowOpenAccess: true (see @gnldev/auth makeGate / host options)',
    );
  }
  // Non-production providerless gate: warn ONCE on the first request (no silent openness), then open.
  let warnedOpen = false;
  // Every host (createRestApi, createStudioApp, `gnl dev`, `gnl studio`, a project's own server) builds
  // its gate through this function, so GNL_ALLOWED_HOSTS reaches all of them with no plumbing — `gnl dev`
  // builds its hosts from the PROJECT's installed packages and could not pass an option through them
  // anyway. It is read per request (memoised on its value): read once at build, a variable that dotenv
  // loaded after the app module was silently ignored.
  // Why a request that resolved to nobody resolved to nobody — for the refusal's wording only. WHETHER the
  // checks run, and what they refuse, is `openSurfaceGuard`'s, the function every door asks too.
  const hostRuleAuth: HostRuleAuth = !provider ? 'none' : bindsIdentity(provider) ? 'unnamed' : 'read-write';
  const openSurface = openSurfaceGuard({
    surface: { gate: hostRuleAuth },
    ...(opts?.allowedHosts !== undefined ? { allowedHosts: opts.allowedHosts } : {}),
    ...(opts?.allowCrossSite !== undefined ? { allowCrossSite: opts.allowCrossSite } : {}),
  });

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
   * One request through the gate, for `allow` and `allowP` alike — in the order every door runs (`doorGate`):
   *   1. who: the provider authenticates the request (no provider: nobody);
   *   2. the role: the provider's `authorize`; a refusal is answered as the provider answered it
   *      (`roleAuth`'s 401 for no token or a wrong one, on any name, from any site);
   *   3. the open-surface protections, `openSurfaceGuard`, with the principal step 1 resolved.
   */
  async function decide(req: Request, ctx: AuthContext): Promise<boolean> {
    let principal: Principal | null = null;
    if (provider) {
      principal = await provider.authenticate(req);
      if (principal) principals.set(req, principal);
      const decision = await provider.authorize(principal, req, ctx);
      notePrincipal(req, principal);
      noteVerdict(req, ctx, decision);
      if (!decision.allow) {
        decisions.set(req, decision);
        return false;
      }
    }
    const refused = openSurface(req, principal);
    if (refused) {
      openRefusals.set(req, refused);
      return false;
    }
    return provider ? true : openSurfaceAllows(req);
  }

  return {
    allow(req, action, resource) {
      return decide(req, { path: new URL(req.url).pathname, method: req.method, action, resource });
    },
    allowP(req, permission) {
      return decide(req, permissionContext(req, permission));
    },
    deny(req, action) {
      const refused = openRefusals.get(req);
      if (refused) return authErrorResponse(refused.code, { error: refused.error, ...(refused.host !== undefined ? { host: refused.host } : {}) });
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

const GATE_NAMES = optionNames<GateOptions>()(['allowOpenAccess', 'allowedHosts', 'allowCrossSite']);
