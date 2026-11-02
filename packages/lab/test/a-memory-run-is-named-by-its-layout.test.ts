// A memory run's parts, named by where they came from — as the run's own layout proves it, never from its
// counts — and the capsule's view of the same run: the working memory told apart from the system prompt,
// a tool memory gave the run answered from the recording, and what a right answer does checked per play.
import { describe, it, expect } from 'vitest';
import { tool, type ModelMessage } from 'ai';
import { z } from 'zod';
import { runDurable, gnlTool, InMemoryJournal, runKeys } from '@gnldev/durable';
import { createMockModel } from '../../durable/test/mock.js';
import { studioLab, proposeParts } from '../src/studio.js';
import { runCapsule } from '../src/capsule.js';

const usage = { inputTokens: 100, outputTokens: 10 };
const recalled = { role: 'user', content: 'Last month my order 4411 was a desk lamp.' };
const window: ModelMessage[] = [
  { role: 'user', content: 'Hi again.' },
  { role: 'assistant', content: 'Welcome back.' },
];

/** Remembers the customer's name when the working memory has none; looks the order up; answers. */
function supportModel() {
  const m = createMockModel(async (o: any) => {
    const prompt = JSON.stringify(o.prompt);
    const done = o.prompt.filter((p: any) => p.role === 'tool').length;
    const plan = [{ toolName: 'lookup', args: { orderId: '4411' } }, { toolName: 'updateWorkingMemory', args: { memory: { lastOrder: '4411' } } }];
    if (!prompt.includes('4411')) return { content: [{ type: 'text', text: 'Which order?' }], finishReason: 'stop', usage };
    if (done < plan.length) return { content: [{ type: 'tool-call', toolCallId: `c${done}`, toolName: plan[done]!.toolName, input: JSON.stringify(plan[done]!.args) }], finishReason: 'tool-calls', usage };
    return { content: [{ type: 'text', text: 'Replacement on its way.' }], finishReason: 'stop', usage };
  });
  m.modelId = 'cheap';
  return m;
}

const memoryOf = (extra: Partial<{ system: string }> = { system: '# Working Memory\nname: Ayse' }): any => ({
  async getMessages() { return []; }, async append() {},
  async loadContext() {
    return {
      messages: [recalled, ...window],
      provenance: { recalled: [{ threadId: 't', seq: 0, role: 'user', preview: 'Last month…' }], recentCount: 2 },
      ...extra,
      // memory's own tool: the run is offered it, the agent's config does not define it
      tools: { updateWorkingMemory: tool({ description: 'Remember', inputSchema: z.object({ memory: z.record(z.any()) }), execute: async () => ({ ok: true }) }) },
    };
  },
});

async function setup(processors?: unknown[]) {
  const journal = new InMemoryJournal();
  const lookup = tool({ description: 'Look up', inputSchema: z.object({ orderId: z.string() }), execute: async () => ({ item: 'desk lamp' }) });
  await runDurable({
    runId: 'r1', journal, agentName: 'support', memory: memoryOf(), threadId: 't', system: 'You are a support agent.',
    prompt: 'It arrived broken.', model: supportModel(), tools: { lookup: gnlTool(lookup, { sideEffect: false }) },
    ...(processors ? { processors } : {}),
  } as any);
  const trap = { lookup: { ...lookup, execute: async () => { throw new Error('the lab ran a tool'); } } };
  const lab = studioLab({ config: { agents: { support: { tools: trap } } }, models: { cheap: supportModel() }, maxParts: 8 });
  return { journal, lab };
}

describe("a memory run's parts are named by its layout", () => {
  it('the working memory, recall and the recent window are parts of their own, proven by the layout', async () => {
    const { journal, lab } = await setup();
    const p = await lab.plan(journal, { runId: 'r1', model: 'cheap' });
    expect(p.layout).toMatchObject({ status: 'present', layout: 'exact', memoryMessages: 3, notes: [] });
    expect(p.parts.map((x) => [x.id, x.kind, x.source])).toEqual([
      ['system 1', 'system', 'layout'],
      ['working memory', 'wm', 'layout'],
      ['recall', 'recall', 'layout'],
      ['recent 1', 'recent', 'layout'],
      ['lookup result', 'tool', 'layout'],
      ['updateWorkingMemory result', 'tool', 'layout'],
    ]);
    expect(p.parts[1]!.preview).toBe('# Working Memory\nname: Ayse');
    expect(JSON.stringify(p.parts)).not.toContain('arrived broken'); // the turn's last user message is never a part
  });

  it('the same run with its layout taken away: plain turns, every one of unknown source, and the reason', async () => {
    const { journal, lab } = await setup();
    const rec: any = await journal.get(runKeys.memoryContext('r1'));
    const { layout: _l, systemSpans: _s, ...legacy } = rec;
    await journal.put(runKeys.memoryContext('r1'), legacy);
    const p = await lab.plan(journal, { runId: 'r1', model: 'cheap' });
    expect(p.layout).toEqual({ status: 'absent', reason: 'no-layout', detail: expect.stringMatching(/no memory layout/) });
    expect(new Set(p.parts.map((x) => x.source))).toEqual(new Set(['unknown']));
    expect(p.parts.map((x) => x.kind)).not.toContain('recall');
    const base = await lab.capsuleBase(journal, { runId: 'r1' });
    expect(base.memoryMessages).toBeNull();
    expect(base.workingMemory).toBeUndefined();
    expect(base.system).toContain('# Working Memory'); // not told apart: shown whole
  });

  it("a row an input processor put in is counted as no one's memory, and labelled unlabelled", async () => {
    const injectAhead = { name: 'jit', processInput: async (i: any) => ({ ...i, messages: [{ role: 'user', content: 'A note the processor added.' }, ...i.messages] }) };
    const { journal, lab } = await setup([injectAhead]);
    const p = await lab.plan(journal, { runId: 'r1', model: 'cheap' });
    expect(p.layout).toMatchObject({ status: 'present', layout: 'changed', memoryMessages: 3 });
    expect((p.layout as any).notes.join(' ')).toMatch(/1 row\(s\) no memory row accounts for/);
    expect(p.parts.find((x) => x.preview.includes('processor added'))).toMatchObject({ id: 'unlabelled 1', kind: 'turn', source: 'unknown' });
  });

  it('the capsule base: the working memory apart from the prompt, the memory tool offered from the recording', async () => {
    const { journal, lab } = await setup();
    const base = await lab.capsuleBase(journal, { runId: 'r1' });
    expect(base.system).toBe('You are a support agent.');
    expect(base.workingMemory).toEqual({ status: 'exact', text: '# Working Memory\nname: Ayse' });
    expect(base.memoryMessages).toBe(3);
    expect(base.parts.map((x) => x.kind)).toEqual(['system', 'wm', 'recall', 'recent', 'tool', 'tool']);
    expect(base.tools.find((t) => t.name === 'updateWorkingMemory')).toEqual({ name: 'updateWorkingMemory', description: '', parameters: { type: 'object' }, recordedOnly: true });
    // played unchanged, the memory tool's call is made again and answered from the recording
    const same = await lab.capsule(journal, { runId: 'r1', model: 'cheap', trials: 1 });
    expect(same.paths[0]!.calls.map((c) => `${c.toolName}:${c.source}`)).toEqual(['lookup:recorded', 'updateWorkingMemory:recorded']);
    expect(same.sameAsRecorded.value).toBe(1);
    // an edited prompt keeps the working memory behind it; memory off leaves it out with the rest
    const edited = await lab.capsule(journal, { runId: 'r1', model: 'cheap', trials: 1, system: 'You are terse.' });
    expect(edited.sameAsRecorded.value).toBe(1);
    const off = await lab.capsule(journal, { runId: 'r1', model: 'cheap', trials: 1, memory: false });
    expect(off.paths[0]!.text).toBe('Which order?');
  });

  it('what a right answer does: the share of plays that did it, failures in words, a stopped play left out', async () => {
    const { journal, lab } = await setup();
    const good = await lab.capsule(journal, { runId: 'r1', model: 'cheap', trials: 2, expect: { calls: [{ toolName: 'lookup', args: { orderId: '4411' } }], answerIncludes: ['replacement'] } });
    expect(good.expected).toEqual({ passRate: expect.objectContaining({ value: 1, n: 2 }), undetermined: 0, bounds: { low: expect.objectContaining({ value: 1, n: 2 }), high: expect.objectContaining({ value: 1, n: 2 }) } });
    expect(good.paths[0]).toMatchObject({ passed: 2, failures: [] });
    const bad = await lab.capsule(journal, { runId: 'r1', model: 'cheap', trials: 2, expect: { forbidden: ['lookup'], answerIncludes: [['refund', 'money back']] } });
    expect(bad.expected!.passRate.value).toBe(0);
    expect(bad.paths[0]!.failures).toEqual(['called forbidden lookup', 'answer lacks "refund" or "money back"']);
    // a play that calls what the recording never made stops there: it is neither a pass nor a failure
    const elsewhere = createMockModel(async () => ({ content: [{ type: 'tool-call', toolCallId: 'x', toolName: 'lookup', input: '{"orderId":"9999"}' }], finishReason: 'tool-calls', usage }));
    const stopped = await runCapsule({ journal, runId: 'r1', model: elsewhere, tools: { lookup: tool({ description: 'Look up', inputSchema: z.object({ orderId: z.string() }) }) } as any, trials: 2, expect: { answerIncludes: ['x'] } });
    expect(stopped.pending).toEqual([{ toolName: 'lookup', args: { orderId: '9999' } }]);
    // stopped plays: no rate of their own, and bounds from 0 (all failures) to 1 (all passes)
    expect(stopped.expected).toEqual({ passRate: expect.objectContaining({ n: 0 }), undetermined: 2, bounds: { low: expect.objectContaining({ value: 0, n: 2 }), high: expect.objectContaining({ value: 1, n: 2 }) } });
    expect(stopped.paths[0]!.failures).toBeUndefined();
  });
});

describe('a tool call and its result stay in one part', () => {
  it('a call recalled and its result in the recent window are one part, not two', () => {
    const messages: ModelMessage[] = [
      { role: 'assistant', content: [{ type: 'tool-call', toolCallId: 'k1', toolName: 'lookup', input: {} }] },
      { role: 'tool', content: [{ type: 'tool-result', toolCallId: 'k1', toolName: 'lookup', output: { type: 'json', value: {} } }] },
      { role: 'user', content: 'thanks' },
      { role: 'assistant', content: 'any time' },
      { role: 'user', content: 'and now?' },
    ] as any;
    const layout = { v: 1, n: 5, status: 'exact', recall: [0, 1], recent: [1, 4], incoming: [4, 5] } as any;
    const p = proposeParts({ messages }, [], 8, { memory: true, layout, rows: { known: true, positions: [0, 1, 2, 3], rewritten: [], ambiguous: [], foreign: [] } });
    const owner = (i: number) => Object.entries(p.messages).find(([, at]) => at.includes(i))![0];
    expect(owner(0)).toBe(owner(1));
    expect(p.parts.find((x) => x.id === owner(0))!.source).toBe('unknown'); // two kinds in one part: not one label
    expect(owner(2)).toBe('recent 1');
  });
});
