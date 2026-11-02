// A recorded run's parts left out in turn: the part the call depended on gets the share, the recording
// is checked first, a failed replay is left out, and no tool is ever run.
import { describe, it, expect } from 'vitest';
import { tool, type ModelMessage } from 'ai';
import { z } from 'zod';
import { runDurable, gnlTool, InMemoryJournal } from '@gnldev/durable';
import { createMockModel } from '../../durable/test/mock.js';
import { explainRun, explainRunSize } from '../src/index.js';

const input: ModelMessage[] = [
  { role: 'user', content: 'Hi, I bought a desk lamp last week.' },
  { role: 'assistant', content: 'Happy to help.' },
  { role: 'user', content: 'The order number is 4411.' },
  { role: 'assistant', content: 'Noted: 4411.' },
  { role: 'user', content: 'It arrived broken.' },
];
const SECTIONS = { rules: 'Always look up an order first.', tone: 'Be brief.' };

/** Looks the order up only when it can see the number; replaces it only when it was told to look first. */
function agentModel(opts: { failEvery?: number } = {}) {
  let n = 0;
  const m = createMockModel(async (o: any) => {
    n++;
    if (opts.failEvery && n % opts.failEvery === 0) throw new Error('ECONNRESET');
    const prompt = JSON.stringify(o.prompt);
    const usage = { inputTokens: 100, outputTokens: 10 };
    const looked = prompt.includes('"toolName":"lookup"') && o.prompt.some((p: any) => p.role === 'tool');
    if (!prompt.includes('4411.')) return { content: [{ type: 'text', text: 'What is the order number?' }], finishReason: 'stop', usage };
    if (!looked) return { content: [{ type: 'tool-call', toolCallId: `l${n}`, toolName: 'lookup', input: '{"orderId":"4411"}' }], finishReason: 'tool-calls', usage };
    return { content: [{ type: 'text', text: 'A replacement is on its way.' }], finishReason: 'stop', usage };
  });
  m.modelId = 'mock';
  return m;
}

async function recorded() {
  const journal = new InMemoryJournal();
  const lookup = tool({ description: 'Look up', inputSchema: z.object({ orderId: z.string() }), execute: async () => ({ item: 'desk lamp' }) });
  await runDurable({ runId: 'r1', journal, messages: input, system: Object.values(SECTIONS).join('\n\n'), model: agentModel(), tools: { lookup: gnlTool(lookup, { sideEffect: false }) } } as any);
  const trap = { lookup: { ...lookup, execute: async () => { throw new Error('explainRun ran a tool'); } } };
  return { journal, trap };
}

describe('a run is explained by its parts', () => {
  it('the message with the order number carries the call; the other parts get nothing; shares sum to v(all) − v(none)', async () => {
    const { journal, trap } = await recorded();
    const r = await explainRun({
      journal, runId: 'r1', model: agentModel(), tools: trap as any,
      systemSections: SECTIONS, messages: { greeting: [0, 1], orderNumber: [2, 3] }, trials: 2,
    });
    expect(r.recordedCalls.map((c) => c.toolName)).toEqual(['lookup']);
    expect(r.replays).toBe(explainRunSize(4, 2));
    expect(r.failed).toBe(0);
    expect(r.representative.ok).toBe(true);
    expect(r.dependsOnParts).toBe(true);
    expect(r.shares[0]).toMatchObject({ part: 'orderNumber', share: 1, noise: 0 });
    for (const s of r.shares.slice(1)) expect(s.share).toBe(0);
    expect(r.shares.reduce((a, s) => a + s.share, 0)).toBeCloseTo(r.values['greeting+orderNumber+rules+tone']! - r.values['∅']!, 12);
  });

  it('a replay that could not run is left out, not counted as "the call did not happen"', async () => {
    const { journal, trap } = await recorded();
    const r = await explainRun({ journal, runId: 'r1', model: agentModel({ failEvery: 7 }), tools: trap as any, messages: { orderNumber: [2, 3] }, trials: 4 });
    expect(r.failed).toBeGreaterThan(0);
    expect(r.values.orderNumber).toBe(1);
    expect(r.values['∅']).toBe(0);
  });

  it('a recording the model does not repeat is reported before any share', async () => {
    const { journal, trap } = await recorded();
    const never = createMockModel(async () => ({ content: [{ type: 'text', text: 'Hello.' }], finishReason: 'stop', usage: { inputTokens: 1, outputTokens: 1 } }));
    const r = await explainRun({ journal, runId: 'r1', model: never, tools: trap as any, messages: { orderNumber: [2, 3] } });
    expect(r.representative.value).toBe(0);
    expect(r.representative.ok).toBe(false);
    expect(r.dependsOnParts).toBe(false);
  });

  it('parts must be named and at most 12; one name in two maps is one part; a misspelled option is refused', async () => {
    const { journal, trap } = await recorded();
    await expect(explainRun({ journal, runId: 'r1', model: agentModel(), tools: trap as any })).rejects.toThrow(/at least one part/);
    // a section and messages under one name go and come together: one player, two subsets
    const one = await explainRun({ journal, runId: 'r1', model: agentModel(), tools: trap as any, systemSections: { a: 'x' }, messages: { a: [0] }, trials: 1 });
    expect(one.parts).toEqual(['a']);
    expect(one.replays).toBe(2);
    await expect(explainRun({ journal, runId: 'r1', model: agentModel(), tools: trap as any, match: 'expect' })).rejects.toThrow(/needs `expect`/);
    await expect(explainRun({ journal, runId: 'r1', model: agentModel(), tools: trap as any, messages: { m: [2] }, trial: 2 } as any)).rejects.toThrow(/trial/);
  });
});
