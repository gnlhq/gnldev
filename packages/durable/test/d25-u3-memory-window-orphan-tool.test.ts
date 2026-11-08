// d25 U3 — the memory window (`recentN`) is cut by COUNT, so it can begin with a `tool` message whose
// assistant tool-call fell outside; a provider (OpenAI-shaped) then answers 400.
// Red = claim holds (the model is called with an orphan tool message at the head).
import { describe, it, expect } from 'vitest';
import { z } from 'zod';
import { InMemoryStorage } from '../src/index.js';
import { runDurable } from '../src/run.js';
import { toJournal } from '../src/storage.js';
import { AgentMemory } from '../../memory/src/index.js';
import { createMockModel, countToolResults, toolCallResult, finalTextResult } from './mock.js';

/** A provider that enforces the rule every real chat API enforces: a `tool` result needs the assistant call before it. */
function strictProvider(seen: any[][]) {
  return createMockModel(async ({ prompt }: any) => {
    seen.push(prompt);
    const msgs = prompt.filter((m: any) => m.role !== 'system');
    const calls = new Set<string>();
    for (const m of msgs) {
      if (m.role === 'assistant') for (const p of m.content) if (p.type === 'tool-call') calls.add(p.toolCallId);
      if (m.role === 'tool') for (const p of m.content) if (!calls.has(p.toolCallId)) throw new Error(`400 Bad Request: tool message for ${p.toolCallId} has no preceding tool_calls`);
    }
    return countToolResults(prompt) === 0 ? toolCallResult('lookup', 'call-1', { q: 1 }) : finalTextResult('answer');
  });
}

for (const recentN of [2, 3]) {
  describe(`U3 recentN=${recentN}`, () => {
    it('turn 2 prompt must not begin with an orphan tool message', async () => {
      const storage = new InMemoryStorage() as any;
      const memory = new AgentMemory({ storage, recentN });
      const tools = { lookup: { sideEffect: false, description: 'x', inputSchema: z.object({ q: z.number() }), execute: async () => ({ v: 1 }) } };
      const seen: any[][] = [];
      const j = toJournal(storage.runs);
      await runDurable({ runId: `u3-a-${recentN}`, journal: j, memory: memory as any, threadId: 'T', resourceId: 'u', model: strictProvider(seen), tools, prompt: 'first' } as any);
      const stored = (await (memory as any).store.getMessages('T', { limit: 50 })).items.map((m: any) => m.role);
      console.log('stored roles =', JSON.stringify(stored));
      seen.length = 0;
      let err: any;
      try { await runDurable({ runId: `u3-b-${recentN}`, journal: j, memory: memory as any, threadId: 'T', resourceId: 'u', model: strictProvider(seen), tools, prompt: 'second' } as any); } catch (e) { err = e; }
      console.log('turn2 first prompt roles =', JSON.stringify(seen[0]?.map((m: any) => m.role)), 'err =', err?.message?.slice(0, 110));
      expect(err).toBeUndefined();
    });
  });
}

describe('U3 default recentN (6): a plain tool-using conversation, one tool call per turn', () => {
  it('no turn may hit the orphan-tool 400; after a failure, later turns must recover', async () => {
    const storage = new InMemoryStorage() as any;
    const memory = new AgentMemory({ storage }); // recentN default
    const tools = { lookup: { sideEffect: false, description: 'x', inputSchema: z.object({ q: z.number() }), execute: async () => ({ v: 1 }) } };
    const j = toJournal(storage.runs);
    const outcome: string[] = [];
    for (let i = 1; i <= 8; i++) {
      const seen: any[][] = [];
      const model = createMockModel(async ({ prompt }: any) => {
        seen.push(prompt);
        const msgs = prompt.filter((m: any) => m.role !== 'system');
        const calls = new Set<string>();
        for (const m of msgs) {
          if (m.role === 'assistant') for (const p of m.content) if (p.type === 'tool-call') calls.add(p.toolCallId);
          if (m.role === 'tool') for (const p of m.content) if (!calls.has(p.toolCallId)) throw new Error('400 Bad Request');
        }
        return countToolResults(prompt.slice(prompt.map((m: any) => m.role).lastIndexOf('user'))) === 0 ? toolCallResult('lookup', `call-${i}`, { q: i }) : finalTextResult('answer');
      });
      try { await runDurable({ runId: `u3d-${i}`, journal: j, memory: memory as any, threadId: 'TD', resourceId: 'u', model, tools, prompt: `msg ${i}` } as any); outcome.push('ok'); }
      catch (e: any) { outcome.push('400'); }
    }
    console.log('turn outcomes (default recentN) =', outcome.join(','));
    expect(outcome.filter((o) => o !== 'ok')).toEqual([]);
  });
});
