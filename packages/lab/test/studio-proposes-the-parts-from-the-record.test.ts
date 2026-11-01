// What Studio's Lab tab calls: the parts proposed from a run's own record (never typed in), the plan and
// its price before anything is spent, and an explanation over those parts.
import { describe, it, expect } from 'vitest';
import { tool, type ModelMessage } from 'ai';
import { z } from 'zod';
import { runDurable, gnlTool, InMemoryJournal } from '@gnldev/durable';
import { createMockModel } from '../../durable/test/mock.js';
import { studioLab } from '../src/index.js';

const input: ModelMessage[] = [
  { role: 'user', content: 'Hi, I bought a desk lamp last week.' },
  { role: 'assistant', content: 'Happy to help.' },
  { role: 'user', content: 'The order number is 4411.' },
  { role: 'assistant', content: 'Noted: 4411.' },
  { role: 'user', content: 'It arrived broken.' },
];
const system = 'You are a support agent.\n\nAlways look up an order first.';

function model(id = 'cheap', byLength = false) {
  const m = createMockModel(async (o: any) => {
    const prompt = JSON.stringify(o.prompt);
    const usage = { inputTokens: byLength ? Math.ceil(prompt.length / 4) : 1000, outputTokens: 100 };
    const response = { modelId: id };
    if (!prompt.includes('4411.')) return { content: [{ type: 'text', text: 'Which order?' }], finishReason: 'stop', usage, response };
    if (!o.prompt.some((p: any) => p.role === 'tool')) return { content: [{ type: 'tool-call', toolCallId: 'l1', toolName: 'lookup', input: '{"orderId":"4411"}' }], finishReason: 'tool-calls', usage, response };
    return { content: [{ type: 'text', text: 'Replacement on its way.' }], finishReason: 'stop', usage, response };
  });
  m.modelId = id;
  return m;
}

async function setup(maxParts?: number, byLength = false) {
  const journal = new InMemoryJournal();
  const lookup = tool({ description: 'Look up', inputSchema: z.object({ orderId: z.string() }), execute: async () => ({ item: 'desk lamp' }) });
  await runDurable({ runId: 'r1', journal, agentName: 'support', messages: input, system, model: model('cheap', byLength), tools: { lookup: gnlTool(lookup, { sideEffect: false }) } } as any);
  await runDurable({ runId: 'other', journal, agentName: 'billing', prompt: 'hi', model: model() } as any);
  const trap = { lookup: { ...lookup, execute: async () => { throw new Error('the lab ran a tool'); } } };
  const lab = studioLab({
    config: { agents: { support: { tools: trap } } }, models: { cheap: model('cheap', byLength) },
    pricing: { cheap: { inputPer1M: 1, outputPer1M: 4 } }, ...(maxParts !== undefined ? { maxParts } : {}),
  });
  return { journal, lab };
}

describe('Studio proposes the parts from the record', () => {
  it('the system prompt cut at blank lines, each earlier turn, each tool it called — never the last user message', async () => {
    const { journal, lab } = await setup();
    expect(lab.catalog()).toEqual({ agents: ['support'], models: ['cheap'] });
    const p = await lab.plan(journal, { runId: 'r1', model: 'cheap' });
    expect(p.parts.map((x) => [x.id, x.kind])).toEqual([['system 1', 'system'], ['system 2', 'system'], ['turn 1', 'turn'], ['turn 2', 'turn'], ['lookup result', 'tool']]);
    expect(p.parts[3]!.preview).toBe('The order number is 4411. · Noted: 4411.');
    expect(JSON.stringify(p.parts)).not.toContain('arrived broken');
    expect(p.replays).toBe(32 * 3);
    // the recorded run: 2 model steps (the lookup, the answer) x (1000 in, 100 out) → 2,200 tokens a replay,
    // priced at the chosen model's row
    expect(p.tokensPerReplay).toBe(2200);
    // each part is out of half the replays: the input is the recorded one less half the parts' share of its characters
    expect(p.estimatedTokens).toBeLessThan(p.replays * p.tokensPerReplay);
    expect(p.estimatedCostUsd).toBeLessThan(96 * (2000 / 1e6 * 1 + 200 / 1e6 * 4));
    expect(p.estimatedCostUsd).toBeGreaterThan(96 * (1000 / 1e6 * 1 + 200 / 1e6 * 4));
  });

  it("the plan's estimate is near what the explanation then spends, where the recorded tokens are not", async () => {
    // tokens grow with the prompt's length, as a provider's do
    const { journal, lab } = await setup(undefined, true);
    const p = await lab.plan(journal, { runId: 'r1', model: 'cheap', trials: 1 });
    const r = await lab.explain(journal, { runId: 'r1', model: 'cheap', trials: 1 });
    const spent = r.inputTokens + r.outputTokens;
    process.env.GNL_TEST_VERBOSE && console.log('estimate', { recorded: p.replays * p.tokensPerReplay, estimated: p.estimatedTokens, spent });
    expect(Math.abs(p.estimatedTokens - spent) / spent).toBeLessThan(Math.abs(p.replays * p.tokensPerReplay - spent) / spent);
  });

  it('an explanation over those parts: the turn with the order number carries the call', async () => {
    const { journal, lab } = await setup();
    const r = await lab.explain(journal, { runId: 'r1', model: 'cheap', trials: 1 });
    expect(r.agent).toBe('support');
    expect(r.shares[0]).toMatchObject({ part: 'turn 2', share: 1 });
    expect(r.partsDetail).toHaveLength(5);
    expect(r.failed).toBe(0);
  });

  it('a run of an agent the lab does not offer, or with no record, is refused; past maxParts the oldest turns merge', async () => {
    const { journal, lab } = await setup();
    await expect(lab.plan(journal, { runId: 'other', model: 'cheap' })).rejects.toThrow(/not a run of an agent the lab offers/);
    await expect(lab.plan(journal, { runId: 'nope', model: 'cheap' })).rejects.toThrow(/no recorded input/);
    const small = await setup(4);
    const p = await small.lab.plan(small.journal, { runId: 'r1', model: 'cheap' });
    expect(p.parts.map((x) => x.id)).toEqual(['system 1', 'system 2', 'turn 1', 'lookup result']);
    expect(p.parts[2]!.preview).toContain('desk lamp');
    expect(p.parts[2]!.preview).toContain('4411');
  });

  it('a misspelled option is refused', () => {
    expect(() => studioLab({ config: {}, models: {}, maxPart: 3 } as any)).toThrow(/maxPart/);
  });
});

describe("a new agent's form, from the prompt in its code", () => {
  const scenarios = ['1042', '1043'].map((id) => ({
    id: `refund-${id}`, category: 'support' as const, system: 'Shop support.', prompt: `Refund order ${id}.`,
    tools: {
      getOrder: { description: 'Get an order', parameters: { type: 'object', properties: { orderId: { type: 'string' } } }, run: () => ({ total: 10 }) },
      refund: { description: 'Refund', parameters: { type: 'object', properties: { orderId: { type: 'string' } } }, run: () => ({ ok: true }) },
    },
    expect: { calls: [{ toolName: 'getOrder', args: { orderId: id } }, { toolName: 'refund', args: { orderId: id } }] },
  }));
  /** Looks the order up only when its system prompt says so. */
  const shopModel = createMockModel(async (o: any) => {
    const sys = String(o.prompt.find((p: any) => p.role === 'system')?.content ?? '');
    const id = /order (\d+)/.exec(JSON.stringify(o.prompt))![1];
    const done = o.prompt.filter((p: any) => p.role === 'tool').length;
    const plan = sys.includes('Look the order up') ? ['getOrder', 'refund'] : ['refund'];
    const usage = { inputTokens: 100 + sys.length, outputTokens: 10 };
    if (done < plan.length) return { content: [{ type: 'tool-call', toolCallId: `c${done}`, toolName: plan[done], input: JSON.stringify({ orderId: id }) }], finishReason: 'tool-calls', usage };
    return { content: [{ type: 'text', text: 'Done.' }], finishReason: 'stop', usage };
  });
  const lab = studioLab({
    config: { agents: { shop: { system: 'Look the order up before you refund it.\n\nBe warm, polite and brief in every answer.' }, dynamic: { system: (() => 'x') as unknown } } },
    models: { m: shopModel }, scenarios: { shop: scenarios },
  });

  it('the prompt cut at blank lines is the components; the plan says how many runs', () => {
    expect(lab.scenarios('shop').map((s) => s.id)).toEqual(['refund-1042', 'refund-1043']);
    expect(lab.scenarios('other')[0]!.id).toBe('refund-full'); // the default set
    const p = lab.formPlan({ agent: 'shop', trials: 2 });
    expect(p.components.map((c) => c.id)).toEqual(['section 1', 'section 2']);
    expect(p).toMatchObject({ scenarios: 2, trials: 2, forms: 4, runs: 16 });
    expect(lab.formPlan({ agent: 'shop', scenarios: ['refund-1043'] }).runs).toBe(8);
  });

  it('the best form is the lookup rule alone: it passes, and costs fewer tokens than with the tone section', async () => {
    const r = await lab.bestForm({ agent: 'shop', model: 'm', trials: 1 });
    expect(r.best!.components).toEqual(['section 1']);
    expect(r.best!.passRate.value).toBe(1);
    expect(r.shares['section 1']).toBe(1);
    expect(r.shares['section 2']).toBe(0);
    expect(r.componentsDetail[1]!.preview).toBe('Be warm, polite and brief in every answer.');
    expect(r.scenarios).toEqual(['refund-1042', 'refund-1043']);
  });

  it('an agent with no fixed prompt, an unknown agent or scenario is refused with the reason', () => {
    expect(() => lab.formPlan({ agent: 'dynamic' })).toThrow(/no fixed system prompt/);
    expect(() => lab.formPlan({ agent: 'nobody' })).toThrow(/not offered/);
    expect(() => lab.formPlan({ agent: 'shop', scenarios: ['nope'] })).toThrow(/no scenario 'nope'/);
  });

  it("a run's capsule: what it starts from, then the run played with the order number's turn left out", async () => {
    const { journal, lab } = await setup();
    const base = await lab.capsuleBase(journal, { runId: 'r1' });
    expect(base).toMatchObject({ agent: 'support', system, earlierMessages: 4, lastMessage: 'It arrived broken.', recordedCalls: [{ toolName: 'lookup', args: { orderId: '4411' } }], tokensPerPlay: 2200 });
    expect(base.tools).toEqual([{ name: 'lookup', description: 'Look up', parameters: expect.objectContaining({ type: 'object', properties: { orderId: { type: 'string' } } }) }]);
    const same = await lab.capsule(journal, { runId: 'r1', model: 'cheap', trials: 2 });
    expect(same.sameAsRecorded.value).toBe(1);
    // without the earlier turns the model never hears the order number, so it asks for it
    const alone = await lab.capsule(journal, { runId: 'r1', model: 'cheap', trials: 2, history: false });
    expect(alone.sameAsRecorded.value).toBe(0);
    expect(alone.paths).toEqual([expect.objectContaining({ calls: [], text: 'Which order?', count: 2 })]);
    // a tool taken away and a new one with no schema: the request's own fault
    await expect(lab.capsule(journal, { runId: 'r1', model: 'cheap', tools: [{ name: 'refund', description: 'Refund' }] })).rejects.toThrow(RangeError);
  });
});

