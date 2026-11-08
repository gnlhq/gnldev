// d25 P5 / karar 15: the model's reasoning is OFF toward the client by default; one switch `stream: { reasoning: true }`
// (createGnl config + per call) turns it on. Same rule on /stream, /run-stream surfaces... here: REST /stream.
// The journal keeps the reasoning either way (it is the run's record, not the client feed).
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { InMemoryJournal } from '@gnldev/durable';
import { createRestApi } from '../src/index.js';
import { call } from './call.js';

const usage = { inputTokens: 1, outputTokens: 1, totalTokens: 2 };
const mkStream = (arr: any[]) => new ReadableStream({ start(c) { for (const p of arr) c.enqueue(p); c.close(); } });
const reasoningModel = (): any => ({
  specificationVersion: 'v2', provider: 'mock', modelId: 'think-1', supportedUrls: {},
  doGenerate: async () => { throw new Error('no gen'); },
  doStream: async () => ({ stream: mkStream([
    { type: 'stream-start', warnings: [] },
    { type: 'reasoning-start', id: 'r1' },
    ...Array.from({ length: 3 }, (_, i) => ({ type: 'reasoning-delta', id: 'r1', delta: `secret thought ${i} ` })),
    { type: 'reasoning-end', id: 'r1' },
    { type: 'text-start', id: '1' }, { type: 'text-delta', id: '1', delta: 'Answer' }, { type: 'text-end', id: '1' },
    { type: 'finish', finishReason: 'stop', usage },
  ]) }),
});
const post = (api: any, p: string, b: any) => call(api, p, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(b) });
const api = (extra: Record<string, unknown> = {}, journal = new InMemoryJournal()) =>
  createRestApi({ journal, agents: { a: { model: reasoningModel() } }, ...extra } as any, { protectionsBanner: false } as any);
beforeEach(() => { vi.spyOn(console, 'warn').mockImplementation(() => {}); });

describe('15: reasoning is opt-in on REST /stream', () => {
  it('default: no reasoning-* event and the thought text never reaches the client; the answer does', async () => {
    const t = await (await post(api(), '/agents/a/stream', { runId: 'p15-1', prompt: 'x' })).text();
    expect(t).not.toMatch(/event: reasoning-/);
    expect(t).not.toContain('secret thought');
    expect(t).toContain('Answer');                       // control: the rest of the stream is intact
  });
  it('config switch: createGnl-level stream.reasoning=true brings reasoning events', async () => {
    const t = await (await post(api({ stream: { reasoning: true } }), '/agents/a/stream', { runId: 'p15-2', prompt: 'x' })).text();
    expect(t).toMatch(/event: reasoning-delta/);
    expect(t).toContain('secret thought');
  });
  it('per call: body stream.reasoning=true opens it for that call only', async () => {
    const a = api();
    const on = await (await post(a, '/agents/a/stream', { runId: 'p15-3', prompt: 'x', stream: { reasoning: true } })).text();
    const off = await (await post(a, '/agents/a/stream', { runId: 'p15-4', prompt: 'x' })).text();
    expect(on).toContain('secret thought');
    expect(off).not.toContain('secret thought');
  });
  it('per call wins over config: body stream.reasoning=false closes it', async () => {
    const t = await (await post(api({ stream: { reasoning: true } }), '/agents/a/stream', { runId: 'p15-5', prompt: 'x', stream: { reasoning: false } })).text();
    expect(t).not.toContain('secret thought');
  });
  it('the journal still records the reasoning when the client feed is off', async () => {
    const journal = new InMemoryJournal();
    await (await post(api({}, journal), '/agents/a/stream', { runId: 'p15-6', prompt: 'x' })).text();
    expect(JSON.stringify(await journal.readRun('p15-6'))).toContain('secret thought');
  });
  it('a typo in the config key is refused, not ignored (stream: { reasonning: true })', () => {
    expect(() => api({ stream: { reasonning: true } })).toThrow(/reasonning/);
  });
});
