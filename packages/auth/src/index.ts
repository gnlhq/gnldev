// @gnldev/auth — open-core auth seam:
// AuthProvider  → stable contract (server + studio gate against this)
//   RoleAuth      → free default (bearer/basic; superAdmin/admin/client/viewer)
//   makeGate      → shared Hono gate (allow/deny)
//   normalizeAuth → AuthProvider | {read,write} backward-compat bridge
export { PRINCIPAL_KINDS } from './types.js';
export type { Principal, PrincipalKind, AuthContext, Decision, AuthCapabilities, AuthProvider, Cred, AccessDecision, RefusalReason } from './types.js';
// The outcome a host reports to `AuthProvider.onDecision`: what the caller got, not what `authorize` said first.
export { markRefusal, markCredentialRejected, credentialRejected, CREDENTIAL_REJECTED, outcomeOf, settleDecision, decisionNotRecorded, authErrorResponse, AUTH_ERROR_CODES, AUTH_ERROR_STATUS, type AuthErrorCode } from './decision.js';
// What a permission string means and whether a grant covers it — the one matcher every tier uses.
export { permissionMatches, parsePermission, patternPartMatches, isReadPermission, grantsAllow, type ParsedPermission } from './permission.js';
export { roleAuth, CLIENT_ROLE, CLIENT_WRITES, END_USER_ROLE, FREE_ROLE_GRANTS, type EndUserTokens } from './role-auth.js';
export { makeGate, principalOf, permissionContext, type Gate, type GateOptions } from './gate.js';
export { fromReadWrite, normalizeAuth, bindsIdentity, carriesIdentity, type ReadWriteAuth } from './adapter.js';
export { safeEqual } from './safe-equal.js';
// One JWT verifier for the free `endUsers` class and every @gnldev/auth-ee SSO provider.
export { jwksSource, DEFAULT_JWKS_TTL_MS, DEFAULT_JWKS_MAX_STALE_MS, DEFAULT_JWKS_REFETCH_MS, type Jwk, type JwksSource, type JwksSourceOptions } from './jwks.js';
export { verifyJwt, jwtFromRequest, b64uDecode, declaredKind, signSubjectToken, MIN_SUBJECT_SECRET_BYTES, MAX_SUBJECT_TTL_SEC, MAX_REVOCABLE_SUBJECT_TTL_SEC, type JwtVerifyOptions } from './jwt.js';
export { isCrossSiteStateChange, crossSiteRefusedMessage, isHostAllowed, hostnameOf, parseAllowedHosts } from './same-site.js';
// The providerless protections for a standalone door (chat, AG-UI, MCP over HTTP), for a request with no identity.
export { openSurfaceGuard, hostNotAllowedMessage, type OpenSurface, type OpenSurfaceGuardOptions, type OpenSurfaceRefusal, type HostRuleAuth } from './open-surface.js';
export { subjectTokenEndpoint, sessionTokenId, type SubjectSession } from './token-endpoint.js';
// The one reading a standalone door (chat, AG-UI, MCP) makes of a request — `doorGate`: `identify`, then
// the open-surface checks for a request with no identity, then the role.
export { doorGate, doorProtectionLines, printProtections, callerOfRequest, authorizeDoorRequest, type DoorGateOptions, type DoorRefusal, type DoorAdmission, AGENTS_RUN, APPLICATION_NAMES_NO_USER, CREDENTIAL_NOT_ACCEPTED, type RequestCaller, type Authorize } from './door.js';
export { PLATFORM_ADMIN_ROLE, isPlatformAdmin, principalScope, callerKind, isPrincipalKind, assertAssignablePrivileges, actorIdOf, isReservedSubjectId, subjectIdProblem, RESERVED_SUBJECT_PREFIXES, engineCallerOf, type PrincipalScope, type AssignabilityResult, type Identify, type EngineCaller } from './scope.js';
// Who may reach a surface that listens on a socket. One decision for every GNL surface that binds
// one; see exposure.ts's header for why @gnldev/cli keeps a pinned second implementation.
export { decideExposure, isLoopbackHost, isPublishedDevCredential, PUBLISHED_DEV_TOKENS, type ExposureInput, type ExposureDecision } from './exposure.js';
// One refusal for an option given in a door's config instead of its options.
export { refuseMisplacedOptions, doorOptionKeys, REMOVED_IDENTITY_OPTIONS, type RemovedDoorOptions } from './misplaced-options.js';
