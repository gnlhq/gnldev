// The default set checks what it claims: a correct agent passes every scenario (so the expectations
// agree with the fake store), and an agent that does not do the work fails them.
import { describe, it, expect } from 'vitest';
import { createMockModel } from '../../durable/test/mock.js';
import { DEFAULT_SUITE, runSuite, compareOnSuite, checkScenario } from '../src/index.js';

type Step = { call: [string, unknown] } | { text: string };
/** What a correct agent does in each scenario — the calls it makes and what it answers. */
const ORACLE: Record<string, Step[]> = {
  'refund-full': [{ call: ['getOrder', { orderId: '1042' }] }, { call: ['refund', { orderId: '1042', amount: 89.5 }] }, { text: 'Refunded 89.50.' }],
  'refund-partial': [{ call: ['refund', { orderId: '1042', amount: 18 }] }, { text: 'Refunded 18.' }],
  'refund-too-late': [{ call: ['getOrder', { orderId: '0077' }] }, { text: 'That order was delivered 45 days ago; refunds are only within 30 days.' }],
  'cancel-processing': [{ call: ['cancelOrder', { orderId: '2001' }] }, { text: 'Canceled.' }],
  'cancel-shipped': [{ call: ['getOrder', { orderId: '1043' }] }, { text: 'It has already shipped, so it cannot be canceled.' }],
  'change-address': [{ call: ['updateAddress', { orderId: '2001', address: '12 Harbor Road, Izmir' }] }, { text: 'Updated.' }],
  'order-status': [{ call: ['getOrder', { orderId: '1043' }] }, { text: 'It has shipped, tracking TRK-55902.' }],
  'tracking': [{ call: ['getOrder', { orderId: '1042' }] }, { text: 'TRK-55821' }],
  'in-stock': [{ call: ['checkStock', { sku: 'LAMP-3' }] }, { text: 'The desk lamp is out of stock.' }],
  'price-compare': [{ call: ['checkStock', { sku: 'MUG-01' }] }, { call: ['checkStock', { sku: 'BAG-2' }] }, { text: 'BAG-2 costs 42 more.' }],
  'balance': [{ call: ['findCustomer', { email: 'ayse@example.com' }] }, { text: 'She has 25 in credit.' }],
  'return-policy': [{ call: ['searchKb', { query: 'returns' }] }, { text: 'Within 30 days of delivery.' }],
  'customer-latest-order': [{ call: ['findCustomer', { email: 'tom@example.com' }] }, { call: ['listOrders', { customerId: 'c-9' }] }, { text: 'Order 2001 is processing.' }],
  'refund-latest-delivered': [{ call: ['findCustomer', { email: 'ayse@example.com' }] }, { call: ['listOrders', { customerId: 'c-7' }] }, { call: ['refund', { orderId: '1042', amount: 89.5 }] }, { text: 'Done.' }],
  'kb-then-answer': [{ call: ['searchKb', { query: 'shipping' }] }, { text: 'Within 5 business days of shipping.' }],
  'quote-in-eur': [{ call: ['checkStock', { sku: 'BAG-2' }] }, { call: ['convert', { amount: 60, from: 'USD', to: 'EUR' }] }, { text: 'About 54 EUR.' }],
  'book-first-slot': [{ call: ['freeSlots', { date: '2026-11-03' }] }, { call: ['bookMeeting', { date: '2026-11-03', time: '10:00' }] }, { text: 'Booked 10:00.' }],
  'escalate-out-of-stock': [{ call: ['checkStock', { sku: 'LAMP-3' }] }, { call: ['escalate', { note: 'LAMP-3 out of stock' }] }, { text: 'A colleague will help.' }],
  'greeting': [{ text: 'Thank you!' }],
  'summarize': [{ text: 'The meeting moved to Thursday; the agenda is unchanged.' }],
  'translate': [{ text: 'Siparişiniz kargoya verildi.' }],
  'arithmetic': [{ text: '391' }],
  'leading-zeros': [{ call: ['getOrder', { orderId: '0077' }] }, { text: 'Found it.' }],
  'date-format': [{ call: ['freeSlots', { date: '2026-11-03' }] }, { text: '10:00 and 14:30.' }],
  'multi-item-order': [{ call: ['placeOrder', { items: [{ sku: 'MUG-01', qty: 3 }, { sku: 'PEN-10', qty: 2 }] }] }, { text: 'Placed.' }],
  'currency-args': [{ call: ['convert', { amount: 250, from: 'USD', to: 'EUR' }] }, { text: '225 EUR.' }],
};

/** A model that plays the oracle for whichever scenario it is in (told apart by the prompt). */
function oracleModel(modelId: string, tokens = 100) {
  const progress = new Map<string, number>();
  const m = createMockModel(async (o: any) => {
    const user = JSON.stringify(o.prompt.find((x: any) => x.role === 'user'));
    const s = DEFAULT_SUITE.find((x) => user.includes(JSON.stringify(x.prompt).slice(1, 30)))!;
    const done = o.prompt.filter((x: any) => x.role === 'tool').length;
    const plan = ORACLE[s.id]!;
    const step = plan[Math.min(done, plan.length - 1)]!;
    progress.set(s.id, done);
    const usage = { inputTokens: tokens, outputTokens: 10 };
    const response = { modelId };
    if ('text' in step) return { content: [{ type: 'text', text: step.text }], finishReason: 'stop', usage, response };
    return { content: [{ type: 'tool-call', toolCallId: `${s.id}-${done}`, toolName: step.call[0], input: JSON.stringify(step.call[1]) }], finishReason: 'tool-calls', usage, response };
  });
  m.modelId = modelId;
  return m;
}

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

  it('compareOnSuite: the cost ratio of two models and the scenarios one does worse on', async () => {
    const pricing = { big: { inputPer1M: 10, outputPer1M: 40 }, small: { inputPer1M: 1, outputPer1M: 4 } };
    const c = await compareOnSuite({ baseline: oracleModel('big'), candidate: oracleModel('small'), pricing });
    expect(c.costRatio).toBeCloseTo(0.1, 9);
    expect(c.compared).toHaveLength(26);
    expect(c.regressions).toEqual([]);
    expect(c.baseline.results.every((r) => r.priced)).toBe(true);
  });

  it('a model that cannot be asked is an error, not a failure: left out of the pass rate and of the comparison', async () => {
    const down = createMockModel(async () => { throw new Error('Not Found'); });
    down.modelId = 'down';
    const r = await runSuite({ model: down, scenarios: DEFAULT_SUITE.slice(0, 3) });
    expect(r.errored).toBe(3);
    expect(Number.isNaN(r.passRate)).toBe(true);
    expect(r.results.every((x) => !x.pass && x.failures.length === 0 && /Not Found/.test(x.error ?? ''))).toBe(true);
    const c = await compareOnSuite({ baseline: down, candidate: oracleModel('small'), scenarios: DEFAULT_SUITE.slice(0, 3) });
    expect(c.compared).toEqual([]);
    expect(c.improvements).toEqual([]);
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
