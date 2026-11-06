// WHO HOLDS A READY ENTRY — the one ownership rule, not a duration.
//
// A taker of a ready entry (`WorkStore.takeReady`) used to hold it for a fixed time, a third of its
// lease's TTL. Nobody asked whether the taker was still there: a worker that died between the take and its
// lease, or while it ran the job, left the entry unseen until that time ran out (measured: a SIGKILLed
// worker's job started again ~1 s later than with the lane scan at a 3 s TTL, +10 s at the default 30 s),
// and a live worker's entry was handed out again every third of a TTL only to be refused by its lease.
// That was a second ownership rule beside the one every claim, lock and execution record is judged by.
//
// So a taken entry carries a holder stamp — the attempt that took it (`hold`), the process (`proc`), the
// take's time and TTL — and is judged by THAT rule (liveness.ts `stampIsLive`): held while its attempt is
// held in this process, or its process is alive, or, when nobody can answer, while it is younger than its
// TTL on the store's clock. The store only keeps the stamp: it never hands a held entry out, and it lets
// one go when asked (`deferReady` fenced by the hold). Whoever runs the record still takes its own lease.
import { randomUUID } from 'node:crypto';
import type { WorkStore, ReadyItem } from './storage.js';
import { stampIsLive, newHoldId, holdHere, releaseHold } from './liveness.js';
import { procStampFor } from './process-liveness.js';

/** A taken entry and the hold that holds it (`takeReadyHeld`). */
export interface ReadyTaken extends ReadyItem {
  hold: string;
}

/**
 * Takes the next entry of `set` (`WorkStore.takeReady`), held by a new attempt of this process: its hold
 * id, this store's process id (`journal`: the journal of the store whose liveness answers for it), and
 * `ttlMs` for a reader nobody can answer for. `undefined` when no entry is ready. @internal
 */
export async function takeReadyHeld(
  work: WorkStore,
  set: string,
  journal: unknown,
  q: { now: number; ttlMs: number; skipKinds?: readonly string[] },
): Promise<ReadyTaken | undefined> {
  // Stamped as the job's lease is (run-lock.ts): with this process's id and an attempt of it when a
  // liveness answers for the store; otherwise with a bare token that names no attempt — read by nobody
  // but its age, as a lease nobody renews is.
  const proc = procStampFor(journal);
  const hold = proc.proc !== undefined ? newHoldId() : randomUUID();
  // Held here before it is written: a reader in this process never sees it written and not held.
  if (proc.proc !== undefined) holdHere(hold, journal);
  let got: ReadyItem | undefined;
  try {
    got = await work.takeReady(set, { now: q.now, holder: { hold, ttlMs: q.ttlMs, ...proc }, ...(q.skipKinds?.length ? { skipKinds: q.skipKinds } : {}) });
  } finally {
    if (!got) releaseHold(hold, journal);
  }
  return got ? { ...got, hold } : undefined;
}

/**
 * The holder lets go of what it took: `write` (a `deferReady` fenced by the hold, or a `dropReady`), and
 * the attempt is over here. Never throws — a let-go is the holder's cleanup; an entry it could not write
 * stays held as its stamp says (`stampIsLive`). @internal
 */
export async function letGoReady(taken: { hold: string }, journal: unknown, write: () => Promise<void>): Promise<void> {
  try {
    await write();
  } catch {
    // Judged by its stamp from here on, like any claim whose release did not land.
  } finally {
    releaseHold(taken.hold, journal);
  }
}

/**
 * Lets go of every entry of `set` whose holder no longer holds it — asked of the holder by the one rule
 * (`stampIsLive`), never of a duration of its own — so it is taken again in its rank's turn. `now` is the
 * store's clock. Returns how many were let go. @internal
 */
export async function reclaimReady(work: WorkStore, set: string, journal: unknown, now: number): Promise<number> {
  let n = 0;
  for (const h of await work.heldReady(set)) {
    if (await stampIsLive(h.at, h.ttlMs, now, h, journal)) continue;
    // Fenced by the hold: a holder that came back and let go meanwhile, or a later holder, is not touched.
    await work.deferReady(set, h.id, now, h.hold);
    n++;
  }
  return n;
}
