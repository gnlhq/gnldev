// d25 U7 — a model stream that never answers: is there a default time limit, and can the chat surface set one?
// Red = claim holds (still pending after the wait).
import { describe, it, expect } from 'vitest';
import { InMemoryJournal, createGnl } from '@gnldev/durable';
import { createChatRoute } from '../src/index.js';

const usage = { inputTokens: 1, outputTokens: 1, totalTokens: 2 };
/** doStream that never produces its first byte (frozen provider connection). */
const hangFirstByte: any = { specificationVersion: 'v2', provider: 'mock', modelId: 'm', supportedUrls: {}, doGenerate: async () => new Promise(() => {}), doStream: async () => new Promise(() => {}) };
/** doStream that sends the first byte and then freezes. */
const hangMidStream: any = { specificationVersion: 'v2', provider: 'mock', modelId: 'm', supportedUrls: {}, doGenerate: async () => new Promise(() => {}),
  doStream: async () => ({ stream: new ReadableStream({ start(c) { c.enqueue({ type: 'stream-start', warnings: [] }); c.enqueue({ type: 'text-start', id: '1' }); c.enqueue({ type: 'text-delta', id: '1', delta: 'par' }); /* never closes */ } }) }) };

const WAIT = 1500;
const settled = (p: Promise<unknown>) => Promise.race([p.then(() => 'settled', () => 'rejected'), new Promise((r) => setTimeout(() => r('pending'), WAIT))]);

describe('U7 model step time limit', () => {
  it('no default limit (documented; the config option is the way): a frozen first byte stays pending', async () => {
    const gnl = createGnl({ journal: new InMemoryJournal(), agents: { a: { model: hangFirstByte } } as any });
    expect(await settled(gnl.run('a', { runId: 'u7-1', prompt: 'x' }))).toBe('pending');
  });
  it('per-call timeouts.modelStepMs works on first-byte freeze (control)', async () => {
    const gnl = createGnl({ journal: new InMemoryJournal(), agents: { a: { model: hangFirstByte } } as any });
    expect(await settled(gnl.run('a', { runId: 'u7-2', prompt: 'x', timeouts: { modelStepMs: 300 } } as any))).toBe('rejected');
  });
  it('createGnl({ timeouts }) applies to every run of the instance and fails it with StepTimeoutError', async () => {
    const gnl = createGnl({ journal: new InMemoryJournal(), timeouts: { modelStepMs: 300 }, agents: { a: { model: hangFirstByte } } } as any);
    const err = await gnl.run('a', { runId: 'u7-cfg', prompt: 'x' }).then(() => undefined, (e) => e);
    expect(err?.name).toBe('StepTimeoutError');
  });
  it('a per-call timeouts value wins over the config, field by field', async () => {
    const gnl = createGnl({ journal: new InMemoryJournal(), timeouts: { modelStepMs: 60_000 }, agents: { a: { model: hangFirstByte } } } as any);
    expect(await settled(gnl.run('a', { runId: 'u7-win', prompt: 'x', timeouts: { modelStepMs: 200 } } as any))).toBe('rejected');
  });
  it('the chat route inherits the config limit: the frozen turn ends with an error frame instead of hanging', async () => {
    const app = createChatRoute({ journal: new InMemoryJournal(), timeouts: { modelStepMs: 200 }, agents: { chat: { model: hangFirstByte } } } as any);
    const res = await app.request('/agents/chat/chat', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ id: 'c', messages: [{ id: 'm1', role: 'user', parts: [{ type: 'text', text: 'hi' }] }] }) });
    expect(await settled(res.text())).toBe('settled');
  });
  it('documented bound: the limit is until the FIRST byte — a freeze after it is not covered', async () => {
    const gnl = createGnl({ journal: new InMemoryJournal(), timeouts: { modelStepMs: 300 }, agents: { a: { model: hangMidStream } } as any });
    expect(await settled(gnl.run('a', { runId: 'u7-3', prompt: 'x' }))).toBe('pending');
  });
  it('an unknown name inside config timeouts is refused (a typo is not a silent no-op)', () => {
    expect(() => createGnl({ journal: new InMemoryJournal(), timeouts: { modelStepsMs: 300 }, agents: { a: { model: hangFirstByte } } } as any)).toThrow(/modelStepsMs/);
  });
});
