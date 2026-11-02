// A flaky provider must not decide an experiment: a trial that could not run is reported apart and left
// out, and a request the connection lost is sent again.
import { describe, it, expect } from 'vitest';
import { runTrials, retryingFetch, classifyFailure, ProviderStoppedError } from '../src/index.js';

describe('a failed trial is left out, not counted', () => {
  it('a job that throws is a failed trial: reported, and not among the values', async () => {
    const jobs = [async () => 1, async () => { throw new Error('socket hang up'); }, async () => 0, async () => 1];
    const r = await runTrials(jobs, { concurrency: 2 });
    expect(r.failed).toBe(1);
    expect(r.values).toEqual([1, 0, 1]);
    expect(r.outcomes[1]).toEqual({ ok: false, error: 'socket hang up' });
  });

  it('progress after every job, with the failures so far and the last reason', async () => {
    const seen: unknown[] = [];
    const jobs = [async () => 1, async () => { throw new Error('socket hang up'); }, async () => 0];
    await runTrials(jobs, { concurrency: 1, onProgress: (p) => seen.push(p) });
    expect(seen).toEqual([
      { done: 0, total: 3, failed: 0, concurrency: 1, running: 1 }, // started, before any job ends
      { done: 1, total: 3, failed: 0, concurrency: 1, running: 0 },
      { done: 2, total: 3, failed: 1, concurrency: 1, running: 0, lastError: 'socket hang up' },
      { done: 3, total: 3, failed: 1, concurrency: 1, running: 0, lastError: 'socket hang up' },
    ]);
  });

  it('a 429 slows the run to one job at a time and runs the job again; it is not a failed trial', async () => {
    const seen: any[] = [];
    let refused = 0;
    const throttled = Object.assign(new Error('Failed after 3 attempts. Last error: Too Many Requests'), { lastError: { statusCode: 429 } });
    const jobs = Array.from({ length: 6 }, (_, i) => async () => { if (i === 1 && refused++ < 2) throw throttled; return i; });
    const r = await runTrials(jobs, { concurrency: 3, throttle: { waitMs: 1 }, onProgress: (p) => seen.push(p) });
    expect(r.failed).toBe(0);
    expect(r.values).toEqual([0, 1, 2, 3, 4, 5]);
    expect(seen.filter((p) => p.throttled)).toHaveLength(2); // a success in between starts the count again
    expect(seen.at(-1)).toMatchObject({ done: 6, total: 6, concurrency: 1 });
  });

  it('a provider that keeps refusing after the slow-down stops the run, saying so', async () => {
    const jobs = Array.from({ length: 5 }, () => async () => { throw new Error('429 Too Many Requests'); });
    await expect(runTrials(jobs, { throttle: { waitMs: 1, maxWaits: 2 } })).rejects.toThrow(/stopped after 0 of 5 — the provider kept refusing requests \(429\)/);
  });

  it('a 5xx after the client retries stops the run at once; a timeout is a failed trial as before', async () => {
    let started = 0;
    const jobs = Array.from({ length: 8 }, (_, i) => async () => { started++; if (i === 2) throw Object.assign(new Error('Internal Server Error'), { statusCode: 500 }); if (i === 1) throw new Error('timed out'); return i; });
    const e = await runTrials(jobs, { concurrency: 1 }).catch((x) => x);
    expect(e).toBeInstanceOf(ProviderStoppedError);
    expect(e.message).toMatch(/stopped after 3 of 8 — the provider answered a server error \(5xx\)/);
    expect(started).toBe(3);
    const kept = await runTrials(jobs.slice(0, 3), { concurrency: 1, stopOnServerError: false });
    expect(kept.failed).toBe(2);
  });

  it('what the error says about the provider', () => {
    expect(classifyFailure(Object.assign(new Error('x'), { lastError: { statusCode: 429 } }))).toBe('throttled');
    expect(classifyFailure('AI_APICallError: Too Many Requests')).toBe('throttled');
    expect(classifyFailure(Object.assign(new Error('x'), { statusCode: 503 }))).toBe('server');
    expect(classifyFailure(Object.assign(new Error('Too Many Requests in the text'), { statusCode: 400 }))).toBe('other');
    expect(classifyFailure(new Error('socket hang up'))).toBe('other');
  });

  it("a request the provider client sends again is reported while its job still runs — not a minute of silence", async () => {
    const seen: any[] = [];
    const answers = [429, 429, 200];
    const f = retryingFetch({ delayMs: 1, fetch: (async () => new Response('{}', { status: answers.shift()! })) as typeof fetch });
    await runTrials([async () => (await f('http://provider')).status], { onProgress: (p) => seen.push(p) });
    expect(seen.filter((p) => p.retrying).map((p) => [p.retrying.reason, p.retrying.attempt, p.running, p.done])).toEqual([['http 429', 1, 1, 0], ['http 429', 2, 1, 0]]);
    expect(seen.at(-1)).toMatchObject({ done: 1, running: 0 });
  });

  it('aborted, no further job starts and the abort is thrown — not a result with the rest missing', async () => {
    const stop = new AbortController();
    let started = 0;
    const job = async () => { started++; if (started === 2) stop.abort(new Error('the client went away')); return 1; };
    await expect(runTrials(Array.from({ length: 10 }, () => job), { concurrency: 1, signal: stop.signal })).rejects.toThrow('the client went away');
    expect(started).toBe(2);
  });

  it('runs at most `concurrency` jobs at once', async () => {
    let running = 0, most = 0;
    const job = async () => { running++; most = Math.max(most, running); await new Promise((s) => setTimeout(s, 5)); running--; return 0; };
    await runTrials(Array.from({ length: 12 }, () => job), { concurrency: 3 });
    expect(most).toBe(3);
  });

  it('a reset connection and a 503 are sent again; a 400 is returned as it is', async () => {
    const answers: Array<Error | number> = [new Error('ECONNRESET'), 503, 200];
    const retries: string[] = [];
    const f = retryingFetch({ delayMs: 1, onRetry: (why) => retries.push(why), fetch: (async () => {
      const a = answers.shift()!;
      if (a instanceof Error) throw a;
      return new Response('{}', { status: a });
    }) as typeof fetch });
    expect((await f('https://provider.test')).status).toBe(200);
    expect(retries).toEqual(['ECONNRESET', 'http 503']);

    let sent = 0;
    const g = retryingFetch({ delayMs: 1, fetch: (async () => { sent++; return new Response('bad', { status: 400 }); }) as typeof fetch });
    expect((await g('https://provider.test')).status).toBe(400);
    expect(sent).toBe(1);
  });

  it('gives up after `retries` and says why: the last error, or the last answer', async () => {
    const down = retryingFetch({ retries: 2, delayMs: 1, fetch: (async () => { throw new Error('ECONNRESET'); }) as typeof fetch });
    await expect(down('https://provider.test')).rejects.toThrow('ECONNRESET');
    let sent = 0;
    const busy = retryingFetch({ retries: 2, delayMs: 1, fetch: (async () => { sent++; return new Response('', { status: 429 }); }) as typeof fetch });
    expect((await busy('https://provider.test')).status).toBe(429);
    expect(sent).toBe(3);
  });

  it('a misspelled option is refused', () => {
    expect(() => retryingFetch({ retry: 3 } as any)).toThrow(/retry/);
    return expect(runTrials([], { concurency: 2 } as any)).rejects.toThrow(/concurency/);
  });
});
