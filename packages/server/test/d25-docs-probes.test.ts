// Measurements behind the d25 documentation fixes (REST request body, resume, approvals on /stream, events).
import { describe, it, expect } from 'vitest';
import { InMemoryStorage } from '@gnldev/durable';
import { createRestApi } from '../src/index.js';

const usage = { inputTokens: 1, outputTokens: 1, totalTokens: 2 };
const model: any = {
  specificationVersion: 'v2', provider: 'mock', modelId: 'm', supportedUrls: {},
  doGenerate: async () => ({ content: [{ type: 'text', text: 'hello' }], finishReason: 'stop', usage, warnings: [] }),
  doStream: async () => ({ stream: new ReadableStream({ start(c) {
    for (const p of [{ type: 'stream-start', warnings: [] }, { type: 'text-start', id: '1' }, { type: 'text-delta', id: '1', delta: 'hello' }, { type: 'text-end', id: '1' }, { type: 'finish', finishReason: 'stop', usage }]) c.enqueue(p);
    c.close();
  } }) }),
};
const api = createRestApi({ storage: new InMemoryStorage(), memory: false, agents: { a: { model } } } as never, { allowOpenAccess: true, protectionsBanner: false } as never);
const post = async (path: string, body: unknown) => {
  const res = await api(new Request(`http://x${path}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }));
  return { status: res.status, h: { runId: res.headers.get('x-gnl-run-id'), idem: res.headers.get('x-gnl-idempotency-status') }, text: await res.text() };
};
describe('REST request body, as documented on the REST API page', () => {
  it('runId XOR workKey; workKey needs a resourceId; resume takes runId only; /stream takes approvals; /runs/:id/events follows', async () => {
    const neither = await post('/agents/a/run', { prompt: 'hi' });
    expect(neither.status).toBe(400); expect(neither.text).toContain('runId or workKey required');
    const noRes = await post('/agents/a/run', { workKey: 'inv-1', prompt: 'hi' });
    expect(noRes.status).toBe(400); expect(noRes.text).toContain('names no resourceId');
    const first = await post('/agents/a/run', { workKey: 'inv-1', resourceId: 'u1', prompt: 'hi' });
    expect(first.status).toBe(200); expect(first.h.idem).toBe('new'); expect(first.h.runId).toMatch(/^run1_/);
    const again = await post('/agents/a/run', { workKey: 'inv-1', resourceId: 'u1', prompt: 'hi' });
    expect(again.h).toEqual({ runId: first.h.runId, idem: 'replay' });
    expect((await post('/agents/a/run', { runId: 'r1', workKey: 'k', prompt: 'hi' })).status).toBe(400);
    const rw = await post('/agents/a/resume', { workKey: 'inv-1', resourceId: 'u1' });
    expect(rw.status).toBe(400); expect(rw.text).toContain('runId required');
    expect((await post('/agents/a/run', { runId: 'r1', prompt: 'hi' })).status).toBe(200);
    expect(JSON.parse((await post('/agents/a/resume', { runId: 'r1' })).text)).toMatchObject({ ok: true, runId: 'r1' });
    const st = await post('/agents/a/stream', { runId: 'r2', prompt: 'hi', approvals: { x: true } });
    expect(st.status).toBe(200); expect(st.text).toContain('event: done');
    const ev = await api(new Request('http://x/runs/r2/events'));
    expect(ev.status).toBe(200); expect(await ev.text()).toContain('event: text-delta');
  });
});
