// A change is worth its difference from the run left as it was, drawn as many times. With `unchanged`
// the capsule plays both, counts both the same way, and says the difference with an interval: one that
// holds 0 does not tell the change from chance.
import { describe, it, expect } from 'vitest';
import { tool } from 'ai';
import { z } from 'zod';
import { runDurable, gnlTool, InMemoryJournal } from '@gnldev/durable';
import { createMockModel } from '../../durable/test/mock.js';
import { runCapsule } from '../src/index.js';

const usage = { inputTokens: 100, outputTokens: 10 };
const REFUND = { calls: [{ toolName: 'refund', args: { orderId: '42' } }] };

/** Refunds when the system prompt says "refund" — else replaces; `refundsAnyway` of the unchanged plays refund too. */
function agentModel(refundsAnyway = 0) {
  let unchangedPlays = 0;
  const m = createMockModel(async (o: any) => {
    const system = String(o.prompt.find((p: any) => p.role === 'system')?.content ?? '');
    const done = o.prompt.filter((p: any) => p.role === 'tool').length;
    const told = system.includes('refund');
    if (!told && done === 0) unchangedPlays++;
    const refunds = told || unchangedPlays <= refundsAnyway;
    const next = done === 0 ? 'findOrder' : refunds ? 'refund' : 'replace';
    const response = { modelId: 'm' };
    if (done < 2) return { content: [{ type: 'tool-call', toolCallId: `c${done}`, toolName: next, input: JSON.stringify({ orderId: '42' }) }], finishReason: 'tool-calls', usage, response };
    return { content: [{ type: 'text', text: 'Done.' }], finishReason: 'stop', usage, response };
  });
  m.modelId = 'm';
  return m;
}

async function recorded() {
  const journal = new InMemoryJournal();
  const def = (name: string, out: unknown) => tool({ description: name, inputSchema: z.object({ orderId: z.string() }), execute: async () => out });
  const real = { findOrder: def('findOrder', { status: 'delivered' }), replace: def('replace', { ok: true }), refund: def('refund', { refunded: true }) };
  await runDurable({
    runId: 'r1', journal, model: agentModel(), system: 'Help with orders.', prompt: 'My lamp came broken.',
    tools: { findOrder: gnlTool(real.findOrder, { sideEffect: false }), replace: gnlTool(real.replace, { sideEffect: true }), refund: gnlTool(real.refund, { sideEffect: true }) },
  } as any);
  const trap = Object.fromEntries(Object.entries(real).map(([k, v]) => [k, { ...v, execute: async () => { throw new Error(`the capsule ran ${k}`); } }]));
  return { journal, trap };
}
const answers = [{ toolName: 'refund', args: { orderId: '42' }, output: { refunded: true } }];

describe('a change is measured beside the run unchanged', () => {
  it('0 of 10 unchanged → 10 of 10 changed: both counted, and the difference is past chance', async () => {
    const { journal, trap } = await recorded();
    const r = await runCapsule({ journal, runId: 'r1', model: agentModel(), tools: trap as any, system: 'Help with orders. If it came broken, refund it.', expect: REFUND, answers, trials: 10, unchanged: { tools: trap as any } });
    expect(Math.round(r.expected!.passRate.value * r.expected!.passRate.n)).toBe(10);
    expect(r.unchanged).toMatchObject({ trials: 10, failed: 0 });
    expect(r.unchanged!.expected!.passRate.value).toBe(0);
    expect(r.unchanged!.sameAsRecorded.value).toBe(1); // unchanged, it made the recorded calls again
    expect(r.difference!.of).toBe('expected');
    expect(r.difference!.interval.value).toBe(1);
    expect(r.difference!.interval.low).toBeGreaterThan(0);
    // the totals cover both arms: 20 plays of 3 steps each
    expect(r.inputTokens).toBe(20 * 3 * 100);
  });

  it('a change no better than the run unchanged: the interval holds 0', async () => {
    const { journal, trap } = await recorded();
    // unchanged, 8 of the 10 plays refund anyway; changed, all 10 do
    const r = await runCapsule({ journal, runId: 'r1', model: agentModel(8), tools: trap as any, system: 'Help with orders. If it came broken, refund it.', expect: REFUND, answers, trials: 10, concurrency: 1, unchanged: { tools: trap as any } });
    expect(r.unchanged!.expected!.passRate.value).toBe(0.8);
    expect(r.difference!.interval.low).toBeLessThanOrEqual(0);
  });

  it('without `unchanged` only the change is played; without `expect` the difference is of the recorded calls', async () => {
    const { journal, trap } = await recorded();
    const alone = await runCapsule({ journal, runId: 'r1', model: agentModel(), tools: trap as any, system: 'refund it.', answers, trials: 2 });
    expect(alone.unchanged).toBeUndefined();
    expect(alone.difference).toBeUndefined();
    const r = await runCapsule({ journal, runId: 'r1', model: agentModel(), tools: trap as any, system: 'refund it.', answers, trials: 4, unchanged: { tools: trap as any } });
    expect(r.difference).toMatchObject({ of: 'sameAsRecorded', interval: { value: -1 } });
  });
});
