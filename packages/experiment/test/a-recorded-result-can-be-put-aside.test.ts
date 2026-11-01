// A recorded tool result can be put aside: an override for a call the recorded run made answers it in
// place of the recording — looked up first, or a wrong result could never be tried as the cause — and is
// traced as 'override'; the recorded call it stands for is used up, not "missed". No tool runs.
import { describe, it, expect } from 'vitest';
import { tool } from 'ai';
import { z } from 'zod';
import { runDurable, gnlTool, InMemoryJournal } from '@gnldev/durable';
import { createMockModel } from '../../durable/test/mock.js';
import { replayCounterfactual } from '../src/index.js';

const usage = { inputTokens: 10, outputTokens: 1 };
/** Looks the customer up, then ships to the address the lookup returned. */
function shipper() {
  const sent: string[] = [];
  const m = createMockModel(async (o: any) => {
    const results = (o.prompt as any[]).filter((p) => p.role === 'tool');
    if (results.length === 0) return { content: [{ type: 'tool-call', toolCallId: 'l1', toolName: 'lookup', input: '{}' }], finishReason: 'tool-calls', usage };
    if (results.length === 1) {
      const address = /"address":"(\w+)"/.exec(JSON.stringify(results[0]))?.[1] ?? 'unknown';
      sent.push(address);
      return { content: [{ type: 'tool-call', toolCallId: 'c1', toolName: 'createOrder', input: JSON.stringify({ address }) }], finishReason: 'tool-calls', usage };
    }
    return { content: [{ type: 'text', text: 'Done.' }], finishReason: 'stop', usage };
  });
  return { m, sent };
}

async function recorded() {
  const journal = new InMemoryJournal();
  const defs = {
    lookup: tool({ description: 'Look up the address', inputSchema: z.object({}), execute: async () => ({ address: 'Izmir' }) }),
    createOrder: tool({ description: 'Create an order', inputSchema: z.object({ address: z.string() }), execute: async ({ address }) => ({ ok: true, address }) }),
  };
  await runDurable({ runId: 'r1', journal, prompt: 'Ship my order.', model: shipper().m, tools: { lookup: gnlTool(defs.lookup, { sideEffect: false }), createOrder: gnlTool(defs.createOrder, { sideEffect: false }) } } as any);
  const trap = Object.fromEntries(Object.entries(defs).map(([k, d]) => [k, { ...d, execute: async () => { throw new Error(`the replay ran ${k}`); } }]));
  return { journal, trap };
}

describe('a recorded result can be put aside', () => {
  it('the override answers the recorded call instead of the recording, and the play goes where it leads', async () => {
    const { journal, trap } = await recorded();
    const plain = shipper();
    const same = await replayCounterfactual({ journal, runId: 'r1', model: plain.m, tools: trap as any });
    expect(plain.sent).toEqual(['Izmir']);
    expect(same.trace.map((c) => c.source)).toEqual(['recorded', 'recorded']);

    const changed = shipper();
    const r = await replayCounterfactual({ journal, runId: 'r1', model: changed.m, tools: trap as any, overrides: [{ toolName: 'lookup', args: {}, output: { address: 'Ankara' } }] });
    expect(changed.sent).toEqual(['Ankara']);
    expect(r.trace.map((c) => `${c.toolName}:${c.source}`)).toEqual(['lookup:override', 'createOrder:none']);
    expect(r.divergence?.call.toolName).toBe('createOrder');
    expect(r.missed).toEqual([]); // the divergence stops the play; nothing is "missed" before it
  });

  it('an override for a call with other arguments leaves the recorded one alone, and an answer never shadows the recording', async () => {
    const { journal, trap } = await recorded();
    const a = shipper();
    const r = await replayCounterfactual({
      journal, runId: 'r1', model: a.m, tools: trap as any,
      overrides: [{ toolName: 'lookup', args: { customer: 'someone else' }, output: { address: 'Ankara' } }],
      answers: [{ toolName: 'lookup', args: {}, output: { address: 'Bursa' } }],
    });
    expect(a.sent).toEqual(['Izmir']);
    expect(r.trace.map((c) => c.source)).toEqual(['recorded', 'recorded']);
    await expect(replayCounterfactual({ journal, runId: 'r1', model: a.m, overide: [] } as any)).rejects.toThrow(/overide/);
  });
});
