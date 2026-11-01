// The default set checks what it claims: a correct agent passes every scenario (so the expectations
// agree with the fake store), and an agent that does not do the work fails them.
import { describe, it, expect } from 'vitest';
import { createMockModel } from '../../durable/test/mock.js';
import { DEFAULT_SUITE, runSuite, checkScenario } from '../src/index.js';
import { ORACLE, oracleModel } from './oracle.js';


describe('the default set is satisfiable and strict', () => {
  it('26 scenarios, unique ids, every expected or forbidden tool is one the scenario has', () => {
    expect(DEFAULT_SUITE).toHaveLength(26);
    expect(new Set(DEFAULT_SUITE.map((s) => s.id)).size).toBe(26);
    for (const s of DEFAULT_SUITE) {
      for (const c of s.expect.calls ?? []) expect({ id: s.id, has: c.toolName in s.tools }).toEqual({ id: s.id, has: true });
      for (const f of s.expect.forbidden ?? []) expect({ id: s.id, has: f in s.tools }).toEqual({ id: s.id, has: true });
      expect(Object.keys(ORACLE)).toContain(s.id);
    }
  });

  it('a correct agent passes every scenario: the expectations agree with the fake store', async () => {
    const r = await runSuite({ model: oracleModel('ref') });
    expect(r.results.filter((x) => !x.pass).map((x) => `${x.id}: ${x.failures.join('; ')}`)).toEqual([]);
    expect(r.passRate).toBe(1);
  });

  it('an agent that only chats fails every scenario that needs work', async () => {
    const lazy = createMockModel(async () => ({ content: [{ type: 'text', text: 'Sure, happy to help!' }], finishReason: 'stop', usage: { inputTokens: 10, outputTokens: 5 } }));
    const r = await runSuite({ model: lazy });
    const passed = r.results.filter((x) => x.pass).map((x) => x.id);
    expect(passed).toEqual(['greeting']);
  });

  it('wrong arguments fail: a refund of the wrong amount, a date in the wrong format', () => {
    const refund = DEFAULT_SUITE.find((s) => s.id === 'refund-full')!;
    expect(checkScenario(refund, [{ toolName: 'refund', args: { orderId: '1042', amount: 90 } }], 'ok')).toEqual([expect.stringMatching(/missing call refund/)]);
    const date = DEFAULT_SUITE.find((s) => s.id === 'date-format')!;
    expect(checkScenario(date, [{ toolName: 'freeSlots', args: { date: '11/03/2026' } }], '10:00')).toHaveLength(1);
  });

  it('a model that cannot be asked is an error, not a failure: left out of the pass rate', async () => {
    const down = createMockModel(async () => { throw new Error('Not Found'); });
    down.modelId = 'down';
    const r = await runSuite({ model: down, scenarios: DEFAULT_SUITE.slice(0, 3) });
    expect(r.errored).toBe(3);
    expect(Number.isNaN(r.passRate)).toBe(true);
    expect(r.results.every((x) => !x.pass && x.failures.length === 0 && /Not Found/.test(x.error ?? ''))).toBe(true);
  });

  it('a model that never answers is stopped at timeoutMs and reported as an error, not held forever', async () => {
    const hung = createMockModel((o: any) => new Promise((_, reject) => { o.abortSignal?.addEventListener('abort', () => reject(o.abortSignal.reason)); }));
    hung.modelId = 'hung';
    const t0 = Date.now();
    const r = await runSuite({ model: hung, scenarios: DEFAULT_SUITE.slice(0, 2), timeoutMs: 200 });
    expect(Date.now() - t0).toBeLessThan(5000);
    expect(r.errored).toBe(2);
    expect(r.results.every((x) => /no answer within 200 ms/.test(x.error ?? ''))).toBe(true);
  });

  it('a gateway that gives up before our deadline is reported in its own words, not as our timeout', async () => {
    const gateway = createMockModel(async () => { throw new Error('upstream request timeout (504)'); });
    gateway.modelId = 'gw';
    const r = await runSuite({ model: gateway, scenarios: DEFAULT_SUITE.slice(0, 1), timeoutMs: 60_000 });
    expect(r.results[0]!.error).toMatch(/^model call failed: .*upstream request timeout/);
  });

  it('real answers that say the right thing pass: a non-breaking hyphen, markdown bold, "30-day" for "30 days"', () => {
    // Verbatim from a measured run (raporlar/2026-10-24-optimizer-arastirma/olcum/suite-ultra-vs-lightning.json):
    // both models wrote the tracking number with U+2011, and the smaller one wrote **30 days** and "30\u2011day".
    const S = (id: string) => DEFAULT_SUITE.find((s) => s.id === id)!;
    expect(checkScenario(S('order-status'), [{ toolName: 'getOrder', args: { orderId: '1043' } }], 'Order **1043** is **shipped**. Tracking number: TRK\u201155902')).toEqual([]);
    expect(checkScenario(S('return-policy'), [], 'You have **30 days** from the delivery date to return an item.')).toEqual([]);
    expect(checkScenario(S('refund-too-late'), [{ toolName: 'getOrder', args: { orderId: '0077' } }], 'It was delivered 45 days ago, outside our 30\u2011day refund window.')).toEqual([]);
    // …and a wrong answer still fails.
    expect(checkScenario(S('order-status'), [{ toolName: 'getOrder', args: { orderId: '1043' } }], 'It has shipped, tracking TRK-55901')).toHaveLength(1);
  });

  it('a misspelled option is refused', async () => {
    await expect(runSuite({ model: oracleModel('x'), maxstep: 2 } as any)).rejects.toThrow(/maxstep/);
  });
});
