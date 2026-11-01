// Many model calls, run so that a flaky provider does not decide the result.
//
// runTrials: jobs run a few at a time; a job that throws is a failed trial, reported apart and LEFT OUT.
// Counting it as "the outcome did not happen" would pull every rate down, and a low rate is the number
// someone uses to remove a guard or a prompt section.
//
// retryingFetch: measured on NVIDIA NIM on one day, 23–38% of requests were reset or answered 5xx/429
// and succeeded when sent again. A fetch for a provider client that sends such a request again, with a
// growing pause; any other answer (a 4xx is the request's own fault) is returned as it is.
import { AsyncLocalStorage } from 'node:async_hooks';
import { refuseUnknownNames } from '@gnldev/options';
import { TRIALS_NAMES, RETRYING_FETCH_NAMES } from './option-names.js';
import { classifyFailure, pause, ProviderStoppedError } from './provider-errors.js';

export interface RunTrialsOptions {
  /** Jobs run at once (default 4). */
  concurrency?: number;
  /** Called after every job: how many are done, of how many, how many failed, and the last failure. */
  onProgress?: (progress: TrialsProgress) => void;
  /** Aborted: no further job starts, the ones running finish, and runTrials throws the abort reason. */
  signal?: AbortSignal;
  /**
   * A job the provider refused with 429: it is run again, after a pause of `waitMs` × the number of
   * refusals in a row (default 15000), one job at a time from then on. More than `maxWaits` refusals in a
   * row (default 4) and runTrials stops with a ProviderStoppedError.
   */
  throttle?: { waitMs?: number; maxWaits?: number };
  /** A job that ended in a provider 5xx (after the client's own retries) stops runTrials (default true). */
  stopOnServerError?: boolean;
}

export interface TrialsProgress {
  done: number;
  total: number;
  failed: number;
  /** The last failure's message — the reason a run that fails as it goes can be stopped early. */
  lastError?: string;
  /** Jobs running at once now: lower than asked once the provider refused one. */
  concurrency: number;
  /** Present while it waits because the provider refused a request (429). */
  throttled?: { waitMs: number; attempt: number; maxWaits: number; error: string };
  /** Jobs started and not finished. */
  running: number;
  /**
   * A request a running job sent is being sent again by retryingFetch: why, which attempt, and the pause
   * before it. Without it a job that waits through a provider's refusals shows nothing for a minute.
   */
  retrying?: { reason: string; attempt: number; waitMs: number };
}

export interface RetryNotice { reason: string; attempt: number; waitMs: number }
// The job a request belongs to: retryingFetch runs inside a provider client the job called, so the job
// cannot be handed a callback — it is found through the async context the request was sent from.
const retryListener = new AsyncLocalStorage<(notice: RetryNotice) => void>();

/** Runs `fn`; every request retryingFetch sends again inside it is reported to `listener`. */
export function reportRetriesTo<T>(listener: (notice: RetryNotice) => void, fn: () => Promise<T>): Promise<T> {
  return retryListener.run(listener, fn);
}

export type TrialOutcome<T> = { ok: true; value: T } | { ok: false; error: string };

export interface TrialsResult<T> {
  /** In the jobs' order. */
  outcomes: TrialOutcome<T>[];
  /** The values of the trials that ran, in the jobs' order. */
  values: T[];
  failed: number;
}

/**
 * Runs `jobs`, `concurrency` at a time. A job that throws is a failed trial, not a value — except when the
 * provider says why: a 429 slows the run down and the job is run again; a 5xx stops the run.
 */
export async function runTrials<T>(jobs: ReadonlyArray<() => Promise<T>>, opts: RunTrialsOptions = {}): Promise<TrialsResult<T>> {
  refuseUnknownNames('runTrials', opts, TRIALS_NAMES);
  const waitMs = opts.throttle?.waitMs ?? 15_000, maxWaits = opts.throttle?.maxWaits ?? 4;
  const outcomes: TrialOutcome<T>[] = new Array(jobs.length);
  const queue = jobs.map((_, i) => i);
  let done = 0, failed = 0, running = 0, width = Math.max(1, opts.concurrency ?? 4), refusals = 0, resumeAt = 0;
  let lastError: string | undefined;
  let stopped: ProviderStoppedError | undefined;
  const report = (extra: Pick<TrialsProgress, 'throttled' | 'retrying'> = {}) =>
    opts.onProgress?.({ done, total: jobs.length, failed, concurrency: width, running, ...(lastError !== undefined ? { lastError } : {}), ...extra });
  const onRetry = (retrying: RetryNotice) => report({ retrying });
  const halted = () => opts.signal?.aborted || stopped !== undefined;
  const worker = async (id: number) => {
    while (queue.length > 0 && !halted() && id < width) {
      if (resumeAt > Date.now()) { await pause(resumeAt - Date.now(), opts.signal); continue; }
      const i = queue.shift()!;
      running++;
      if (running === 1 && done === 0) report(); // it has started: say so before the first job ends
      let thrown: { e: unknown } | undefined;
      try { outcomes[i] = { ok: true, value: await reportRetriesTo(onRetry, jobs[i]!) }; refusals = 0; }
      catch (e) { thrown = { e }; }
      running--;
      if (thrown) {
        const error = thrown.e instanceof Error ? thrown.e.message : String(thrown.e);
        const kind = classifyFailure(thrown.e);
        if (kind === 'throttled') {
          refusals++;
          lastError = error;
          if (refusals > maxWaits) { stopped ??= new ProviderStoppedError('throttled', error, done, jobs.length); return; }
          queue.unshift(i);
          width = 1;
          resumeAt = Date.now() + waitMs * refusals;
          report({ throttled: { waitMs: waitMs * refusals, attempt: refusals, maxWaits, error } });
          continue;
        }
        outcomes[i] = { ok: false, error }; failed++; lastError = error;
        if (kind === 'server' && (opts.stopOnServerError ?? true)) { done++; stopped ??= new ProviderStoppedError('server', error, done, jobs.length); return; }
      }
      done++;
      report();
    }
  };
  // A job a retiring worker put back (the pace dropped to one) is picked up by a new round.
  while (queue.length > 0 && !halted()) await Promise.all(Array.from({ length: width }, (_, id) => worker(id)));
  opts.signal?.throwIfAborted();
  if (stopped) throw stopped;
  const values = outcomes.filter((o): o is { ok: true; value: T } => o?.ok === true).map((o) => o.value);
  return { outcomes, values, failed: outcomes.length - values.length };
}

export interface RetryingFetchOptions {
  /** Sends after the first (default 5). */
  retries?: number;
  /** The first pause in ms; each later one is this times the attempt (default 1500). */
  delayMs?: number;
  /** The fetch to wrap (default globalThis.fetch). */
  fetch?: typeof fetch;
  /** Called before each repeat, with what failed — to count them. */
  onRetry?: (reason: string, attempt: number) => void;
}

/** A fetch that sends a request again when the connection failed or the answer was 5xx or 429. */
export function retryingFetch(opts: RetryingFetchOptions = {}): typeof fetch {
  refuseUnknownNames('retryingFetch', opts, RETRYING_FETCH_NAMES);
  const base = opts.fetch ?? globalThis.fetch;
  const retries = opts.retries ?? 5;
  const delay = opts.delayMs ?? 1500;
  return (async (input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
    for (let attempt = 0; ; attempt++) {
      let reason: string;
      try {
        const r = await base(input, init);
        if (r.status < 500 && r.status !== 429) return r;
        if (attempt >= retries) return r;
        reason = `http ${r.status}`;
      } catch (e) {
        if (attempt >= retries || init?.signal?.aborted) throw e;
        reason = e instanceof Error ? e.message : String(e);
      }
      opts.onRetry?.(reason, attempt + 1);
      retryListener.getStore()?.({ reason, attempt: attempt + 1, waitMs: delay * (attempt + 1) });
      await new Promise((s) => setTimeout(s, delay * (attempt + 1)));
    }
  }) as typeof fetch;
}
