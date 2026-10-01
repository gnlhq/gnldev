// The one reading every standalone door makes of a request: who is calling, as the engine's caller.
//
// A door (the chat and AG-UI routes, an MCP server) has a web Request and the application's `identify`.
// It asks `identify` once and maps the answer with `engineCallerOf` — the one mapping (ADR-0002) — so
// the same principal is the same caller whichever door the request came in through.
import type { AuthProvider, Principal } from './types.js';
import { callerKind, engineCallerOf, type EngineCaller, type Identify } from './scope.js';
import { markRefusal, notePrincipal, noteVerdict, credentialRejected, CREDENTIAL_REJECTED } from './decision.js';
import { permissionContext } from './gate.js';
import { carriesIdentity } from './adapter.js';
import { openDoorGuard } from './open-door.js';

/**
 * Why a door refuses an application that names no user. The sentence @gnldev/server answers an
 * application credential that sends no `resourceId`, so the doors have one vocabulary for it.
 */
export const APPLICATION_NAMES_NO_USER = 'resourceId is required: this request used an application credential and named no end user.';

/**
 * Why a door refuses a request whose credential the provider rejected (`markCredentialRejected`).
 * Sent with 401: the caller said who they are and it was not true, so serving them as anonymous would
 * quietly turn them into somebody else.
 */
export const CREDENTIAL_NOT_ACCEPTED = 'the credential this request carried was not accepted (revoked, expired, deleted or never issued). Send a valid one — or none, to call as an anonymous caller.';

export type RequestCaller =
  /** `principal` is what `identify` returned (undefined for an anonymous request); `caller` is the engine's. */
  | { principal: Principal | undefined; caller: EngineCaller }
  /**
   * Nothing runs. `status` 401: the request carried a credential the provider rejected. Absent (400):
   * an application that named no user, or a name no user can carry.
   */
  | { refused: string; status?: 401 };

/**
 * Who a request is, for the engine.
 *
 *   subject      → that user; a name in the request is ignored — a user speaks only for itself
 *   operator     → staff; a name in the request is ignored too — staff is staff, not a user
 *   application  → the user it names in `named`; REFUSED when it names nobody (never staff, never unknown)
 *   nothing      → unknown, which the engine keeps closed
 *
 * `named` is read for an application ONLY. It comes from the request, because an application is the one
 * caller trusted to say which of its users it acts for on each request — the same rule, and the same
 * field (`resourceId`), as @gnldev/server's REST routes. The organization always comes from the
 * principal, never from the request.
 *
 * `identify` absent means the door was built without one: every request is unknown.
 */
export async function callerOfRequest(identify: Identify | undefined, req: Request, named?: unknown): Promise<RequestCaller> {
  const principal = (await identify?.(req)) ?? undefined;
  // Noted for the door's `onDecision` (settleDecision): the record names who asked, whatever came of it.
  notePrincipal(req, principal);
  // A credential was presented and rejected: refused, not served as anonymous. Only a provider that
  // noted it says so — `identify: () => undefined` reads no credential and keeps every caller anonymous.
  if (!principal && credentialRejected(req)) {
    markRefusal(req, 'unauthenticated', { detail: CREDENTIAL_REJECTED });
    return { refused: CREDENTIAL_NOT_ACCEPTED, status: 401 };
  }
  if (callerKind(principal) === 'application') {
    const caller = engineCallerOf(principal, typeof named === 'string' ? named : undefined);
    if (caller.kind === 'user') return { principal, caller };
    markRefusal(req, 'unauthenticated', { detail: APPLICATION_NAMES_NO_USER });
    return { refused: APPLICATION_NAMES_NO_USER };
  }
  return { principal, caller: engineCallerOf(principal) };
}

/**
 * The provider's `authorize`, as a door takes it: `authorize: (p, req, ctx) => auth.authorize(p, req, ctx)`.
 * The same function @gnldev/server and @gnldev/studio ask through `makeGate`, so a role means the same
 * thing on every door that is handed it.
 */
export type Authorize = AuthProvider['authorize'];

/** The permission running an agent takes: the one @gnldev/server's run, stream and surface routes ask. */
export const AGENTS_RUN = 'agents:run';

/**
 * May this caller do `permission` on this door? Asked ONLY when the door was handed `authorize`: a door
 * built with `identify` alone keeps checking identity and ownership, and no roles.
 *
 * The context is `permissionContext`, the one `makeGate().allowP` asks with, so an RBAC provider matches
 * the exact permission and a free provider reduces it to read/write. The verdict is noted for the door's `onDecision`, which then
 * records a refusal as `rbac` (or `unauthenticated`), as @gnldev/server's gate does.
 *
 * Returns undefined when allowed, or what to answer with.
 */
export async function authorizeDoorRequest(
  authorize: Authorize | undefined,
  principal: Principal | undefined,
  req: Request,
  permission: string,
): Promise<{ refused: string; status: 401 | 403 } | undefined> {
  if (!authorize) return undefined;
  const ctx = permissionContext(req, permission);
  const decision = await authorize(principal ?? null, req, ctx);
  noteVerdict(req, ctx, decision);
  if (decision.allow) return undefined;
  return { refused: decision.reason ?? `permission denied: ${permission}`, status: decision.status ?? (principal ? 403 : 401) };
}

export interface DoorGateOptions {
  /** How the door is built, for every refusal's way through — e.g. `'createChatRoute'`. */
  door: string;
  /** The door's `identify`. Without it every request is anonymous. */
  identify?: Identify;
  /** The door's `authorize`; asked only when the door passes a `permission`. */
  authorize?: Authorize;
  /** The host rule's list (`makeGate`'s `allowedHosts`; GNL_ALLOWED_HOSTS adds to it). */
  allowedHosts?: readonly string[] | true;
  /** `true` for a door other sites are meant to embed: lifts the cross-site check only. */
  allowCrossSite?: boolean;
  /**
   * The REST mount that replaces this door, e.g. `'createRestApi(config, { auth, surfaces: [chatSurface()] })'`.
   * Given → in production a door with no `identify` refuses to start, naming it. Omitted → no such rule
   * (an MCP server over stdio, spawned by its one client, is a legitimate door with no `identify`).
   */
  restMount?: string;
}

/** What a door answers when it refuses: the status and the JSON body. */
export interface DoorRefusal {
  status: number;
  body: { error: string; code?: string; host?: string };
}

export type DoorAdmission = { principal: Principal | undefined; caller: EngineCaller } | { refused: DoorRefusal };

/**
 * The preamble every standalone door runs before it does anything — ONE copy, which the chat, AG-UI and
 * MCP doors call (it was three, cloned line for line, and the clones shared a wrong rule: "the door was
 * given `identify`, so skip the open-surface checks").
 *
 * Per request, in order:
 *   1. who: `callerOfRequest` — `identify` once, then `engineCallerOf` (a rejected credential → 401, an
 *      application naming nobody → 400);
 *   2. the open-surface checks, unless the request carries an identity (`carriesIdentity`, the owner
 *      `makeGate` asks too): the host rule, then the cross-site check (`allowCrossSite: true` lifts it);
 *   3. the role, when `permission` is given and the door was handed `authorize` (`authorizeDoorRequest`).
 * Every refusal is recorded for the door's `onDecision` (`markRefusal` / `noteVerdict`).
 *
 * Built once, where the door is built: an `allowedHosts` entry that can never match throws there, and so
 * does a door with a `restMount` and no `identify` in production.
 */
export function doorGate(opts: DoorGateOptions): (req: Request, ask?: { named?: unknown; permission?: string }) => Promise<DoorAdmission> {
  if (opts.restMount !== undefined && process.env.NODE_ENV === 'production' && !opts.identify) {
    throw new Error(
      `[gnl ${opts.door}] no \`identify\` in production: this door has no auth of its own, so every caller would run the model ` +
        `and leave an ownerless run. Mount it on the REST API instead — ${opts.restMount} — or pass ` +
        '`identify: (req) => principal` reading your verified session; it may answer undefined for a visitor who has none, ' +
        'who is then served as anonymous (with the host rule and the cross-site check: allowedHosts, allowCrossSite).',
    );
  }
  const guard = openDoorGuard({ door: opts.door, allowedHosts: opts.allowedHosts, allowCrossSite: opts.allowCrossSite });
  return async (req, ask = {}) => {
    const who = await callerOfRequest(opts.identify, req, ask.named);
    if ('refused' in who) return { refused: { status: who.status ?? 400, body: { error: who.refused } } };
    if (!carriesIdentity({ principal: who.principal })) {
      const open = guard(req);
      if (open) {
        markRefusal(req, 'policy', { detail: open.code });
        return { refused: { status: open.status, body: { error: open.error, code: open.code, ...(open.host !== undefined ? { host: open.host } : {}) } } };
      }
    }
    if (ask.permission !== undefined) {
      const denied = await authorizeDoorRequest(opts.authorize, who.principal, req, ask.permission);
      if (denied) return { refused: { status: denied.status, body: { error: denied.refused } } };
    }
    return who;
  };
}
