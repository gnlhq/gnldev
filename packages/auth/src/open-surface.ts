// The open-surface protections — the ONE owner of "may this request skip them, and if not, is it refused?"
//
// A surface refuses two things for a request that carries no identity: a cross-site state change (a
// `<form enctype="text/plain">` on any site, which needs no CORS preflight) and a request addressed by a
// name somebody else could point here (DNS rebinding — the rebound page is same-origin, so it can also
// READ the answer). Every surface asks this one function, per request, with the principal it resolved:
// @gnldev/server's and @gnldev/studio's gate (`makeGate`, with what its provider authenticated — nobody
// without a provider or with a `{ read, write }` pair) and every standalone door (`doorGate`, with what its
// `identify` resolved) — `createChatRoute`, `createAguiRoute`, `createMcpServer` over HTTP.
//
// It was three things before: the gate asked "does the PROVIDER bind identities?" (a configuration
// question) and ran its own copy of both checks; the doors asked the principal and ran this file's copy.
// Measured with a provider that names identities and lets anonymous requests through: a DNS-rebound page
// read Studio's runs (fixed for the host rule alone in round 5), and a page on another site swept Studio's
// retention (`POST /api/retention/sweep`, cross-site, no credential → 200). One function, one question.
//
// The ways through are the same everywhere: `allowedHosts` / GNL_ALLOWED_HOSTS for the host rule;
// `allowCrossSite: true` — a surface other sites embed, such as a public chat widget — for the cross-site
// check alone; or a credential the surface resolves to a caller, for both.
import { refuseUnknownNames, optionNames } from '@gnldev/options';
import type { Principal } from './types.js';
import { isCrossSiteStateChange, isHostAllowed, hostnameOf, allowedHostEntry, readAllowedHosts, crossSiteRefusedMessage } from './same-site.js';
import { carriesIdentity } from './adapter.js';
import { AUTH_ERROR_CODES, AUTH_ERROR_STATUS, markRefusal } from './decision.js';

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
 * @internal — door plumbing shared by the GNL doors; gnl builds its argument, no host writes it.
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
 * (`makeGate`) and the standalone doors (`doorGate`), through `openSurfaceGuard`.
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

/** Which surface is asking — for the refusal's wording only; the decision is the same for all. */
export type OpenSurface =
  /** @gnldev/server / @gnldev/studio, and why a request there resolves to nobody. */
  | { gate: HostRuleAuth }
  /** A standalone door, by how it is built — e.g. `'createChatRoute'`. */
  | { door: string };

export interface OpenSurfaceGuardOptions {
  surface: OpenSurface;
  /** The host rule's list (GNL_ALLOWED_HOSTS adds to it). */
  allowedHosts?: readonly string[] | true;
  /**
   * `true` for a surface that pages on other sites are meant to call with no identity — a chat widget
   * embedded on a customer's website. Lifts the cross-site check only; the host rule stays.
   */
  allowCrossSite?: boolean;
}

/** What a surface answers when an open-surface protection refuses a request. */
export interface OpenSurfaceRefusal {
  /** `AUTH_ERROR_STATUS[code]`. */
  status: number;
  code: typeof AUTH_ERROR_CODES.hostNotAllowed | typeof AUTH_ERROR_CODES.crossSiteRefused;
  error: string;
  /** The hostname the request named — for `host_not_allowed`. */
  host?: string;
}

const GATE_OPTIONS = 'the createRestApi / createStudioApp options';

function crossSiteWay(surface: OpenSurface): string {
  if ('door' in surface) {
    return `pass allowCrossSite: true in the ${surface.door} options for a door embedded on other sites (a public chat widget; the host rule still applies), ` +
      `or \`identify: (req) => principal\` there, reading a verified token, so the request carries an identity`;
  }
  const optOut = `pass allowCrossSite: true in ${GATE_OPTIONS} for a surface other sites embed (a public widget; the host rule still applies)`;
  return surface.gate === 'unnamed'
    ? `send a credential the auth provider resolves to a caller (Authorization: Bearer …), or ${optOut}`
    : `give it an identity to check — an auth provider that binds one, auth: roleAuth({ admin: { token } }) — or ${optOut}, or serve the page from this machine (a dev-server proxy to the API)`;
}

/**
 * The open-surface protections as one function every surface asks per request, AFTER it has decided who
 * is calling and whether that caller may do this (a refused request is answered with its own refusal —
 * `roleAuth`'s 401 — whatever its name or site: nothing was going to be served).
 *
 *   1. a request that carries an identity (`carriesIdentity({ principal })`: a caller the engine holds to
 *      a name) skips both checks — its credential is the defence, and no other site can read it;
 *   2. otherwise the host rule, then the cross-site check (`allowCrossSite: true` lifts the latter).
 *
 * Returns `undefined` to go on, or the refusal to answer with, already recorded for `onDecision`
 * (`policy`, detail = the code). Build it once, where the surface is built: an `allowedHosts` entry that
 * can never match throws there, naming the fix.
 */
export function openSurfaceGuard(opts: OpenSurfaceGuardOptions): (req: Request, principal: Principal | null | undefined) => OpenSurfaceRefusal | undefined {
  refuseUnknownNames('openSurfaceGuard', opts, OPEN_SURFACE_GUARD_NAMES);
  const allowed = hostAllowList(opts.allowedHosts);
  const { surface } = opts;
  let warnedHost = false;
  let warnedCrossSite = false;
  return (req, principal) => {
    if (carriesIdentity({ principal })) return undefined;
    const host = req.headers.get('host');
    // No Host header: not a browser request over HTTP/1.1 (an in-process fetch, or HTTP/2, which a browser
    // speaks only over TLS, where a rebound name fails the certificate first) — nothing to check.
    if (host && !isHostAllowed(host, allowed())) {
      const name = hostnameOf(host);
      const error = hostNotAllowedMessage(name, 'door' in surface ? { door: surface.door } : { auth: surface.gate });
      if (!warnedHost) {
        warnedHost = true;
        console.warn(`@gnldev/auth: refused a request addressed to "${name}". ${error}`);
      }
      return refuse(req, { code: AUTH_ERROR_CODES.hostNotAllowed, error, host: name });
    }
    if (opts.allowCrossSite !== true && isCrossSiteStateChange(req)) {
      const error = crossSiteRefusedMessage(crossSiteWay(surface));
      if (!warnedCrossSite) {
        warnedCrossSite = true;
        console.warn(`@gnldev/auth: blocked a cross-site write. ${error}`);
      }
      return refuse(req, { code: AUTH_ERROR_CODES.crossSiteRefused, error });
    }
    return undefined;
  };
}

function refuse(req: Request, r: Omit<OpenSurfaceRefusal, 'status'>): OpenSurfaceRefusal {
  // Recorded for `onDecision`: a provider's verdict noted before this said allowed.
  markRefusal(req, 'policy', { detail: r.code });
  return { status: AUTH_ERROR_STATUS[r.code]!, ...r };
}

const OPEN_SURFACE_GUARD_NAMES = optionNames<OpenSurfaceGuardOptions>()(['surface', 'allowedHosts', 'allowCrossSite']);
