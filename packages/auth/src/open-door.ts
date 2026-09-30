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
// A door has no provider; its `identify` is the analogue. With `identify` the application owns who the
// caller is, as a provider does on REST — the door does not second-guess it (`identify: () => undefined`
// is the explicit "this door has no per-user identity, on purpose"). WITHOUT `identify` it gets exactly
// the gate's two checks, from the same functions, with the same way through (`allowedHosts` /
// GNL_ALLOWED_HOSTS).
import { isCrossSiteStateChange, isHostAllowed, hostnameOf, crossSiteRefusedMessage } from './same-site.js';
import { hostAllowList, hostNotAllowedMessage } from './gate.js';
import { AUTH_ERROR_CODES } from './decision.js';

export interface OpenDoorGuardOptions {
  /** The same list as `makeGate`'s `allowedHosts` (and GNL_ALLOWED_HOSTS adds to it). */
  allowedHosts?: readonly string[] | true;
  /** How the door is built, for the refusal's way through — e.g. `'createChatRoute'`. */
  door: string;
}

/** What a door answers when a providerless protection refuses a request. */
export interface OpenDoorRefusal {
  status: 403;
  code: typeof AUTH_ERROR_CODES.hostNotAllowed | typeof AUTH_ERROR_CODES.crossSiteRefused;
  error: string;
  /** The hostname the request named — for `host_not_allowed`. */
  host?: string;
}

/**
 * The providerless protections as one function a door asks per request: `undefined` to go on, or the
 * refusal to answer with (403). Build it once, where the door is built — an `allowedHosts` entry that
 * can never match throws there, naming the fix.
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
      return { status: 403, code: AUTH_ERROR_CODES.hostNotAllowed, error, host: name };
    }
    if (isCrossSiteStateChange(req)) {
      const error = crossSiteRefusedMessage(`pass \`identify: (req) => principal\` in ${options} (from a verified token), or \`identify: () => undefined\` to declare, on purpose, that it has no per-user identity`);
      if (!warnedCrossSite) {
        warnedCrossSite = true;
        console.warn(`@gnldev/auth: ${error}`);
      }
      return { status: 403, code: AUTH_ERROR_CODES.crossSiteRefused, error };
    }
    return undefined;
  };
}
