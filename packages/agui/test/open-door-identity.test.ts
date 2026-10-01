// The AG-UI door follows the same identity rule as the chat door (its open-door-identity.test.ts has the
// panel's measurements): an `identify` that answers nothing is no identity, and `allowCrossSite: true`
// is the one opt-out for a door embedded on other sites. Same owner (@gnldev/auth `doorGate`).
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
const tokenOrAnonymous = (req: Request) => (req.headers.get('authorization') === 'Bearer ok' ? { kind: 'subject' as const, id: 'u1', roles: [] } : undefined);
const json = { 'content-type': 'application/json' };

beforeEach(() => { vi.spyOn(console, 'warn').mockImplementation(() => {}); });
afterEach(() => { vi.restoreAllMocks(); });

describe('createAguiRoute: identify that answers nothing is no identity', () => {
  it('S-d1 on this door: identify: () => undefined does not open it to a rebound name', async () => {
    const { h, calls } = setup({ identify: () => undefined });
    const r = await post(h, { host: 'evil.example', 'sec-fetch-site': 'same-origin', ...json }, 'a1');
    expect(r.status).toBe(403);
    expect((await r.json()).code).toBe('host_not_allowed');
    expect(calls.n).toBe(0);
  });
  it('S-d2 on this door: an anonymous cross-site form POST is refused; the refusal names allowCrossSite', async () => {
    const { h, calls } = setup({ identify: tokenOrAnonymous });
    const r = await post(h, { host: 'localhost:4111', origin: 'https://evil.example', 'sec-fetch-site': 'cross-site', 'content-type': 'text/plain' }, 'a2');
    expect(r.status).toBe(403);
    const body = await r.json();
    expect(body.code).toBe('cross_site_refused');
    expect(body.error).toContain('allowCrossSite: true in the createAguiRoute options');
    expect(calls.n).toBe(0);
  });
  it('sibling: a caller the identify resolved is served on any name and from any site', async () => {
    const { h, calls } = setup({ identify: tokenOrAnonymous });
    const r = await post(h, { host: 'evil.example', origin: 'https://evil.example', 'sec-fetch-site': 'cross-site', authorization: 'Bearer ok', ...json }, 'a3');
    expect(r.status).toBe(200);
    await r.text();
    expect(calls.n).toBe(1);
  });
  it('sibling: allowCrossSite lets an embedding site in, and leaves the host rule on', async () => {
    const { h } = setup({ allowCrossSite: true });
    const ok = await post(h, { host: 'localhost:4111', origin: 'https://customer.example', 'sec-fetch-site': 'cross-site', ...json }, 'a4');
    expect(ok.status).toBe(200);
    await ok.text();
    const no = await post(h, { host: 'evil.example', 'sec-fetch-site': 'same-origin', ...json }, 'a5');
    expect(no.status).toBe(403);
  });
});
