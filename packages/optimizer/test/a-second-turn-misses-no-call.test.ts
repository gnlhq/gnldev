// A conversation's second turn, replayed as part of an agent's latest runs: the earlier turn's tool call
// is in the run's input, not its work, so the summary reports no missed call.
import { describe, it, expect } from 'vitest';
import { tool, type ModelMessage } from 'ai';
import { z } from 'zod';
import { runDurable, gnlTool, InMemoryJournal } from '@gnldev/durable';
import { createMockModel } from '../../durable/test/mock.js';
import { replayAgent } from '../src/index.js';

type Plan = Array<{ toolName: string; args: unknown } | { text: string }>;

function planned(modelId: string, plan: Plan) {
  let step = 0;
  const m = createMockModel(async () => {
    const p = plan[Math.min(step++, plan.length - 1)]!;
    const response = { modelId };
    const usage = { inputTokens: 1000, outputTokens: 100 };
    if ('text' in p) return { content: [{ type: 'text', text: p.text }], finishReason: 'stop', usage, response };
    return { content: [{ type: 'tool-call', toolCallId: `c${step}`, toolName: p.toolName, input: JSON.stringify(p.args) }], finishReason: 'tool-calls', usage, response };
  });
  m.modelId = modelId;
  return m;
}

/** An earlier turn in which order 42 was looked up — part of the second run's input, not its work. */
const history: ModelMessage[] = [
  { role: 'user', content: 'What is in order 42?' },
  { role: 'assistant', content: [{ type: 'tool-call', toolCallId: 'h1', toolName: 'lookup', input: { orderId: '42' } }] },
  { role: 'tool', content: [{ type: 'tool-result', toolCallId: 'h1', toolName: 'lookup', output: { type: 'json', value: { orderId: '42', total: 30 } } }] },
  { role: 'assistant', content: 'Order 42 is a mug, 30.' },
];

async function secondTurn() {
  const journal = new InMemoryJournal();
  const lookup = tool({ description: 'Find an order', inputSchema: z.object({ orderId: z.string() }), execute: async ({ orderId }) => ({ orderId, total: orderId === '43' ? 55 : 30 }) });
  await runDurable({
    runId: 'r2', journal, agentName: 'support',
    messages: [...history, { role: 'user', content: 'And order 43?' }],
    model: planned('big-model', [{ toolName: 'lookup', args: { orderId: '43' } }, { text: 'Order 43 is a lamp, 55.' }]),
    tools: { lookup: gnlTool(lookup, { sideEffect: false }) },
  } as any);
  const trap = { lookup: { ...lookup, execute: async () => { throw new Error('the replay ran lookup'); } } };
  return { journal, trap };
}

describe('an agent summary over a second turn', () => {
  it("the agent summary does not report a missed call for a conversation's second turn", async () => {
    const { journal, trap } = await secondTurn();
    const s = await replayAgent({
      journal, agent: 'support', tools: trap as any,
      model: planned('small-model', [{ toolName: 'lookup', args: { orderId: '43' } }, { text: 'Order 43: a lamp, 55.' }]),
    });
    expect(s.summary.replayed).toBe(1);
    expect(s.summary.missedCallRuns).toBe(0);
  });
});
