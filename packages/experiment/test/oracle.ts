// What a correct agent does in each scenario of DEFAULT_SUITE, and a mock model that does it.
// Shared by the suite's own test and by @gnldev/optimizer's model comparison test.
import { createMockModel } from '../../durable/test/mock.js';
import { DEFAULT_SUITE } from '../src/index.js';

type Step = { call: [string, unknown] } | { text: string };
/** What a correct agent does in each scenario — the calls it makes and what it answers. */
export const ORACLE: Record<string, Step[]> = {
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
export function oracleModel(modelId: string, tokens = 100) {
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
