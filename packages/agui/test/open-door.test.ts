// A standalone AG-UI door with no `identify` gets the protections a providerless REST API has — the
// same two checks and the same way through as @gnldev/chat-adapter's route (see its open-door.test.ts).
// K1 = the review's cases carried to this door; K2/K3 = siblings.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { InMemoryJournal } from '@gnldev/durable';
import { createAguiRoute } from '../src/index.js';

const usage = { inputTokens: 1, outputTokens: 1, totalTokens: 2 };
function model(calls: { n: number }): any {
  return {
    specificationVersion: 'v2', provider: 'mock', modelId: 'm', supportedUrls: {},
    doGenerate: async () => { throw new Error('no gen'); },
    doStream: async () => {
      calls.n++;
      return { stream: new ReadableStream({ start(c) { for (const x of [{ type: 'stream-start', warnings: [] }, { type: 'text-start', id: '1' }, { type: 'text-delta', id: '1', delta: 'hi' }, { type: 'text-end', id: '1' }, { type: 'finish', finishReason: 'stop', usage }]) c.enqueue(x); c.close(); } }) };
    },
  };
}
const post = (h: any, headers: Record<string, string>, runId: string) =>
  h(new Request('http://localhost/agents/a/run', { method: 'POST', headers, body: JSON.stringify({ runId, prompt: 'hello' }) }));

function setup(opts: Record<string, unknown> = {}) {
  const calls = { n: 0 };
  const h = createAguiRoute({ journal: new InMemoryJournal(), agents: { a: { model: model(calls) } } } as any, opts as any);
  return { h, calls };
}

beforeEach(() => { vi.spyOn(console, 'warn').mockImplementation(() => {}); });
afterEach(() => { delete process.env.GNL_ALLOWED_HOSTS; vi.restoreAllMocks(); });

describe('createAguiRoute with no identify', () => {
  it('K1: a cross-site text/plain POST is refused before the model runs', async () => {
    const { h, calls } = setup();
    const r = await post(h, { host: 'localhost:4111', 'sec-fetch-site': 'cross-site', 'content-type': 'text/plain' }, 'x1');
    expect(r.status).toBe(403);
    expect((await r.json()).code).toBe('cross_site_refused');
    expect(calls.n).toBe(0);
  });

  it('K1: a rebound page is refused, and the refusal names the createAguiRoute option', async () => {
    const { h, calls } = setup();
    const r = await post(h, { host: 'evil.example:4111', 'sec-fetch-site': 'same-origin', 'content-type': 'application/json' }, 'x2');
    expect(r.status).toBe(403);
    const body = await r.json();
    expect(body.code).toBe('host_not_allowed');
    expect(body.error).toContain('createAguiRoute options');
    expect(calls.n).toBe(0);
  });

  it('K2: localhost, an IP, no Host and a listed name are answered', async () => {
    const { h } = setup({ allowedHosts: ['mybox.test'] });
    for (const [i, host] of ['localhost:4111', '192.168.1.20:4111', undefined, 'mybox.test:4111'].entries()) {
      const r = await post(h, { ...(host ? { host } : {}), 'content-type': 'application/json' }, `ok${i}`);
      expect(r.status, String(host)).toBe(200);
      await r.text();
    }
  });

  it('K3: with identify the door does not second-guess the application', async () => {
    const { h } = setup({ identify: () => undefined });
    const r = await post(h, { host: 'evil.example', 'content-type': 'application/json' }, 'id1');
    expect(r.status).toBe(200);
    await r.text();
  });
});
