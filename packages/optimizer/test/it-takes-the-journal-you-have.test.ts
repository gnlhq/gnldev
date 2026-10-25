// The optimizer takes the journal a host has: a store's `runs` (what runDurable is handed), the store
// itself, or a journal. The in-memory journal carries every reader method; a store's `runs` does not
// carry `listRunsPaged` — a test on the in-memory journal alone would pass while the README's own
// example (`journal: storage.runs`) threw.
import { describe, it, expect } from 'vitest';
import { tool } from 'ai';
import { z } from 'zod';
import { runDurable, gnlTool } from '@gnldev/durable';
import { SqliteStorage } from '@gnldev/durable/sqlite';
import { createMockModel } from '../../durable/test/mock.js';
import { diagnoseAgent, replayCounterfactual } from '../src/index.js';

function planned(modelId: string) {
  let step = 0;
  const m = createMockModel(async () => {
    step++;
    const usage = { inputTokens: 2000, outputTokens: 10 };
    const response = { modelId };
    return step % 2 === 1
      ? { content: [{ type: 'tool-call', toolCallId: `c${step}`, toolName: 'refund', input: '{"id":"a"}' }], finishReason: 'tool-calls', usage, response }
      : { content: [{ type: 'text', text: 'done' }], finishReason: 'stop', usage, response };
  });
  m.modelId = modelId;
  return m;
}
const refund = tool({ description: 'Refund', inputSchema: z.object({ id: z.string() }), execute: async () => 'ok' });
const pricing = { big: { inputPer1M: 10, outputPer1M: 40 }, small: { inputPer1M: 1, outputPer1M: 4 } };

describe('it takes the journal you have', () => {
  for (const [name, pick] of [['storage.runs', (s: SqliteStorage) => s.runs], ['the storage', (s: SqliteStorage) => s]] as const) {
    it(`a Sqlite store, handed as ${name}: diagnoseAgent and replayCounterfactual both read it`, async () => {
      const storage = new SqliteStorage(':memory:');
      await runDurable({ runId: 'r1', journal: storage.runs, prompt: 'refund a', model: planned('big'), tools: { refund: gnlTool(refund, { sideEffect: true }) }, agentName: 'support' } as any);
      const d = await diagnoseAgent({ journal: pick(storage) as any, agent: 'support', pricing });
      expect(d.runs).toBe(1);
      expect(d.modelSteps).toBe(2);
      const r = await replayCounterfactual({ journal: pick(storage) as any, runId: 'r1', model: planned('small'), tools: { refund: { ...refund, execute: async () => { throw new Error('ran'); } } } as any, pricing });
      expect(r.divergence).toBeUndefined();
      expect(r.candidate.costUsd).toBeLessThan(r.recorded.costUsd);
    });
  }
});
