// A turn kept as a scenario is a copy: it plays again after its run is gone, against the agent as it is
// then, every call answered from the copy. It is kept under the person whose conversation it copies, so
// erasing them erases it; a turn that names no person is kept under the agent.
import { describe, it, expect } from 'vitest';
import { tool } from 'ai';
import { z } from 'zod';
import { runDurable, gnlTool, InMemoryJournal, purgeRun, purgeResource, personRecordPrefix } from '@gnldev/durable';
import { createMockModel } from '../../durable/test/mock.js';
import { scenarioOfRun, saveScenario, listScenarios, deleteScenario, updateScenario, runScenarios, scenarioKey } from '../src/index.js';

const usage = { inputTokens: 100, outputTokens: 10 };
const ANKARA = { calls: [{ toolName: 'createOrder', args: { address: 'Ankara' } }] };

/** Looks the address up, then orders to it — or, told by the system prompt, orders to Ankara straight away. */
function shop() {
  const m = createMockModel(async (o: any) => {
    const system = String(o.prompt.find((p: any) => p.role === 'system')?.content ?? '');
    const results = (o.prompt as any[]).filter((p) => p.role === 'tool');
    const response = { modelId: 'cheap' };
    const call = (toolName: string, args: unknown, id: string) => ({ content: [{ type: 'tool-call', toolCallId: id, toolName, input: JSON.stringify(args) }], finishReason: 'tool-calls', usage, response });
    if (system.includes('always Ankara') && results.length === 0) return call('createOrder', { address: 'Ankara' }, 'c1');
    if (results.length === 0) return call('lookup', {}, 'l1');
    if (results.length === 1) { const a = /"address":"(\w+)"/.exec(JSON.stringify(results[0])); return call('createOrder', { address: a ? a[1] : '?' }, 'c1'); }
    return { content: [{ type: 'text', text: 'Done.' }], finishReason: 'stop', usage, response };
  });
  m.modelId = 'cheap';
  return m;
}
const real = () => ({
  lookup: gnlTool(tool({ description: 'Look the address up', inputSchema: z.object({}), execute: async () => ({ address: 'Izmir' }) }), { sideEffect: false }),
  createOrder: gnlTool(tool({ description: 'Order', inputSchema: z.object({ address: z.string() }), execute: async () => ({ ok: true }) }), { sideEffect: true }),
});
const trap = () => Object.fromEntries(Object.entries(real()).map(([k, v]) => [k, { ...v, execute: async () => { throw new Error(`the lab ran ${k}`); } }])) as any;

async function recorded(resourceId?: string) {
  const journal = new InMemoryJournal();
  await runDurable({ runId: 'r1', journal, agentName: 'shop', ...(resourceId ? { resourceId } : {}), prompt: 'Ship my order.', system: 'You are a shop agent.', model: shop(), tools: real() } as any);
  return journal;
}

describe('a turn kept as a scenario outlives its run, not its person', () => {
  it("kept under its person; played after the run is gone, with the person's replacement, against the agent as it is now", async () => {
    const journal = await recorded('ayse');
    const s = await saveScenario(journal, await scenarioOfRun({
      journal, runId: 'r1', agent: 'shop', title: 'Ship to the right address', by: 'operator:deniz', expect: ANKARA,
      overrides: [{ toolName: 'lookup', args: {}, output: { address: 'Ankara' } }],
    }));
    expect(s.owner).toBe('ayse');
    expect(scenarioKey(s).startsWith(personRecordPrefix('ayse'))).toBe(true);
    expect(s.results).toEqual([{ toolName: 'lookup', args: {}, output: { address: 'Ankara' } }, { toolName: 'createOrder', args: { address: 'Izmir' }, output: { ok: true } }]);
    await purgeRun(journal as any, 'r1');
    expect(await listScenarios(journal, 'shop')).toHaveLength(1);
    // played against the agent: the corrected lookup leads to the right call, one the copy never held
    const ok = await runScenarios({ scenarios: [s], model: shop(), tools: trap(), trials: 3 });
    // createOrder(Ankara) is a call the copy never held: each play stops there — and, that being the one call
    // a right answer makes, is settled as a pass (judgePlay); the call is listed to answer
    expect(ok.scenarios[0]).toMatchObject({ passed: 3, failed: 0, undetermined: 0 });
    expect(ok.scenarios[0]!.pending).toEqual([{ toolName: 'createOrder', args: { address: 'Ankara' } }]);
  });

  it('a call the copy does not hold stops the play; answered, it is judged — and an agent changed since is what is played', async () => {
    const journal = await recorded('ayse');
    const s = await scenarioOfRun({ journal, runId: 'r1', agent: 'shop', title: 't', by: 'x', expect: ANKARA, answers: [{ toolName: 'createOrder', args: { address: 'Ankara' }, output: { ok: true } }] });
    // the recording's lookup says Izmir: the agent as recorded orders to Izmir — wrong
    const before = await runScenarios({ scenarios: [s], model: shop(), tools: trap(), trials: 2 });
    expect(before.scenarios[0]).toMatchObject({ passed: 0, failed: 2 });
    expect(before.scenarios[0]!.failures.join()).toMatch(/createOrder/);
    // the agent's prompt changed since: it orders to Ankara, answered by the person's answer — right
    const after = await runScenarios({ scenarios: [s], model: shop(), tools: trap(), trials: 2, system: 'You are a shop agent: always Ankara.' });
    expect(after.scenarios[0]).toMatchObject({ passed: 2, failed: 0, undetermined: 0 });
    expect(after.allPassed).toBe(1);
    expect(after.inputTokens).toBeGreaterThan(0);
  });

  it("erasing the person erases the scenarios copied from their conversations, and no one else's", async () => {
    const journal = await recorded('ayse');
    await saveScenario(journal, await scenarioOfRun({ journal, runId: 'r1', agent: 'shop', title: 'a', by: 'x', expect: ANKARA }));
    const other = await recorded('tom');
    const tom = await scenarioOfRun({ journal: other, runId: 'r1', agent: 'shop', title: 'b', by: 'x', expect: ANKARA });
    await saveScenario(journal, tom);
    await purgeResource(journal, 'ayse');
    expect((await listScenarios(journal, 'shop')).map((x) => x.owner)).toEqual(['tom']);
  });

  it('a turn that names no person is kept under the agent; a scenario can be removed', async () => {
    const journal = await recorded();
    const s = await saveScenario(journal, await scenarioOfRun({ journal, runId: 'r1', agent: 'shop', title: 'scheduled', by: 'x', expect: ANKARA }));
    expect(s.owner).toBeUndefined();
    expect(scenarioKey(s).startsWith('__lab__:scenario:shop:')).toBe(true);
    expect(await listScenarios(journal, 'shop')).toHaveLength(1);
    expect(await listScenarios(journal, 'billing')).toHaveLength(0);
    await deleteScenario(journal, s);
    expect(await listScenarios(journal, 'shop')).toHaveLength(0);
  });

  it("what a tool returns is changed in place: the scenario plays with it, and stays under its person", async () => {
    const journal = await recorded('ayse');
    const s = await saveScenario(journal, await scenarioOfRun({ journal, runId: 'r1', agent: 'shop', title: 'kept', by: 'x', expect: ANKARA }));
    // as recorded the lookup says Izmir: the order goes wrong
    expect((await runScenarios({ scenarios: [s], model: shop(), tools: trap(), trials: 1 })).scenarios[0]).toMatchObject({ failed: 1 });
    const edited = await updateScenario(journal, s, {
      title: 'Lookup corrected',
      results: s.results.map((r) => (r.toolName === 'lookup' ? { ...r, output: { address: 'Ankara' } } : r)),
      answers: [{ toolName: 'createOrder', args: { address: 'Ankara' }, output: { ok: true } }],
    });
    expect(scenarioKey(edited)).toBe(scenarioKey(s));
    expect((await listScenarios(journal, 'shop')).map((x) => x.title)).toEqual(['Lookup corrected']);
    expect((await runScenarios({ scenarios: [edited], model: shop(), tools: trap(), trials: 2 })).scenarios[0]).toMatchObject({ passed: 2, failed: 0 });
    await expect(updateScenario(journal, edited, { title: '' })).rejects.toThrow(/needs a title/);
    await purgeResource(journal, 'ayse');
    expect(await listScenarios(journal, 'shop')).toEqual([]);
  });

  it('a scenario needs a title and what a right answer does', async () => {
    const journal = await recorded();
    await expect(scenarioOfRun({ journal, runId: 'r1', agent: 'shop', title: ' ', by: 'x', expect: ANKARA })).rejects.toThrow(/needs a title/);
    await expect(scenarioOfRun({ journal, runId: 'r1', agent: 'shop', title: 't', by: 'x', expect: {} })).rejects.toThrow(/needs `expect`/);
  });
});
