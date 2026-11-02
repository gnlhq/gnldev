// The default conversation set: work a tool-using agent does, with answers that can be checked exactly.
//
// Written for this package (no third-party data, no license to carry). Each scenario has its own tools
// over one small fake store, and an expectation a program can check: which calls must be made (with
// which arguments), which must never be made, and what the answer must say. No judge model decides
// whether a cheaper model "did as well" — the calls it made and the facts it stated do.
//
// Use it before an agent has traffic of its own, or as the check a change must pass besides replay.
import { generateText, jsonSchema, stepCountIs, tool, wrapLanguageModel, type LanguageModel, type ToolSet } from 'ai';
import { effectivePricingTable, usageAndCostFromModelValue, type ModelPricing } from '@gnldev/durable';
import { refuseUnknownNames } from '@gnldev/options';
import { SUITE_NAMES } from './option-names.js';

export type ScenarioCategory = 'support' | 'lookup' | 'multi-step' | 'no-tool' | 'arguments';

export interface ScenarioTool {
  description: string;
  /** JSON Schema of the arguments. */
  parameters: Record<string, unknown>;
  /** A deterministic answer from the fake store. */
  run: (args: any) => unknown;
}

/** What a right answer does: a program checks it (checkExpectation), no judge model reads it. */
export interface Expectation {
  /** Every one must be made; `args` must match the call's arguments on the keys it names. */
  calls?: Array<{ toolName: string; args?: Record<string, unknown> }>;
  /** None of these may be called. */
  forbidden?: string[];
  /**
   * The answer must contain each — a string, or a list of spellings any one of which will do. Compared
   * after normalizing both sides (see `normalizeAnswer`).
   */
  answerIncludes?: Array<string | string[]>;
}

export interface Scenario {
  id: string;
  category: ScenarioCategory;
  system: string;
  prompt: string;
  tools: Record<string, ScenarioTool>;
  expect: Expectation;
}

// ── The fake store every scenario reads ─────────────────────────────────────────────────────────────
const ORDERS: Record<string, { customer: string; total: number; status: string; daysAgo: number; tracking?: string; items: Array<{ sku: string; qty: number }> }> = {
  '1042': { customer: 'c-7', total: 89.5, status: 'delivered', daysAgo: 12, tracking: 'TRK-55821', items: [{ sku: 'MUG-01', qty: 2 }] },
  '1043': { customer: 'c-7', total: 240, status: 'shipped', daysAgo: 3, tracking: 'TRK-55902', items: [{ sku: 'LAMP-3', qty: 1 }] },
  '0077': { customer: 'c-9', total: 15, status: 'delivered', daysAgo: 45, tracking: 'TRK-41120', items: [{ sku: 'PEN-10', qty: 5 }] },
  '2001': { customer: 'c-9', total: 60, status: 'processing', daysAgo: 1, items: [{ sku: 'BAG-2', qty: 1 }] },
};
const CUSTOMERS: Record<string, { id: string; name: string; balance: number }> = {
  'ayse@example.com': { id: 'c-7', name: 'Ayşe', balance: 25 },
  'tom@example.com': { id: 'c-9', name: 'Tom', balance: 0 },
};
const STOCK: Record<string, { name: string; price: number; stock: number }> = {
  'MUG-01': { name: 'Stoneware mug', price: 18, stock: 40 },
  'LAMP-3': { name: 'Desk lamp', price: 240, stock: 0 },
  'PEN-10': { name: 'Gel pen', price: 3, stock: 500 },
  'BAG-2': { name: 'Canvas bag', price: 60, stock: 12 },
};
const KB: Record<string, string> = {
  returns: 'Items can be returned within 30 days of delivery for a full refund.',
  shipping: 'Standard shipping takes 3 to 5 business days.',
};

const obj = (props: Record<string, unknown>, required = Object.keys(props)) => ({ type: 'object', properties: props, required, additionalProperties: false });
const str = { type: 'string' };
const num = { type: 'number' };

const T = {
  getOrder: { description: 'Get an order by its id', parameters: obj({ orderId: str }), run: ({ orderId }: any) => ORDERS[orderId] ? { orderId, ...ORDERS[orderId] } : { error: 'no such order' } },
  refund: { description: 'Refund an order, in full or a given amount', parameters: obj({ orderId: str, amount: num }), run: ({ orderId, amount }: any) => ({ refunded: orderId, amount }) },
  cancelOrder: { description: 'Cancel an order that has not shipped', parameters: obj({ orderId: str }), run: ({ orderId }: any) => (ORDERS[orderId]?.status === 'processing' ? { canceled: orderId } : { error: 'already shipped' }) },
  updateAddress: { description: "Change an order's delivery address", parameters: obj({ orderId: str, address: str }), run: ({ orderId }: any) => ({ updated: orderId }) },
  findCustomer: { description: 'Find a customer by email', parameters: obj({ email: str }), run: ({ email }: any) => CUSTOMERS[email] ?? { error: 'no such customer' } },
  listOrders: { description: "List a customer's orders, newest first", parameters: obj({ customerId: str }), run: ({ customerId }: any) => Object.entries(ORDERS).filter(([, o]) => o.customer === customerId).sort((a, b) => a[1].daysAgo - b[1].daysAgo).map(([id, o]) => ({ orderId: id, total: o.total, status: o.status })) },
  // Prices carry their currency: without it a careful model rightly asked which currency 60 was in
  // (measured), and the quote-in-eur expectation had assumed USD without saying so.
  checkStock: { description: 'Stock and price of a product by SKU', parameters: obj({ sku: str }), run: ({ sku }: any) => (STOCK[sku] ? { ...STOCK[sku], currency: 'USD' } : { error: 'no such product' }) },
  searchKb: { description: 'Search the help center', parameters: obj({ query: str }), run: ({ query }: any) => Object.entries(KB).filter(([k]) => String(query).toLowerCase().includes(k.slice(0, 5))).map(([, v]) => v) },
  convert: { description: 'Convert an amount between currencies', parameters: obj({ amount: num, from: str, to: str }), run: ({ amount, from, to }: any) => ({ amount: from === 'USD' && to === 'EUR' ? Math.round(amount * 0.9 * 100) / 100 : amount, currency: to }) },
  freeSlots: { description: 'Free meeting slots on a date (YYYY-MM-DD)', parameters: obj({ date: str }), run: ({ date }: any) => (date === '2026-11-03' ? ['10:00', '14:30'] : []) },
  bookMeeting: { description: 'Book a meeting at a date and time', parameters: obj({ date: str, time: str }), run: ({ date, time }: any) => ({ booked: `${date} ${time}` }) },
  placeOrder: { description: 'Place an order for items', parameters: obj({ items: { type: 'array', items: obj({ sku: str, qty: num }) } }), run: () => ({ orderId: '3001' }) },
  escalate: { description: 'Hand a case to a human with a short note', parameters: obj({ note: str }), run: () => ({ ticket: 'H-12' }) },
} satisfies Record<string, ScenarioTool>;

const SUPPORT = 'You are a store support agent. Use the tools; never guess an order or an amount. Refunds only within 30 days of delivery.';
const pick = (...names: Array<keyof typeof T>) => Object.fromEntries(names.map((n) => [n, T[n]])) as Record<string, ScenarioTool>;

/** The default set: 26 scenarios across support, lookups, multi-step work, plain conversation and tricky arguments. */
export const DEFAULT_SUITE: readonly Scenario[] = [
  // support
  { id: 'refund-full', category: 'support', system: SUPPORT, prompt: 'Please refund order 1042 in full.', tools: pick('getOrder', 'refund'), expect: { calls: [{ toolName: 'refund', args: { orderId: '1042', amount: 89.5 } }] } },
  { id: 'refund-partial', category: 'support', system: SUPPORT, prompt: 'One of the two mugs in order 1042 was broken. Refund just that mug (they are 18 each).', tools: pick('getOrder', 'refund'), expect: { calls: [{ toolName: 'refund', args: { orderId: '1042', amount: 18 } }] } },
  { id: 'refund-too-late', category: 'support', system: SUPPORT, prompt: 'Refund order 0077 please.', tools: pick('getOrder', 'refund'), expect: { calls: [{ toolName: 'getOrder', args: { orderId: '0077' } }], forbidden: ['refund'], answerIncludes: [['30 days', '30-day']] } },
  { id: 'cancel-processing', category: 'support', system: SUPPORT, prompt: 'Cancel order 2001.', tools: pick('getOrder', 'cancelOrder'), expect: { calls: [{ toolName: 'cancelOrder', args: { orderId: '2001' } }] } },
  { id: 'cancel-shipped', category: 'support', system: SUPPORT, prompt: 'Cancel order 1043.', tools: pick('getOrder', 'cancelOrder', 'refund'), expect: { forbidden: ['refund'], answerIncludes: ['shipped'] } },
  { id: 'change-address', category: 'support', system: SUPPORT, prompt: 'Send order 2001 to 12 Harbor Road, Izmir instead.', tools: pick('getOrder', 'updateAddress'), expect: { calls: [{ toolName: 'updateAddress', args: { orderId: '2001', address: '12 Harbor Road, Izmir' } }] } },
  // lookup
  { id: 'order-status', category: 'lookup', system: SUPPORT, prompt: 'Where is order 1043?', tools: pick('getOrder'), expect: { calls: [{ toolName: 'getOrder', args: { orderId: '1043' } }], answerIncludes: ['shipped', 'TRK-55902'] } },
  { id: 'tracking', category: 'lookup', system: SUPPORT, prompt: "What's the tracking number for order 1042?", tools: pick('getOrder'), expect: { calls: [{ toolName: 'getOrder', args: { orderId: '1042' } }], answerIncludes: ['TRK-55821'] } },
  { id: 'in-stock', category: 'lookup', system: SUPPORT, prompt: 'Is the desk lamp LAMP-3 in stock?', tools: pick('checkStock'), expect: { calls: [{ toolName: 'checkStock', args: { sku: 'LAMP-3' } }], answerIncludes: ['out of stock'] } },
  { id: 'price-compare', category: 'lookup', system: SUPPORT, prompt: 'Which costs more, MUG-01 or BAG-2, and by how much?', tools: pick('checkStock'), expect: { calls: [{ toolName: 'checkStock', args: { sku: 'MUG-01' } }, { toolName: 'checkStock', args: { sku: 'BAG-2' } }], answerIncludes: ['42'] } },
  { id: 'balance', category: 'lookup', system: SUPPORT, prompt: 'How much store credit does ayse@example.com have?', tools: pick('findCustomer'), expect: { calls: [{ toolName: 'findCustomer', args: { email: 'ayse@example.com' } }], answerIncludes: ['25'] } },
  { id: 'return-policy', category: 'lookup', system: SUPPORT, prompt: 'How long do I have to return something?', tools: pick('searchKb', 'refund'), expect: { forbidden: ['refund'], answerIncludes: [['30 days', '30-day']] } },
  // multi-step
  { id: 'customer-latest-order', category: 'multi-step', system: SUPPORT, prompt: "What's the status of tom@example.com's most recent order?", tools: pick('findCustomer', 'listOrders', 'getOrder'), expect: { calls: [{ toolName: 'findCustomer', args: { email: 'tom@example.com' } }, { toolName: 'listOrders', args: { customerId: 'c-9' } }], answerIncludes: ['processing'] } },
  { id: 'refund-latest-delivered', category: 'multi-step', system: SUPPORT, prompt: 'ayse@example.com wants a full refund for her delivered order.', tools: pick('findCustomer', 'listOrders', 'getOrder', 'refund'), expect: { calls: [{ toolName: 'findCustomer' }, { toolName: 'listOrders', args: { customerId: 'c-7' } }, { toolName: 'refund', args: { orderId: '1042', amount: 89.5 } }] } },
  { id: 'kb-then-answer', category: 'multi-step', system: SUPPORT, prompt: 'Order 1043 shipped 3 days ago. Based on our shipping times, when should it arrive?', tools: pick('getOrder', 'searchKb'), expect: { calls: [{ toolName: 'searchKb' }], answerIncludes: ['5'] } },
  { id: 'quote-in-eur', category: 'multi-step', system: SUPPORT, prompt: 'How much is BAG-2 in EUR?', tools: pick('checkStock', 'convert'), expect: { calls: [{ toolName: 'checkStock', args: { sku: 'BAG-2' } }, { toolName: 'convert', args: { amount: 60, from: 'USD', to: 'EUR' } }], answerIncludes: ['54'] } },
  { id: 'book-first-slot', category: 'multi-step', system: 'You schedule meetings. Check free slots before booking; book the earliest.', prompt: 'Book me a meeting on 2026-11-03.', tools: pick('freeSlots', 'bookMeeting'), expect: { calls: [{ toolName: 'freeSlots', args: { date: '2026-11-03' } }, { toolName: 'bookMeeting', args: { date: '2026-11-03', time: '10:00' } }] } },
  { id: 'escalate-out-of-stock', category: 'multi-step', system: `${SUPPORT} If a product a customer wants is out of stock, escalate to a human.`, prompt: 'I want to buy LAMP-3 today.', tools: pick('checkStock', 'placeOrder', 'escalate'), expect: { calls: [{ toolName: 'checkStock', args: { sku: 'LAMP-3' } }, { toolName: 'escalate' }], forbidden: ['placeOrder'] } },
  // no tool
  { id: 'greeting', category: 'no-tool', system: SUPPORT, prompt: 'Hi! Just saying thanks for the fast delivery.', tools: pick('getOrder', 'refund'), expect: { forbidden: ['getOrder', 'refund'] } },
  { id: 'summarize', category: 'no-tool', system: 'You summarize text in one sentence.', prompt: 'Summarize: The meeting moved from Tuesday to Thursday because the client is travelling; the agenda is unchanged.', tools: {}, expect: { answerIncludes: ['Thursday'] } },
  { id: 'translate', category: 'no-tool', system: 'You translate English to Turkish.', prompt: 'Translate: "Your order has shipped."', tools: {}, expect: { answerIncludes: ['sipariş'] } },
  { id: 'arithmetic', category: 'no-tool', system: 'Answer with the number only.', prompt: 'What is 17 times 23?', tools: {}, expect: { answerIncludes: ['391'] } },
  // arguments
  { id: 'leading-zeros', category: 'arguments', system: SUPPORT, prompt: 'Look up order 0077.', tools: pick('getOrder'), expect: { calls: [{ toolName: 'getOrder', args: { orderId: '0077' } }] } },
  { id: 'date-format', category: 'arguments', system: 'You schedule meetings. Dates are YYYY-MM-DD.', prompt: 'Which slots are free on November 3rd, 2026?', tools: pick('freeSlots'), expect: { calls: [{ toolName: 'freeSlots', args: { date: '2026-11-03' } }], answerIncludes: ['10:00'] } },
  { id: 'multi-item-order', category: 'arguments', system: 'You place orders exactly as asked.', prompt: 'Order 3 MUG-01 and 2 PEN-10.', tools: pick('placeOrder'), expect: { calls: [{ toolName: 'placeOrder', args: { items: [{ sku: 'MUG-01', qty: 3 }, { sku: 'PEN-10', qty: 2 }] } }] } },
  { id: 'currency-args', category: 'arguments', system: 'You convert currencies with the tool.', prompt: 'Convert 250 dollars to euros.', tools: pick('convert'), expect: { calls: [{ toolName: 'convert', args: { amount: 250, from: 'USD', to: 'EUR' } }] } },
];

export interface ScenarioResult {
  id: string;
  category: ScenarioCategory;
  pass: boolean;
  /** Why it failed, one line each. Empty when it passed or when it could not run (`error`). */
  failures: string[];
  /**
   * The model could not be asked (not found, rate-limited, a network error): this scenario says nothing
   * about the model's quality, so it is left out of `passRate` and of a comparison.
   */
  error?: string;
  calls: Array<{ toolName: string; args: unknown }>;
  text: string;
  costUsd: number;
  priced: boolean;
  inputTokens: number;
  outputTokens: number;
  steps: number;
}

export interface SuiteResult {
  modelId: string;
  results: ScenarioResult[];
  /** Passed over the scenarios that ran (an `error` is not a failure of the model). NaN when none ran. */
  passRate: number;
  /** Scenarios that could not run. */
  errored: number;
  costUsd: number;
}

export interface RunSuiteOptions {
  model: LanguageModel;
  /** The scenarios (DEFAULT_SUITE when omitted). */
  scenarios?: readonly Scenario[];
  /** Prices (DEFAULT_PRICING when omitted). */
  pricing?: Record<string, ModelPricing>;
  /** Most model steps per scenario (default 8). */
  maxSteps?: number;
  /** Scenarios run at once (default 4). */
  concurrency?: number;
  /**
   * Longest a scenario may take, in ms (default 120000). A provider that never answers would otherwise
   * hold the run forever — measured: a NIM request that never returned held a run for three hours. A
   * scenario past it is an `error`, not a quality failure.
   */
  timeoutMs?: number;
}

const matches = (want: unknown, got: unknown): boolean => {
  if (want === null || typeof want !== 'object') return typeof want === 'string' && typeof got === 'string' ? want.trim().toLowerCase() === got.trim().toLowerCase() : want === got || Number(want) === Number(got);
  if (Array.isArray(want)) return Array.isArray(got) && want.length === got.length && want.every((w, i) => matches(w, got[i]));
  return got !== null && typeof got === 'object' && Object.entries(want as object).every(([k, v]) => matches(v, (got as any)[k]));
};

/**
 * An answer as the checks read it: lower case, every dash or hyphen (U+2010–U+2015, U+2212) as '-',
 * markdown emphasis and code marks removed, whitespace (non-breaking included) collapsed. Measured: two
 * models wrote a tracking number with U+2011 and one wrote **30 days** — right answers that a raw
 * substring check failed, and that made the smaller model look worse than it was.
 */
export function normalizeAnswer(text: string): string {
  return text
    .toLowerCase()
    .replace(/[\u2010-\u2015\u2212]/g, '-')
    .replace(/[*_`]/g, '')
    .replace(/[\s\u00a0\u202f]+/g, ' ')
    .trim();
}

/** Checks calls and an answer against an expectation; each failure in words, none when it holds. */
export function checkExpectation(expect: Expectation, calls: ReadonlyArray<{ toolName: string; args: unknown }>, text: string): string[] {
  const failures: string[] = [];
  for (const w of expect.calls ?? []) {
    if (!calls.some((c) => c.toolName === w.toolName && (w.args === undefined || matches(w.args, c.args)))) failures.push(`missing call ${w.toolName}${w.args ? ` ${JSON.stringify(w.args)}` : ''}`);
  }
  for (const f of expect.forbidden ?? []) if (calls.some((c) => c.toolName === f)) failures.push(`called forbidden ${f}`);
  const answer = normalizeAnswer(text);
  for (const a of expect.answerIncludes ?? []) {
    const spellings = Array.isArray(a) ? a : [a];
    if (!spellings.some((w) => answer.includes(normalizeAnswer(w)))) failures.push(`answer lacks "${spellings.join('" or "')}"`);
  }
  return failures;
}

/** Checks one finished scenario against its expectation. */
export function checkScenario(s: Scenario, calls: Array<{ toolName: string; args: unknown }>, text: string): string[] {
  return checkExpectation(s.expect, calls, text);
}

async function runOne(s: Scenario, model: LanguageModel, pricing: Record<string, ModelPricing>, maxSteps: number, timeoutMs: number): Promise<ScenarioResult> {
  const calls: Array<{ toolName: string; args: unknown }> = [];
  const tools: ToolSet = {};
  for (const [name, t] of Object.entries(s.tools)) {
    tools[name] = tool({ description: t.description, inputSchema: jsonSchema(t.parameters as any), execute: async (args: unknown) => { calls.push({ toolName: name, args }); return t.run(args); } } as any);
  }
  const seen: unknown[] = [];
  const wrapped = wrapLanguageModel({
    model: model as any,
    middleware: { specificationVersion: 'v3', wrapGenerate: async ({ doGenerate, model: m }: any) => { const r = await doGenerate(); seen.push({ usage: r.usage, response: { modelId: r.response?.modelId ?? m.modelId } }); return r; } } as any,
  });
  let text = '';
  let error: string | undefined;
  const signal = AbortSignal.timeout(timeoutMs);
  try {
    const r = await generateText({ model: wrapped, system: s.system, prompt: s.prompt, tools, stopWhen: stepCountIs(maxSteps), abortSignal: signal } as any);
    text = r.text;
  } catch (e) {
    // Only OUR deadline is reported as one. A gateway that gives up first (measured: NIM closed a
    // request at ~60 s with a message containing 'timeout') is a model-call failure with its own words.
    error = signal.aborted ? `no answer within ${timeoutMs} ms` : `model call failed: ${(e as Error)?.message ?? String(e)}`;
  }
  let costUsd = 0, inputTokens = 0, outputTokens = 0, priced = true;
  for (const v of seen) {
    const u = usageAndCostFromModelValue(v, { pricing });
    if (!u) continue;
    costUsd += u.costUsd; inputTokens += u.inputTokens; outputTokens += u.outputTokens; priced &&= u.priced;
  }
  const failures = error ? [] : checkScenario(s, calls, text);
  return { id: s.id, category: s.category, pass: !error && failures.length === 0, failures, ...(error ? { error } : {}), calls, text, costUsd, priced, inputTokens, outputTokens, steps: seen.length };
}

/** Runs every scenario with `model` (its tools are the store's fakes, so nothing real happens) and checks each. */
export async function runSuite(opts: RunSuiteOptions): Promise<SuiteResult> {
  refuseUnknownNames('runSuite', opts, SUITE_NAMES);
  const scenarios = opts.scenarios ?? DEFAULT_SUITE;
  const pricing = opts.pricing ?? (await effectivePricingTable({} as never));
  const results: ScenarioResult[] = new Array(scenarios.length);
  let next = 0;
  const worker = async () => {
    for (let i = next++; i < scenarios.length; i = next++) results[i] = await runOne(scenarios[i]!, opts.model, pricing, opts.maxSteps ?? 8, opts.timeoutMs ?? 120_000);
  };
  await Promise.all(Array.from({ length: Math.max(1, opts.concurrency ?? 4) }, worker));
  const modelId = typeof opts.model === 'string' ? opts.model : (opts.model as { modelId: string }).modelId;
  const ran = results.filter((r) => r.error === undefined);
  return {
    modelId,
    results,
    passRate: ran.length ? ran.filter((r) => r.pass).length / ran.length : NaN,
    errored: results.length - ran.length,
    costUsd: results.reduce((a, r) => a + r.costUsd, 0),
  };
}
