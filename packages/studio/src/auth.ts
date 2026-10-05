// Ready-made auth providers: plug into the StudioAuth.read/write hook (productizes the admin↔API split).
// The new role-based default (bearer+basic, viewer/admin) is re-exported from the free @gnldev/auth.
import { safeEqual } from '@gnldev/auth';
import { refuseUnknownNames } from '@gnldev/options';
import { BASIC_AUTH_NAMES } from './option-names.js';
export { roleAuth } from '@gnldev/auth';
export type { AuthProvider, Principal, Decision, AuthCapabilities, Cred } from '@gnldev/auth';

/** Auth function that checks Authorization: Bearer <token> (constant-time comparison). */
export function bearerAuth(token: string): (req: Request) => boolean {
  const expected = `Bearer ${token}`;
  return (req) => safeEqual(req.headers.get('authorization') ?? '', expected);
}

/** Auth function that checks basic auth (user:pass) (constant-time comparison). */
export function basicAuth(creds: { user: string; pass: string }): (req: Request) => boolean {
  refuseUnknownNames('basicAuth', creds, BASIC_AUTH_NAMES);
  const expected = 'Basic ' + Buffer.from(`${creds.user}:${creds.pass}`).toString('base64');
  return (req) => safeEqual(req.headers.get('authorization') ?? '', expected);
}
