// What Studio's Lab tab asks of a run beyond its explanation: would removing a section of its prompt
// change what the agent does (on new messages, its tools answered from the page, never run), and which
// words of its last message decided its next call — read from a provider's probability when it gives
// one, else the share of tries, with how far each word's share can be off by chance.
import { describe, it, expect } from 'vitest';
import { tool, type ModelMessage } from 'ai';
import { z } from 'zod';
import { runDurable, gnlTool, InMemoryJournal } from '@gnldev/durable';
import { createMockModel } from '../../durable/test/mock.js';
import { studioLab, sampledToolChoice, wordShares } from '../src/index.js';
import { shapleyVariance } from '../src/word-shares.js';
import { openAIMessagesOf } from '../src/openai-messages.js';

const usage = { inputTokens: 100, outputTokens: 10 };
const input: ModelMessage[] = [
  { role: 'user', content: 'Hi, about order 4411.' },
  { role: 'assistant', content: 'Noted.' },
  { role: 'user', content: 'It arrived broken, refund please.' },
];
const system = 'You are a support agent.\n\nAlways look up an order first.\n\nBe brief.';

/** Looks the order up first when the rules are in its prompt, then refunds when asked for one; else answers. */
function model() {
  const m = createMockModel(async (o: any) => {
    const sys = JSON.stringify(o.prompt.filter((p: any) => p.role === 'system'));
    const lastUser = JSON.stringify((o.prompt as any[]).filter((p) => p.role === 'user').at(-1));
    const made = (o.prompt as any[]).filter((p) => p.role === 'tool').flatMap((p) => p.content.map((c: any) => c.toolName));
    if (sys.includes('look up') && !made.includes('lookup')) return { content: [{ type: 'tool-call', toolCallId: 'l', toolName: 'lookup', input: '{"orderId":"4411"}' }], finishReason: 'tool-calls', usage };
    if (lastUser.includes('refund') && !made.includes('refund')) return { content: [{ type: 'tool-call', toolCallId: 'r', toolName: 'refund', input: '{"orderId":"4411"}' }], finishReason: 'tool-calls', usage };
    return { content: [{ type: 'text', text: 'Done.' }], finishReason: 'stop', usage };
  });
  m.modelId = 'cheap';
  return m;
}

async function setup(logprobs?: Parameters<typeof studioLab>[0]['logprobs']) {
  const journal = new InMemoryJournal();
  const lookup = tool({ description: 'Look up an order', inputSchema: z.object({ orderId: z.string() }), execute: async () => ({ item: 'lamp' }) });
  const refund = tool({ description: 'Refund an order', inputSchema: z.object({ orderId: z.string() }), execute: async () => ({ ok: true }) });
  await runDurable({ runId: 'r1', journal, agentName: 'support', messages: input, system, model: model(), tools: { lookup: gnlTool(lookup, { sideEffect: false }), refund: gnlTool(refund, { sideEffect: false }) } } as any);
  // The agent's own tools must never run in the lab.
  const trap = (t: any) => ({ ...t, execute: async () => { throw new Error('the lab ran a tool'); } });
  const lab = studioLab({
    config: { agents: { support: { tools: { lookup: trap(lookup), refund: trap(refund) }, system } } }, models: { cheap: model() },
    pricing: { cheap: { inputPer1M: 1, outputPer1M: 4 } }, ...(logprobs ? { logprobs } : {}),
  });
  return { journal, lab };
}

describe('a run is tried without a section, and cut into words', () => {
  it('the plan lists the prompt sections and the tools to answer, and prices the runs before any is made', async () => {
    const { journal, lab } = await setup();
    const p = await lab.prunePlan(journal, { runId: 'r1', model: 'cheap', prompts: 2, trials: 3, control: true });
    expect(p.sections.map((s) => s.id)).toEqual(['system 1', 'system 2', 'system 3']);
    expect(p.tools.map((t) => t.name)).toEqual(['lookup', 'refund']);
    expect(p.tools[0]!.parameters).toMatchObject({ type: 'object', properties: { orderId: { type: 'string' } } });
    expect(p.runs).toBe(4 * 2 * 3);
    expect(p.estimatedTokens).toBeGreaterThan(0);
    expect(p.estimatedCostUsd).toBeGreaterThan(0);
  });

  it('a section that matters is not harmless; one that does not is, beside the control — the tools answered from the page', async () => {
    const { journal, lab } = await setup();
    const answers = [{ toolName: 'lookup', args: { orderId: '4411' }, output: { item: 'lamp' } }];
    const brief = await lab.prune(journal, { runId: 'r1', model: 'cheap', remove: 'system 3', control: 'system 2', prompts: ['It is cracked, refund please.'], answers, otherwise: { refund: { ok: true } }, trials: 2 });
    expect(brief).toMatchObject({ harmless: true, controlSeparates: true, noise: 0, failed: 0, unanswered: [], priced: true });
    expect(brief.removed.distance).toBe(0);
    expect(brief.control!.distance).toBe(1);
    expect(brief.inputTokens).toBeGreaterThan(0);
    expect(brief.costUsd).toBeGreaterThan(0);
    const rules = await lab.prune(journal, { runId: 'r1', model: 'cheap', remove: 'system 2', prompts: ['It is cracked, refund please.'], answers, otherwise: { refund: { ok: true } }, trials: 2 });
    expect(rules.harmless).toBe(false);
  });

  it('a call the page does not answer gets an error back and is listed with how often', async () => {
    const { journal, lab } = await setup();
    const r = await lab.prune(journal, { runId: 'r1', model: 'cheap', remove: 'system 3', prompts: ['refund please.'], trials: 2 });
    expect(r.unanswered).toEqual(expect.arrayContaining([{ toolName: 'lookup', args: { orderId: '4411' }, count: 6 }, { toolName: 'refund', args: { orderId: '4411' }, count: 6 }]));
    await expect(lab.prune(journal, { runId: 'r1', model: 'cheap', remove: 'system 3', prompts: [], trials: 1 })).rejects.toThrow(/at least one/);
    await expect(lab.prune(journal, { runId: 'r1', model: 'cheap', remove: 'nope', prompts: ['x'], trials: 1 })).rejects.toThrow(/no section 'nope'/);
  });

  it('sampled: the last message cut into words, the share of tries as the value, each share with its chance', async () => {
    const { journal, lab } = await setup();
    const plan = await lab.wordsPlan(journal, { runId: 'r1', model: 'cheap', samples: 3 });
    expect(plan).toMatchObject({ method: 'sampled', samples: 3, tool: 'lookup', tools: ['lookup', 'refund'] });
    expect(plan.words).toEqual(['It', 'arrived', 'broken,', 'refund', 'please.']);
    expect(plan.calls).toBe(32 * 3);
    // each call is the run's first step asked again (100 tokens in), its answer a call's few
    expect(plan.estimatedTokens).toBe(96 * (100 + 20));
    // the run's own prompt says "look up first": the first call is lookup whatever the words — refund never is
    const r = await lab.words(journal, { runId: 'r1', model: 'cheap', tool: 'refund', words: ['It arrived broken,', 'refund please.'], samples: 3 });
    expect(r).toMatchObject({ method: 'sampled', samples: 3, full: 0, none: 0, priced: true });
    expect(r.shares.every((s) => s.share === 0 && s.sd! > 0)).toBe(true);
    expect(r.inputTokens).toBe(4 * 3 * 100);
    await expect(lab.words(journal, { runId: 'r1', model: 'cheap', tool: 'nope', words: ['a'] })).rejects.toThrow(/no tool 'nope'/);
  });

  it('logprobs: one call per subset to the endpoint the host named, the conversation before it in the OpenAI format', async () => {
    const sent: any[] = [];
    const fetch = (async (_u: string, init: any) => {
      const b = JSON.parse(init.body); sent.push(b);
      const p = String(b.messages.at(-1).content).includes('refund') ? 0.9 : 0.1;
      const content = ['{"', 'name', '":"', 'refund', '"'].map((token, i) => ({ token, logprob: 0, top_logprobs: i === 3 ? [{ token: 'refund', logprob: Math.log(p) }, { token: 'lookup', logprob: Math.log(1 - p) }] : [] }));
      return new Response(JSON.stringify({ choices: [{ logprobs: { content } }] }), { status: 200 });
    }) as unknown as typeof globalThis.fetch;
    const { journal, lab } = await setup({ cheap: { baseURL: 'https://nim.test/v1', apiKey: 'k', model: 'm', fetch } });
    expect((await lab.wordsPlan(journal, { runId: 'r1', model: 'cheap' })).method).toBe('logprobs');
    const r = await lab.words(journal, { runId: 'r1', model: 'cheap', tool: 'refund', words: ['It arrived broken,', 'refund please.'] });
    expect(r.method).toBe('logprobs');
    expect(r.calls).toBe(4);
    expect(r.shares[1]!.share).toBeCloseTo(0.8, 9);
    expect(r.shares[0]!.sd).toBeUndefined();
    expect(sent[0].system ?? sent[0].messages[0]).toMatchObject({ role: 'system' });
    expect(sent[0].messages.slice(1, 3)).toEqual([{ role: 'user', content: 'Hi, about order 4411.' }, { role: 'assistant', content: 'Noted.' }]);
  });

  it("a share's chance is the weighted sum of its subsets' variances; a value said exact makes none", async () => {
    const ids = ['a', 'b'];
    // φ_a = ½(v{a} − v∅) + ½(v{ab} − v{b}): each weight ½, squared ¼ — four subsets of variance 1 → 1
    expect(shapleyVariance(ids, 'a', { '∅': 1, a: 1, b: 1, 'a+b': 1 })).toBeCloseTo(1, 12);
    const m = createMockModel(async () => ({ content: [{ type: 'tool-call', toolCallId: 'x', toolName: 'lookup', input: '{}' }], finishReason: 'tool-calls', usage }));
    const tools = { lookup: tool({ description: '', inputSchema: z.object({}), execute: async () => { throw new Error('ran'); } }) };
    const v = sampledToolChoice({ model: m, tools, tool: 'lookup', samples: 4 });
    // every try picked it: the value is 1, its variance that of 5/6 — not zero
    const got = await v('x');
    expect(got.value).toBe(1);
    expect(got.variance).toBeCloseTo((5 / 6) * (1 / 6) / 4, 12);
    expect(v.spent).toEqual({ calls: 4, inputTokens: 400, outputTokens: 40 });
    const progress: number[] = [];
    await wordShares({ words: ['a', 'b'], value: async () => 0.5, onProgress: (p) => progress.push(p.done) });
    expect(progress.at(-1)).toBe(4);
  });

  it('a tool call and its result keep the id that pairs them in the OpenAI format', () => {
    expect(openAIMessagesOf([
      { role: 'assistant', content: [{ type: 'text', text: 'Looking.' }, { type: 'tool-call', toolCallId: 'c1', toolName: 'lookup', input: { orderId: '1' } }] },
      { role: 'tool', content: [{ type: 'tool-result', toolCallId: 'c1', toolName: 'lookup', output: { type: 'json', value: { item: 'lamp' } } }] },
    ] as ModelMessage[])).toEqual([
      { role: 'assistant', content: 'Looking.', tool_calls: [{ id: 'c1', type: 'function', function: { name: 'lookup', arguments: '{"orderId":"1"}' } }] },
      { role: 'tool', tool_call_id: 'c1', content: '{"item":"lamp"}' },
    ]);
  });
});
