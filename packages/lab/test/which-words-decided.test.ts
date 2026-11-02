// Words as parts, a probability as the value: the shares of a known value function, and the probability
// read from a provider's logprobs however it spaces the tool call.
import { describe, it, expect } from 'vitest';
import { wordShares, toolChoiceProbability } from '../src/index.js';

const tools = ['searchOrders', 'replaceOrder', 'refundOrder', 'escalate'].map((name) => ({ type: 'function' as const, function: { name } }));

/** An OpenAI-compatible answer whose tool-name token has these alternatives. */
function provider(alternatives: Array<[string, number]>, opts: { spaced?: boolean; noLogprobs?: boolean } = {}) {
  const sent: any[] = [];
  const fetch = (async (_url: string, init: any) => {
    sent.push(JSON.parse(init.body));
    const sep = opts.spaced ? '": "' : '":"';
    const tokens = ['[', '{"', 'name', sep, alternatives[0]![0], 'Order', '","', 'arguments'];
    const content = tokens.map((t, i) => ({ token: t, logprob: -0.1, top_logprobs: i === 4 ? alternatives.map(([token, p]) => ({ token, logprob: Math.log(p) })) : [] }));
    return new Response(JSON.stringify({ choices: [{ message: {}, logprobs: opts.noLogprobs ? null : { content } }] }), { status: 200 });
  }) as unknown as typeof globalThis.fetch;
  return { fetch, sent };
}

describe('which words decided', () => {
  it('a value that is "money" and "back" together, or "broken" taking it away: the shares say so', async () => {
    const words = ['My lamp', 'broken', 'my money', 'back.'];
    const value = async (t: string) => (t.includes('my money') && t.includes('back.') ? (t.includes('broken') ? 0.2 : 0.8) : 0);
    const r = await wordShares({ words, value });
    expect(r.calls).toBe(16);
    expect(r.full).toBe(0.2);
    expect(r.none).toBe(0);
    const s = Object.fromEntries(r.shares.map((x) => [x.word, x.share]));
    expect(s['My lamp']).toBe(0);
    expect(s['my money']).toBeCloseTo(s['back.']!, 12);
    expect(s.broken).toBeLessThan(0);
    expect(s['my money']! + s['back.']! + s.broken!).toBeCloseTo(0.2, 12);
  });

  it('a subset whose call failed is asked again; still failing, it is an error, not a zero', async () => {
    let n = 0;
    const flaky = async () => { if (++n % 5 === 0) throw new Error('ECONNRESET'); return 0.5; };
    const r = await wordShares({ words: ['a', 'b', 'c'], value: flaky });
    expect(r.calls).toBeGreaterThan(8);
    await expect(wordShares({ words: ['a'], value: async () => { throw new Error('down'); }, retries: 1 })).rejects.toThrow(/no value after retries — down/);
  });

  it('the tool name is read after "name":" with or without a space, summed over its alternatives', async () => {
    for (const spaced of [false, true]) {
      const p = provider([['refund', 0.3], ['replace', 0.6], ['escalate', 0.05]], { spaced });
      const decide = toolChoiceProbability({ baseURL: 'https://nim.test/v1', apiKey: 'k', model: 'm', tools, tool: 'refundOrder', fetch: p.fetch, body: { chat_template_kwargs: { enable_thinking: false } } });
      expect(await decide('I want my money back')).toBeCloseTo(0.3, 9);
      expect(p.sent[0]).toMatchObject({ tool_choice: 'required', logprobs: true, chat_template_kwargs: { enable_thinking: false } });
      expect(p.sent[0].messages.at(-1)).toEqual({ role: 'user', content: 'I want my money back' });
    }
  });

  it('a provider with no logprobs is an error; a token two tool names begin with is left out, and an error when it holds most of the probability', async () => {
    const none = provider([['refund', 1]], { noLogprobs: true });
    await expect(toolChoiceProbability({ baseURL: 'https://x.test', apiKey: 'k', model: 'm', tools, tool: 'refundOrder', fetch: none.fetch })('x')).rejects.toThrow(/no logprobs/);
    // measured on NIM: 're' begins replaceOrder and refundOrder — a small alternative is left out, the rest is read
    const minor = provider([['replace', 0.7], ['ref', 0.2], ['re', 0.05]]);
    expect(await toolChoiceProbability({ baseURL: 'https://x.test', apiKey: 'k', model: 'm', tools, tool: 'refundOrder', fetch: minor.fetch })('x')).toBeCloseTo(0.2, 9);
    const mostly = provider([['re', 0.9], ['ref', 0.05]]);
    await expect(toolChoiceProbability({ baseURL: 'https://x.test', apiKey: 'k', model: 'm', tools, tool: 'refundOrder', fetch: mostly.fetch })('x')).rejects.toThrow(/begin more than one tool name — 're' \(replaceOrder, refundOrder\)/);
    expect(() => toolChoiceProbability({ baseURL: 'https://x.test', apiKey: 'k', model: 'm', tools, tool: 'cancelOrder' })).toThrow(/not among the tools/);
  });
});
