// Aday D, S15 — memory on, ONE conversation, two turns; the provider names the call of every response `call_0`.
// What the conversation then holds (memory) and shows (UI messages) must tell the two calls apart, each with
// its own result. Control: ids=unique.
import { describe, it, expect, beforeAll, vi } from 'vitest';
import { z } from 'zod';
import { InMemoryStorage } from '@gnldev/durable';
import { createRestApi } from '../../server/dist/index.js';
import { chatSurface } from '../dist/index.js';
import { AgentMemory } from '../../memory/dist/index.js';

beforeAll(() => { vi.spyOn(console, 'warn').mockImplementation(() => {}); });
const usage = { inputTokens: 1, outputTokens: 1, totalTokens: 2 };

function model(ids: 'same' | 'unique', prompts: any[]) {
  const stream = (parts: any[]) => ({ stream: new ReadableStream({ start(c) { c.enqueue({ type: 'stream-start', warnings: [] }); for (const p of parts) c.enqueue(p); c.close(); } }) });
  return {
    specificationVersion: 'v2', provider: 'mock', modelId: 'm', supportedUrls: {},
    doGenerate: async () => { throw new Error('stream only'); },
    doStream: async ({ prompt }: any) => {
      prompts.push(JSON.parse(JSON.stringify(prompt)));
      const lastUser = prompt.map((m: any) => m.role).lastIndexOf('user');
      const answered = prompt.slice(lastUser).some((m: any) => m.role === 'tool');
      const turn = prompt.filter((m: any) => m.role === 'user').length;
      if (!answered) return stream([{ type: 'tool-call', toolCallId: ids === 'same' ? 'call_0' : `call_${crypto.randomUUID()}`, toolName: 'look', input: JSON.stringify({ q: `turn-${turn}` }) }, { type: 'finish', finishReason: 'tool-calls', usage }]);
      return stream([{ type: 'text-start', id: 't' }, { type: 'text-delta', id: 't', delta: 'ok' }, { type: 'text-end', id: 't' }, { type: 'finish', finishReason: 'stop', usage }]);
    },
  } as any;
}

describe('k3d S15 — two turns of one conversation, memory on', () => {
  for (const ids of ['same', 'unique'] as const) {
    it(`ids=${ids}: memory holds two distinct calls, each with its own result; the provider is sent its own ids`, async () => {
      const storage = new InMemoryStorage(); const prompts: any[] = [];
      const config: any = { storage, preset: 'assistant', memoryFactory: (st: any) => new AgentMemory({ storage: st }), agents: { a: { model: model(ids, prompts), system: 's', tools: { look: { description: 'look', inputSchema: z.object({ q: z.string() }), execute: async (a: any) => ({ saw: a.q }) } } } } };
      const api = createRestApi(config, { surfaces: [chatSurface()], protectionsBanner: false } as any);
      for (const turn of ['t1', 't2']) {
        const res = await api(new Request('http://x/agents/a/chat', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ id: 'conv-1', resourceId: 'u1', messages: [{ id: `m-${turn}`, role: 'user', parts: [{ type: 'text', text: turn }] }] }) }));
        expect(res.status).toBe(200); await res.text();
      }
      const memory = new AgentMemory({ storage });
      const threads = await memory.listAllThreads();
      const msgs = (await Promise.all(threads.map((t: any) => memory.getMessages(t.id)))).flat();
      const calls = msgs.flatMap((m: any) => (Array.isArray(m.content) ? m.content : [])).filter((p: any) => p.type === 'tool-call');
      const results = msgs.flatMap((m: any) => (Array.isArray(m.content) ? m.content : [])).filter((p: any) => p.type === 'tool-result');
      console.log(`[S15 ${ids}] calls`, calls.map((c: any) => c.toolCallId), 'results', results.map((r: any) => [r.toolCallId, JSON.stringify(r.output).slice(0, 50)]));
      expect(calls).toHaveLength(2);
      expect(new Set(calls.map((c: any) => c.toolCallId)).size, 'two distinct ids in memory').toBe(2);
      for (const c of calls) {
        const r = results.find((x: any) => x.toolCallId === c.toolCallId);
        expect(JSON.stringify(r?.output), `the result of ${c.toolCallId} is its own`).toContain(JSON.parse(typeof c.input === 'string' ? c.input : JSON.stringify(c.input)).q);
      }
      // turn 2's request carries turn 1's call under the provider's own id
      const last = JSON.stringify(prompts.at(-1));
      expect(last).not.toContain('.gnl-');
    });
  }
});
