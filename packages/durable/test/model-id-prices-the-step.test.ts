// A step is priced by the model that ran it, even when the provider's response does not name one.
//
// Pricing read its model id from the RESPONSE only (`response.modelId`, or a `response-metadata`
// stream part). A provider, a proxy or a user middleware that does not echo the id left every step
// as 'unknown': cost 0, so `maxCostUsd` could never fire and the run's only symptom was one warning.
// The model object itself always knows its id (`wrapLanguageModel` keeps it: `modelId ?? model.modelId`),
// so the configured id is the fallback — the provider's own answer still wins when it gives one.
import { describe, it, expect, vi, afterEach } from 'vitest';
import { wrapLanguageModel } from 'ai';
import { InMemoryJournal } from '../src/journal.js';
import { runDurable, streamDurable } from '../src/run.js';
import { createMockModel, finalTextResult } from './mock.js';

afterEach(() => vi.restoreAllMocks());

// 1M in + 1M out on a priced model is far past a one-cent ceiling.
const bigStep = () => ({ ...finalTextResult('done'), usage: { inputTokens: 1_000_000, outputTokens: 1_000_000 } });

/** A model whose responses never name themselves, behind a pass-through user middleware. */
const wrapped = (modelId: string) => {
  const inner = createMockModel(async () => bigStep());
  inner.modelId = modelId;
  return wrapLanguageModel({ model: inner, middleware: { specificationVersion: 'v4' } as never });
};

describe('the configured model id prices a step whose response names none', () => {
  it('wrapLanguageModel keeps the id the pricing fallback relies on', () => {
    expect(wrapped('claude-opus-4').modelId).toBe('claude-opus-4');
  });

  it('generate: maxCostUsd fires for a wrapped, priced model', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    await expect(runDurable({
      runId: 'g1', journal: new InMemoryJournal(), model: wrapped('claude-opus-4'), prompt: 'x',
      limits: { maxCostUsd: 0.01 },
    } as never)).rejects.toThrow(/exceeded the maxCostUsd limit/);
  });

  it('stream: maxCostUsd fires for a wrapped, priced model', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const res: any = await streamDurable({
      runId: 's1', journal: new InMemoryJournal(), model: wrapped('claude-opus-4'), prompt: 'x',
      limits: { maxCostUsd: 0.01 },
    } as never);
    await expect((async () => { for await (const _ of res.fullStream) { /* drain */ } await res.text; })()).rejects.toThrow(/maxCostUsd/);
  });

  it('an unpriced model is named by its configured id in the warning, not "unknown"', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    await runDurable({
      runId: 'g2', journal: new InMemoryJournal(), model: wrapped('acme-internal/finetune-2026-08'), prompt: 'x',
      limits: { maxCostUsd: 0.01 },
    } as never);
    const said = warn.mock.calls.flat().join(' ');
    expect(said).toContain('acme-internal/finetune-2026-08');
    expect(said).not.toContain('unknown');
  });

  it('the provider\'s own response id still wins over the configured one', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const inner = createMockModel(async () => ({ ...bigStep(), response: { modelId: 'gpt-4o-mini' } }));
    inner.modelId = 'claude-opus-4';
    const journal = new InMemoryJournal();
    // gpt-4o-mini at 1M+1M is $0.75: over a 0.5 ceiling, under what claude-opus-4 would be priced at 5.
    await expect(runDurable({ runId: 'g3', journal, model: inner, prompt: 'x', limits: { maxCostUsd: 0.5 } } as never))
      .rejects.toThrow(/\$0\.7500/);
  });
});
