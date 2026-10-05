// A token budget is the request's: the parent's spend and every sub-agent's. Measured on a 60-token
// budget: 75 tokens directly and 90 through sub-agents (checked only after each step), and four
// sub-agents' 120 tokens not counted at all (a child registered at birth was cached as absent). Now both
// ways stop at the budget, and a new step starts only if budget is left. A request an earlier version
// started keeps no total: its children are registered with the parent and walked, and stop there too.
import { describe, it, expect } from 'vitest';
import { z } from 'zod';
import { InMemoryStorage, createGnl, gnlTool, STAFF, runKeys } from '../src/index.js';
import { SqliteStorage } from '../src/sqlite-storage.js';
import { createMockModel, toolCallResult, finalTextResult } from './mock.js';

describe.each([['InMemory', () => new InMemoryStorage()], ['Sqlite', () => new SqliteStorage(':memory:')]])('request budget, %s', (_n, make) => {
  for (const mode of ['direct', 'sub', 'sub, a request an earlier version started'] as const) {
    it(`${mode}: four 15-token model calls on a 60-token budget`, async () => {
      const storage: any = make();
      // An earlier version seeded the root's limit state and kept no request total.
      if (mode.includes('earlier')) await storage.runs.put(runKeys.proc('r', '__gnl_limits_state'), { consecutiveRepeats: 0, subRunIds: [] });
      let calls = 0;
      const t = gnlTool({ description: 't', inputSchema: z.object({}).passthrough(), execute: async () => ({ ok: true }) }, { sideEffect: true, idempotencyWindow: 'run', idempotencyKey: (a: any) => a.k });
      const parent = createMockModel(async ({ prompt }: any) => { calls++; const n = prompt.filter((m: any) => m.role === 'assistant').length;
        return n < 6 ? toolCallResult(mode === 'direct' ? 't' : 'agent_w', `p${n}`, mode === 'direct' ? { k: `k${n}` } : { task: `k${n}` }) : finalTextResult('ok'); });
      const w = createMockModel(async ({ prompt }: any) => { calls++; return prompt.some((m: any) => m.role === 'tool') ? finalTextResult('done') : toolCallResult('t', 'call_0', { k: JSON.stringify(prompt).match(/k\d/)![0] }); });
      await expect(createGnl({ storage, agents: { parent: { model: parent, ...(mode === 'direct' ? { tools: { t } } : { agents: ['w'] }) }, w: { model: w, tools: { t } } } } as any)
        .run('parent', { runId: 'r', prompt: 'go', caller: STAFF, limits: { maxTokens: 60 } } as any)).rejects.toThrow(/maxTokens/);
      expect(calls).toBe(4);
    });
  }
});

// In flight, a request an earlier version started sees a sibling only through its registration at birth
// (measured with registration off: 7 calls, not 5). Four sub-agents in parallel
// (on a new request, and on one an earlier version started), 15 tokens a model call, budget 60. Each child's first call
// happens before any finishes (parent 15 + 4 × 15 = 75); its second call must then be refused.
describe.each([['InMemory', () => new InMemoryStorage()], ['Sqlite', () => new SqliteStorage(':memory:')]])('request budget in flight, %s', (_n, make) => {
  for (const earlier of [false, true]) it(`four parallel sub-agents${earlier ? ' on a request an earlier version started' : ''}: no second call`, async () => {
    let calls = 0;
    const storage: any = make();
    if (earlier) await storage.runs.put(runKeys.proc('r', '__gnl_limits_state'), { consecutiveRepeats: 0, subRunIds: [] });
    const t = gnlTool({ description: 't', inputSchema: z.object({}).passthrough(), execute: async () => { await new Promise((r) => setTimeout(r, 20)); return { ok: true }; } }, { sideEffect: true, idempotencyWindow: 'run', idempotencyKey: (a: any) => a.k });
    const parent = createMockModel(async ({ prompt }: any) => { calls++;
      return prompt.some((m: any) => m.role === 'tool') ? finalTextResult('ok')
        : { content: [0, 1, 2, 3].map((i) => ({ type: 'tool-call', toolCallId: `p${i}`, toolName: 'agent_w', input: JSON.stringify({ task: `k${i}` }) })), finishReason: 'tool-calls', usage: { inputTokens: 10, outputTokens: 5, totalTokens: 15 }, warnings: [] }; });
    const w = createMockModel(async ({ prompt }: any) => { calls++; return prompt.some((m: any) => m.role === 'tool') ? finalTextResult('done') : toolCallResult('t', 'call_0', { k: JSON.stringify(prompt).match(/k\d/)![0] }); });
    await createGnl({ storage, agents: { parent: { model: parent, agents: ['w'] }, w: { model: w, tools: { t } } } } as any)
      .run('parent', { runId: 'r', prompt: 'go', caller: STAFF, limits: { maxTokens: 60 } } as any).catch(() => {});
    expect(calls).toBe(5);
  });
});
