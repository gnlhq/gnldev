// Prompt-cache marks, placed per provider: Anthropic on the system message and the last message within
// its limit of 4, OpenAI a promptCacheKey, anything else untouched — and a run with them still runs each
// tool once.
import { describe, it, expect } from 'vitest';
import { generateText, tool } from 'ai';
import { z } from 'zod';
import { runDurable, gnlTool, InMemoryJournal } from '@gnldev/durable';
import { createMockModel } from '../../durable/test/mock.js';
import { placeAnthropicMarks, withCacheBreakpoints, cacheBreakpoints } from '../src/index.js';

const CC = { anthropic: { cacheControl: { type: 'ephemeral' } } };
const text = (role: string, t: string) => ({ role, content: role === 'system' ? t : [{ type: 'text', text: t }] });

/** A model of `provider` that records the request it was given. */
function recording(provider: string) {
  const calls: any[] = [];
  const m = createMockModel(async (o: any) => { calls.push(o); return { content: [{ type: 'text', text: 'ok' }], finishReason: 'stop', usage: { inputTokens: 1, outputTokens: 1 } }; });
  m.provider = provider;
  return { m, calls };
}

describe('cache marks go where the provider reads them', () => {
  it('Anthropic: the system message and the last message are marked; the rest is not', () => {
    const out = placeAnthropicMarks([text('system', 's'), text('user', 'a'), text('assistant', 'b'), text('user', 'c')] as any);
    expect(out.map((m: any) => m.providerOptions ?? null)).toEqual([CC, null, null, CC]);
  });

  it('Anthropic: marks the caller already set count toward the limit of 4', () => {
    const three = [text('user', 'a'), text('user', 'b'), text('user', 'c')].map((m) => ({ ...m, providerOptions: CC }));
    const out = placeAnthropicMarks([text('system', 's'), ...three, text('user', 'd')] as any);
    expect(out.filter((m: any) => m.providerOptions?.anthropic?.cacheControl).length).toBe(4); // one added: the system
    expect((out[0] as any).providerOptions).toEqual(CC);
    expect((out[4] as any).providerOptions).toBeUndefined();
  });

  it('Anthropic: a 1-hour lifetime is asked for when configured', () => {
    const out = placeAnthropicMarks([text('user', 'a')] as any, '1h');
    expect((out[0] as any).providerOptions.anthropic.cacheControl).toEqual({ type: 'ephemeral', ttl: '1h' });
  });

  it('through the middleware: an Anthropic model receives the marks', async () => {
    const { m, calls } = recording('anthropic.messages');
    await generateText({ model: withCacheBreakpoints(m), system: 'be brief', prompt: 'hi' });
    const prompt = calls[0].prompt;
    expect(prompt[0]).toMatchObject({ role: 'system', providerOptions: CC });
    expect(prompt.at(-1).providerOptions).toEqual(CC);
  });

  it('OpenAI: the cache key is sent; a key the caller set is kept', async () => {
    const a = recording('openai.responses');
    await generateText({ model: withCacheBreakpoints(a.m, { cacheKey: 'support' }), prompt: 'hi' });
    expect(a.calls[0].providerOptions.openai.promptCacheKey).toBe('support');
    const b = recording('openai.chat');
    await generateText({ model: withCacheBreakpoints(b.m, { cacheKey: 'support' }), prompt: 'hi', providerOptions: { openai: { promptCacheKey: 'tenant-7' } } });
    expect(b.calls[0].providerOptions.openai.promptCacheKey).toBe('tenant-7');
  });

  it('another provider is sent the request unchanged', async () => {
    const { m, calls } = recording('google.generative-ai');
    await generateText({ model: withCacheBreakpoints(m, { cacheKey: 'support' }), system: 's', prompt: 'hi' });
    expect(JSON.stringify(calls[0].prompt)).not.toContain('cacheControl');
    expect(calls[0].providerOptions?.openai).toBeUndefined();
  });

  it('in a durable run: the provider is sent the marks, each tool runs once, a second call replays', async () => {
    const journal = new InMemoryJournal();
    let ran = 0;
    const calls: any[] = [];
    let step = 0;
    const inner = createMockModel(async (o: any) => {
      calls.push(o);
      step++;
      return step === 1
        ? { content: [{ type: 'tool-call', toolCallId: 'r1', toolName: 'refund', input: '{"id":"a"}' }], finishReason: 'tool-calls', usage: { inputTokens: 1, outputTokens: 1 } }
        : { content: [{ type: 'text', text: 'done' }], finishReason: 'stop', usage: { inputTokens: 1, outputTokens: 1 } };
    });
    inner.provider = 'anthropic.messages';
    const refund = gnlTool(tool({ description: 'Refund', inputSchema: z.object({ id: z.string() }), execute: async () => { ran++; return 'ok'; } }), { sideEffect: true });
    const args = { runId: 'c1', journal, system: 'refunds', prompt: 'refund a', model: withCacheBreakpoints(inner), tools: { refund } } as any;
    await runDurable(args);
    expect(ran).toBe(1);
    expect(calls.length).toBe(2);
    for (const c of calls) expect(c.prompt.at(-1).providerOptions).toEqual(CC);
    await runDurable(args); // the same run again: answered from the journal
    expect(ran).toBe(1);
    expect(calls.length).toBe(2);
  });

  it('a misspelled option is refused', () => {
    expect(() => cacheBreakpoints({ cachekey: 'x' } as any)).toThrow(/cachekey/);
  });
});
