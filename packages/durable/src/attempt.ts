// THE ATTEMPT THAT OWNS A CALL — the one place a call's records are written once it is claimed.
//
// The invariant: only the attempt that still owns a call may write its record or start its effect. A
// call is owned by the attempt whose 'running' stamp its record holds; a takeover (after the stamp went
// stale), an erasure, or a late success replaces that stamp, and from then on the attempt owns nothing.
//
// It was enforced site by site. Thirteen fixes added a compare-and-set or a busy check where a bug had
// been measured, and the sites they had not reached still acted for an attempt that had lost its call
// (release audit e-exactly-once, 11 Oct 2026): the body ran after a takeover had already run it (E1),
// a duplicate question was written over the takeover's success (E3). The heartbeat noticed the loss and
// only printed it. So the rule lives here, in one object, and the call site cannot forget it:
//
//   · every write of the call's records — its terminal record, a renewal, the give-back, the duplicate
//     marker and the cross-channel id it holds in flight — is a compare-and-set over the value this
//     attempt last wrote, made through this object;
//   · `assertHeld()` immediately before the body: the attempt proves it still owns the call (below);
//   · a lost attempt (a renewal that found the stamp replaced, a write that lost its compare-and-set)
//     is marked lost, and every later write or proof through it throws `AttemptLost` — the caller
//     answers from the record as it stands, like a claim that lost.
//
// One exception, stated where it is made: a SUCCESS is a fact about the effect, not this attempt's
// account of itself. An attempt that lost its call after its body ran (a stall past the TTL inside the
// body — release audit E6, the lease's residual; a partition) still records that the effect happened,
// over a record that says otherwise ('failed', a question, a given-back claim, or the claim of a later
// attempt that is itself gone — the call waiting at its retry ceiling with its outcome unknown). Never
// over an ANSWER — another success, a person's 'denied', a 'reflected' nudge: the run was told it and
// went on from it, and a replay must tell it the same — never over a LIVE claim (that attempt is
// executing: it settles its own), never into a record that is gone. A success that finds the call
// answered or held is kept beside it as a LATE REPORT (call-outcome.ts: the one fenced writer, the one
// reader) and said aloud — never silently dropped.

import { claim } from './journal.js';
import type { Journal, ToolJournalRecord } from './journal.js';
import { stableStringify } from './hash.js';
import { stampFormat, upgradeFormat } from './format.js';
import { journalNow, stampIsLive, claimIsLive, holdHere, releaseHold } from './liveness.js';
import { procStampFor, livenessFor } from './process-liveness.js';
import { claimXidInFlight, renewXid, releaseXid, type XidHeld, type XidPlan, type XidRecord } from './xid.js';
import { keepLateReport, type LateWriter } from './call-outcome.js';

/** Compare-and-set: `expected === undefined` means "no record" (first writer wins). */
export async function compareAndSet(journal: Journal, key: string, expected: unknown, next: unknown): Promise<boolean> {
  if (expected === undefined) return claim(journal, key, next);
  return journal.putIfMatch(key, expected, next);
}

/**
 * What a claim given back leaves when there was no record before it. A row cannot be deleted
 * (`put(key, undefined)` leaves it, and `putIfAbsent` then loses — see DupMarker.released), so this
 * marker stands for "no record": the call reads it as absent and takes it over by compare-and-set.
 * Same status as `releaseFailedClaim`'s tombstone, which reads as absent too: an operator released a
 * failed claim because its effect did not happen, so the next call is a FIRST call again. Read as a
 * record, it skipped every gate that answers only a fresh call — a `confirm: true` tool ran straight
 * after the release without asking anyone (measured).
 */
interface UnstartedRelease { status: 'released'; notStarted: true; releasedAt: number; toolName: string }

export const isUnstartedRelease = (v: unknown): boolean =>
  typeof v === 'object' && v !== null && (v as { status?: unknown }).status === 'released';

/** Per-(tool,args) duplicate marker — see the duplicate guard in durable-tool.ts. */
export interface DupMarker {
  firstToolCallId: string;
  at: number;
  nudged?: boolean;
  /** Set while the first caller is still executing; finalized on success, released on failure. */
  inFlight?: boolean;
  /** The claim TTL of the attempt holding an in-flight marker: its liveness is judged by it (liveness.ts). */
  ttlMs?: number;
  /** The process holding an in-flight marker (process-liveness.ts): judged by that process before the TTL. */
  proc?: string;
  /** The attempt holding an in-flight marker (liveness.ts): live in the process that holds it. */
  hold?: string;
  /**
   * The attempt that held this marker FAILED and gave the slot back. This is a real field rather
   * than a deletion because `put(key, undefined)` does not delete a row: `get` reads it as absent,
   * but `putIfAbsent` still sees the row and loses — so the "release" poisoned every later claim,
   * and a legitimate retry after a failed attempt was permanently reported as a concurrent
   * duplicate. Under `sideEffectDuplicates:'block'` that turned exactly-once into exactly-ZERO
   * (audit-measured: executions=0 with no success anywhere). A released marker is claimable.
   */
  released?: boolean;
}

/**
 * Claim the duplicate marker, honouring its lifecycle. Absent → normal first-writer claim. Released
 * (a failed attempt gave it back) → taken over by CAS. In-flight but STALE by the shared clock and its
 * holder's own TTL (its writer crashed without releasing) → taken over only by the call that left it.
 * A live marker — someone genuinely executing right now — loses. `cur` is what stands there when lost.
 */
async function claimDupMarker(journal: Journal, dupKey: string, next: DupMarker, staleTtlMs: number, windowTtlMs?: number): Promise<{ won: boolean; cur?: DupMarker }> {
  const raw = await journal.get<DupMarker>(dupKey);
  if (raw === undefined) return (await claim(journal, dupKey, next)) ? { won: true } : { won: false, cur: await journal.get<DupMarker>(dupKey) };
  const cur = raw as DupMarker;
  const now = await journalNow(journal);
  const stale = cur.inFlight === true && !(await stampIsLive(cur.at, cur.ttlMs ?? staleTtlMs, now, cur, journal));
  // FAZ-3 windowTtlMs: a COMPLETED marker older than the configured dedup window is not a duplicate
  // of anything anymore — takeable like a released one. A LIVE in-flight marker is never
  // window-expired (a live executor is arbitrated by its TTL alone); a stale one ages out like a
  // completed one.
  const windowExpired = windowTtlMs !== undefined && (cur.inFlight !== true || stale) && now - cur.at > windowTtlMs;
  // A stale in-flight marker is taken over only by the call that left it. For any other call it is
  // what it says: these arguments were running when their process stopped — the effect may have
  // happened, or have SUCCEEDED (a process that died between the call's record and this marker's
  // finish left exactly that). Taking it over ran the repeat with no block and no question (measured:
  // 2 executions under 'block' and under the default 'suspend'); the call that left it resumes through
  // its own crash ladder (recover, approval), and this one is a duplicate of something that may have run.
  const takeable = cur.released === true || windowExpired || (stale && cur.firstToolCallId === next.firstToolCallId);
  if (takeable && (await compareAndSet(journal, dupKey, raw, next))) return { won: true };
  return { won: false, cur: takeable ? await journal.get<DupMarker>(dupKey) : cur };
}

interface HeldDup { key: string; toolCallId: string; claimed: DupMarker }

/** Writes the call's terminal record over `expected` (compare-and-set) with every side write of the choke point. */
export type TerminalWriter = (record: ToolJournalRecord, expected: unknown, xid: XidHeld | undefined) => Promise<boolean>;

/** Thrown by an attempt that no longer owns its call when asked to write or start anything for it. */
export class AttemptLost extends Error {
  constructor(key: string) { super(`@gnldev/durable: the claim on ${key} is no longer this attempt's`); this.name = 'AttemptLost'; }
}

type RunningStamp = { status: 'running'; startedAt: number; attempts: number; claimTtlMs: number; idempotencyKey: string; hold?: string };

export class Attempt {
  /** The tool's own execute has been called: from here on its effect may have happened. */
  started = false;
  /** The body timed out and is still running: the attempt settles its own record when it ends. */
  outlived = false;
  /** The marker / id this attempt holds in flight; `gone`: no longer the value it wrote (never touched again). */
  private dup: (HeldDup & { gone: boolean }) | undefined;
  private xid: (XidHeld & { gone?: boolean }) | undefined;
  private state: 'held' | 'lost' | 'settled' = 'held';
  /** Every write this attempt makes runs in order: a renewal never lands between a check and a write. */
  private queue: Promise<unknown> = Promise.resolve();
  private timer: ReturnType<typeof setInterval> | undefined;
  private renewing = false;
  /** This process's monotonic time taken BEFORE the shared clock dated the current stamp (see assertHeld). */
  private datedAt: number;

  constructor(
    private readonly journal: Journal,
    readonly key: string,
    /** The raw value the claim replaced; `undefined`: there was none. */
    private readonly prior: unknown,
    private stamp: RunningStamp,
    datedAt: number,
    private readonly toolName: string,
    private readonly writeTerminal: TerminalWriter,
    /** The run whose attempt this is: a success that finds the call answered is kept as its late report (see the head of this file). */
    private readonly writer?: LateWriter,
  ) {
    this.datedAt = datedAt;
    // From here until `end()` this process holds the claim: its stamp reads live here at any age (liveness.ts).
    holdHere(stamp.hold, journal);
  }

  /** The attempt counter its stamp carries. */
  get attempts(): number { return this.stamp.attempts; }
  /** The call's idempotency key, as its claim carries it (durable-tool.ts idempotencyKeyOf). */
  get idempotencyKey(): string { return this.stamp.idempotencyKey; }
  get held(): boolean { return this.state === 'held'; }
  /** Holds a duplicate marker or a cross-channel id in flight. */
  get holdsMarkers(): boolean { return this.dup !== undefined || this.xid !== undefined; }
  /** The in-flight cross-channel id this attempt holds (completed by its success write). */
  get heldXid(): XidHeld | undefined { return this.xid; }

  /**
   * Keeps the claim (and the marker and id it holds) fresh while the attempt is alive: re-dated every
   * third of the TTL, by compare-and-set over the value last written. A renewal that finds the stamp
   * replaced means the claim was judged stale and taken over: the attempt is LOST — nothing further is
   * written or started through it. A storage error is retried on the next beat.
   */
  hold(): void {
    const every = Math.min(2_147_483_647, Math.max(1, Math.floor(this.stamp.claimTtlMs / 3)));
    this.timer = setInterval(() => {
      if (this.renewing || this.state !== 'held') return;
      this.renewing = true;
      void this.serial(() => this.renew())
        .catch((err) => console.warn(`@gnldev/durable: '${this.toolName}' is still running and its claim (${this.key}) could not be renewed — retrying:`, err))
        .finally(() => { this.renewing = false; });
    }, every);
    // A process whose only work left is a renewal timer has nothing to keep alive for: its claim expires.
    (this.timer as { unref?: () => void }).unref?.();
  }

  /** Stops renewing (an outcome is being written, or the call is over). Does not change ownership. */
  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
  }

  /**
   * The attempt is over — its outcome written, or nothing more to write. From here its stamp, and the
   * marker and id it held, are judged as anyone's (liveness.ts): by the process, then the age. Called once
   * the call's last write is done, never before it: a stamp released while its success was still being
   * written read as a crashed attempt's to a twin in this process.
   */
  end(): void {
    this.stop();
    releaseHold(this.stamp.hold, this.journal);
  }

  /**
   * Proves the attempt still owns the call, immediately before its body. Throws `AttemptLost` if not.
   *
   * A claim can only be taken over once it is stale by its own TTL on the shared clock. This process
   * knows how old its stamp is on its OWN monotonic clock (taken before the shared clock dated the
   * stamp, so it never under-counts): younger than half its TTL, no takeover can have happened yet and
   * the proof costs no I/O — the common case. Older (a slow gate, a long lookup, a stalled process), it
   * re-dates its own stamp by compare-and-set: winning proves ownership and restarts the lease for the
   * body; losing means it was taken over.
   */
  async assertHeld(): Promise<void> {
    await this.serial(async () => {
      if (this.state !== 'held') throw new AttemptLost(this.key);
      // The claim names this process (process-liveness.ts): it is held exactly while the process holds
      // its own lock. A process whose session is gone (a partition, a terminated backend) may already be
      // judged dead by the others, and starts nothing.
      // A stamp naming an id this process no longer holds (its session was cut and it came back under a
      // new one) is not its own any more: the others read that id as dead.
      const proc = livenessFor(this.journal);
      const stampedBy = (this.stamp as { proc?: string }).proc;
      if (proc && stampedBy !== undefined && (stampedBy !== proc.id || !(await proc.confirm()))) {
        this.state = 'lost';
        throw new AttemptLost(this.key);
      }
      if (performance.now() - this.datedAt < this.stamp.claimTtlMs / 2) return;
      if (!(await this.renew())) throw new AttemptLost(this.key);
    });
  }

  /**
   * Writes the call's record as decided by this attempt — a question, a refusal, a failure — over its
   * own stamp only. Throws `AttemptLost` when the call is no longer its own (nothing is written).
   * The marker and id it holds are given back unless `keepMarkers` (a question the body itself asked:
   * the work has not happened yet and still stands for these arguments).
   */
  async settle(record: ToolJournalRecord, opts: { keepMarkers?: boolean } = {}): Promise<void> {
    await this.serial(async () => {
      this.stop();
      if (this.state !== 'held' || !(await this.writeTerminal(record, this.stamp, this.xid))) {
        this.state = 'lost';
        throw new AttemptLost(this.key);
      }
      this.state = 'settled';
      if (!opts.keepMarkers) await this.releaseMarkers();
    });
  }

  /**
   * A failure: this attempt's account of itself, written only over its own claim. False when the call
   * was taken over meanwhile — the failure is not written over the other attempt, and the marker and
   * id stay (they may stand for that attempt's run).
   */
  async fail(record: ToolJournalRecord): Promise<boolean> {
    try {
      await this.settle(record);
      return true;
    } catch (err) {
      if (err instanceof AttemptLost) return false;
      throw err;
    }
  }

  /**
   * A success — the effect happened (the body returned, or `lookup()` found it downstream). Written over
   * the attempt's own claim; when the call was taken over meanwhile, recorded as the fact it is over a
   * record that says otherwise (see the head of this file). False when nothing was written.
   */
  async succeed(record: ToolJournalRecord): Promise<boolean> {
    return this.serial(async () => {
      this.stop();
      if (this.state === 'held') {
        if (await this.writeTerminal(record, this.stamp, this.xid)) { this.state = 'settled'; return true; }
        this.state = 'lost';
      }
      for (let round = 0; round < 3; round++) {
        const raw = await this.journal.get<ToolJournalRecord>(this.key);
        const cur = upgradeFormat(raw, this.key);
        if (raw === undefined) return false;
        if (cur?.status === 'succeeded' || cur?.status === 'denied' || cur?.status === 'reflected') { await this.keepLate(record, cur); return false; }
        // A live claim: that attempt is executing and settles its own record. This success is still a
        // fact — kept as evidence, which the crash ladder reads before it runs the call again or gives up.
        if (cur?.status === 'running' && (await claimIsLive(cur, await journalNow(this.journal), this.stamp.claimTtlMs, this.journal))) { await this.keepLate(record, undefined); return false; }
        if (await this.writeTerminal(record, raw, undefined)) return true;
      }
      return false;
    });
  }

  /**
   * A late success that could not be the call's record — the call was answered by another, or a live
   * attempt holds it: kept as a late report beside it (call-outcome.ts `keepLateReport`, behind the
   * erasure fence), and said aloud.
   */
  private async keepLate(record: ToolJournalRecord, settled: ToolJournalRecord | undefined): Promise<void> {
    const output = (record as { output?: unknown }).output;
    const same = settled?.status !== 'succeeded' ? undefined : stableStringify(output) === stableStringify(settled.output);
    console.warn(
      `@gnldev/durable: '${this.toolName}' attempt ${this.stamp.attempts} finished its body after it lost the call (${this.key}) — ` +
      (settled === undefined ? 'a live attempt holds it; '
        : settled.status !== 'succeeded' ? `it was answered '${settled.status}' meanwhile, which stays what the run was told; `
        : `it was settled by another${same ? ' (same result); ' : ' (a DIFFERENT result); '}`) +
      `its effect happened: ${this.writer ? 'kept as a late report beside it' : 'not kept (no run to keep it for)'}.`,
    );
    if (!this.writer) return;
    try {
      const kept = await keepLateReport(this.journal, this.key, this.writer, { attempt: this.stamp.attempts, output, ...(same !== undefined ? { sameAsSettled: same } : {}) });
      if (kept === 'not-written') console.warn(`@gnldev/durable: the late result of '${this.toolName}' (${this.key}) could not be kept: other writers kept winning`);
    } catch (err) {
      console.warn(`@gnldev/durable: the late result of '${this.toolName}' (${this.key}) could not be kept:`, err);
    }
  }

  /**
   * The call failed after its claim and before its body: nothing ran, so the record goes back to what
   * it was before this attempt claimed it — none (a 'released' marker stands for that), or an earlier
   * failed or crashed attempt with its counter. Only over its own stamp; the marker and id go back with
   * it. A failure here leaves the claim as it was — it expires by its TTL, never a silent re-run.
   */
  async giveBack(): Promise<void> {
    // Once the body started there is nothing to give back — and a timed-out body still running keeps
    // its claim fresh until it settles (`outlived`).
    if (this.started) return;
    await this.serial(async () => {
      this.stop();
      if (this.state !== 'held') return;
      try {
        const back = this.prior !== undefined
          ? this.prior
          : stampFormat({ status: 'released', notStarted: true, releasedAt: await journalNow(this.journal), toolName: this.toolName } satisfies UnstartedRelease);
        this.state = (await compareAndSet(this.journal, this.key, this.stamp, back)) ? 'settled' : 'lost';
        if (this.state === 'settled') await this.releaseMarkers();
      } catch (err) {
        console.warn(`@gnldev/durable: '${this.toolName}' failed before it ran, and its claim (${this.key}) could not be given back — it expires by its TTL:`, err);
      }
    });
  }

  /**
   * Claims the duplicate marker for these arguments in flight, before the body (see the same-step race
   * in durable-tool.ts). Stamped with this attempt's TTL so every reader judges its liveness the same
   * way. Lost: `cur` is what stands there. Throws `AttemptLost` when the call is no longer its own.
   */
  async claimDup(dupKey: string, toolCallId: string, windowTtlMs: number | undefined): Promise<{ won: boolean; cur?: DupMarker }> {
    return this.serial(async () => {
      if (this.state !== 'held') throw new AttemptLost(this.key);
      const claimed: DupMarker = { firstToolCallId: toolCallId, at: await journalNow(this.journal), inFlight: true, ttlMs: this.stamp.claimTtlMs, ...procStampFor(this.journal), ...(this.stamp.hold ? { hold: this.stamp.hold } : {}) };
      const got = await claimDupMarker(this.journal, dupKey, claimed, this.stamp.claimTtlMs, windowTtlMs);
      if (got.won) this.dup = { key: dupKey, toolCallId, claimed, gone: false };
      return got;
    });
  }

  /** Claims the cross-channel id in flight (xid.ts claimXidInFlight). Throws `AttemptLost` when the call is no longer its own. */
  async claimXid(plan: XidPlan, runId: string, toolCallId: string, windowTtlMs: number | undefined): Promise<{ won: boolean; cur?: XidRecord }> {
    return this.serial(async () => {
      if (this.state !== 'held') throw new AttemptLost(this.key);
      const got = await claimXidInFlight(this.journal, plan, runId, toolCallId, this.stamp.claimTtlMs, windowTtlMs, this.stamp.hold);
      if (got.won) { this.xid = got.held; return { won: true }; }
      return { won: false, cur: got.cur };
    });
  }

  /** Gives back the duplicate marker it holds (the call settles without running these arguments). */
  async releaseDup(): Promise<void> {
    await this.serial(async () => {
      if (this.state === 'lost') return;
      await this.releaseHeldDup();
    });
  }

  private serial<T>(fn: () => Promise<T>): Promise<T> {
    const next = this.queue.then(fn, fn);
    this.queue = next.catch(() => undefined);
    return next;
  }

  /** Re-dates the stamp to now (CAS over its last value), then the marker and id it holds. False: lost. */
  private async renew(): Promise<boolean> {
    if (this.state !== 'held') return false;
    const datedAt = performance.now();
    const renewed = stampFormat({ ...this.stamp, startedAt: await journalNow(this.journal) });
    if (!(await compareAndSet(this.journal, this.key, this.stamp, renewed))) {
      this.state = 'lost';
      this.stop();
      console.warn(
        `@gnldev/durable: '${this.toolName}' is still running, but its claim (${this.key}) is no longer its own — ` +
        `it was judged stale and taken over; this attempt writes and starts nothing further for it.`,
      );
      return false;
    }
    this.stamp = renewed;
    this.datedAt = datedAt;
    // The duplicate marker this attempt holds in flight is the same claim at the arguments' level and
    // ages the same way: past its TTL it read as a crashed attempt's leftover, and with a dedup window
    // shorter than the attempt an identical call took it over and ran beside it, under 'block'
    // (measured). The in-flight cross-channel id ages the same way. Renewed with the claim; one that is
    // no longer the value last written is not renewed again.
    if (this.dup && !this.dup.gone) {
      const renewedDup: DupMarker = { ...this.dup.claimed, at: await journalNow(this.journal) };
      if (await compareAndSet(this.journal, this.dup.key, this.dup.claimed, renewedDup)) this.dup.claimed = renewedDup;
      else this.dup.gone = true;
    }
    if (this.xid && !this.xid.gone && !(await renewXid(this.journal, this.xid))) this.xid.gone = true;
    return true;
  }

  private async releaseMarkers(): Promise<void> {
    await this.releaseHeldDup();
    if (this.xid) {
      if (!this.xid.gone) await releaseXid(this.journal, this.xid);
      this.xid = undefined;
    }
  }

  /**
   * Gives the duplicate marker back as 'released' — by compare-and-set over the value this attempt
   * wrote, so a marker another attempt took over (a resume of the same call, which the in-flight marker
   * may stand for) is never touched. Journal clock for the stamp: windowExpired reads `at` with it.
   */
  private async releaseHeldDup(): Promise<void> {
    if (!this.dup) return;
    const { key, toolCallId, claimed, gone } = this.dup;
    this.dup = undefined;
    if (gone) return;
    const released: DupMarker = { firstToolCallId: toolCallId, at: await journalNow(this.journal), released: true };
    await compareAndSet(this.journal, key, claimed, released);
  }
}
