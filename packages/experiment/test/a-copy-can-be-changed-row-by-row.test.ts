// A capsule changes a run's copy row by row: an input message replaced or a new one put in, both named
// by their position in the ORIGINAL input on every step. A memory run whose input holds a system message
// (observations) can be played again at all. An expectation is one shared check, scenario or capsule.
import { describe, it, expect } from 'vitest';
import { generateText, stepCountIs, tool, type ModelMessage } from 'ai';
import { z } from 'zod';
import { InMemoryJournal, runKeys } from '@gnldev/durable';
import { createMockModel } from '../../durable/test/mock.js';
import { maskConversation, replayCounterfactual, checkExpectation, checkScenario, DEFAULT_SUITE } from '../src/index.js';

const input: ModelMessage[] = [
  { role: 'user', content: 'zero' },
  { role: 'assistant', content: 'one' },
  { role: 'user', content: 'two' },
  { role: 'assistant', content: 'three' },
  { role: 'user', content: 'four' },
];

/** Every prompt the model is handed, over two steps (a tool call, then the answer). */
async function prompts(prepareStep: any) {
  const seen: any[] = [];
  const model = createMockModel(async (o: any) => {
    seen.push(o.prompt.filter((p: any) => p.role !== 'tool' && !(p.role === 'assistant' && Array.isArray(p.content) && p.content.some((c: any) => c.type === 'tool-call'))));
    if (seen.length === 1) return { content: [{ type: 'tool-call', toolCallId: 'a', toolName: 'look', input: '{}' }], finishReason: 'tool-calls', usage: { inputTokens: 1, outputTokens: 1 } };
    return { content: [{ type: 'text', text: 'done' }], finishReason: 'stop', usage: { inputTokens: 1, outputTokens: 1 } };
  });
  await generateText({ model: model as any, messages: input, stopWhen: stepCountIs(3), prepareStep, tools: { look: tool({ description: 'l', inputSchema: z.object({}), execute: async () => ({}) }) } });
  return seen.map((p) => p.map((m: any) => (typeof m.content === 'string' ? m.content : m.content.map((c: any) => c.text).join(''))));
}

describe('a copy changed row by row', () => {
  it('replaced, then dropped, then inserted — every position the original input\'s, on every step', async () => {
    const seen = await prompts(maskConversation({
      replaceInput: { 1: { role: 'assistant', content: 'ONE' } },
      dropInput: [2],
      insertInput: [{ at: 0, message: { role: 'user', content: 'before zero' } }, { at: 3, message: { role: 'user', content: 'before three' } }, { at: 5, message: { role: 'assistant', content: 'at the end' } }],
    }));
    const want = ['before zero', 'zero', 'ONE', 'before three', 'three', 'four', 'at the end'];
    expect(seen).toHaveLength(2);
    for (const p of seen) expect(p).toEqual(want);
  });

  it('a position outside the input, or one both replaced and dropped, is refused', async () => {
    await expect(prompts(maskConversation({ replaceInput: { 5: { role: 'user', content: 'x' } } }))).rejects.toThrow(/outside the run's 5 input messages/);
    await expect(prompts(maskConversation({ insertInput: [{ at: 6, message: { role: 'user', content: 'x' } }] }))).rejects.toThrow(/outside 0…5/);
    expect(() => maskConversation({ dropInput: [1], replaceInput: { 1: { role: 'user', content: 'x' } } })).toThrow(/both replaced and dropped/);
    expect(() => maskConversation({ insert: [] } as any)).toThrow(/insert/);
  });
});

describe('a memory run with observations in its messages is replayed', () => {
  it('an input holding a system message plays again (the run itself allowed it)', async () => {
    const journal = new InMemoryJournal();
    await journal.put(runKeys.input('om-run'), { messages: [{ role: 'system', content: '# Observations\nprefers email' }, { role: 'user', content: 'hi' }] });
    let seen: any;
    const model = createMockModel(async (o: any) => { seen = o.prompt; return { content: [{ type: 'text', text: 'hello' }], finishReason: 'stop', usage: { inputTokens: 1, outputTokens: 1 } }; });
    const r = await replayCounterfactual({ journal, runId: 'om-run', model });
    expect(r.candidate.text).toBe('hello');
    expect(JSON.stringify(seen)).toContain('prefers email');
  });
});

describe('an expectation is one check', () => {
  it('calls, forbidden calls and the answer, each failure in words — the same as a scenario\'s', () => {
    const want = { calls: [{ toolName: 'refund', args: { orderId: '1042' } }], forbidden: ['cancel'], answerIncludes: [['30 days', '30-day']] };
    expect(checkExpectation(want, [{ toolName: 'refund', args: { orderId: '1042', amount: 1 } }], 'Within **30 days**.')).toEqual([]);
    expect(checkExpectation(want, [{ toolName: 'cancel', args: {} }], 'no')).toEqual(['missing call refund {"orderId":"1042"}', 'called forbidden cancel', 'answer lacks "30 days" or "30-day"']);
    const s = DEFAULT_SUITE[0]!;
    expect(checkScenario(s, [], '')).toEqual(checkExpectation(s.expect, [], ''));
  });
});
