// M4 — Run-level advisory lock. Prevents two concurrent resumes of the same runId (so the live
// tail doesn't run twice). Opt-in: only kicks in when `runDurable({ lock })` is given.
//
// 4.2 (fencing): since the lock is advisory, a takeover after TTL is possible — if the old owner
// still calls `release()` with the `RunLock` reference it's holding, without a fencing token this
// call would blindly overwrite the new (takeover) owner's record (a half-release). On every
// acquisition a unique `token` is generated and written to the journal; `release()` writes ONLY IF
// the current record's token in the journal matches its own token — a stale (superseded) owner can no longer release it.
//
// While a process liveness is installed the record names the holding process, and "is it held?" is
// asked of that process, not of the clock (process-liveness.ts): a holder frozen past its TTL keeps
// the lock, a dead one loses it at once. Without one — or in a journal only this process reaches —
// the TTL decides as before.
import { runRecordKey } from './run-id-grammar.js';
import { randomUUID } from 'node:crypto';
import { claim } from './journal.js';
import type { Journal } from './journal.js';
import { bindOwnLiveness, giveBack, procStampFor } from './process-liveness.js';
import { holderIsLive, journalNow, newHoldId, holdHere, releaseHold } from './liveness.js';

export interface RunLock {
  runId: string;
  owner: string;
  /**
   * 8.2: unique fencing token for this acquisition (the same token is written to the journal's
   * LockRecord). Exposed read-only for consumers who want to build their own in-engine CAS fencing
   * chain in THEIR OWN store (outside RunJournal, e.g. @gnldev/queue's WorkStore) — see @gnldev/queue's
   * createWorker: on terminal writes (qdone/qfail/qatt), WorkStore.putIfMatch uses this token to verify "I'm still the owner".
   */
  readonly token: string;
  /**
   * Y2 (heartbeat): extends the duration of the lock we own (`expires = now + ttlMs`).
   * If the fencing token in the current record is NOT this acquisition's token — a takeover
   * happened, the record is gone, or the lock was released — returns `false`: a lost/released lock
   * is NEVER renewed. `true` = the lock is still ours and the duration was extended. Long-running
   * jobs (a queue handler) should call this at an interval shorter than the ttl to prevent the lock
   * from expiring at TTL end (double execution).
   */
  renew(ttlMs: number): Promise<boolean>;
  release(): Promise<void>;
}

interface LockRecord {
  owner: string;
  expires: number;
  /** Fencing token: a unique identity for this acquisition. release() compares it against the current record. */
  token: string;
  /**
   * The process holding it, while a liveness is installed (process-liveness.ts). A held lock is a
   * holder stamp like a claim: live exactly while that process is — a frozen holder past `expires`
   * keeps it, a dead one loses it at once. A released lock carries no process and reads by `expires`.
   */
  proc?: string;
  /**
   * The acquisition holding it, in the holder's process (liveness.ts `hold`): held there from the
   * acquisition until `release()` or a lost renewal. Its own process reads the lock as free once the
   * acquisition is over, whether or not the release reached the store.
   */
  hold?: string;
}

/** Whether `cur` is held: by its holder when it can be asked (liveness.ts `holderIsLive`), else by its age on the store's clock. */
async function isHeld(journal: Journal, cur: LockRecord, at: number): Promise<boolean> {
  return (await holderIsLive(cur, journal)) ?? cur.expires >= at;
}

const lockKey = (runId: string) => runRecordKey(runId, 'lock'); // ':lock' does not match parseJournalKey → invisible to the reader

/**
 * Tries to acquire the lock atomically (`claim`/putIfAbsent). Acquires it → `RunLock` if it's free
 * or expired; returns `null` if a live lock belongs to someone else. Every successful acquisition
 * comes with a new fencing token (including on takeover) — so the old owner's handle is invalidated.
 *
 * H1 (takeover atomicity): if the journal supports `putIfMatch`, taking over an expired record is
 * done via CAS — even if two workers read the same expired record, only ONE can change it (NO
 * split-brain). If unsupported, falls back to the old best-effort get→put behavior (a documented
 * risk, the core-hardening review).
 * H2 (clock-skew): the TTL is dated and judged on the storage's own clock (`journal.now()`), never a
 * caller's: a lock dated by a process clock was born expired behind a long poll, or judged expired by a
 * process whose clock ran ahead (k3: A4, Y1). There is no `now` to pass.
 */
export async function acquireRunLock(
  journal: Journal,
  runId: string,
  owner: string,
  ttlMs: number,
): Promise<RunLock | null> {
  const key = lockKey(runId);
  const token = randomUUID();
  // A primitive called directly names its process, as durableTool and runDurable do (process-liveness.ts
  // `bindOwnLiveness`): a lock that named none was judged by its age alone — a dead holder kept it for its
  // whole TTL, a frozen one lost it at the TTL (k3: the waker's lock after a SIGKILL, the scheduler's A4).
  await bindOwnLiveness(journal);
  // The acquisition's hold travels with the process it names: it answers for THIS process's own lock,
  // whose process alone says nothing (liveness.ts `holderIsLive`). A lock that names no process (no
  // liveness for the store) carries none and is judged by its age, as a lease that is not renewed should be.
  const proc = procStampFor(journal);
  const hold = proc.proc !== undefined ? newHoldId() : undefined;
  const at = await journalNow(journal);
  const rec: LockRecord = { owner, expires: at + ttlMs, token, ...proc, ...(hold ? { hold } : {}) };
  // Held here before it is written: a reader in this process never sees it written and not held.
  holdHere(hold, journal);
  const won = async (): Promise<RunLock | null> => {
    if (await claim(journal, key, rec)) return mkLock(journal, runId, owner, token, hold);

    const cur = await journal.get<LockRecord>(key);
    if (cur && (await isHeld(journal, cur, at))) return null; // a live lock belongs to someone else

    if (!cur) {
      // The claim was lost but the record couldn't be read either (raced with purge/deletion) → try atomically once more.
      return (await claim(journal, key, rec)) ? mkLock(journal, runId, owner, token, hold) : null;
    }

    // Not held (its holder is gone, or — nobody to ask — it expired) → take over. If putIfMatch is available it's ATOMIC: change it if the expired record we
    // read is still in place; if another worker acted first, false → null (the loser doesn't run).
    // A new token is written → the old owner's handle cannot release/write (see mkLock: no-op on token mismatch).
    return (await journal.putIfMatch(key, cur, rec)) ? mkLock(journal, runId, owner, token, hold) : null;
  };
  try {
    const lock = await won();
    if (!lock) releaseHold(hold, journal);
    return lock;
  } catch (e) {
    releaseHold(hold, journal);
    throw e;
  }
}

function mkLock(journal: Journal, runId: string, owner: string, token: string, hold: string | undefined): RunLock {
  const key = lockKey(runId);
  return {
    runId,
    owner,
    token,
    // Y2 (heartbeat): SAME owner-check (fencing) logic as release() — if the current record no
    // longer carries THIS acquisition's token (a takeover happened / no record / lock released),
    // returns `false`, the record is NOT TOUCHED (showing a lost lock as "alive" would hide a
    // split-brain). If it matches, moves `expires` to `now + ttlMs` — the token DOES NOT CHANGE (same acquisition, just the duration is extended).
    renew: async (ttlMs: number) => {
      const cur = await journal.get<LockRecord>(key);
      if (!cur || cur.token !== token) { releaseHold(hold, journal); return false; } // stale owner → rejected, record is not renewed; the acquisition is over
      const at = await journalNow(journal);
      const next: LockRecord = { owner, expires: at + ttlMs, token, ...procStampFor(journal), ...(hold ? { hold } : {}) };
      // SAME philosophy as the takeover CAS in acquireRunLock: atomic if putIfMatch is available
      // (change it if the record we read is still in place — if a takeover happened in between,
      // returns false, the record is not corrupted). Otherwise falls back to best-effort get→put
      // (sufficient for single-process, the core-hardening review).
      return journal.putIfMatch(key, cur, next);
    },
    // The journal has no delete → release by moving expires into the past (the next acquire takes over).
    // Owner-check (fencing): if the current record no longer carries THIS acquisition's token (a
    // takeover happened or there's no record at all), release is a no-op — it never overwrites another owner's lock.
    release: async () => {
      // SAME CAS discipline as renew(): the old get→put pair was a TOCTOU window — a takeover
      // landing between the token check and the write was erased by the plain put (a half-release of
      // the NEW owner's live lock). putIfMatch writes only if the record we token-checked is still in
      // place. A false CAS has TWO causes and the retry loop tells them apart: a takeover (the next
      // get sees a foreign token → silent no-op, correct) vs OUR OWN in-flight renew() landing in
      // between (the next get sees our token with a fresh `expires` → retry against the fresh record,
      // otherwise the lock we mean to free stays live until TTL). Bounded, so a hot takeover race can
      // never spin.
      // The acquisition is over the moment its holder releases it — in this process at once, whether or
      // not the write below reaches the store (k3 S4: a release that failed once held the lock for the life
      // of the process).
      releaseHold(hold, journal);
      // A storage error here never surfaces into the caller's cleanup path (queue's renew-failure tests
      // measured it escaping through finally-release). The write is not dropped either: while this
      // process lives, the others read a lock that names it as held — so it is retried until it lands
      // (process-liveness.ts `giveBack`). Fenced by the token: a late retry never frees a later acquisition.
      await giveBack(token, journal, async () => {
        for (let attempt = 0; attempt < 3; attempt++) {
          const cur = await journal.get<LockRecord>(key);
          if (!cur || cur.token !== token) return; // stale owner → rejected, silent no-op
          const dead: LockRecord = { owner, expires: 0, token };
          if (await journal.putIfMatch(key, cur, dead)) return;
        }
      });
    },
  };
}
