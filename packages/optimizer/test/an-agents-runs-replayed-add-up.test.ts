// An agent's latest runs replayed under one candidate: how often it would have done different work,
// what it would have cost — and a run that cannot be replayed counts toward nothing.
import { describe, it, expect } from 'vitest';
import { tool } from 'ai';
import { z } from 'zod';
import { runDurable, gnlTool, InMemoryJournal } from '@gnldev/durable';
import { createMockModel } from '../../durable/test/mock.js';
import { replayAgent } from '../src/index.js';

const refund = tool({ description: 'Refund', inputSchema: z.object({ orderId: z.string(), amount: z.number() }), execute: async (a) => ({ refunded: a.orderId }) });
const trap = { refund: { ...refund, execute: async () => { throw new Error('a replay ran refund'); } } };
const pricing = { big: { inputPer1M: 10, outputPer1M: 40 }, small: { inputPer1M: 1, outputPer1M: 4 } };

/** Refunds the order named in the prompt ("refund order N for A"), then answers. `amountFor` lets a candidate get it wrong. */
function refunder(modelId: string, amountFor: (order: string, amount: number) => number = (_, a) => a) {
  const m = createMockModel(async (o: any) => {
    const user = JSON.stringify(o.prompt);
    const [, order, amount] = /refund order (\d+) for (\d+)/.exec(user)!;
    const done = o.prompt.some((x: any) => x.role === 'tool');
    const usage = { inputTokens: 1000, outputTokens: 50 };
    const response = { modelId };
    return done
      ? { content: [{ type: 'text', text: 'Refunded.' }], finishReason: 'stop', usage, response }
      : { content: [{ type: 'tool-call', toolCallId: `c-${order}`, toolName: 'refund', input: JSON.stringify({ orderId: order, amount: amountFor(order!, Number(amount)) }) }], finishReason: 'tool-calls', usage, response };
  });
  m.modelId = modelId;
  return m;
}

async function recorded() {
  const journal = new InMemoryJournal();
  for (const [order, amount] of [['1', 10], ['2', 20], ['3', 30]] as const) {
    await runDurable({ runId: `r${order}`, journal, prompt: `refund order ${order} for ${amount}`, model: refunder('big'), tools: { refund: gnlTool(refund, { sideEffect: true }) }, agentName: 'support' } as any);
  }
  await runDurable({ runId: 'x1', journal, prompt: 'refund order 9 for 90', model: refunder('big'), tools: { refund: gnlTool(refund, { sideEffect: true }) }, agentName: 'billing' } as any);
  return journal;
}

describe("an agent's runs, replayed, add up", () => {
  it('3 runs: the candidate gets order 3 wrong — 1 divergence in 3, costs summed, the other agent left out, no tool run', async () => {
    const journal = await recorded();
    const r = await replayAgent({ journal, agent: 'support', tools: trap as any, pricing, model: refunder('small', (o, a) => (o === '3' ? a * 10 : a)) });
    expect(r.errors).toEqual([]);
    expect(r.runs.map((x) => x.runId).sort()).toEqual(['r1', 'r2', 'r3']);
    expect(r.summary).toMatchObject({ replayed: 3, diverged: 1, missedCallRuns: 0, reorderedRuns: 0, priced: true });
    expect(r.summary.divergenceRate).toBeCloseTo(1 / 3, 9);
    // recorded: 3 runs x 2 steps x (1000 x 10 + 50 x 40) / 1M = 0.072; candidate: r1, r2 two steps, r3 stops after one
    expect(r.summary.recordedCostUsd).toBeCloseTo(0.072, 9);
    expect(r.summary.candidateCostUsd).toBeCloseTo(5 * (1000 * 1 + 50 * 4) / 1e6, 9);
    expect(r.summary.costRatio).toBeCloseTo((5 * 1200) / (6 * 12000), 9);
  });

  it('a candidate that never answers: each run is an error, not a divergence, and the replay ends', async () => {
    const journal = await recorded();
    const hung = createMockModel((o: any) => new Promise((_, reject) => { o.abortSignal?.addEventListener('abort', () => reject(o.abortSignal.reason)); }));
    const r = await replayAgent({ journal, agent: 'support', tools: trap as any, pricing, model: hung, timeoutMs: 100 });
    expect(r.summary.replayed).toBe(0);
    expect(r.errors).toHaveLength(3);
    expect(r.errors.every((e) => /no answer within 100 ms/.test(e.error))).toBe(true);
    expect(Number.isNaN(r.summary.divergenceRate)).toBe(true);
  });

  it('an unpriced model: tokens are summed, no cost ratio is made up', async () => {
    const journal = await recorded();
    const r = await replayAgent({ journal, agent: 'support', tools: trap as any, pricing: {}, model: refunder('small') });
    expect(r.summary.priced).toBe(false);
    expect(Number.isNaN(r.summary.costRatio)).toBe(true);
    expect(r.summary.candidateTokens).toBe(3 * 2 * 1050);
  });

  it('a misspelled option is refused', async () => {
    await expect(replayAgent({ journal: new InMemoryJournal(), agent: 'support', model: refunder('small'), limt: 3 } as any)).rejects.toThrow(/limt/);
  });
});
