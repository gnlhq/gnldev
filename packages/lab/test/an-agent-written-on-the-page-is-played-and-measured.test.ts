// The playground: an agent written on the page, talked to and measured with no run of its own. Every
// tool call is answered from what the person wrote — an answer for those arguments, else the tool's
// default — and a call nothing answers stops the play, named. Two definitions measured side by side say
// whether the change is more than chance.
import { describe, it, expect } from 'vitest';
import { createMockModel } from '../../durable/test/mock.js';
import { InMemoryJournal } from '@gnldev/durable';
import { playAgent, measureAgent, studioLab, listScenarios, type PlaygroundAgent } from '../src/index.js';

const usage = { inputTokens: 100, outputTokens: 10 };
/** Looks the order up when the prompt says so, then answers with what the lookup said; else asks. */
function model() {
  const m = createMockModel(async (o: any) => {
    const system = String(o.prompt.find((p: any) => p.role === 'system')?.content ?? '');
    const results = (o.prompt as any[]).filter((p) => p.role === 'tool');
    const asked = /order (\d+)/.exec(JSON.stringify((o.prompt as any[]).filter((p) => p.role === 'user').at(-1)))?.[1];
    if (system.includes('Look the order up') && results.length === 0) {
      return { content: [{ type: 'tool-call', toolCallId: 'l1', toolName: 'getOrder', input: JSON.stringify({ orderId: asked }) }], finishReason: 'tool-calls', usage };
    }
    const status = /"status":"(\w+)"/.exec(JSON.stringify(results.at(-1) ?? ''))?.[1];
    return { content: [{ type: 'text', text: status ? `Your order is ${status}.` : 'Which order do you mean?' }], finishReason: 'stop', usage };
  });
  m.modelId = 'cheap';
  return m;
}
const getOrder = (extra: Partial<PlaygroundAgent['tools'][number]> = {}) => ({
  name: 'getOrder', description: 'Look an order up', parameters: { type: 'object', properties: { orderId: { type: 'string' } } },
  answers: [{ args: { orderId: '42' }, output: { status: 'shipped' } }], ...extra,
});
const agent = (system: string, tool = getOrder()): PlaygroundAgent => ({ system, tools: [tool] });
const ask = (text: string) => [{ role: 'user' as const, content: text }];

describe('an agent written on the page is played and measured', () => {
  it("a call is answered from the page: by its arguments, else the tool's default; one nothing answers stops, named", async () => {
    const r = await playAgent({ agent: agent('Look the order up.'), model: model(), messages: ask('Where is order 42?') });
    expect(r.text).toBe('Your order is shipped.');
    expect(r.calls).toEqual([{ toolName: 'getOrder', args: { orderId: '42' }, source: 'answer', output: { status: 'shipped' } }]);
    expect(r.messages.map((m) => m.role)).toEqual(['assistant', 'tool', 'assistant']);
    const other = await playAgent({ agent: agent('Look the order up.', getOrder({ otherwise: { output: { status: 'unknown' } } })), model: model(), messages: ask('Where is order 7?') });
    expect(other.calls[0]).toMatchObject({ source: 'otherwise', args: { orderId: '7' } });
    expect(other.text).toBe('Your order is unknown.');
    const stuck = await playAgent({ agent: agent('Look the order up.'), model: model(), messages: ask('Where is order 7?') });
    expect(stuck).toMatchObject({ text: '', stopped: { toolName: 'getOrder', args: { orderId: '7' } }, messages: [] });
  });

  it('measured against what a right answer does, and side by side with another definition', async () => {
    const right = { calls: [{ toolName: 'getOrder', args: { orderId: '42' } }], answerIncludes: ['shipped'] };
    const r = await measureAgent({ agent: agent('Look the order up.'), compareTo: agent('Be brief.'), model: model(), messages: ask('Where is order 42?'), expect: right, trials: 6 });
    expect(r.measure).toMatchObject({ passed: 6, failed: 0, undetermined: 0 });
    expect(r.compared).toMatchObject({ passed: 0, failed: 6 });
    expect(r.compared!.paths[0]!.failures!.join()).toMatch(/getOrder/);
    expect(r.difference!.value).toBe(1);
    expect(r.difference!.low).toBeGreaterThan(0);
    expect(r.inputTokens).toBeGreaterThan(0);
  });

  it('a call nothing answers is listed, and the definition is checked before any model is asked', async () => {
    const r = await measureAgent({ agent: agent('Look the order up.'), model: model(), messages: ask('Where is order 7?'), expect: { answerIncludes: ['shipped'] }, trials: 2 });
    expect(r.measure.pending).toEqual([{ toolName: 'getOrder', args: { orderId: '7' } }]);
    expect(r.measure.undetermined).toBe(2);
    await expect(playAgent({ agent: agent('x', getOrder({ name: 'get order' })), model: model(), messages: ask('hi') })).rejects.toThrow(/letters, digits/);
    await expect(playAgent({ agent: agent('x', getOrder({ parameters: { type: 'string' } })), model: model(), messages: ask('hi') })).rejects.toThrow(/object JSON Schema/);
    await expect(playAgent({ agent: { system: 'x', tools: [getOrder(), getOrder()] }, model: model(), messages: ask('hi') })).rejects.toThrow(/defined twice/);
    await expect(playAgent({ agent: agent('x'), model: model(), messages: [{ role: 'assistant', content: 'hi' }] })).rejects.toThrow(/end with the user/);
    await expect(measureAgent({ agent: agent('x'), model: model(), messages: ask('hi'), expect: {} })).rejects.toThrow(/needs `expect`/);
  });

  it("its conversations are kept under its own name and played against its definition as it is now", async () => {
    const journal = new InMemoryJournal();
    const lab = studioLab({ config: { agents: {} }, models: { cheap: model() } });
    const right = { calls: [{ toolName: 'getOrder', args: { orderId: '42' } }], answerIncludes: ['shipped'] };
    const def = agent('Look the order up.');
    const kept = await lab.savePlaygroundScenario(journal as never, { agent: 'destek-v2', title: 'Order 42', definition: def, messages: ask('Where is order 42?'), expect: right }, 'operator:x');
    expect(kept).toMatchObject({ agent: 'destek-v2', from: { playground: true } });
    expect((await listScenarios(journal, 'destek-v2')).map((x) => x.title)).toEqual(['Order 42']);
    // as on the page now: right
    const now = await lab.runPlaygroundScenarios(journal as never, { agent: 'destek-v2', definition: def, model: 'cheap', trials: 2 });
    expect(now.scenarios[0]).toMatchObject({ passed: 2, failed: 0 });
    // the tool's answer changed on the page since: the kept conversation breaks, and says how
    const changed = agent('Look the order up.', getOrder({ answers: [{ args: { orderId: '42' }, output: { status: 'lost' } }] }));
    const after = await lab.runPlaygroundScenarios(journal as never, { agent: 'destek-v2', definition: changed, model: 'cheap', trials: 2 });
    expect(after.scenarios[0]).toMatchObject({ passed: 0, failed: 2 });
    expect(after.scenarios[0]!.failures.join()).toMatch(/shipped/);
    // a name is needed to keep one
    await expect(lab.savePlaygroundScenario(journal as never, { agent: '', title: 't', definition: def, messages: ask('x'), expect: right }, 'x')).rejects.toThrow(/needs a name/);
    await expect(lab.runPlaygroundScenarios(journal as never, { agent: 'nobody', definition: def, model: 'cheap' })).rejects.toThrow(/no kept scenario/);
  });
});
