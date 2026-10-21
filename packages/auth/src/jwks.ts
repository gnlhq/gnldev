import { createPublicKey, type JsonWebKey } from 'node:crypto';
import { refuseUnknownNames, optionNames } from '@gnldev/options';

/** A JSON Web Key as a JWKS endpoint publishes it (RFC 7517): RSA (`n`,`e`), EC (`crv`,`x`,`y`) or OKP (`crv`,`x`). */
export interface Jwk {
  kty: string;
  kid?: string;
  use?: string;
  alg?: string;
  [member: string]: unknown;
}

export interface JwksSourceOptions {
  /** The provider's JWKS endpoint, e.g. `https://<tenant>.auth0.com/.well-known/jwks.json`. */
  url: string;
  /** How long fetched keys are used without asking again (default 10 minutes). */
  ttlMs?: number;
  /**
   * How old the last good key set may be and still be used while the endpoint fails (default 1 hour).
   * Past it verification fails closed: a key the provider rotated out must not stay trusted for as long
   * as its endpoint is down (measured before this bound: a removed key verified 24 h into an outage).
   */
  maxStaleMs?: number;
  /**
   * A token naming a key id the cached set does not have — the provider has just rotated — asks the
   * endpoint again at once, but at most once per this many ms (default 30 s), so a stream of tokens with
   * made-up key ids cannot turn every request into a fetch.
   */
  refetchMs?: number;
  /** Test/DI: the fetch used; default the global one. */
  fetch?: typeof fetch;
  /** Test/DI: the clock, in ms; default `Date.now`. */
  now?: () => number;
}

/** Where verification gets a key: the key for a token's `kid`, as PEM. */
export interface JwksSource {
  /** The PEM of the key a token names (`kid`), or of the first key when it names none; `undefined` when there is no such key. Throws when the key set cannot be had. */
  pemFor(kid: string | undefined): Promise<string | undefined>;
}

const JWKS_SOURCE_NAMES = optionNames<JwksSourceOptions>()(['url', 'ttlMs', 'maxStaleMs', 'refetchMs', 'fetch', 'now']);
/** Default `ttlMs`: 10 minutes. */
export const DEFAULT_JWKS_TTL_MS = 10 * 60 * 1000;
/**
 * Default `maxStaleMs`: 1 hour. It caps how long a rotated-out key stays trusted during an outage at 6
 * TTLs, while an outage shorter than that still does not log anyone out. A judgement, not a measurement.
 */
export const DEFAULT_JWKS_MAX_STALE_MS = 60 * 60 * 1000;
/** Default `refetchMs`: 30 seconds. */
export const DEFAULT_JWKS_REFETCH_MS = 30 * 1000;

/** A JWK as an SPKI PEM — `verifyJwt` then picks the algorithm from the key type, never from the token. */
function pemOf(jwk: Jwk): string | undefined {
  try {
    return createPublicKey({ key: jwk as unknown as JsonWebKey, format: 'jwk' }).export({ type: 'spki', format: 'pem' }) as string;
  } catch {
    return undefined; // a key this runtime cannot load (an unknown kty) verifies nothing
  }
}

/**
 * Keys from a JWKS: a fixed list, or an endpoint, fetched when first needed and cached.
 *
 * The cache's rules (moved here from @gnldev/auth-ee's Auth0 provider, which now uses this, so a fix
 * is a fix in both): a fresh set is not fetched again; concurrent requests share one fetch; a clock
 * that went backwards makes the set stale, not fresh (measured: a clock stepped back a day kept a
 * rotated-out key "fresh" that day); while the endpoint fails, the last good set serves up to
 * `maxStaleMs` and then verification fails closed. New here: a token naming a key id the set does not
 * have asks again at once (at most once per `refetchMs`) — a rotation is picked up on the next token,
 * not up to `ttlMs` later.
 *
 * `label` and `staleOption` only shape messages: who is asking, and which option moves the stale bound.
 */
export function jwksSource(
  from: JwksSourceOptions | { keys: Jwk[] },
  label = '@gnldev/auth',
  staleOption = 'maxStaleMs',
): JwksSource {
  if ('keys' in from) {
    const keys = from.keys;
    return { pemFor: async (kid) => { const k = kid ? keys.find((j) => j.kid === kid) : keys[0]; return k ? pemOf(k) : undefined; } };
  }
  refuseUnknownNames('jwksSource', from, JWKS_SOURCE_NAMES);
  const opts: JwksSourceOptions = from;
  if (typeof opts.url !== 'string' || !/^https?:\/\//.test(from.url)) throw new TypeError(`${label}: a JWKS \`url\` is an http(s) address`);
  const doFetch = opts.fetch ?? fetch;
  const now = opts.now ?? Date.now;
  const ttl = opts.ttlMs ?? DEFAULT_JWKS_TTL_MS;
  const maxStale = opts.maxStaleMs ?? DEFAULT_JWKS_MAX_STALE_MS;
  const refetch = opts.refetchMs ?? DEFAULT_JWKS_REFETCH_MS;

  let cache: { keys: Jwk[]; fetchedAt: number } | null = null;
  let inFlight: Promise<Jwk[]> | null = null;
  let lastForced = -Infinity;

  async function fetchKeys(): Promise<Jwk[]> {
    const res = await doFetch(opts.url);
    if (!res.ok) throw new Error(`${label}: JWKS fetch failed (HTTP ${res.status})`);
    const body = (await res.json()) as { keys?: Jwk[] };
    // Keys for encryption are not signing keys.
    const keys = (body.keys ?? []).filter((k) => k && typeof k.kty === 'string' && k.use !== 'enc');
    if (!keys.length) throw new Error(`${label}: JWKS empty`);
    return keys;
  }

  async function load(force: boolean): Promise<Jwk[]> {
    // Fresh cache → no fetch. A negative age means the clock went backwards: the age is unknown, so the
    // cache is not fresh.
    if (cache && !force) {
      const age = now() - cache.fetchedAt;
      if (age >= 0 && age < ttl) return cache.keys;
    }
    if (!inFlight) {
      inFlight = fetchKeys()
        .then((keys) => { cache = { keys, fetchedAt: now() }; return keys; })
        .finally(() => { inFlight = null; });
    }
    try {
      return await inFlight;
    } catch (err) {
      // Stale-while-error, bounded: an outage should not drop every caller to anonymous, but past
      // `maxStale` a key the provider still publishes cannot be told from one it removed.
      if (cache) {
        const age = now() - cache.fetchedAt;
        if (age >= 0 && age < maxStale) return cache.keys;
        throw new Error(
          `${label}: JWKS unreachable and the cached keys are past ${staleOption} (${maxStale} ms) — ` +
            `pass a larger \`${staleOption}\` (or \`Infinity\`) to keep trusting them during an outage`,
          { cause: err },
        );
      }
      throw err;
    }
  }

  const pick = (keys: Jwk[], kid: string | undefined) => (kid ? keys.find((k) => k.kid === kid) : keys[0]);

  return {
    async pemFor(kid) {
      let found = pick(await load(false), kid);
      // An unknown key id: the provider may have rotated since the set was fetched. Ask again — but not
      // when the set is itself younger than `refetchMs` (it was just fetched, and lacks the key), and not
      // more than once per `refetchMs` (a fetch that fails leaves the set's age as it was).
      const age = cache ? now() - cache.fetchedAt : Infinity;
      if (!found && kid && age >= refetch && now() - lastForced >= refetch) {
        lastForced = now();
        found = pick(await load(true), kid);
      }
      return found ? pemOf(found) : undefined;
    },
  };
}
