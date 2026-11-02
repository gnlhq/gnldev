// A recorded run played again under another model: every tool call is answered from the recording, a
// call the recording never made stops the replay as a divergence, and no tool is ever executed.
import { describe, it, expect } from 'vitest';
import { tool } from 'ai';
import { z } from 'zod';
import { runDurable, gnlTool, InMemoryJournal, PRICING_KEY } from '@gnldev/durable';
import { createMockModel } from '../../durable/test/mock.js';
import { replayCounterfactual, ReplaySourceError } from '../src/index.js';

type Plan = Array<{ toolName: string; args: unknown } | { text: string }>;
const usage = (input: number, output: number) => ({ inputTokens: input, outputTokens: output });

/** A model that walks a plan: one step per entry, a tool call or the final text. */
function planned(modelId: string, plan: Plan, tokens = { input: 1000, output: 100 }) {
  let step = 0;
  const m = createMockModel(async () => {
    const p = plan[Math.min(step++, plan.length - 1)]!;
    // A real provider names the model in `response`; the journal prices a step by it.
    const response = { modelId };
    if ('text' in p) return { content: [{ type: 'text', text: p.text }], finishReason: 'stop', usage: usage(tokens.input, tokens.output), response };
    return { content: [{ type: 'tool-call', toolCallId: `c${step}`, toolName: p.toolName, input: JSON.stringify(p.args) }], finishReason: 'tool-calls', usage: usage(tokens.input, tokens.output), response };
  });
  m.modelId = modelId;
  return m;
}

const pricing = {
  'big-model': { inputPer1M: 10, outputPer1M: 40 },
  'small-model': { inputPer1M: 1, outputPer1M: 4 },
};

async function recordedRun() {
  const journal = new InMemoryJournal();
  const executed = { lookup: 0, refund: 0 };
  const defs = {
    lookup: tool({ description: 'Find an order', inputSchema: z.object({ orderId: z.string() }), execute: async ({ orderId }) => { executed.lookup++; return { orderId, total: 30 }; } }),
    refund: tool({ description: 'Refund an order', inputSchema: z.object({ orderId: z.string(), amount: z.number() }), execute: async ({ orderId, amount }) => { executed.refund++; return { refunded: orderId, amount }; } }),
  };
  const tools = { lookup: gnlTool(defs.lookup, { sideEffect: false }), refund: gnlTool(defs.refund, { sideEffect: true }) };
  await runDurable({
    runId: 'r1', journal, prompt: 'Refund order 42',
    model: planned('big-model', [{ toolName: 'lookup', args: { orderId: '42' } }, { toolName: 'refund', args: { orderId: '42', amount: 30 } }, { text: 'Refunded order 42.' }]),
    tools,
  } as any);
  // The replay gets the definitions with an execute that must never run.
  const trap = {
    lookup: { ...defs.lookup, execute: async () => { throw new Error('the replay ran lookup'); } },
    refund: { ...defs.refund, execute: async () => { throw new Error('the replay ran refund'); } },
  };
  return { journal, executed, trap };
}

describe('a counterfactual replay never runs a tool', () => {
  it('the same work on a cheaper model: same calls answered from the recording, no divergence, the cost of each side', async () => {
    const { journal, executed, trap } = await recordedRun();
    expect(executed).toEqual({ lookup: 1, refund: 1 });
    const r = await replayCounterfactual({
      journal, runId: 'r1', tools: trap as any, pricing,
      model: planned('small-model', [{ toolName: 'lookup', args: { orderId: '42' } }, { toolName: 'refund', args: { orderId: '42', amount: 30 } }, { text: 'Order 42 refunded.' }]),
    });
    expect(executed).toEqual({ lookup: 1, refund: 1 }); // nothing ran again
    expect(r.divergence).toBeUndefined();
    expect(r.missed).toEqual([]);
    expect(r.reordered).toBe(false);
    expect(r.candidate.calls.map((c) => c.toolName)).toEqual(['lookup', 'refund']);
    expect(r.candidate.text).toBe('Order 42 refunded.');
    expect(r.recorded.text).toBe('Refunded order 42.');
    // 3 steps x (1000 in, 100 out): big 3 x (0.01 + 0.004) = 0.042; small 3 x (0.001 + 0.0004) = 0.0042
    expect(r.recorded.costUsd).toBeCloseTo(0.042, 9);
    expect(r.candidate.costUsd).toBeCloseTo(0.0042, 9);
    expect(r.candidate.priced && r.recorded.priced).toBe(true);
  });

  it('the candidate refunds another amount: a divergence at that call, the replay stops, the tool is not run', async () => {
    const { journal, executed, trap } = await recordedRun();
    const r = await replayCounterfactual({
      journal, runId: 'r1', tools: trap as any, pricing,
      model: planned('small-model', [{ toolName: 'lookup', args: { orderId: '42' } }, { toolName: 'refund', args: { orderId: '42', amount: 300 } }, { text: 'never reached' }]),
    });
    expect(executed).toEqual({ lookup: 1, refund: 1 });
    expect(r.divergence).toMatchObject({ at: 1, call: { toolName: 'refund' } });
    expect(r.candidate.modelSteps).toBe(2); // stopped after the diverging step
    expect(r.candidate.text).toBe('');
  });

  it('the candidate skips the lookup: no divergence, the skipped call is reported', async () => {
    const { journal, trap } = await recordedRun();
    const r = await replayCounterfactual({
      journal, runId: 'r1', tools: trap as any, pricing,
      model: planned('small-model', [{ toolName: 'refund', args: { orderId: '42', amount: 30 } }, { text: 'Refunded.' }]),
    });
    expect(r.divergence).toBeUndefined();
    expect(r.missed.map((c) => c.toolName)).toEqual(['lookup']);
  });

  it('the candidate makes the same calls in another order: reported as reordered', async () => {
    const { journal, trap } = await recordedRun();
    const r = await replayCounterfactual({
      journal, runId: 'r1', tools: trap as any, pricing,
      model: planned('small-model', [{ toolName: 'refund', args: { orderId: '42', amount: 30 } }, { toolName: 'lookup', args: { orderId: '42' } }, { text: 'Done.' }]),
    });
    expect(r.divergence).toBeUndefined();
    expect(r.reordered).toBe(true);
  });

  it('without a table both sides are priced from the journal\'s own __pricing__, not two different tables', async () => {
    const { journal, trap } = await recordedRun();
    await journal.put(PRICING_KEY, { version: 1, models: pricing });
    const r = await replayCounterfactual({
      journal, runId: 'r1', tools: trap as any,
      model: planned('small-model', [{ toolName: 'lookup', args: { orderId: '42' } }, { toolName: 'refund', args: { orderId: '42', amount: 30 } }, { text: 'ok' }]),
    });
    expect(r.recorded.costUsd).toBeCloseTo(0.042, 9);
    expect(r.candidate.costUsd).toBeCloseTo(0.0042, 9);
  });

  it('a call recorded twice answers twice; a third time is a divergence', async () => {
    const journal = new InMemoryJournal();
    const ping = tool({ description: 'Ping', inputSchema: z.object({ n: z.number() }), execute: async () => ({ pong: true }) });
    const twice: Plan = [{ toolName: 'ping', args: { n: 1 } }, { toolName: 'ping', args: { n: 1 } }, { text: 'done' }];
    await runDurable({ runId: 'r2', journal, prompt: 'ping twice', model: planned('big-model', twice), tools: { ping: gnlTool(ping, { sideEffect: false }) } } as any);
    const trap = { ping: { ...ping, execute: async () => { throw new Error('ran'); } } };
    const same = await replayCounterfactual({ journal, runId: 'r2', tools: trap as any, pricing, model: planned('small-model', twice) });
    expect(same.divergence).toBeUndefined();
    const thrice = await replayCounterfactual({
      journal, runId: 'r2', tools: trap as any, pricing,
      model: planned('small-model', [{ toolName: 'ping', args: { n: 1 } }, { toolName: 'ping', args: { n: 1 } }, { toolName: 'ping', args: { n: 1 } }, { text: 'x' }]),
    });
    expect(thrice.divergence).toMatchObject({ at: 2, call: { toolName: 'ping' } });
  });

  it('a run with no recorded input cannot be replayed', async () => {
    await expect(replayCounterfactual({ journal: new InMemoryJournal(), runId: 'nope', model: planned('small-model', [{ text: 'x' }]) }))
      .rejects.toBeInstanceOf(ReplaySourceError);
  });

  it('a misspelled option is refused', async () => {
    const { journal } = await recordedRun();
    await expect(replayCounterfactual({ journal, runId: 'r1', model: planned('small-model', [{ text: 'x' }]), maxStep: 3 } as any))
      .rejects.toThrow(/maxStep/);
  });

  it("a call the recording never made: without an answer it stops and says the arguments; with one it goes on, marked as the caller's", async () => {
    const { journal, executed, trap } = await recordedRun();
    const plan: Plan = [{ toolName: 'lookup', args: { orderId: '42' } }, { toolName: 'refund', args: { orderId: '42', amount: 15 } }, { text: 'Half of order 42 refunded.' }];
    const stopped = await replayCounterfactual({ journal, runId: 'r1', tools: trap as any, model: planned('small-model', plan) });
    expect(stopped.divergence).toMatchObject({ at: 1, call: { toolName: 'refund' }, args: { orderId: '42', amount: 15 } });
    expect(stopped.trace).toEqual([
      { toolName: 'lookup', args: { orderId: '42' }, source: 'recorded' },
      { toolName: 'refund', args: { orderId: '42', amount: 15 }, source: 'none' },
    ]);
    expect(stopped.recordedTrace).toEqual([{ toolName: 'lookup', args: { orderId: '42' } }, { toolName: 'refund', args: { orderId: '42', amount: 30 } }]);
    const answered = await replayCounterfactual({
      journal, runId: 'r1', tools: trap as any, model: planned('small-model', plan),
      answers: [{ toolName: 'refund', args: { amount: 15, orderId: '42' }, output: { refunded: '42', amount: 15 } }], // key order does not matter
    });
    expect(answered.divergence).toBeUndefined();
    expect(answered.trace.map((c) => c.source)).toEqual(['recorded', 'answer']);
    expect(answered.candidate.text).toBe('Half of order 42 refunded.');
    expect(answered.reordered).toBe(false); // an answered call is not compared with the recording
    expect(executed).toEqual({ lookup: 1, refund: 1 });
  });
});

