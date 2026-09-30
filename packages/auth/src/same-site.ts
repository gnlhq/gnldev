// Is this a state-changing request that a page on another site caused?
//
// The default posture of a new gnl project is auth-off on loopback, which is the right default for a
// local tool — but "open to this machine" and "open to every page this machine's browser visits" are
// different things, and the gate treated them as one. With no provider it returned true for every
// request, and nothing anywhere looked at where the request came from.
//
// Measured on the publish candidate: a cross-origin request to `POST /api/retention/sweep` purged a
// seeded run (RUNS before [r-1] → purged:["r-1"] → RUNS after []). `POST /agents/:name/run` passed
// the same gate and would bill the project's API key. It is reachable from a plain
// `<form enctype="text/plain">` navigation, so it needs no CORS preflight and no fetch() permission
// — the same shape as the webpack-dev-server and Vite dev-server advisories.
//
// SCOPE — deliberately only the providerless case. When a provider IS configured the defence is the
// bearer token, which a cross-site page cannot read; gnl uses no cookies, so token auth is not
// CSRF-reachable. Applying this with a provider present would break legitimate cross-origin API
// clients for no gain.

/** Methods that cannot change state, so cross-site is not a concern for them. */
const SAFE = new Set(['GET', 'HEAD', 'OPTIONS']);

/**
 * `true` when the request both changes state AND was initiated by a different site.
 *
 * Primary signal is Fetch Metadata (`Sec-Fetch-Site`), which every current browser sends and no
 * page can forge. `same-site` is accepted rather than rejected: the documented dev setup proxies
 * `/api` through Vite so it is same-ORIGIN anyway, and rejecting same-site would break anyone
 * serving the UI from a sibling port for no meaningful gain — a hostile page on your own machine's
 * other port is a different threat model from any page on the internet.
 *
 * When the header is absent, the request is not from a modern browser. A non-browser client is not
 * the CSRF threat — it has no ambient credentials to be ridden — so it falls through to the `Origin`
 * hostname, and to allow when there is no Origin either. Hostname, not origin: ports must differ
 * freely (localhost:5173 → localhost:4747) while example.com must not.
 */
export function isCrossSiteStateChange(req: Request): boolean {
  if (SAFE.has(req.method.toUpperCase())) return false;

  const site = req.headers.get('sec-fetch-site');
  if (site) return site.trim().toLowerCase() === 'cross-site';

  const origin = req.headers.get('origin');
  if (!origin) return false;
  // `null` is an OPAQUE origin — a sandboxed iframe, a `data:` document, a `file://` page, some
  // redirect chains. It is never the app itself, so allowing it was the wrong side of the fence: the
  // earlier reading here was that Fetch Metadata covers those contexts, which is true of a current
  // browser but not of a client that omits the header. An opaque origin is not same-origin by
  // definition, so it is treated as cross-site.
  if (origin === 'null') return true;
  try {
    return new URL(origin).hostname !== new URL(req.url).hostname;
  } catch {
    return true; // an Origin that will not parse is not one to trust
  }
}

/**
 * The sentence a cross-site refusal carries. `way` is the one line that lets a page on another site in:
 * for the REST and Studio gate an auth provider, for a door an `identify`.
 */
export function crossSiteRefusedMessage(way: string): string {
  return (
    'a page on another site sent a state-changing request to a surface with no identity to authenticate, which is ' +
    'the shape of cross-site request forgery (Sec-Fetch-Site: cross-site, or an Origin naming another host). ' +
    'A page on this machine\'s own sites (localhost and its ports) is not refused. If another site is meant to call ' +
    `this surface, give it an identity to check: ${way}. See docs/errors/cross_site_refused.md.`
  );
}

// ── Which NAME was this request addressed to? ─────────────────────────────────────────────────────
//
// The check above answers "did another site cause this", and after a DNS rebind it answers no,
// truthfully: the attacker's page is served from http://evil.example:4747, evil.example is then
// re-pointed at 127.0.0.1, and the page's own requests are SAME-ORIGIN (an origin is scheme + host +
// port, not an IP). Measured over a real loopback socket before this rule existed: the rebound page
// purged Studio's runs, ran an agent on REST, and READ the run list — a same-origin page can read the
// answer, so reads are part of the attack, not only writes.
//
// What the rebound page cannot choose is the Host header: the browser writes the page's own host
// there. So a surface with no identity answers only names that cannot be somebody else's:
//
//   • `localhost` and `*.localhost` — RFC 6761; browsers resolve these to loopback themselves and never
//     ask DNS, so no one else can point them anywhere.
//   • an IP address — a rebind needs a DNS NAME to re-point; a page whose origin is an IP literal was
//     served by whatever listens at that address, which is this server. This is what keeps a LAN
//     address (`--host 0.0.0.0`, opened from a phone) working with no setting. Vite and
//     webpack-dev-server draw the same line.
//   • a name the developer listed (`allowedHosts`, or `GNL_ALLOWED_HOSTS`).

/**
 * The hostname in a Host header: lowercased, port and IPv6 brackets removed, one trailing dot removed
 * (`localhost.` is the same name as `localhost` to a resolver, so it must be the same name here).
 *
 * A bracketed IPv6 literal may be followed by `:<port>` and nothing else. Anything after the `]` used
 * to be dropped, so `[::1]evil.com` and `[::1]:x@evil` read as `[::1]`; they are returned whole now,
 * and whole they are no address and no listed name.
 */
export function hostnameOf(hostHeader: string): string {
  let h = hostHeader.trim().toLowerCase();
  if (h.startsWith('[')) {
    const end = h.indexOf(']');
    if (end === -1) return h;
    return /^(:\d*)?$/.test(h.slice(end + 1)) ? h.slice(0, end + 1) : h;
  }
  const colon = h.lastIndexOf(':');
  if (colon !== -1 && /^\d*$/.test(h.slice(colon + 1))) h = h.slice(0, colon);
  return h.endsWith('.') ? h.slice(0, -1) : h;
}

function isIpLiteral(hostname: string): boolean {
  if (hostname.startsWith('[') && hostname.endsWith(']')) return /^[0-9a-f:.]+(%[\w.-]+)?$/.test(hostname.slice(1, -1)) && hostname.includes(':');
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(hostname);
  return !!m && m.slice(1, 5).every((o) => Number(o) <= 255);
}

/** A DNS name made of non-empty labels (`..localhost` and `.localhost` are not names a browser sends). */
function isDnsName(name: string): boolean {
  return /^[a-z0-9_-]+(\.[a-z0-9_-]+)*$/.test(name);
}

/**
 * One `allowedHosts` / `GNL_ALLOWED_HOSTS` entry, in the form `isHostAllowed` compares: a hostname, or a
 * leading-dot domain. Accepts what developers write — `'mybox.test'`, `'.ngrok-free.app'`,
 * `'*.ngrok-free.app'` (read as the leading-dot form), `'mybox.test:4111'`, `'http://mybox.test:4111/'` —
 * and answers `{ problem }` for an entry that could never match a Host header, with the fix.
 */
export function allowedHostEntry(raw: string): { entry: string } | { problem: string } {
  let e = raw.trim().toLowerCase();
  if (e === '*') return { problem: 'for every name, pass allowedHosts: true (or GNL_ALLOWED_HOSTS=*)' };
  if (/^[a-z][a-z0-9+.-]*:\/\//.test(e)) {
    try {
      e = new URL(e).hostname;
    } catch {
      return { problem: "write a host name ('mybox.test'), a leading-dot domain ('.ngrok-free.app'), or a URL ('http://mybox.test:4111')" };
    }
  }
  if (e.startsWith('*.')) e = e.slice(1);
  if (e.includes('*')) {
    const rest = e.slice(e.lastIndexOf('*') + 1).replace(/^\.+/, '');
    return { problem: `a wildcard is understood only as a leading '*.' — for every name under ${rest || 'a domain'} write '.${rest || 'example.com'}'` };
  }
  const dot = e.startsWith('.');
  const name = hostnameOf(dot ? e.slice(1) : e);
  if (!(isDnsName(name) || isIpLiteral(name))) {
    return { problem: "write a host name ('mybox.test'), a leading-dot domain ('.ngrok-free.app'), or a URL ('http://mybox.test:4111')" };
  }
  return { entry: dot ? `.${name}` : name };
}

/**
 * Is a request whose Host header is `hostHeader` addressed to this machine by a name nobody else controls?
 *
 * `allowed` entries are hostnames (`mybox.test`), or a leading-dot domain (`.ngrok-free.app`, also
 * written `*.ngrok-free.app`) meaning that name and every name under it; a URL or a `:port` is read as
 * its hostname. An entry that is none of these matches nothing. `true` answers every name.
 */
export function isHostAllowed(hostHeader: string, allowed: readonly string[] | true): boolean {
  if (allowed === true) return true;
  const name = hostnameOf(hostHeader);
  if (isIpLiteral(name)) return true;
  if (!isDnsName(name)) return false;
  if (name === 'localhost' || name.endsWith('.localhost')) return true;
  for (const raw of allowed) {
    const parsed = allowedHostEntry(raw);
    if (!('entry' in parsed)) continue;
    const entry = parsed.entry;
    if (entry.startsWith('.') ? name === entry.slice(1) || name.endsWith(entry) : name === entry) return true;
  }
  return false;
}

/** `GNL_ALLOWED_HOSTS`, with the entries that can never match set apart (a gate warns about those). */
export function readAllowedHosts(raw: string | undefined): { hosts: string[] | true; invalid: string[] } {
  if (!raw) return { hosts: [], invalid: [] };
  const list = raw.split(',').map((s) => s.trim()).filter((s) => s.length > 0);
  if (list.includes('*')) return { hosts: true, invalid: [] };
  const hosts: string[] = [];
  const invalid: string[] = [];
  for (const item of list) {
    const parsed = allowedHostEntry(item);
    if ('entry' in parsed) hosts.push(parsed.entry);
    else invalid.push(item);
  }
  return { hosts, invalid };
}

/**
 * `GNL_ALLOWED_HOSTS`: comma-separated names (same forms as `allowedHosts`), or `*` for every name.
 * Entries are normalised (`*.x` → `.x`, a URL or `:port` → its hostname); one that can never match is dropped.
 */
export function parseAllowedHosts(raw: string | undefined): string[] | true {
  return readAllowedHosts(raw).hosts;
}
