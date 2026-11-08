// d25 U5 — POST /agents/:name/chat with a body that is not the useChat v5 shape. Agent 19 saw
// "Cannot read properties of undefined (reading 'some')". Which bodies trigger it, and what status comes back?
import { describe, it, expect } from 'vitest';
import { InMemoryJournal } from '@gnldev/durable';
import { createChatRoute, chatSurface } from '../src/index.js';

const usage = { inputTokens: 1, outputTokens: 1, totalTokens: 2 };
const model: any = {
  specificationVersion: 'v2', provider: 'mock', modelId: 'm', supportedUrls: {},
  doGenerate: async () => { throw new Error('no gen'); },
  doStream: async () => ({ stream: new ReadableStream({ start(c) { for (const p of [{ type: 'stream-start', warnings: [] }, { type: 'text-start', id: '1' }, { type: 'text-delta', id: '1', delta: 'hi' }, { type: 'text-end', id: '1' }, { type: 'finish', finishReason: 'stop', usage }]) c.enqueue(p); c.close(); } }) }),
};
const app = () => createChatRoute({ journal: new InMemoryJournal(), agents: { chat: { model, maxSteps: 2 } } });
const post = (body: unknown) => app().request('/agents/chat/chat', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });

const bodies: Record<string, unknown> = {
  'valid useChat v5 (parts)': { id: 'c1', messages: [{ id: 'm1', role: 'user', parts: [{ type: 'text', text: 'hi' }] }] },
  'OpenAI/v4 style {role,content} (no parts)': { messages: [{ role: 'user', content: 'hi' }] },
  '/run style {prompt}': { prompt: 'hi' },
  '{message:"hi"}': { message: 'hi' },
  'messages is a string': { messages: 'hi' },
  'messages: [null]': { messages: [null] },
};

describe('U5 chat surface malformed bodies', () => {
  it('a valid useChat v5 body still answers 200', async () => {
    expect((await post(bodies['valid useChat v5 (parts)'])).status).toBe(200);
  });
  for (const name of Object.keys(bodies).filter((n) => !n.startsWith('valid'))) {
    it(`${name}: a clear 400 that names the right shape, never the converter's TypeError`, async () => {
      const res = await post(bodies[name]);
      const j: any = await res.json();
      expect(res.status).toBe(400);
      expect(j.error).toMatch(/^invalid chat request: /);
      expect(j.error).toMatch(/parts|messages/);
      expect(j.error).not.toMatch(/reading '|is not a function/);
    });
  }
  it('{role, content} messages are told they need `parts`', async () => {
    const j: any = await (await post(bodies['OpenAI/v4 style {role,content} (no parts)'])).json();
    expect(j.error).toContain('no `parts` array');
  });
  it('{prompt} is pointed at /run instead of running an empty turn', async () => {
    const j: any = await (await post(bodies['/run style {prompt}'])).json();
    expect(j.error).toContain('/agents/:name/run');
  });
  it('the REST door, through the chat surface, answers the same 400', async () => {
    const { createRestApi } = await import('../../server/src/index.js');
    const api = createRestApi({ journal: new InMemoryJournal(), agents: { chat: { model, maxSteps: 2 } } } as any, { surfaces: [chatSurface()], protectionsBanner: false } as any) as (r: Request) => Promise<Response>;
    const r = await api(new Request('http://localhost/agents/chat/chat', { method: 'POST', headers: { 'content-type': 'application/json', host: 'localhost' }, body: JSON.stringify({ messages: [{ role: 'user', content: 'hi' }] }) }));
    expect(r.status).toBe(400);
    expect(((await r.json()) as any).error).toContain('no `parts` array');
  });
});
