// What a failed model call says about the provider, read from the error a provider client throws.
//
// Measured on NVIDIA NIM: a throttled account answers every request 429 for minutes, and an experiment
// that keeps its pace through that spends all of them and ends with nothing. A 429 is a reason to slow
// down; a 5xx that outlived the client's own retries is a reason to stop — the provider is not answering,
// and the next replay will not be different. Anything else (a timeout, a bad answer) is the trial's own.
//
// The AI SDK wraps the provider's answer: a RetryError's `lastError`, an APICallError's `statusCode`.
// The status is read from those first; the message is the fallback for clients that only say it in text.

export type ProviderFailure = 'throttled' | 'server' | 'other';

function statusOf(e: unknown, depth = 0): number | undefined {
  if (!e || typeof e !== 'object' || depth > 4) return undefined;
  const o = e as { statusCode?: unknown; status?: unknown; lastError?: unknown; cause?: unknown };
  if (typeof o.statusCode === 'number') return o.statusCode;
  if (typeof o.status === 'number' && o.status >= 400) return o.status;
  return statusOf(o.lastError, depth + 1) ?? statusOf(o.cause, depth + 1);
}

/** 'throttled' for a 429, 'server' for a 5xx, 'other' for anything else. Takes the error or its message. */
export function classifyFailure(e: unknown): ProviderFailure {
  const status = typeof e === 'string' ? undefined : statusOf(e);
  if (status === 429) return 'throttled';
  if (status !== undefined && status >= 500) return 'server';
  if (status !== undefined) return 'other';
  const text = typeof e === 'string' ? e : e instanceof Error ? e.message : String(e);
  if (/\b429\b|too many requests|rate.?limit/i.test(text)) return 'throttled';
  if (/\b50[0-4]\b|internal server error|bad gateway|service unavailable|gateway time-?out/i.test(text)) return 'server';
  return 'other';
}

/** An experiment stopped because the provider stopped answering: what it said, and how far it got. */
export class ProviderStoppedError extends Error {
  constructor(readonly failure: Exclude<ProviderFailure, 'other'>, readonly last: string, readonly done: number, readonly total: number) {
    super(failure === 'throttled'
      ? `@gnldev/experiment: stopped after ${done} of ${total} — the provider kept refusing requests (429) after slowing down: ${last}`
      : `@gnldev/experiment: stopped after ${done} of ${total} — the provider answered a server error (5xx) after its retries: ${last}`);
    this.name = 'ProviderStoppedError';
  }
}

/** Waits `ms`, or until `signal` aborts. */
export function pause(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal?.aborted) return resolve();
    const t = setTimeout(done, ms);
    function done() { clearTimeout(t); signal?.removeEventListener('abort', done); resolve(); }
    signal?.addEventListener('abort', done, { once: true });
  });
}
