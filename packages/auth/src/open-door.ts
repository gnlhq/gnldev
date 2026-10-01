// The providerless protections, for a standalone door.
//
// @gnldev/server and @gnldev/studio refuse two things on a surface with no identity (makeGate): a
// cross-site state change (a `<form enctype="text/plain">` on any site, which needs no CORS preflight)
// and a request addressed by a name somebody else could point here (DNS rebinding — the rebound page is
// same-origin, so it can also READ the answer). The standalone doors — @gnldev/chat-adapter's
// `createChatRoute`, @gnldev/agui's `createAguiRoute`, @gnldev/mcp's `createMcpServer` over HTTP — did
// neither. Measured on a real loopback socket with the quickstart shape (no `identify`): a cross-site
// `text/plain` POST ran the model and appended to a thread, and a rebound page replayed a run and read
// the thread's earlier messages back.
//
// WHEN they apply is not decided here: `doorGate` (door.ts) asks `carriesIdentity` with the principal the
// door's `identify` resolved for the request, and asks this guard only when there is none. Having an
// `identify` is not having an identity — `identify: () => undefined`, or an `identify` that answers
// nothing for an anonymous visitor, resolves nobody, so both checks run. The way through is the gate's
// (`allowedHosts` / GNL_ALLOWED_HOSTS) for the host rule, and `allowCrossSite: true` — a door meant to be
// embedded on other sites, such as a public chat widget — for the cross-site check alone.
import { isCrossSiteStateChange, isHostAllowed, hostnameOf, crossSiteRefusedMessage } from './same-site.js';
import { hostAllowList, hostNotAllowedMessage } from './gate.js';
import { AUTH_ERROR_CODES, AUTH_ERROR_STATUS } from './decision.js';

export interface OpenDoorGuardOptions {
  /** The same list as `makeGate`'s `allowedHosts` (and GNL_ALLOWED_HOSTS adds to it). */
  allowedHosts?: readonly string[] | true;
  /**
   * `true` for a door that pages on other sites are meant to call with no identity — a chat widget
   * embedded on a customer's website. Lifts the cross-site check only; the host rule stays.
   */
  allowCrossSite?: boolean;
  /** How the door is built, for the refusal's way through — e.g. `'createChatRoute'`. */
  door: string;
}

/** What a door answers when a providerless protection refuses a request. */
export interface OpenDoorRefusal {
  /** `AUTH_ERROR_STATUS[code]`. */
  status: number;
  code: typeof AUTH_ERROR_CODES.hostNotAllowed | typeof AUTH_ERROR_CODES.crossSiteRefused;
  error: string;
  /** The hostname the request named — for `host_not_allowed`. */
  host?: string;
}

/**
 * The providerless protections as one function a door asks per request with no identity: `undefined`
 * to go on, or the refusal to answer with. Build it once, where the door is built — an `allowedHosts`
 * entry that can never match throws there, naming the fix.
 */
export function openDoorGuard(opts: OpenDoorGuardOptions): (req: Request) => OpenDoorRefusal | undefined {
  const allowed = hostAllowList(opts.allowedHosts);
  const options = `the ${opts.door} options`;
  let warnedHost = false;
  let warnedCrossSite = false;
  return (req) => {
    const host = req.headers.get('host');
    if (host && !isHostAllowed(host, allowed())) {
      const name = hostnameOf(host);
      const error = hostNotAllowedMessage(name, { door: opts.door });
      if (!warnedHost) {
        warnedHost = true;
        console.warn(`@gnldev/auth: refused a request addressed to "${name}". ${error}`);
      }
      const code = AUTH_ERROR_CODES.hostNotAllowed;
      return { status: AUTH_ERROR_STATUS[code]!, code, error, host: name };
    }
    if (opts.allowCrossSite !== true && isCrossSiteStateChange(req)) {
      const error = crossSiteRefusedMessage(
        `pass allowCrossSite: true in ${options} for a door embedded on other sites (a public chat widget; the host rule still applies), ` +
          `or \`identify: (req) => principal\` there, reading a verified token, so the request carries an identity`,
      );
      if (!warnedCrossSite) {
        warnedCrossSite = true;
        console.warn(`@gnldev/auth: ${error}`);
      }
      const code = AUTH_ERROR_CODES.crossSiteRefused;
      return { status: AUTH_ERROR_STATUS[code]!, code, error };
    }
    return undefined;
  };
}
