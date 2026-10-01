// What a permission string means, and whether a grant covers it — ONE owner for every tier.
//
// The free tier (`roleAuth`, and the gate's read/write reduction in `permissionContext`) and the paid
// tier (@gnldev/auth-ee's `createRbac`) evaluate the same grant data — `FREE_ROLE_GRANTS` is the start of
// the paid default map. They used to evaluate it with two matchers: the free one read "ends with
// `:read`", the paid one split on `:` and compared the FIRST TWO segments. On the permissions the hosts
// ask for (all two segments) they agreed; on any other string they did not. Measured: `x:y:read` was a
// read on the free tier (client, viewer, end user allowed) and refused with a licence; `runs:read:secret`
// and `agents:run:x` were refused free and allowed licensed (the third segment was dropped). A licence
// may only add, and two matchers cannot promise that for strings nobody listed.
//
// THE GRAMMAR
//
//   permission  := resource ':' action     split at the LAST colon
//                | resource                no colon: a bare name with no action
//   grant       := '*'                     every permission, bare names included
//                | permission              with '*' allowed as a WHOLE resource or a WHOLE action
//
//   • The action is the last segment; the resource is everything before it, colons included:
//     `billing:invoices:read` is the action `read` on the resource `billing:invoices`.
//   • `*` as a resource matches any resource (one segment, several, or empty); as an action, any action
//     (empty included). It is never a partial wildcard: `run*:read` and `x:*:read` are literals.
//   • `*:read` therefore matches every permission whose last segment is `read` — exactly the strings the
//     free tier always treated as reads (`p.endsWith(':read')`), now by definition rather than by a copy.
//   • `x:*` is every action on the resource `x` — not on `x:y`. Resources are names, not paths: grant
//     `x:y:*` for the actions on `x:y`.
//   • Case-sensitive, no trimming: `runs:READ` is not a read.
//   • A bare name (`admin`, `read`) has no action: only the grant `*` or the same bare name matches it.

/** A permission string read by the grammar above. `action` is undefined for a bare name (no colon). */
export interface ParsedPermission {
  resource: string;
  action: string | undefined;
}

/** Split a permission at its LAST colon (see the grammar in this file's header). */
export function parsePermission(permission: string): ParsedPermission {
  const at = permission.lastIndexOf(':');
  return at < 0 ? { resource: permission, action: undefined } : { resource: permission.slice(0, at), action: permission.slice(at + 1) };
}

/**
 * Does one PART of a grant cover the same part of what is asked? `*` covers any value that is present;
 * anything else covers only itself. Exported for a matcher over structured parts that must not be
 * joined into one string first — @gnldev/auth-ee's FGA compares `{ type, id }` with it, because a run id
 * may contain colons and joining would let the grammar split the id.
 */
export function patternPartMatches(granted: string | undefined, required: string | undefined): boolean {
  if (granted === undefined || required === undefined) return granted === required;
  return granted === '*' || granted === required;
}

/**
 * Does the grant `granted` cover the permission `required`? The ONE matcher: @gnldev/auth's `roleAuth`
 * and `permissionContext`, and @gnldev/auth-ee's RBAC, all decide through it.
 */
export function permissionMatches(granted: string, required: string): boolean {
  if (granted === '*' || granted === required) return true;
  const g = parsePermission(granted);
  const r = parsePermission(required);
  return patternPartMatches(g.resource, r.resource) && patternPartMatches(g.action, r.action);
}

/** Is `permission` a read? By definition: the grant `*:read` covers it. */
export function isReadPermission(permission: string): boolean {
  return permissionMatches('*:read', permission);
}

/** Does any grant in `grants` cover `permission`? */
export function grantsAllow(grants: readonly string[], permission: string): boolean {
  return grants.some((g) => permissionMatches(g, permission));
}
