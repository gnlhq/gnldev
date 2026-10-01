// The A2A request signature — the one definition both sides use: @gnldev/a2a's client signs with it,
// @gnldev/server's `a2aSecret` verifies with it.
//
// signature = hex HMAC-SHA256(secret, `${timestamp}.${METHOD} ${path}.${body}`)
//
// `path` is the route the request is for, decoded and relative to the API root (`/agents/<name>/run`),
// so a host that mounts the API under a prefix (and strips it) verifies what the client signed. The
// method and the route are in the signed text because the body alone named no door: a request signed
// for agent `a` was accepted by agent `b`, by `a`'s /stream and /resume, and by a workflow's run.
import { createHmac, timingSafeEqual } from 'node:crypto';

/** How far a request's timestamp may be from the verifier's clock, in ms (either way). */
export const A2A_SIGNATURE_WINDOW_MS = 300_000;

export interface A2ASignedRequest {
  /** HTTP method, any case. */
  method: string;
  /** The route, decoded and relative to the API root: `/agents/<name>/run`. */
  path: string;
  /** The exact body bytes sent. */
  body: string;
}

/** The text that is signed. */
export function a2aSigningInput(timestamp: string, r: A2ASignedRequest): string {
  return `${timestamp}.${r.method.toUpperCase()} ${r.path}.${r.body}`;
}

/** The two headers a signed request carries. */
export function signA2ARequest(secret: string, r: A2ASignedRequest, now: number = Date.now()): { 'x-gnl-timestamp': string; 'x-gnl-signature': string } {
  const timestamp = String(now);
  return { 'x-gnl-timestamp': timestamp, 'x-gnl-signature': createHmac('sha256', secret).update(a2aSigningInput(timestamp, r)).digest('hex') };
}

/** `ok`, or why not: headers absent, timestamp outside the window, or a signature that does not match. */
export type A2ASignatureVerdict = 'ok' | 'missing' | 'stale' | 'invalid';

export function verifyA2ARequest(
  secret: string,
  r: A2ASignedRequest & { timestamp: string | null | undefined; signature: string | null | undefined },
  now: number = Date.now(),
): A2ASignatureVerdict {
  if (!r.signature || !r.timestamp) return 'missing';
  const ts = Number(r.timestamp);
  if (!Number.isFinite(ts) || Math.abs(now - ts) > A2A_SIGNATURE_WINDOW_MS) return 'stale';
  const expected = createHmac('sha256', secret).update(a2aSigningInput(r.timestamp, r)).digest();
  const provided = Buffer.from(r.signature, 'hex');
  return provided.length === expected.length && timingSafeEqual(provided, expected) ? 'ok' : 'invalid';
}
