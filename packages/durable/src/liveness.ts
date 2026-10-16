// When a claim is LIVE — one rule, read by every place that asks.
//
// "Is this 'running' a live attempt or a corpse?" was answered in four places with the READER's own
// threshold (durable-tool's busy check, its claim loop, its takeover re-read, and run.ts's approval
// probe), and the claim formula `claimTtlMs ?? timeoutMs-derived` was recomputed four more times. The
// claim has carried its own threshold since 77bae1c5 (`claimTtlMs` on the stamp), but only the probe
// read it: a worker configured with a shorter TTL (a rolling deploy, a different run-level
// `timeouts.claimTtlMs`) took a live, renewed claim over and ran the effect beside it (release audit
// E4: 2 landings). The holder's threshold is the one that counts — it is the holder that renews at a
// third of it — so the stamp's own value is read first, everywhere, through this module.
import { randomUUID } from 'node:crypto';
import type { Journal } from './journal.js';
import { holderAlive, storeOf } from './process-liveness.js';

/** A stale 'running' claim (after a crash) can be taken over once it is older than this. */
export const CLAIM_TTL_MS = 30_000;

/**
 * The claim TTL a call stamps on its claim: an explicit `claimTtlMs` (tool, then run), otherwise long
 * enough for the work the tool declares it may take (`timeoutMs`), never under the 30 s default.
 */
export function claimTtlFor(
  tool: { claimTtlMs?: number; timeoutMs?: number },
  ctx: { claimTtlMs?: number; toolTimeoutMs?: number },
): number {
  return tool.claimTtlMs ?? ctx.claimTtlMs ?? Math.max(CLAIM_TTL_MS, tool.timeoutMs ?? ctx.toolTimeoutMs ?? 0);
}

/**
 * The storage's clock. `startedAt`/`at` stamps are written by whichever worker claimed, so staleness is
 * measured on the shared clock, never a local one (clock skew would decide it otherwise).
 */
export async function journalNow(journal: Pick<Journal, 'now'>): Promise<number> {
  return journal.now ? journal.now() : Date.now();
}

/** A stamp dated `at` with threshold `ttlMs` is live at `now`. An undated stamp is never live. */
export function isLiveStamp(at: unknown, ttlMs: number, now: number): boolean {
  return typeof at === 'number' && now - at <= ttlMs;
}

/**
 * A record is a LIVE claim: 'running', dated, and younger than ITS OWN `claimTtlMs` — `fallbackTtlMs`
 * (the reader's) only for a claim written before claims carried their threshold.
 */
export function isLiveClaim(rec: { status?: unknown; startedAt?: unknown; claimTtlMs?: unknown } | undefined, now: number, fallbackTtlMs: number): boolean {
  if (rec?.status !== 'running') return false;
  return isLiveStamp(rec.startedAt, ownTtl(rec, fallbackTtlMs), now);
}

/** How long a live claim has left at `now` (0 when it is not live). */
export function claimTimeLeft(rec: { startedAt?: unknown; claimTtlMs?: unknown }, now: number, fallbackTtlMs: number): number {
  return typeof rec.startedAt === 'number' ? Math.max(0, ownTtl(rec, fallbackTtlMs) - (now - rec.startedAt)) : 0;
}

function ownTtl(rec: { claimTtlMs?: unknown }, fallbackTtlMs: number): number {
  return typeof rec.claimTtlMs === 'number' ? rec.claimTtlMs : fallbackTtlMs;
}

// ── The claims this process holds ──────────────────────────────────────────────────────────────────
//
// A stamp this process wrote for an attempt it still holds is live, whatever its age: the attempt is here,
// in its body or settling it. Its age decided before when no liveness answered for the store (an
// in-memory or Sqlite :memory: store, a primitive called directly): a holder whose event loop stalled
// past the TTL (a GC pause, a synchronous burst) could not renew it, and a twin of the call in the same
// process judged it crashed and ran the effect beside it (audit 2026-10-16, a-stalled-holder-keeps-its-
// claim.test.ts). So a holder stamp carries the id of the attempt that holds it (`hold`), and this
// process keeps the ids it holds, by the store it holds them in (the store a journal belongs to, as the
// process liveness is looked up), until the attempt ends. An id is never reused and never known to another
// process, which reads it as nothing and asks the holder's process liveness, then the age.

const heldHere = new WeakMap<object, Set<string>>();

/** A new hold id, for the stamp of a claim this process is about to write. Held from `holdHere`. */
export function newHoldId(): string {
  return randomUUID();
}

/** This process holds the claim stamped `hold` in `journal`'s store: every reader of that store here reads it live. */
export function holdHere(hold: unknown, journal: unknown): void {
  const store = storeOf(journal);
  if (typeof hold !== 'string' || !store) return;
  let ids = heldHere.get(store);
  if (!ids) heldHere.set(store, (ids = new Set()));
  ids.add(hold);
}

/** The attempt that held `hold` has ended: its stamp is judged as any other's from here on. */
export function releaseHold(hold: unknown, journal: unknown): void {
  const store = storeOf(journal);
  if (typeof hold === 'string' && store) heldHere.get(store)?.delete(hold);
}

/** Who a holder stamp names: the attempt (`hold`, this process's) and the process (`proc`, the store's liveness). */
export interface StampHolder { proc?: unknown; hold?: unknown }

/**
 * THE LIVENESS OF A HOLDER STAMP — the one rule. In order:
 *
 *   1. a stamp whose attempt this process holds in that store (`hold`) is live;
 *   2. a stamp that names the process holding it (`proc`) is live exactly while that process is: a
 *      frozen process — past its TTL by any clock — still holds what it holds, and a dead one holds
 *      nothing from the moment it is gone (process-liveness.ts);
 *   3. only a stamp neither can answer for is judged by its age (`isLiveStamp`).
 *
 * Every reader asks through here or `claimIsLive`.
 */
export async function stampIsLive(at: unknown, ttlMs: number, now: number, holder: StampHolder, journal: unknown): Promise<boolean> {
  if (typeof holder.hold === 'string' && heldHere.get(storeOf(journal) ?? {})?.has(holder.hold)) return true;
  const alive = await holderAlive(holder.proc, journal);
  if (alive !== undefined) return alive;
  return isLiveStamp(at, ttlMs, now);
}

/** `isLiveClaim`, asked of the holder first (see `stampIsLive`); `journal` is the store the claim was read from. */
export async function claimIsLive(
  rec: { status?: unknown; startedAt?: unknown; claimTtlMs?: unknown; proc?: unknown; hold?: unknown } | undefined,
  now: number,
  fallbackTtlMs: number,
  journal: unknown,
): Promise<boolean> {
  if (rec?.status !== 'running') return false;
  return stampIsLive(rec.startedAt, ownTtl(rec, fallbackTtlMs), now, rec, journal);
}
