// d25 P5 / karar 17: REST body `strictInput` is honoured per call (same runId + different input -> 409), and an
// unknown body field produces a WARNING (the call still runs; it is not refused). Known fields never warn.
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { InMemoryJournal } from '@gnldev/durable';
import { createRestApi } from '../src/index.js';
import { call } from './call.js';

const usage = { inputTokens: 1, outputTokens: 1, totalTokens: 2 };
const model = (): any => ({ specificationVersion: 'v2', provider: 'mock', modelId: 'm', supportedUrls: {}, doGenerate: async () => { throw new Error('no gen'); },
  doStream: async () => ({ stream: new ReadableStream({ start(c) { for (const p of [{ type: 'stream-start', warnings: [] }, { type: 'text-start', id: '1' }, { type: 'text-delta', id: '1', delta: 'Answer' }, { type: 'text-end', id: '1' }, { type: 'finish', finishReason: 'stop', usage }]) c.enqueue(p); c.close(); } }) }) });
const api = () => createRestApi({ journal: new InMemoryJournal(), agents: { a: { model: model() } } }, { protectionsBanner: false } as any);
const post = (a: any, p: string, b: any) => call(a, p, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(b) });
let logs: string[];
beforeEach(() => {
  logs = [];
  const grab = (...a: unknown[]) => { const s = a.map(String).join(' '); if (!s.startsWith('@gnldev/auth')) logs.push(s); }; // the unrelated open-access notice is not under test
  vi.spyOn(console, 'warn').mockImplementation(grab); vi.spyOn(console, 'error').mockImplementation(grab);
});

describe('17: body strictInput', () => {
  it('/run: same runId + different input is refused with 409 when body.strictInput is true', async () => {
    const a = api();
    await post(a, '/agents/a/run', { runId: 'p17-1', prompt: 'one', strictInput: true });
    const r = await post(a, '/agents/a/run', { runId: 'p17-1', prompt: 'two', strictInput: true });
    expect(r.status).toBe(409);
  });
  it('SIBLING /stream: the same refusal on the stream door', async () => {
    const a = api();
    await post(a, '/agents/a/stream', { runId: 'p17-2', prompt: 'one', strictInput: true });
    const r = await post(a, '/agents/a/stream', { runId: 'p17-2', prompt: 'two', strictInput: true });
    const t = await r.text();
    expect(r.status === 409 || /input_mismatch|"code"/.test(t)).toBe(true);
  });
  it('NEGATIVE: strictInput with the SAME input is a normal replay (200)', async () => {
    const a = api();
    await post(a, '/agents/a/run', { runId: 'p17-3', prompt: 'one', strictInput: true });
    const r = await post(a, '/agents/a/run', { runId: 'p17-3', prompt: 'one', strictInput: true });
    expect(r.status).toBe(200);
  });
  it('NEGATIVE: without strictInput the default is unchanged (a different input on a same runId is not refused with 409)', async () => {
    const a = api();
    await post(a, '/agents/a/run', { runId: 'p17-4', prompt: 'one' });
    const r = await post(a, '/agents/a/run', { runId: 'p17-4', prompt: 'two' });
    expect(r.status).not.toBe(409);
  });
});

describe('17: unknown body field', () => {
  it('/run: the call still runs (200), and a warning names the field', async () => {
    const r = await post(api(), '/agents/a/run', { runId: 'p17-5', prompt: 'x', strcitInput: true });
    expect(r.status).toBe(200);                            // warn, not refuse (this release)
    expect(logs.join('\n')).toContain('strcitInput');
  });
  it('SIBLING /stream: same warning, stream still answers', async () => {
    const r = await post(api(), '/agents/a/stream', { runId: 'p17-6', prompt: 'x', madeUpField: 1 });
    expect(await r.text()).toContain('Answer');
    expect(logs.join('\n')).toContain('madeUpField');
  });
  it('NEGATIVE: known body fields (runId, prompt, limits, strictInput) raise no warning', async () => {
    const r = await post(api(), '/agents/a/run', { runId: 'p17-7', prompt: 'x', strictInput: true, limits: { maxToolCalls: 5 } });
    expect(r.status).toBe(200);
    expect(logs.join('\n')).not.toMatch(/strictInput|limits|prompt|runId/);
  });
});
