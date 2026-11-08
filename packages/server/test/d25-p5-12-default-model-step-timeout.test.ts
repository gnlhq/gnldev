// d25 P5 / karar 12: a model step has a DEFAULT time limit (120 s, until the first byte). A frozen provider
// connection ends the run with StepTimeoutError without any configuration; chat/REST inherit it.
// Opt-out is explicit: timeouts: { modelStepMs: 0 }. A slow model that keeps streaming is never cut.
// Clock is faked (setTimeout only) so 120 s costs nothing.
import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';
import { InMemoryJournal, createGnl } from '@gnldev/durable';
import { createRestApi } from '../src/index.js';
import { call } from './call.js';

const usage = { inputTokens: 1, outputTokens: 1, totalTokens: 2 };
const hangFirstByte = (): any => ({ specificationVersion: 'v2', provider: 'mock', modelId: 'm', supportedUrls: {}, doGenerate: async () => new Promise(() => {}), doStream: async () => new Promise(() => {}) });
/** First byte after `firstMs`, then one chunk every `gapMs`: slow overall (> 120 s) but never silent for 120 s. */
const slowButStreaming = (firstMs: number, gapMs: number, chunks: number): any => ({
  specificationVersion: 'v2', provider: 'mock', modelId: 'slow', supportedUrls: {}, doGenerate: async () => { throw new Error('no gen'); },
  doStream: async () => {
    await new Promise((r) => setTimeout(r, firstMs));
    let i = 0;
    return { stream: new ReadableStream({
      async start(c) { c.enqueue({ type: 'stream-start', warnings: [] }); c.enqueue({ type: 'text-start', id: '1' }); },
      async pull(c) {
        await new Promise((r) => setTimeout(r, gapMs));
        if (i < chunks) { c.enqueue({ type: 'text-delta', id: '1', delta: `p${i++} ` }); return; }
        c.enqueue({ type: 'text-end', id: '1' }); c.enqueue({ type: 'finish', finishReason: 'stop', usage }); c.close();
      },
    }) };
  },
});

beforeEach(() => { vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] }); vi.spyOn(console, 'warn').mockImplementation(() => {}); vi.spyOn(console, 'error').mockImplementation(() => {}); });
afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); });

const outcome = (p: Promise<any>) => { const o: { v?: any; e?: any; done: boolean } = { done: false }; p.then((v) => { o.v = v; o.done = true; }, (e) => { o.e = e; o.done = true; }); return o; };

describe('12: default model-step time limit', () => {
  it('a frozen first byte, no timeouts configured: still pending at 119 s, StepTimeoutError after 120 s', async () => {
    const gnl = createGnl({ journal: new InMemoryJournal(), agents: { a: { model: hangFirstByte() } } } as any);
    const o = outcome(gnl.run('a', { runId: 'p12-1', prompt: 'x' }));
    await vi.advanceTimersByTimeAsync(119_000);
    expect(o.done).toBe(false);                       // not cut early
    await vi.advanceTimersByTimeAsync(5_000);
    expect(o.done).toBe(true);
    expect(o.e?.name).toBe('StepTimeoutError');
  });
  it('REST /run inherits the default: the frozen call answers (not 200) once 120 s pass', async () => {
    const api = createRestApi({ journal: new InMemoryJournal(), agents: { a: { model: hangFirstByte() } } }, { protectionsBanner: false } as any);
    const o = outcome(call(api, '/agents/a/run', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ runId: 'p12-rest', prompt: 'x' }) }));
    await vi.advanceTimersByTimeAsync(130_000);
    expect(o.done).toBe(true);
    expect(o.v?.status).not.toBe(200);
  });
  it('SIBLING (negative): a slow model that keeps streaming (first byte 100 s, then a chunk every 50 s, 300 s total) is NOT cut', async () => {
    const gnl = createGnl({ journal: new InMemoryJournal(), agents: { a: { model: slowButStreaming(100_000, 50_000, 4) } } } as any);
    const o = outcome(gnl.run('a', { runId: 'p12-slow', prompt: 'x' }));
    await vi.advanceTimersByTimeAsync(400_000);
    expect(o.e).toBeUndefined();
    expect(o.v?.text).toContain('p3');
  });
  it('SIBLING: the opt-out is explicit — timeouts: { modelStepMs: 0 } keeps the frozen call waiting past 120 s', async () => {
    const gnl = createGnl({ journal: new InMemoryJournal(), timeouts: { modelStepMs: 0 }, agents: { a: { model: hangFirstByte() } } } as any);
    const o = outcome(gnl.run('a', { runId: 'p12-off', prompt: 'x' }));
    await vi.advanceTimersByTimeAsync(600_000);
    expect(o.done).toBe(false);
  });
  it('SIBLING: a configured value still wins over the default (60 s ends it before 120 s)', async () => {
    const gnl = createGnl({ journal: new InMemoryJournal(), timeouts: { modelStepMs: 60_000 }, agents: { a: { model: hangFirstByte() } } } as any);
    const o = outcome(gnl.run('a', { runId: 'p12-cfg', prompt: 'x' }));
    await vi.advanceTimersByTimeAsync(65_000);
    expect(o.e?.name).toBe('StepTimeoutError');
  });
});
