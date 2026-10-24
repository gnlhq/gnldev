// Where an agent's money went, read from what the provider billed: the opening each later step
// re-sent (and how much of it was already read from cache), and the tool output carried past its use.
import { describe, it, expect } from 'vitest';
import { tool } from 'ai';
import { z } from 'zod';
import { runDurable, gnlTool, InMemoryJournal } from '@gnldev/durable';
import { createMockModel } from '../../durable/test/mock.js';
import { diagnoseAgent } from '../src/index.js';

type Step = { input: number; cached?: number; call?: { toolName: string; args: unknown } };
function scripted(steps: Step[]) {
  let i = 0;
  const m = createMockModel(async () => {
    const s = steps[Math.min(i++, steps.length - 1)]!;
    const usage = { inputTokens: s.input, outputTokens: 50, cachedInputTokens: s.cached ?? 0 };
    const response = { modelId: 'big-model' };
    return s.call
      ? { content: [{ type: 'tool-call', toolCallId: `c${i}`, toolName: s.call.toolName, input: JSON.stringify(s.call.args) }], finishReason: 'tool-calls', usage, response }
      : { content: [{ type: 'text', text: 'done' }], finishReason: 'stop', usage, response };
  });
  m.modelId = 'big-model';
  return m;
}
const pricing = { 'big-model': { inputPer1M: 10, outputPer1M: 40, cachedInputPer1M: 1, cacheWritePer1M: 12.5 } };
const tools = {
  lookup: gnlTool(tool({ description: 'Look up', inputSchema: z.object({ id: z.string() }), execute: async () => 'x'.repeat(4000) }), { sideEffect: false }),
  refund: gnlTool(tool({ description: 'Refund', inputSchema: z.object({ id: z.string() }), execute: async () => 'ok' }), { sideEffect: true }),
};
const threeSteps = (cached = 0): Step[] => [
  { input: 2000, call: { toolName: 'lookup', args: { id: 'a' } } },
  { input: 3100, cached, call: { toolName: 'refund', args: { id: 'a' } } },
  { input: 3200, cached },
];

describe('a diagnosis reads what the provider billed', () => {
  it('the re-sent opening, the cache saving after one write per run, and the old tool output', async () => {
    const journal = new InMemoryJournal();
    await runDurable({ runId: 's1', journal, prompt: 'refund a', model: scripted(threeSteps()), tools, agentName: 'support' } as any);
    await runDurable({ runId: 'o1', journal, prompt: 'other', model: scripted(threeSteps()), tools, agentName: 'other' } as any);
    const d = await diagnoseAgent({ journal, agent: 'support', pricing, keepLast: 1 });
    expect(d.runs).toBe(1);
    expect(d.modelSteps).toBe(3);
    expect(d.inputTokens).toBe(8300);
    // Steps 2 and 3 each re-sent the 2,000-token opening; nothing was read from cache.
    expect(d.repeatedPrefix).toMatchObject({ tokens: 4000, uncachedTokens: 4000, cacheableUncachedTokens: 4000, medianOpening: 2000 });
    expect(d.repeatedPrefix.share).toBeCloseTo(4000 / 8300, 9);
    // Saved 4,000 x (10 - 1) per 1M = 0.036; one write of the opening costs 2,000 x (12.5 - 10) per 1M = 0.005.
    const cache = d.findings.find((f) => f.lever === 'cache')!;
    expect(cache.estimatedSavingUsd).toBeCloseTo(0.031, 9);
    expect(cache.needsReplay).toBe(false);
    // The lookup's 4,000 characters (~1,000 tokens) ride in step 3, two steps after it was produced.
    expect(d.oldToolOutput.estimatedTokens).toBe(1000);
    const mask = d.findings.find((f) => f.lever === 'mask-old-tool-output')!;
    expect(mask.estimatedSavingUsd).toBeCloseTo(0.01, 9);
    expect(mask.needsReplay).toBe(true);
    expect(d.findings[0]!.lever).toBe('cache');
  });

  it('an opening the provider already reads from cache leaves nothing to save there', async () => {
    const journal = new InMemoryJournal();
    await runDurable({ runId: 's2', journal, prompt: 'refund a', model: scripted(threeSteps(2000)), tools, agentName: 'support' } as any);
    const d = await diagnoseAgent({ journal, agent: 'support', pricing });
    expect(d.repeatedPrefix).toMatchObject({ tokens: 4000, uncachedTokens: 0 });
    expect(d.findings.some((f) => f.lever === 'cache')).toBe(false);
  });

  it('an opening shorter than a provider caches is not counted as cacheable', async () => {
    const journal = new InMemoryJournal();
    await runDurable({ runId: 's3', journal, prompt: 'refund a', model: scripted([{ input: 500, call: { toolName: 'refund', args: { id: 'a' } } }, { input: 600 }]), tools, agentName: 'support' } as any);
    const d = await diagnoseAgent({ journal, agent: 'support', pricing });
    expect(d.repeatedPrefix.tokens).toBe(500);
    expect(d.findings.some((f) => f.lever === 'cache')).toBe(false);
    expect(d.notes.join(' ')).toMatch(/median 500 tokens\) are shorter than a provider caches \(1024\)/);
  });

  it('a model missing from the price table still gets its findings, in tokens, with no dollar figure', async () => {
    const journal = new InMemoryJournal();
    await runDurable({ runId: 's4', journal, prompt: 'refund a', model: scripted(threeSteps()), tools, agentName: 'support' } as any);
    const d = await diagnoseAgent({ journal, agent: 'support', pricing: {}, keepLast: 1 });
    const cache = d.findings.find((f) => f.lever === 'cache')!;
    expect(cache).toMatchObject({ tokens: 4000 });
    expect(cache.estimatedSavingUsd).toBeUndefined();
    expect(cache.why).toMatch(/not in the price table/);
    expect(d.findings.find((f) => f.lever === 'mask-old-tool-output')!.estimatedSavingUsd).toBeUndefined();
  });

  it('a misspelled option is refused', async () => {
    await expect(diagnoseAgent({ journal: new InMemoryJournal(), agent: 'support', keeplast: 2 } as any)).rejects.toThrow(/keeplast/);
  });
});
