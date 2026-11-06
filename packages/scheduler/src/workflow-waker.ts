// @gnldev/scheduler/workflow-waker — P2-waker closes the "suspend and hope
// someone polls" gap in @gnldev/workflow. `sleep(id, untilMs)`/`waitFor` suspend a run and rely on
// someone re-calling `runResumable` to wake it up — this builds a real waker on top of the P0.4
// suspended-run registry (`listWorkflowRuns`) the same way `pollScheduler` drives cron/interval/at
// triggers: a self-rescheduling poll loop (`createPollLoop`, the SAME shared core `createScheduler`
// uses — see index.ts) that scans `wfrun:` for suspended runs and calls the host-supplied `resume`
// for the ones that are actually due.
//
// The waker does NOT know how to rebuild a workflow instance — it has no `workflows: {}` registry.
// `resume(runId, status)` is host-supplied and closes over whatever registry (e.g. `createGnl` /
// a plain `Workflow` map) actually knows how to call `runResumable` again for that run.
import { acquireRunLock, createPollLoop, withOrg } from '@gnldev/durable';
import type { PollLoop } from '@gnldev/durable';
import { rootJournal } from './root-journal.js';
import { getWorkflowRunStatus, listWorkflowRuns } from '@gnldev/workflow';
import type { JournalLike, WorkflowRunStatus } from '@gnldev/workflow';
import { refuseUnknownNames } from '@gnldev/options';
import { CREATE_WORKFLOW_WAKER_NAMES } from './option-names.js';

/**
 * Per-run wake lock: held (run-lock.ts) for the length of ONE `resume()` and released after it, however
 * it ends. It used to be a permanent ticket per suspend point (`wfwake:<runId>:<updatedAt>`, put-if-absent,
 * no holder, no expiry), taken BEFORE `resume()`: a resume that threw, or a process that died inside it,
 * never gave it back, and since a failed attempt does not move `updatedAt` the run stayed suspended for
 * good (k3, A1). A lock has a holder: released when the resume ends, read as free once its process is
 * gone (or, with no liveness for the store, once its TTL passes on the store's clock).
 */
const WAKE_LOCK = (runId: string) => `wfwake:${runId}`;
/**
 * Written AFTER a `resume()` that returned: this suspend point was woken. A suspend point is
 * `(runId, suspendSeq)` — the run's own suspend counter (@gnldev/workflow), so the same run at a NEW
 * suspend point is a new wake. It used to be `updatedAt`, a clock: a run that re-suspended within the
 * same millisecond shared the key of the point just woken and was never woken again (k3). A resume
 * that threw writes none, and the run is woken again on a later tick.
 */
const WOKEN = (run: WorkflowRunStatus) => `wfwake:${run.runId}:${run.suspendSeq}`;
/** How long a wake lock lasts when no process liveness answers for its holder (its age then decides). */
const WAKE_LOCK_TTL_MS = 60_000;

/** Best-effort narrowing of `WorkflowRunStatus.reason` — see `sleep`/`waitFor`/`waitForResume` in @gnldev/workflow. */
function reasonKind(reason: unknown): { kind?: string; untilMs?: number } {
  return reason && typeof reason === 'object' ? (reason as { kind?: string; untilMs?: number }) : {};
}

export interface WorkflowWakerOptions {
  /** Structurally compatible with @gnldev/workflow's JournalLike (a superset — @gnldev/durable's Journal — also works). */
  journal: JournalLike;
  /**
   * Host-supplied resume: the waker does not know how to rebuild a workflow instance, so it hands
   * the runId + registry record back to the host, which typically calls the matching workflow's
   * `runResumable(input, { runId, journal }, opts)` again (completed steps replay from the journal;
   * the suspended step re-evaluates and either continues or suspends again).
   */
  resume: (runId: string, status: WorkflowRunStatus, where?: { orgId: string }) => Promise<unknown>;
  /**
   * Organizations to scan besides the root. A workflow started inside an organization sleeps in its
   * partition (`org:<id>:wfrun:…`), which a scan of the root never sees — it was never woken. For each
   * one found, `resume` is called with `{ orgId }`, so it can resume on that organization's instance.
   * A list, or a function asked on every tick (e.g. read from your organization registry).
   */
  orgs?: string[] | (() => string[] | Promise<string[]>);
  /** Poll interval (ms). Default 5000. */
  intervalMs?: number;
  /**
   * Random delay (0..jitterMs) added BEFORE each tick's scan — spreads multiple waker instances'
   * polls apart so they don't all hit the journal in lockstep. Does NOT push a time-based sleep
   * PAST its `untilMs`: the due-check reads `Date.now()` AFTER the jitter delay, so a run only
   * ever wakes at-or-after its scheduled time (may be noticed up to `jitterMs` later, never earlier
   * than what a poll interval would already allow). Default 0 (off).
   */
  jitterMs?: number;
  /**
   * Evented (`waitFor`) and HITL (`waitForResume`) suspends have NO time signal — the waker cannot
   * tell whether the event/payload has arrived. Default (false): SKIP them entirely (only time-based
   * sleeps are woken). Opt-in `true`: resume them too, on every tick they remain suspended. Honest
   * cost: since a still-not-ready evented run is at a NEW suspend point (`suspendSeq`, and thus a
   * fresh wake) every time `resume()` re-suspends it, this means one `resume()` round-trip (and
   * whatever `check()`/host work it triggers) PER TICK PER still-suspended evented run, for as long
   * as it stays unresolved — a busy-poll, not a push. Fine for a handful of runs; expensive at scale
   * (prefer delivering the event directly, e.g. `runResumable({ resume })`, when you can).
   */
  wakeEvented?: boolean;
  /**
   * Per-run error hook. Default (omitted): swallowed — `console.warn` ONCE per runId per
   * failure-streak (a success, or the run moving on, resets the streak) so a stuck run doesn't spam
   * logs every tick. The tick loop never dies from a `resume()` throw either way (matches
   * `createPollLoop`'s "the chain doesn't die" contract).
   */
  onError?: (runId: string, error: unknown) => void;
}

export interface WorkflowWakerTickResult {
  /** Runs whose `resume()` was called (this waker held their wake lock for it). */
  resumed: number;
  /** Runs not due yet, evented/HITL runs skipped (wakeEvented off), or runs already woken at this suspend point. */
  skipped: number;
  /** Due runs another waker is resuming right now (it holds their wake lock): tried again on a later tick. */
  busy: number;
  /** `resume()` calls that threw (swallowed — see `onError`). Included in `resumed` (the call WAS made). */
  errored: number;
}

export interface WorkflowWaker {
  /** One scan+wake pass. Exposed directly for tests/manual driving (mirrors pollScheduler/poll). */
  tick(now?: number): Promise<WorkflowWakerTickResult>;
  start(): void;
  stop(): void;
}

/**
 * Creates a durable sleep/event waker for @gnldev/workflow suspended runs. `start()`/`stop()` mirror
 * `createScheduler`'s lifecycle (a self-rescheduling `setTimeout` chain via `createPollLoop` — no
 * dangling timer after `stop()`).
 */
export function createWorkflowWaker(opts: WorkflowWakerOptions): WorkflowWaker {
  refuseUnknownNames('createWorkflowWaker', opts, CREATE_WORKFLOW_WAKER_NAMES);
  const { resume } = opts;
  let { journal } = opts;
  // The waker scans the ROOT registry and reaches organizations through `orgs` (R18): handed an
  // organization's journal it would scan only that partition, and `orgs` would nest a scope inside it.
  journal = rootJournal(journal, 'createWorkflowWaker');
  const intervalMs = opts.intervalMs ?? 5000;
  const jitterMs = opts.jitterMs ?? 0;
  const wakeEvented = opts.wakeEvented ?? false;
  const onError = opts.onError;
  // Warn-once-per-failure-streak bookkeeping (default onError path only) — a run that starts
  // succeeding (or stops showing up as suspended) drops out of the map, so a LATER failure streak
  // warns again.
  const failStreak = new Map<string, number>();
  const owner = `waker-${Math.random().toString(36).slice(2, 10)}`;

  async function tick(now: number = Date.now()): Promise<WorkflowWakerTickResult> {
    const out: WorkflowWakerTickResult = { resumed: 0, skipped: 0, busy: 0, errored: 0 };
    // The root, then each organization's partition — its runs, and its wake tickets, live there.
    const orgList = typeof opts.orgs === 'function' ? await opts.orgs() : (opts.orgs ?? []);
    const partitions: Array<{ j: JournalLike; orgId?: string }> = [
      { j: journal },
      ...orgList.map((orgId) => ({ j: withOrg(journal as never, orgId) as unknown as JournalLike, orgId })),
    ];
    for (const { j, orgId } of partitions) {
      const runs = await listWorkflowRuns(j, { status: 'suspended' });
      for (const run of runs) {
        const reason = reasonKind(run.reason);
        const due =
          reason.kind === 'time'
            ? reason.untilMs !== undefined && now >= reason.untilMs
            : reason.kind === 'event' || reason.kind === 'resume'
              ? wakeEvented
              : false; // unknown reason shape — conservatively don't wake it
        if (!due) {
          out.skipped++;
          continue;
        }

        // Cost/politeness optimization ONLY — correctness does NOT depend on this CAS. `runResumable`
        // is idempotent by construction (completed steps replay from the journal), so even if two
        // waker instances both win this race, both `resume()` calls are harmless — at most one of
        // them actually advances the run.
        // Per partition: two organizations may each have a run with this id.
        const streakKey = `${orgId ?? ''}\u0000${run.runId}`;
        const wokenKey = WOKEN(run);
        const lock = await acquireRunLock(j as never, WAKE_LOCK(run.runId), owner, WAKE_LOCK_TTL_MS);
        if (!lock) {
          out.busy++;
          continue;
        }
        // Decided under the lock, never from the scan: the scan is a snapshot, and another waker may have
        // woken this suspend point since — the run has moved on, or its point is marked woken.
        const cur = await getWorkflowRunStatus(j, run.runId);
        if (cur?.status !== 'suspended' || cur.suspendSeq !== run.suspendSeq || (await j.get(wokenKey)) !== undefined) {
          await lock.release();
          out.skipped++;
          continue;
        }

        out.resumed++;
        try {
          await (orgId === undefined ? resume(run.runId, run) : resume(run.runId, run, { orgId }));
          await j.put(wokenKey, { at: now });
          failStreak.delete(streakKey);
        } catch (err) {
          out.errored++;
          if (onError) {
            onError(run.runId, err);
          } else {
            const streak = (failStreak.get(streakKey) ?? 0) + 1;
            failStreak.set(streakKey, streak);
            if (streak === 1) {
              console.warn(`@gnldev/scheduler: workflow-waker resume('${run.runId}') failed (chain continues):`, err);
            }
          }
        } finally {
          await lock.release();
        }
      }
    }
    return out;
  }

  const loop: PollLoop = createPollLoop(
    async () => {
      if (jitterMs > 0) await new Promise((r) => setTimeout(r, Math.floor(Math.random() * jitterMs)));
      const r = await tick();
      return r.resumed > 0;
    },
    { pollMs: intervalMs, backoff: false }, // sleep waking is timing-critical, same rationale as createScheduler's default
  );

  return {
    tick,
    start: loop.start,
    stop: loop.stop,
  };
}
