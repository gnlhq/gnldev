// k3 AG-UI — one run, two model steps, both calls named `call_0` by the provider (it numbers per response).
// The two calls must reach the AG-UI client as two calls: two TOOL_CALL_STARTs, two results, each result
// carrying its own call's output, and the client able to tell them apart (distinct tool-call ids and
// distinct result message ids — AG-UI clients key both by id, so equal ids merge two calls into one).
// Control: distinct ids per step (today's behaviour).
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { z } from 'zod';
import { InMemoryJournal } from '@gnldev/durable';
import { createAguiRoute } from '../src/index.js';

const usage = { inputTokens: 1, outputTokens: 1, totalTokens: 2 };
function model(ids: 'same' | 'unique', streamedArgs: 'none' | 'all' | 'first'): any {
  const stream = (parts: any[]) => ({ stream: new ReadableStream({ start(c) { c.enqueue({ type: 'stream-start', warnings: [] }); for (const p of parts) c.enqueue(p); c.close(); } }) });
  return {
    specificationVersion: 'v2', provider: 'mock', modelId: 'm', supportedUrls: {},
    doGenerate: async () => { throw new Error('stream only'); },
    doStream: async ({ prompt }: any) => {
      const n = prompt.filter((m: any) => m.role === 'tool').flatMap((m: any) => m.content).filter((p: any) => p.type === 'tool-result').length;
      const id = ids === 'same' ? 'call_0' : `call_${n}`;
      const input = JSON.stringify({ amount: n === 0 ? 5 : 7 });
      // streamedArgs: the provider streams the arguments first (tool-input-start/delta/end), as most do;
      // 'first': only the first step streams them, the second arrives as one tool-call part.
      const argParts = streamedArgs === 'all' || (streamedArgs === 'first' && n === 0) ? [{ type: 'tool-input-start', id, toolName: 'pay' }, { type: 'tool-input-delta', id, delta: input }, { type: 'tool-input-end', id }] : [];
      if (n < 2) return stream([...argParts, { type: 'tool-call', toolCallId: id, toolName: 'pay', input }, { type: 'finish', finishReason: 'tool-calls', usage }]);
      return stream([{ type: 'text-start', id: 't' }, { type: 'text-delta', id: 't', delta: 'done' }, { type: 'text-end', id: 't' }, { type: 'finish', finishReason: 'stop', usage }]);
    },
  };
}

beforeEach(() => { vi.spyOn(console, 'warn').mockImplementation(() => {}); });
afterEach(() => { vi.restoreAllMocks(); });

describe('k3 AG-UI — two calls of one run with a repeated id reach the client as two calls', () => {
  for (const streamedArgs of ['none', 'all', 'first'] as const) for (const ids of ['same', 'unique'] as const) {
    it(`ids=${ids} · arguments streamed: ${streamedArgs}`, async () => {
      const paid: number[] = [];
      const h = createAguiRoute({ journal: new InMemoryJournal(), agents: { a: { model: model(ids, streamedArgs), tools: { pay: { description: 'pay', inputSchema: z.object({ amount: z.number() }), sideEffect: true, execute: async (a: any) => { paid.push(a.amount); return { charged: a.amount }; } } } } } } as any, { allowedHosts: ['localhost'] } as any);
      const res = await h(new Request('http://localhost/agents/a/run', { method: 'POST', headers: { host: 'localhost', 'content-type': 'application/json' }, body: JSON.stringify({ runId: `k3-agui-${ids}-${streamedArgs}`, prompt: 'pay 5 then 7' }) }));
      const raw = await res.text();
      const events = raw.split('\n').filter((l) => l.startsWith('data: ')).map((l) => { try { return JSON.parse(l.slice(6)); } catch { return null; } }).filter(Boolean);
      const starts = events.filter((e: any) => e.type === 'TOOL_CALL_START');
      const results = events.filter((e: any) => e.type === 'TOOL_CALL_RESULT');
      console.log(`[AGUI ${ids} streamed=${streamedArgs}] status=${res.status} paid=${JSON.stringify(paid)} starts=${JSON.stringify(starts.map((e: any) => e.toolCallId))} results=${JSON.stringify(results.map((e: any) => [e.toolCallId, e.messageId, String(e.content).slice(0, 40)]))}`);
      expect(res.status).toBe(200);
      expect(starts.length, 'two TOOL_CALL_STARTs').toBe(2);
      expect(results.length, 'two TOOL_CALL_RESULTs').toBe(2);
      expect(String(results[0].content)).toContain('5');
      expect(String(results[1].content), 'the second result is the second call\'s own').toContain('7');
      expect(new Set(starts.map((e: any) => e.toolCallId)).size, 'the client can tell the two calls apart').toBe(2);
      expect(new Set(results.map((e: any) => e.messageId)).size, 'two result messages, not one id twice').toBe(2);
      expect(results.map((e: any) => e.toolCallId)).toEqual(starts.map((e: any) => e.toolCallId));
    });
  }
});
