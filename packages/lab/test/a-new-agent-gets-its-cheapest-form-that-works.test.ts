// Before an agent has runs of its own: every form of it (subset of components) on a scenario set, the
// cheapest form that passes as well as the best, and each component's share.
import { describe, it, expect } from 'vitest';
import { createMockModel } from '../../durable/test/mock.js';
import type { Scenario } from '@gnldev/experiment';
import { bestForm, promptSection, withoutTool, studioLab } from '../src/index.js';

const scenarios: Scenario[] = ['1042', '1043'].map((id) => ({
  id: `refund-${id}`, category: 'support', system: '', prompt: `Refund order ${id}.`,
  tools: {
    getOrder: { description: 'Get an order', parameters: { type: 'object', properties: { orderId: { type: 'string' } } }, run: () => ({ total: 10 }) },
    refund: { description: 'Refund', parameters: { type: 'object', properties: { orderId: { type: 'string' } } }, run: () => ({ ok: true }) },
  },
  expect: { calls: [{ toolName: 'getOrder', args: { orderId: id } }, { toolName: 'refund', args: { orderId: id } }] },
}));

/** Looks the order up only when told to; a longer system prompt costs more input tokens. */
const model = createMockModel(async (o: any) => {
  const system = String(o.prompt.find((p: any) => p.role === 'system')?.content ?? '');
  const id = /order (\d+)/.exec(JSON.stringify(o.prompt))![1];
  const done = o.prompt.filter((p: any) => p.role === 'tool').length;
  const usage = { inputTokens: 100 + system.length, outputTokens: 10 };
  const response = { modelId: 'm' };
  const plan = system.includes('Look the order up') ? ['getOrder', 'refund'] : ['refund'];
  if (done < plan.length) return { content: [{ type: 'tool-call', toolCallId: `c${done}`, toolName: plan[done], input: JSON.stringify({ orderId: id }) }], finishReason: 'tool-calls', usage, response };
  return { content: [{ type: 'text', text: 'Done.' }], finishReason: 'stop', usage, response };
});
model.modelId = 'm';

describe('a new agent gets its cheapest form that works', () => {
  it('the rule is needed, the tone is not: the best form is the rule alone, and the shares say why', async () => {
    const r = await bestForm({
      model, scenarios, trials: 1,
      pricing: { m: { inputPer1M: 1, outputPer1M: 1 } },
      components: { rule: promptSection('Look the order up before you refund it.'), tone: promptSection('Be warm, polite and brief in every answer.') },
    });
    expect(r.forms).toHaveLength(4);
    expect(r.target).toBe(1);
    expect(r.best!.components).toEqual(['rule']);
    expect(r.best!.passRate.value).toBe(1);
    expect(r.forms.find((f) => f.components.join() === 'rule,tone')!.costUsd).toBeGreaterThan(r.best!.costUsd);
    expect(r.shares.rule).toBe(1);
    expect(r.shares.tone).toBe(0);
  });

  it('taking a tool away is a component too; a target no form reaches is an error', async () => {
    const r = await bestForm({ model, scenarios, trials: 1, components: { rule: promptSection('Look the order up before you refund it.'), noLookup: withoutTool('getOrder') } });
    expect(r.shares.noLookup).toBeLessThan(0);
    // unpriced: every form costs 0, so the cheapest is the one with the fewest tokens — the shorter prompt
    const u = await bestForm({ model, scenarios, trials: 1, components: { rule: promptSection('Look the order up before you refund it.'), tone: promptSection('Be warm, polite and brief in every answer.') } });
    expect(u.best!.priced).toBe(false);
    expect(u.best!.components).toEqual(['rule']);
    expect(u.forms.find((f) => f.components.join() === 'rule,tone')!.tokens).toBeGreaterThan(u.best!.tokens);
    await expect(bestForm({ model, scenarios, trials: 1, target: 1, components: { tone: promptSection('Be brief.') } })).rejects.toThrow(/no form reached the target pass rate 1/);
  });

  it("in Studio: the tools the scenarios offer can be taken away, and a tool written on the page offered", async () => {
    const lab = studioLab({ config: { agents: { support: { system: 'Look the order up before you refund it.\n\nBe brief.' } } }, models: { m: model }, scenarios: { support: scenarios } });
    const plan = lab.formPlan({ agent: 'support', trials: 1, withoutTools: ['getOrder'], addTools: [{ name: 'escalate', description: 'Hand to a person', parameters: { type: 'object' }, output: { ok: true } }] });
    expect(plan.tools).toEqual(['getOrder', 'refund']);
    expect(plan.components.map((c) => c.id)).toEqual(['section 1', 'section 2', 'without getOrder', 'with escalate']);
    expect(plan.forms).toBe(16);
    const r = await lab.bestForm({ agent: 'support', model: 'm', trials: 1, withoutTools: ['getOrder'] });
    // without getOrder no form can make the lookup a right answer needs
    expect(r.best!.components).toEqual(['section 1']);
    expect(r.shares['without getOrder']).toBeLessThan(0);
    expect(r.componentsDetail.map((c) => c.id)).toContain('without getOrder');
    expect(() => lab.formPlan({ agent: 'support', withoutTools: ['nope'] })).toThrow(/no tool 'nope'/);
    expect(() => lab.formPlan({ agent: 'support', addTools: [{ name: 'refund', description: '', parameters: { type: 'object' }, output: 1 }] })).toThrow(/offered already/);
    expect(() => lab.formPlan({ agent: 'support', addTools: [{ name: 'x', description: '', parameters: { type: 'string' } as never, output: 1 }] })).toThrow(/object JSON Schema/);
  });

  it('when no form passes a single scenario run, none is named best — the forms are still all there', async () => {
    const never = scenarios.map((s) => ({ ...s, expect: { calls: [{ toolName: 'getOrder', args: { orderId: 'nobody' } }] } }));
    const r = await bestForm({ model, scenarios: never, trials: 1, components: { rule: promptSection('Look the order up before you refund it.'), tone: promptSection('Be brief.') } });
    expect(r.forms).toHaveLength(4);
    expect(r.forms.every((f) => f.passRate.value === 0)).toBe(true);
    expect(r.best).toBeUndefined();
    expect(r.target).toBe(0);
  });

  it('a provider that refuses is waited for, one run at a time; one that breaks stops the search', async () => {
    let refusals = 2;
    const flaky = createMockModel(async (o: any) => {
      if (refusals-- > 0) throw new Error('Too Many Requests');
      return (model as any).doGenerate(o);
    });
    flaky.modelId = 'm';
    const seen: any[] = [];
    const r = await bestForm({ model: flaky, scenarios, trials: 1, concurrency: 2, throttle: { waitMs: 1 }, onProgress: (p) => seen.push(p), components: { rule: promptSection('Look the order up before you refund it.') } });
    expect(r.best!.components).toEqual(['rule']);
    expect(r.forms.every((f) => f.errored === 0)).toBe(true); // a refused run is run again, not counted
    expect(seen.filter((p) => p.throttled).length).toBeGreaterThan(0);
    expect(seen.at(-1)).toMatchObject({ done: 2, total: 2, concurrency: 1 });
    const broken = createMockModel(async () => { throw new Error('Internal Server Error'); });
    await expect(bestForm({ model: broken, scenarios, trials: 1, components: { rule: promptSection('x') } })).rejects.toThrow(/stopped after 0 of 2 — the provider answered a server error/);
  });
});
