// A body that is not a JSON object is refused as THAT — 400 invalid_json — on every door. It used to
// be read as `{}` (36 `c.req.json().catch(() => ({}))` sites), so the request failed on a field it
// seemed to lack: "runId or workKey required" from REST and AG-UI, and a 200 with "An error
// occurred." in the stream from the chat door. The rule is @gnldev/durable `readJsonObject`.
import { describe, it, expect } from 'vitest';
import { createHmac } from 'node:crypto';
import { InMemoryJournal } from '@gnldev/durable';
import { createRestApi } from '../src/index.js';
import { createAguiRoute } from '../../agui/src/route.js';
import { createChatRoute } from '../../chat-adapter/src/index.js';
import { createStudioApi } from '../../studio/src/server.js';
import { a2aSigningInput } from '@gnldev/a2a';

const usage = { inputTokens: 1, outputTokens: 1, totalTokens: 2 };
const mkStream = (arr: any[]) => new ReadableStream({ start(c) { for (const p of arr) c.enqueue(p); c.close(); } });
const model: any = {
  specificationVersion: 'v2', provider: 'mock', modelId: 'm', supportedUrls: {},
  doGenerate: async () => ({ content: [{ type: 'text', text: 'ok' }], finishReason: 'stop', usage, warnings: [] }),
  doStream: async () => ({ stream: mkStream([{ type: 'stream-start', warnings: [] }, { type: 'text-start', id: '1' }, { type: 'text-delta', id: '1', delta: 'ok' }, { type: 'text-end', id: '1' }, { type: 'finish', finishReason: 'stop', usage }]) }),
};
const agents = () => ({ a: { model, maxSteps: 2 } });
type Door = { name: string; send: (body: string) => Promise<Response>; valid: string };
const req = (h: any, url: string, body: string, headers: Record<string, string> = {}) => h(new Request(url, { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body }));
const doors = (): Door[] => {
  const rest = createRestApi({ journal: new InMemoryJournal(), agents: agents() } as any, { protectionsBanner: false } as any) as any;
  const signed = createRestApi({ journal: new InMemoryJournal(), agents: agents() } as any, { protectionsBanner: false, a2aSecret: 's' } as any) as any;
  const agui = createAguiRoute({ journal: new InMemoryJournal(), agents: agents() } as any) as any;
  const chat = createChatRoute({ journal: new InMemoryJournal(), agents: agents() } as any) as any;
  const studio = createStudioApi({ reader: new InMemoryJournal(), gnl: { listAgents: () => [{ name: 'a' }], run: async () => ({ text: 'ok', interrupts: [] }) } } as any) as any;
  const sign = (body: string) => { const ts = String(Date.now()); return { 'x-gnl-timestamp': ts, 'x-gnl-signature': createHmac('sha256', 's').update(a2aSigningInput(ts, { method: 'POST', path: '/agents/a/run', body })).digest('hex') }; };
  return [
    { name: 'REST /run', send: (b) => req(rest, 'http://x/agents/a/run', b), valid: JSON.stringify({ runId: 'r1', prompt: 'hi' }) },
    { name: 'REST /run, signed', send: (b) => req(signed, 'http://x/agents/a/run', b, sign(b)), valid: JSON.stringify({ runId: 'r2', prompt: 'hi' }) },
    { name: 'AG-UI', send: (b) => req(agui, 'http://x/agents/a/run', b), valid: JSON.stringify({ runId: 'r3', threadId: 't', prompt: 'hi' }) },
    { name: 'chat', send: (b) => chat.request('/agents/a/chat', { method: 'POST', headers: { 'content-type': 'application/json' }, body: b }), valid: JSON.stringify({ id: 'c', messages: [{ id: 'm', role: 'user', parts: [{ type: 'text', text: 'hi' }] }] }) },
    { name: 'Studio /agents/:name/run', send: (b) => req(studio, 'http://x/agents/a/run', b), valid: JSON.stringify({ runId: 'r5', prompt: 'hi' }) },
  ];
};

describe('a request body that is not a JSON object → 400 invalid_json, on every door', () => {
  for (const door of doors()) {
    for (const [label, body] of [['not JSON', '{not json'], ['an array', '[]'], ['a string', '"str"'], ['null', 'null']] as const) {
      it(`${door.name}: ${label}`, async () => {
        const res = await door.send(body);
        const text = await res.text();
        expect(res.status, text.slice(0, 200)).toBe(400);
        expect(JSON.parse(text).code).toBe('invalid_json');
      });
    }
    if (door.valid) it(`${door.name}: a valid body still works`, async () => {
      const res = await door.send(door.valid);
      expect(res.status, (await res.clone().text()).slice(0, 200)).toBe(200);
    });
  }
});
