// ONE SHUTDOWN PATH FOR THE PROCESS (SIGTERM).
//
// A process manager (pm2, Kubernetes, systemd) stops a process with SIGTERM, waits, then kills it.
// What this process holds when the signal arrives is finished, not cut off:
//   · a new request is refused (503, `draining`) — the doors read the same flag;
//   · a run's running tool finishes and is recorded, no new step or tool starts, the run is released
//     and another process continues it (the executor, detached.ts);
//   · the queue takes no new job and the scheduler fires no trigger (every poll loop, polling.ts); the
//     job a worker holds runs to its end and is recorded;
//   · when nothing is left in hand the drain resolves, and the process exits.
// Nothing is written to the store to say "shutting down": the flag is the process's, and a process
// that dies instead of draining is the crash path every promise already covers.
import { beginDrain, heldWorkSettled } from './process-liveness.js';
import { drainExecutors } from './executors.js';
import { pollLoopsIdle } from './polling.js';
import { refuseUnknownNames } from '@gnldev/options';
import { DRAIN_NAMES, DRAIN_ON_SIGNAL_NAMES } from './option-names.js';

/**
 * How long a drain waits for what this process holds, by default. A process manager must wait longer
 * than this before it kills: pm2's `kill_timeout` (1.6 s by default — too short), Kubernetes'
 * `terminationGracePeriodSeconds` (30 s by default).
 */
export const DRAIN_DEADLINE_MS = 25_000;

export interface DrainOptions {
  /** How long to wait for the work in hand (default `DRAIN_DEADLINE_MS`). Past it, the drain resolves `{ drained: false }`. */
  deadlineMs?: number;
}

/**
 * Drains this process: stops taking work and waits for the work in hand — runs (released at their next
 * boundary), queue jobs, scheduler fires. `{ drained: true }` when nothing is left; `{ drained: false }`
 * when the deadline passed first — what is still running is left to the crash path (another process
 * takes it over once this one is gone). Idempotent: a second call waits for the same thing.
 */
export async function drainProcess(opts: DrainOptions = {}): Promise<{ drained: boolean }> {
  refuseUnknownNames('drainProcess', opts, DRAIN_NAMES);
  beginDrain();
  const deadlineMs = opts.deadlineMs ?? DRAIN_DEADLINE_MS;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const late = new Promise<false>((resolve) => {
    timer = setTimeout(() => resolve(false), deadlineMs);
    (timer as { unref?: () => void }).unref?.();
  });
  const done = Promise.all([drainExecutors(), pollLoopsIdle(), heldWorkSettled()]).then(() => true as const);
  try {
    return { drained: await Promise.race([done, late]) };
  } finally {
    clearTimeout(timer);
  }
}

export interface DrainOnSignalOptions extends DrainOptions {
  /** The signals that drain (default SIGTERM and SIGINT). A second one exits at once. */
  signals?: NodeJS.Signals[];
  /** Runs after the drain, before the exit — close the HTTP server, the store's pool. Its failure is logged. */
  onDrained?: (result: { drained: boolean }) => void | Promise<void>;
}

let installed: { off: () => void; signals: NodeJS.Signals[]; deadlineMs?: number; onDrained?: DrainOnSignalOptions['onDrained'] } | undefined;

/**
 * Drains on SIGTERM (and SIGINT), then exits: 0 when everything in hand finished, 1 when the deadline
 * passed first. What an application's entry point calls once (the `gnl init` server templates do).
 * Returns the function that uninstalls it. A second call with the same options returns the same one;
 * with other options it is refused — one process has one shutdown, and the second call's `onDrained`
 * or deadline was silently dropped before. Uninstall the first to install others.
 */
export function drainOnSignal(opts: DrainOnSignalOptions = {}): () => void {
  refuseUnknownNames('drainOnSignal', opts, DRAIN_ON_SIGNAL_NAMES);
  const signals = opts.signals ?? ['SIGTERM', 'SIGINT'];
  if (installed) {
    const same = installed.deadlineMs === opts.deadlineMs && installed.onDrained === opts.onDrained
      && installed.signals.length === signals.length && installed.signals.every((s) => signals.includes(s));
    if (same) return installed.off;
    throw new Error('@gnldev/durable: drainOnSignal is already installed in this process with other options (signals, deadlineMs or onDrained) — one process has one shutdown. Do it in one call, or uninstall the first (the function it returned) before installing another.');
  }
  let draining = false;
  const handler = (signal: NodeJS.Signals): void => {
    // A second signal while draining: the operator wants it gone now.
    if (draining) process.exit(1);
    draining = true;
    console.warn(`gnl: ${signal} — draining (finishing the work in hand, taking none; up to ${Math.round((opts.deadlineMs ?? DRAIN_DEADLINE_MS) / 1000)} s)`);
    void (async () => {
      const result = await drainProcess(opts.deadlineMs !== undefined ? { deadlineMs: opts.deadlineMs } : {});
      if (!result.drained) console.warn('gnl: the drain deadline passed with work still running — it is left to another process');
      try { await opts.onDrained?.(result); } catch (e) { console.warn('gnl: onDrained failed:', e); }
      process.exit(result.drained ? 0 : 1);
    })();
  };
  for (const s of signals) process.on(s, handler);
  const off = (): void => {
    for (const s of signals) process.off(s, handler);
    if (installed?.off === off) installed = undefined;
  };
  installed = { off, signals: [...signals], ...(opts.deadlineMs !== undefined ? { deadlineMs: opts.deadlineMs } : {}), ...(opts.onDrained ? { onDrained: opts.onDrained } : {}) };
  return off;
}
