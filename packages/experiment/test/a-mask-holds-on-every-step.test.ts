// A part left out stays left out on every step, and nothing else is cut: ai@7 hands a step the messages
// the previous prepareStep returned, so a mask that filtered those by position cut the wrong messages
// from the second step on.
import { describe, it, expect } from 'vitest';
import { generateText, stepCountIs, tool, type ModelMessage } from 'ai';
import { z } from 'zod';
import { createMockModel } from '../../durable/test/mock.js';
import { maskConversation } from '../src/index.js';

const input: ModelMessage[] = [
  { role: 'user', content: 'Hi, I bought a desk lamp.' },
  { role: 'assistant', content: 'Happy to help.' },
  { role: 'user', content: 'The order number is 4411.' },
  { role: 'assistant', content: 'Noted: 4411.' },
  { role: 'user', content: 'It arrived broken.' },
];

async function run(prepareStep: any) {
  const seen: any[] = [];
  let step = 0;
  const model = createMockModel(async (o: any) => {
    seen.push(o.prompt);
    step++;
    if (step === 1) return { content: [{ type: 'tool-call', toolCallId: 's1', toolName: 'searchOrders', input: '{"orderId":"4411"}' }], finishReason: 'tool-calls', usage: { inputTokens: 1, outputTokens: 1 } };
    if (step === 2) return { content: [{ type: 'tool-call', toolCallId: 'r1', toolName: 'replaceOrder', input: '{"orderId":"4411"}' }], finishReason: 'tool-calls', usage: { inputTokens: 1, outputTokens: 1 } };
    return { content: [{ type: 'text', text: 'Replacement on its way.' }], finishReason: 'stop', usage: { inputTokens: 1, outputTokens: 1 } };
  });
  const id = z.object({ orderId: z.string() });
  await generateText({
    model: model as any, messages: input, stopWhen: stepCountIs(5), prepareStep,
    tools: {
      searchOrders: tool({ description: 'Look up', inputSchema: id, execute: async () => ({ item: 'desk lamp', status: 'delivered' }) }),
      replaceOrder: tool({ description: 'Replace', inputSchema: id, execute: async () => ({ replacement: 'shipped' }) }),
    },
  });
  return seen;
}
const texts = (prompt: any[]) => JSON.stringify(prompt);

describe('a mask holds on every step', () => {
  it('the dropped input messages are missing from all three steps, every other message is there', async () => {
    const seen = await run(maskConversation({ dropInput: [2, 3] }));
    expect(seen).toHaveLength(3);
    for (const p of seen) {
      expect(texts(p)).not.toContain('4411.');
      expect(texts(p)).toContain('desk lamp.');
      expect(texts(p)).toContain('arrived broken');
    }
    // what the steps produced is kept: the third step sees both calls and both results
    expect(texts(seen[2])).toContain('replaceOrder');
    expect(texts(seen[2])).toContain('"status":"delivered"');
  });

  it('a hidden tool result: the call stays, its output is a note, on this step and the next', async () => {
    const seen = await run(maskConversation({ hideToolResults: ['searchOrders'] }));
    for (const p of [seen[1], seen[2]]) {
      expect(texts(p)).toContain('searchOrders');
      expect(texts(p)).not.toContain('"status":"delivered"');
      expect(texts(p)).toContain('result hidden for this experiment');
    }
    expect(texts(seen[2])).toContain('"replacement":"shipped"');
  });

  it('a position outside the input is refused, not ignored', async () => {
    await expect(run(maskConversation({ dropInput: [9] }))).rejects.toThrow(/outside the run's 5 input messages/);
  });

  it('a misspelled option is refused', () => {
    expect(() => maskConversation({ drop: [1] } as any)).toThrow(/drop/);
  });
});
