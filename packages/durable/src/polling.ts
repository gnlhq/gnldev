// @gnldev/durable/polling — shared poll-loop core (Phase 8.1 review finding: the tick/backoff/"polling"
// flag loop in @gnldev/queue, @gnldev/events, @gnldev/scheduler was nearly THREE identical copies). This module
// consolidates those three copies into ONE place — external behavior (tick timing, backoff
// growth/reset, overlap protection) is preserved exactly; calling packages only pass their own
// `backoff` default already RESOLVED (queue/events ON, scheduler OFF) — this module doesn't impose its own default.
//
// A self-rescheduling setTimeout chain: the next tick is never scheduled until the previous fn()
// FULLY finishes → the overlap risk that exists with setInterval is structurally absent. The
// `polling` flag is still extra insurance against possible externally (manually) triggered overlaps.
// If fn() returns true ("work was done") the interval resets to pollMs; if false ("empty poll") the
// interval grows ×2 (capped at maxPollMs) WHEN backoff IS ON, or stays fixed at pollMs WHEN it's OFF.

import { refuseUnknownNames } from '@gnldev/options';
import { POLL_LOOP_NAMES } from './option-names.js';
import { isDraining, within, settledExceptOwn, outsideHeld } from './process-liveness.js';

/** The ticks running now in this process, across every loop — what a drain waits for (drain.ts). */
const ticking = new Set<Promise<void>>();

/**
 * Resolves when no tick of any poll loop in this process is running. While the process drains no
 * new tick starts (see `tick`), so once this resolves the loops have nothing left in hand.
 */
export function pollLoopsIdle(): Promise<void> {
  // Except the tick the caller runs inside: a job that drains would otherwise wait for its own tick.
  return settledExceptOwn(() => ticking);
}
export interface PollLoopOptions {
  /** Tick interval (ms). Default 200. */
  pollMs?: number;
  /** When fn() returns false (no work), grow the interval ×2 (capped at maxPollMs). Default true. */
  backoff?: boolean;
  /** Backoff cap (only meaningful while backoff !== false). Default pollMs*32. */
  maxPollMs?: number;
}

export interface PollLoop {
  start(): void;
  stop(): void;
}

/**
 * `fn` returns whether work was done in a tick (true/false). Errors (if fn() didn't swallow them
 * internally) are caught and logged here — the chain NEVER dies (the next tick is always scheduled).
 */
export function createPollLoop(fn: () => Promise<boolean>, opts: PollLoopOptions = {}): PollLoop {
  refuseUnknownNames('createPollLoop', opts, POLL_LOOP_NAMES);
  const pollMs = opts.pollMs ?? 200;
  const backoffOn = opts.backoff ?? true;
  const maxPollMs = opts.maxPollMs ?? pollMs * 32;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let polling = false; // overlap protection: a new tick doesn't start before the previous one finishes
  let currentPollMs = pollMs;

  async function tick() {
    if (polling) return;
    // GRACEFUL DRAIN (process-liveness.ts): a process shutting down starts no new tick — the queue
    // takes no job, the scheduler fires no trigger. The chain stays scheduled: the flag belongs to the
    // process, and a test that ends a drain (`endDrain`) gets its loop back.
    if (isDraining()) {
      if (timer !== undefined) timer = setTimeout(tick, currentPollMs);
      return;
    }
    polling = true;
    let progressed = false;
    let done!: () => void;
    const running = new Promise<void>((r) => (done = r));
    ticking.add(running);
    try {
      progressed = await within(running, fn);
    } catch (err) {
      // fn() usually swallows its own work/handler errors internally; this is the last resort only
      // for unexpected (e.g. storage I/O) errors — it matters that the chain NOT DIE (the next tick can still be scheduled).
      console.warn('@gnldev/durable: poll-loop tick failed (chain continues):', err);
    } finally {
      polling = false;
      ticking.delete(running);
      done();
    }
    currentPollMs = !backoffOn ? pollMs : progressed ? pollMs : Math.min(currentPollMs * 2, maxPollMs);
    if (timer !== undefined) timer = setTimeout(tick, currentPollMs); // don't reschedule if stop() set timer to undefined in the meantime
  }

  return {
    start() {
      if (timer !== undefined) return; // already running
      currentPollMs = pollMs;
      // Outside any held unit: the loop outlives whatever started it, and its ticks are nobody's part.
      timer = outsideHeld(() => setTimeout(tick, currentPollMs));
    },
    stop() {
      if (timer) clearTimeout(timer);
      timer = undefined;
    },
  };
}
