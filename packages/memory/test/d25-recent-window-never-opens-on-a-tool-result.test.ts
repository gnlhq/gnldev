// d25 finding 2: the plain `recentN` window must never open on an orphaned tool result.
// Measured against release/0.17.1: several cut positions, parallel calls, and the loadContext path.
import { describe, it, expect } from 'vitest';
import { InMemoryStorage } from '@gnldev/durable';
import { AgentMemory } from '../src/index.js';

const user = (c: string) => ({ role: 'user', content: c });
const calls = (...ids: string[]) => ({ role: 'assistant', content: ids.map((id) => ({ type: 'tool-call', toolCallId: id, toolName: 'x', input: {} })) });
const answer = (id: string) => ({ role: 'tool', content: [{ type: 'tool-result', toolCallId: id, toolName: 'x', output: { type: 'json', value: 1 } }] });
const final = (t: string) => ({ role: 'assistant', content: [{ type: 'text', text: t }] });

function paired(messages: any[]) {
  const called = new Set<string>(), answered = new Set<string>();
  for (const m of messages) for (const p of Array.isArray(m?.content) ? m.content : []) {
    if (p?.type === 'tool-call') called.add(p.toolCallId);
    if (p?.type === 'tool-result') answered.add(p.toolCallId);
  }
  return [...answered].every((id) => called.has(id)) && [...called].every((id) => answered.has(id));
}

describe('recentN window vs tool pairs', () => {
  for (const recentN of [1, 2, 3, 4, 5, 6, 7]) {
    it(`recentN=${recentN}: single pair + parallel pair turns, getMessages and loadContext stay paired`, async () => {
      const storage = new InMemoryStorage();
      const mem = new AgentMemory({ storage, recentN });
      await storage.memory.upsertThread({ id: 't', resourceId: 'u', createdAt: 1, updatedAt: 1 });
      await mem.append('t', [user('q1'), calls('a'), answer('a'), final('r1'), user('q2'), calls('b', 'c'), answer('b'), answer('c'), final('r2')]);
      const msgs = await mem.getMessages('t');
      expect(msgs[0]?.role, 'window opens on a tool message').not.toBe('tool');
      expect(paired(msgs)).toBe(true);
      const ctx: any = await (mem as any).loadContext('t', { resourceId: 'u' });
      const head = ctx.messages ?? ctx.recent ?? [];
      if (head.length) expect(head[0]?.role).not.toBe('tool');
      expect(paired(head)).toBe(true);
    });
  }
});

// 08-klinik (e): a thread that was left with a call nobody answered (suspended approval / failed turn),
// then the user writes again. The mirror image of an orphan result: a call with no result in the window.
describe('a thread left holding an unanswered tool call', () => {
  it('the next window does not carry a call without its result', async () => {
    const storage = new InMemoryStorage();
    const mem = new AgentMemory({ storage, recentN: 6 });
    await storage.memory.upsertThread({ id: 't', resourceId: 'u', createdAt: 1, updatedAt: 1 });
    await mem.append('t', [user('book me'), calls('p'), user('are you there?')]);
    const msgs = await mem.getMessages('t');
    expect(paired(msgs), 'window holds a tool call with no result: providers answer 400').toBe(true);
  });
});

// 08-klinik (e), end to end: a run suspended on an approval, then the same thread gets a new message.
import { runDurable } from '@gnldev/durable';
import { tool } from 'ai';
import { z } from 'zod';

describe('thread with a pending approval, then a new user message (end to end)', () => {
  it('the second turn never sends the provider a tool call without its result', async () => {
    const storage = new InMemoryStorage();
    const mem = new AgentMemory({ storage, recentN: 10 });
    const prompts: any[] = [];
    const usage = { inputTokens: { total: 1 }, outputTokens: { total: 1 } };
    const model: any = {
      specificationVersion: 'v4', provider: 'm', modelId: 'm', supportedUrls: {},
      doGenerate: async ({ prompt }: any) => {
        prompts.push(prompt);
        const hasTool = prompt.some((m: any) => m.role === 'tool');
        return hasTool || prompts.length > 1
          ? { content: [{ type: 'text', text: 'ok' }], finishReason: { unified: 'stop', raw: 'stop' }, usage, warnings: [] }
          : { content: [{ type: 'tool-call', toolCallId: 'c1', toolName: 'pay', input: '{"k":1}' }], finishReason: { unified: 'tool-calls', raw: 'tool-calls' }, usage, warnings: [] };
      },
    };
    const pay: any = tool({ description: 'pay', inputSchema: z.object({ k: z.number() }), execute: async () => ({ ok: true }) });
    pay.sideEffect = true;
    const guard = { guard: () => ({ action: 'require-approval', reason: 'human' }) };
    await runDurable({ runId: 'r1', journal: storage.runs as any, model, tools: { pay }, memory: mem, prompt: 'pay please', threadId: 't', resourceId: 'u', ...guard } as any).catch(() => undefined);
    await runDurable({ runId: 'r2', journal: storage.runs as any, model, tools: { pay }, memory: mem, prompt: 'hello?', threadId: 't', resourceId: 'u' } as any).catch(() => undefined);
    const last = prompts[prompts.length - 1] ?? [];
    expect(prompts.length, 'second turn never reached the model').toBeGreaterThan(1);
    expect(paired(last.map((m: any) => ({ content: (Array.isArray(m.content) ? m.content : []).map((p: any) => ({ type: p.type, toolCallId: p.toolCallId })) })))).toBe(true);
  });
});
