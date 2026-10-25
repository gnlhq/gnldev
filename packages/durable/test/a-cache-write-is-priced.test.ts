// A cache write is billed at the provider's write price, not at the plain input price.
//
// Anthropic bills a cache write at 1.25x input (5-minute TTL) or 2x (1 hour); OpenAI's GPT-5.6+ bills
// 1.25x (30 minutes) or 2.5x (12 hours). The AI SDK reports the written tokens in
// `usage.inputTokens.cacheWrite`; flattening dropped them, so they were billed as plain input — a run
// that cached a long prefix and never read it back looked cheaper than it was, and a spend ceiling read
// the lower number. A price row may now name the write rate; a row that does not keeps the old result.
import { describe, it, expect, vi } from 'vitest';
import { costOf, priceFor, DEFAULT_PRICING, type ModelPricing } from '../src/pricing.js';
import { flattenUsage } from '../src/sdk-compat.js';
import { usageAndCostFromModelValue } from '../src/cost.js';

const sdkUsage = (o: { noCache?: number; cacheRead?: number; cacheWrite?: number; output?: number }) => {
  const noCache = o.noCache ?? 0, cacheRead = o.cacheRead ?? 0, cacheWrite = o.cacheWrite ?? 0, output = o.output ?? 0;
  return {
    inputTokens: { total: noCache + cacheRead + cacheWrite, noCache, cacheRead, cacheWrite },
    outputTokens: { total: output, text: output, reasoning: 0 },
  };
};
const price: ModelPricing = { inputPer1M: 5, outputPer1M: 25, cachedInputPer1M: 0.5, cacheWritePer1M: 6.25 };

describe('a cache write is priced as a write', () => {
  it('flattening keeps the written tokens apart from the read ones', () => {
    expect(flattenUsage(sdkUsage({ noCache: 100, cacheRead: 300, cacheWrite: 1000, output: 50 }))).toMatchObject({
      inputTokens: 1400, cachedTokens: 300, cacheWriteTokens: 1000, outputTokens: 50,
    });
  });

  it('a write is billed at cacheWritePer1M; reads and plain input keep their own rates', () => {
    const cost = costOf(flattenUsage(sdkUsage({ noCache: 100, cacheRead: 300, cacheWrite: 1000, output: 50 })), price);
    // 100 x 5 + 300 x 0.5 + 1000 x 6.25 + 50 x 25 = 500 + 150 + 6250 + 1250 = 8150 per 1M
    expect(cost).toBeCloseTo(8150 / 1e6, 12);
  });

  it('a row without a write rate bills a write as plain input, as before', () => {
    const { cacheWritePer1M: _, ...noWriteRate } = price;
    const cost = costOf(flattenUsage(sdkUsage({ cacheWrite: 1000 })), noWriteRate);
    expect(cost).toBeCloseTo(5000 / 1e6, 12);
  });

  it('a usage with no cache fields at all is billed exactly as before', () => {
    expect(costOf(flattenUsage({ inputTokens: 1000, outputTokens: 100 }), price)).toBeCloseTo((5000 + 2500) / 1e6, 12);
  });

  it('a negative or non-finite write rate makes the row unusable, like the other rates', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    expect(priceFor('m-neg', { 'm-neg': { ...price, cacheWritePer1M: -1 } })).toBeUndefined();
    expect(priceFor('m-nan', { 'm-nan': { ...price, cacheWritePer1M: Number.NaN } })).toBeUndefined();
    warn.mockRestore();
  });

  it('a recorded model step (the funnel getRunCost and the spend limits read) bills the write too', () => {
    const value = { usage: sdkUsage({ noCache: 100, cacheRead: 300, cacheWrite: 1000, output: 50 }), response: { modelId: 'm' } };
    const u = usageAndCostFromModelValue(value, { pricing: { m: price } });
    expect(u).toMatchObject({ cachedTokens: 300, cacheWriteTokens: 1000, modelId: 'm', priced: true });
    expect(u!.costUsd).toBeCloseTo(8150 / 1e6, 12);
  });

  it('every Anthropic row names its 5-minute write rate: 1.25x its input rate', () => {
    const anthropic = Object.entries(DEFAULT_PRICING).filter(([k]) => k.startsWith('claude-'));
    expect(anthropic.length).toBeGreaterThan(0);
    for (const [k, row] of anthropic) expect({ k, w: row.cacheWritePer1M }).toEqual({ k, w: row.inputPer1M * 1.25 });
  });
});
