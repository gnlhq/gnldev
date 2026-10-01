# ADR-0004: One function decides the open-surface checks, for every surface, per request

- **Status:** Accepted, 2026-10-01
- **Builds on:** ADR-0002 (one owner per rule), ADR-0003 (a door asks the provider for roles).

## Context

Two protections guard a request that carries no identity: the host rule (`host_not_allowed`, DNS
rebinding) and the cross-site check (`cross_site_refused`, CSRF). Whether they apply was decided in two
places, in two ways:

- the standalone doors (`doorGate`) asked per REQUEST: `carriesIdentity({ principal })`, then ran
  `openDoorGuard`, BEFORE `authorize`;
- the REST/Studio gate (`makeGate`) asked the host rule per request (round 5) but the cross-site check per
  CONFIGURATION (`bindsIdentity(provider)`), with its own copy of both checks, and had no `allowCrossSite`.

Measured on fix/audit-integration @9f4d77b9, real loopback socket, a provider that names identities and
allows anonymous requests: Studio answered a cross-site, credential-less `POST /api/retention/sweep` and
`POST /api/auth/sse-ticket` with 200. (REST's scoped routes already refuse an unnamed caller at the
engine, 403, model not called.) The same request asked of the gate and of a door, over a 70-cell matrix
(principal × verdict × request shape × `allowCrossSite`), got different answers in 13 cells.

## Decision

1. **One function owns the rule:** `openSurfaceGuard(opts)(req, principal)` in `@gnldev/auth`
   (`open-surface.ts`, replacing `open-door.ts`). It alone asks `carriesIdentity({ principal })` — the
   engine's `callerKind(principal) !== 'unnamed'` — and alone runs the host rule and the cross-site check,
   words the refusal for the surface that asks, and records it (`policy`, detail = code).
2. **One order, everywhere:** who (authenticate / `identify`) → role (`authorize`) → `openSurfaceGuard`.
   A request the provider refuses is answered as the provider answered it (`roleAuth`'s 401 for a missing
   or wrong token, from any site, under any name). `makeGate` and `doorGate` both follow it.
3. **One escape hatch, same meaning on every surface:** `allowCrossSite: true` on `createRestApi`,
   `createStudioApp`, `createChatRoute`, `createAguiRoute`, `createMcpServer` — lifts the cross-site check
   only; `allowedHosts` / `GNL_ALLOWED_HOSTS` for the host rule; a credential the surface resolves, for
   both. Every refusal names these in its message.
4. `carriesIdentity` takes a principal only: a configuration is never an identity.

## Consequences

- R2 closed: Studio refuses the cross-site anonymous state change (403 `cross_site_refused`, recorded
  `policy`); REST answers it the same way before the engine is reached.
- Gate/door parity: 70/70 cells (105/105 with an origin-list `allowCrossSite`).
- A new surface keeps the rule by calling `doorGate` or `makeGate` — measured with an A2A server door:
  0 rule files touched. Changing the rule touches one function — measured: an origin-list
  `allowCrossSite` changed one logic site (the alternative with two copies needed two, and leaving one out
  type-checked and diverged in 5 more cells).
- **Breaking (0.x):** a deployment whose pages on other sites call Studio/REST with no credential under a
  provider that allows it must add `allowCrossSite: true`. A door handed `authorize` now answers an
  anonymous request it refuses with that refusal (401) instead of `cross_site_refused` / `host_not_allowed`.
  A `{ read, write }` pair's own refusal now precedes `host_not_allowed`. `openDoorGuard` is replaced by
  `openSurfaceGuard`; `hostNotAllowedMessage` and `HostRuleAuth` move with it (still exported).
- Per-request cost: unchanged on allowed requests (within noise, 2 warm-up + 10 runs); a refused request
  pays for building its JSON refusal.

## Alternatives measured

- **A — per-request checks inside `makeGate`, doors untouched:** closes R2, passes R3–R6, but keeps two
  copies of both checks and two orders; 10/70 parity cells differ (door 403 vs gate 401).
- **A-pre — checks before `authorize`:** turns `roleAuth`'s 401 into 403 (6 tests fail, R4). Rejected.
- **C — refuse at build a provider that allows anonymous requests unless declared:** not built; a
  provider's `authorize` is opaque, so "allows anonymous" cannot be known at build time without calling it.
