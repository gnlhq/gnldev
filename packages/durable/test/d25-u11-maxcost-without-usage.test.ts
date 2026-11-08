// d25 U11 — `limits.maxCostUsd` over a model that returns no token usage: no cap, and no warning.
// Control: an UNPRICED model that does report usage already warns. The gap is the provider that reports nothing.
import { describe, it, expect, vi, afterEach } from 'vitest';
import { InMemoryJournal } from '../src/journal.js';
import { runDurable } from '../src/run.js';
import { createMockModel, finalTextResult } from './mock.js';

const warnings: string[] = [];
afterEach(() => { vi.restoreAllMocks(); warnings.length = 0; });

function model(modelId: string, usage: any) {
  const m: any = createMockModel(async () => ({ content: [{ type: 'text', text: 'ok' }], finishReason: 'stop', usage, warnings: [] }));
  m.modelId = modelId;
  return m;
}
// A provider that reports no usage: every count is undefined (what @ai-sdk/openai-compatible hands over for an upstream that omits `usage`).
const noUsage = { inputTokens: { total: undefined, noCache: undefined, cacheRead: undefined, cacheWrite: undefined }, outputTokens: { total: undefined, text: undefined, reasoning: undefined } };
const hugeUsage = { inputTokens: { total: 5_000_000, noCache: 5_000_000, cacheRead: undefined, cacheWrite: undefined }, outputTokens: { total: 1_000_000, text: 1_000_000, reasoning: undefined } };

async function go(m: any, limits: any) {
  vi.spyOn(console, 'warn').mockImplementation((...a: any[]) => { warnings.push(a.join(' ')); });
  let err: any;
  try { await runDurable({ runId: 'u11-' + Math.random().toString(36).slice(2), journal: new InMemoryJournal(), model: m, prompt: 'x', limits } as any); } catch (e) { err = e; }
  return { err, warn: warnings.filter((w) => /maxCostUsd|usage/i.test(w)) };
}

describe('U11 maxCostUsd vs a provider that reports no usage', () => {
  it('control: priced model + real usage over the cap → stops', async () => {
    const r = await go(model('gpt-4o', hugeUsage), { maxCostUsd: 0.01 });
    console.log('priced+usage:', r.err?.constructor?.name, r.warn.length);
    expect(r.err?.constructor?.name).toBe('RunLimitExceededError');
  });
  it('control: unpriced model + usage → warns that the ceiling is not capping', async () => {
    const r = await go(model('some-open-model', hugeUsage), { maxCostUsd: 0.01 });
    console.log('unpriced+usage: err=', r.err?.constructor?.name, '| warnings=', r.warn.length);
    expect(r.warn.length).toBeGreaterThan(0);
  });
  it('claim: priced model, provider reports NO usage → silent (no stop, no warning)', async () => {
    const r = await go(model('gpt-4o', noUsage), { maxCostUsd: 0.01 });
    console.log('priced+NO usage: err=', r.err?.constructor?.name, '| warnings=', r.warn.length);
    expect(r.warn.length).toBeGreaterThan(0);   // red => silent
  });
  it('claim: unpriced model (e.g. NVIDIA-hosted) AND no usage → silent', async () => {
    const r = await go(model('mistralai/mistral-large-4-1t-a52b', noUsage), { maxCostUsd: 0.01 });
    console.log('unpriced+NO usage: err=', r.err?.constructor?.name, '| warnings=', r.warn.length, r.warn[0]?.slice(0, 120));
    expect(r.warn.length).toBeGreaterThan(0);
  });
  it('maxTokens with no usage → also silent', async () => {
    const r = await go(model('gpt-4o', noUsage), { maxTokens: 10 });
    console.log('maxTokens + NO usage: err=', r.err?.constructor?.name, '| warnings=', r.warn.length);
    expect(r.warn.length + (r.err ? 1 : 0)).toBeGreaterThan(0);
  });
});
