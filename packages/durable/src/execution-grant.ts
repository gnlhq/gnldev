// THE RIGHT TO EXECUTE — one shape for every holder of work: a detached run's executor, a queue worker's
// job, a scheduler's fire, an event consumer's delivery.
//
// Each of them holds its work by something that can be taken away: a lease that another process takes
// over, a close of the store under it, a cancel, a time limit. Each used to keep its own AbortController
// and abort it for only some of these — a queue job aborted on a cancel and ran on after its lease was
// taken (audit N4), a fire's workflow was never told (scheduler KNOWN LIMIT), a detached run aborted on
// close() wrote `completed` because nothing read why it stopped (audit A2).
//
// A grant is the one place this is decided:
//   · ONE SIGNAL, ONE REASON. The body is handed `grant.signal`. However the right ends — `released`
//     (this process lets go: another one continues), `lease-lost` (another holder has it now),
//     `timeout` (held as long as it may be), `canceled` (nobody is to continue it) — the signal aborts
//     with an ExecutionRevokedError naming it. The first revocation wins.
//   · THE ENDING READS THE REASON, never a default: a revoked execution ended because of the revocation,
//     whatever its stream or handler did after it (`revokedWhy`); one that was not revoked ended as its
//     own positive evidence says (a finish, a return, a throw).
//   · A BODY THAT DOES NOT HEAR IT IS SAID SO, ONCE: JavaScript cannot be stopped from outside. If the
//     body is still running `unheededAfterMs` after the right was lost (`lease-lost`, or `timeout`) it
//     did not observe the signal — a warning, once per grant, naming what that costs (`unheededWarning`).
//     A cancel and a release are not losses: nothing continues elsewhere, nothing is warned.
//   · ONE RENEWAL RULE (`keep`): a renewal that answers `false` is a lost lease; one that throws
//     `maxFailures` times in a row is taken for one (its TTL has run out by then).
//
// Read by name, as attemptEndOf reads errors: a host with two copies of this package — or a package that
// does not depend on it (@gnldev/workflow) — gets the same answer.

/** Why an execution lost its right to run. */
export type RevokeWhy = 'released' | 'lease-lost' | 'timeout' | 'canceled';

/** The reason a grant's signal aborts with. */
export class ExecutionRevokedError extends Error {
  override readonly name = 'ExecutionRevokedError';
  readonly code = 'execution_revoked';
  constructor(readonly why: RevokeWhy, readonly unit: string, message?: string) {
    super(message ?? `${unit}: ${WHY_TEXT[why]}`);
  }
}

const WHY_TEXT: Record<RevokeWhy, string> = {
  released: 'released by this process (another process continues it)',
  'lease-lost': 'its lease was lost (another holder has it now)',
  timeout: 'held as long as it may be (maxHoldMs)',
  canceled: 'canceled',
};

/** Why `e` (an abort reason, an error, or what wraps one, one `cause` deep) says an execution was stopped; `undefined`: it is not a revocation. */
export function revokedWhy(e: unknown): RevokeWhy | undefined {
  for (let x = e as { name?: unknown; why?: unknown; cause?: unknown } | null | undefined, i = 0; x && typeof x === 'object' && i < 2; x = x.cause as typeof x, i++) {
    if (x.name === 'ExecutionRevokedError' && typeof x.why === 'string' && x.why in WHY_TEXT) return x.why as RevokeWhy;
  }
  return undefined;
}

/** A revocation after which the work goes on elsewhere (nothing about it ended here). */
export function continuesElsewhere(why: RevokeWhy | undefined): boolean {
  return why === 'released' || why === 'lease-lost';
}

export interface ExecutionGrant {
  /** What the body is handed: aborted once, with an ExecutionRevokedError, when the right ends. */
  readonly signal: AbortSignal;
  /** Why the right ended, or `undefined` while it holds. */
  readonly revoked: RevokeWhy | undefined;
  /** Ends the right (the first call wins). */
  revoke(why: RevokeWhy, message?: string): void;
  /**
   * Keeps a lease behind the right: `renew` every `everyMs`; `false` → `lease-lost`; a throw `maxFailures`
   * times in a row (default 3) → `lease-lost`, each throw before that reported to `onTransient`. Renewed
   * until the lease is lost or `dispose()` — after a `timeout` or a cancel too: until its body stops, the
   * work is still held, and a lease let go under a running body is a second execution beside it.
   */
  keep(renew: () => Promise<boolean>, opts: { everyMs: number; maxFailures?: number; onTransient?: (err: unknown, inARow: number) => void }): void;
  /**
   * Stops the grant's timers (its renewal, its hold limit) and resolves once a renewal in flight has
   * settled — after it nothing renews the lease, so a release that follows is not undone. Call when the
   * execution is over.
   */
  dispose(): Promise<void>;
}

/**
 * What the warning says about the body, in the words of the package that runs it — the one place the
 * sentence is built; each package gives only its own nouns and its own advice. Queue: "the handler",
 * "ctx.signal", side effects inside `ctx.run`; events: "the handler", "meta.signal", an idempotent handler;
 * scheduler: "the workflow", the runner's `signal`, the workflow's recorded steps.
 */
export interface UnheededText {
  /** What is still running: `'the handler'`, `'the workflow'`. */
  body: string;
  /** The signal it was given, as its author knows it: `'ctx.signal'`, `'meta.signal'`. */
  signal: string;
  /** What a body that ran on after a `lease-lost` costs, and how to make it safe. */
  lost: string;
  /** The same after a `timeout` (`maxHoldMs`); omitted where there is no hold limit. */
  timeout?: string;
}
const NEUTRAL: UnheededText = { body: 'the body', signal: 'its signal', lost: 'Work it does now may be repeated by the holder that took it over.', timeout: 'Work it does now may be repeated by the next attempt.' };

/** The warning for a body that kept running after its right ended and did not stop on its signal. */
function unheededWarning(unit: string, why: RevokeWhy, afterMs: number, text: UnheededText): string {
  const tail = `${text.signal} may not be observed — the framework cannot stop code that ignores it.`;
  return why === 'lease-lost'
    ? `${unit}: its lease was lost and the work moved to another holder, but ${text.body} is still running ${afterMs} ms later — ${tail} ${text.lost}`
    : `${unit}: its hold time (maxHoldMs) is up, but ${text.body} is still running ${afterMs} ms later — ${tail} ${text.timeout ?? NEUTRAL.timeout}`;
}

/**
 * A right to execute `unit`, ending at the latest after `maxHoldMs` (`timeout`; default: no limit).
 * `unheededAfterMs`: warn once if the body is still running that long after a `lease-lost` or `timeout`,
 * in the words of `unheeded` (the package's; neutral when omitted).
 * @internal — gnl plumbing between packages: queue, events and scheduler build its options, no host writes them
 * (a host's limit is the package's own option, e.g. the queue's `maxHoldMs`).
 */
export function executionGrant(unit: string, opts: { maxHoldMs?: number; unheededAfterMs?: number; unheeded?: UnheededText } = {}): ExecutionGrant {
  const ctrl = new AbortController();
  let why: RevokeWhy | undefined;
  const timers: Array<ReturnType<typeof setInterval>> = [];
  let inFlight: Promise<void> | undefined;
  const revoke = (w: RevokeWhy, message?: string) => {
    if (why) return;
    why = w;
    ctrl.abort(new ExecutionRevokedError(w, unit, message));
    const after = opts.unheededAfterMs;
    if (after !== undefined && (w === 'lease-lost' || w === 'timeout')) {
      // Cleared by dispose(): the body having stopped is what keeps this warning from being said.
      const t = setTimeout(() => console.warn(unheededWarning(unit, w, after, opts.unheeded ?? NEUTRAL)), after);
      (t as { unref?: () => void }).unref?.();
      timers.push(t as unknown as ReturnType<typeof setInterval>);
    }
  };
  const hold = opts.maxHoldMs;
  if (hold !== undefined && hold !== Infinity) {
    if (!(typeof hold === 'number' && hold > 0)) throw new TypeError(`maxHoldMs must be a positive number of milliseconds (or Infinity), got ${String(hold)}`);
    const t = setTimeout(() => revoke('timeout', `${unit}: held for ${hold} ms (maxHoldMs) — stopped`), hold);
    (t as { unref?: () => void }).unref?.();
    timers.push(t as unknown as ReturnType<typeof setInterval>);
  }
  return {
    signal: ctrl.signal,
    get revoked() { return why; },
    revoke,
    keep(renew, k) {
      const max = k.maxFailures ?? 3;
      let inARow = 0;
      const t = setInterval(() => {
        // The lease is kept after any other revocation: a body that has not stopped yet still holds its work.
        if (inFlight || why === 'lease-lost') return;
        inFlight = renew()
          .then((ok) => { if (!ok) revoke('lease-lost'); else inARow = 0; })
          .catch((err) => {
            inARow++;
            k.onTransient?.(err, inARow);
            if (inARow >= max) revoke('lease-lost', `${unit}: its lease could not be renewed ${inARow} times in a row — taken as lost (its TTL has run out)`);
          })
          .finally(() => { inFlight = undefined; });
      }, Math.max(1, Math.floor(k.everyMs)));
      (t as { unref?: () => void }).unref?.();
      timers.push(t);
    },
    async dispose() {
      for (const t of timers) { clearInterval(t); clearTimeout(t); }
      timers.length = 0;
      await inFlight;
    },
  };
}
