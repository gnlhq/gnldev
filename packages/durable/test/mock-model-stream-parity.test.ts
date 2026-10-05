// A mock model answers the same script whether it is called or streamed. `toolCallingModel` called
// its tool from `doGenerate` and only said its closing sentence from `doStream`, so every streaming
// door — chat, AG-UI, `streamDurable` — showed a keyless project a tool that never ran. Each case
// below drives the SAME options through `generateText` and `streamText` and compares what ran.
import { describe, it, expect } from 'vitest';
import { generateText, streamText, stepCountIs, tool } from 'ai';
import { z } from 'zod';
import { echoModel, toolCallingModel, type ToolCallingModelOptions } from '../src/mock-model.js';
import { InMemoryJournal } from '../src/index.js';
import { createChatRoute } from '../../chat-adapter/src/index.js';

function chargeTool(log: unknown[]) {
  return tool({ inputSchema: z.object({ orderId: z.string(), amount: z.number() }).partial().passthrough(), execute: async (args) => { log.push(args); return { charged: true }; } });
}
async function both(opts: ToolCallingModelOptions) {
  const name = opts.toolName ?? 'chargeOrder';
  const g: unknown[] = []; const s: unknown[] = [];
  const gen = await generateText({ model: toolCallingModel(opts) as any, prompt: 'go', tools: { [name]: chargeTool(g) }, stopWhen: stepCountIs(4) });
  const str = streamText({ model: toolCallingModel(opts) as any, prompt: 'go', tools: { [name]: chargeTool(s) }, stopWhen: stepCountIs(4) });
  const streamedText = await str.text;
  return { gen: { calls: g, text: gen.text }, str: { calls: s, text: streamedText } };
}

describe('toolCallingModel: called or streamed, the same script', () => {
  for (const [label, opts] of [
    ['defaults', {}],
    ['a named tool and input', { toolName: 'refund', input: { orderId: 'o-9', amount: 5 }, doneText: 'refunded' }],
    ['three duplicate calls in one turn', { calls: 3 }],
  ] as const) {
    it(label, async () => {
      const r = await both(opts as ToolCallingModelOptions);
      expect(r.gen.calls.length, 'PRECONDITION: the called path ran no tool').toBeGreaterThan(0);
      expect(r.str.calls).toEqual(r.gen.calls);
      expect(r.str.text).toBe(r.gen.text);
    });
  }
  it('echoModel streams what it generates', async () => {
    const gen = await generateText({ model: echoModel() as any, prompt: 'hello' });
    const str = await streamText({ model: echoModel() as any, prompt: 'hello' }).text;
    expect(str).toBe(gen.text);
  });
  it('through the chat door (streaming), the tool runs once', async () => {
    const log: unknown[] = [];
    const app = createChatRoute({ journal: new InMemoryJournal(), agents: { shop: { model: toolCallingModel() as any, tools: { chargeOrder: chargeTool(log) }, maxSteps: 4 } } } as any);
    const res = await app.request('/agents/shop/chat', { method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ id: 'c1', messages: [{ id: 'm1', role: 'user', parts: [{ type: 'text', text: 'charge it' }] }] }) });
    const body = await res.text();
    expect(res.status).toBe(200);
    expect(log, body.slice(0, 300)).toHaveLength(1);
  });
});
