// d25 A3 (stream/KARAR-06, option A): a `model: [a, b]` chain moves to `b` when `a`'s stream OPENS and then
// delivers an `error` part before any content. OpenAI-compatible servers often answer 200 and put the 429 inside the
// stream; the chain treated the open stream as success and the run ended in the error. A thrown 429 already moved
// to `b` on 0.17.1 (kept below as controls).
//
// The option also fixes the other side of the rule, and that is pinned too: once content has started, an error
// does NOT switch models (a half answer from `a` must not be glued to an answer from `b`).
import { describe, it, expect } from 'vitest';
import { createGnl } from '../src/registry.js';
import { InMemoryJournal } from '../src/journal.js';
import { streamFromGenerate } from './mock.js';

const upstream = (status: number, message: string) => () =>
  Object.assign(new Error(message), { name: 'AI_APICallError', statusCode: status, isRetryable: status === 429 || status >= 500, url: 'https://x.example/v1/chat/completions' });
const err429 = upstream(429, 'Too Many Requests');
const err503 = upstream(503, 'Service Unavailable');

type Mode = 'throw' | 'part' | 'part-after-metadata' | 'part-after-text';
function mk(modelId: string, fail?: () => Error, mode: Mode = 'throw') {
  const calls = { stream: 0 };
  const model: any = {
    specificationVersion: 'v2', provider: 'p', modelId, supportedUrls: {},
    doGenerate: async () => {
      if (fail) throw fail();
      return { content: [{ type: 'text', text: `from ${modelId}` }], finishReason: 'stop', usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 }, warnings: [], response: { modelId } };
    },
    doStream: async function (this: any, o: any) {
      calls.stream++;
      if (fail && mode === 'throw') throw fail();
      if (fail) {
        const parts: any[] = [{ type: 'stream-start', warnings: [] }];
        if (mode === 'part-after-metadata') parts.push({ type: 'response-metadata', id: 'resp-1', modelId, timestamp: new Date(0) });
        if (mode === 'part-after-text') parts.push({ type: 'text-start', id: 't' }, { type: 'text-delta', id: 't', delta: `half from ${modelId}` });
        parts.push({ type: 'error', error: fail() });
        return { stream: new ReadableStream({ start(c) { for (const p of parts) c.enqueue(p); c.close(); } }) };
      }
      return streamFromGenerate(this, o);
    },
  };
  return { model, calls };
}
const gnlOf = (a: any, b: any) => createGnl({ journal: new InMemoryJournal(), agents: { bot: { model: [a, b], maxSteps: 2 } } } as any);
const settle = async (s: any) => { try { return { text: await s.text }; } catch (e) { return { error: String((e as Error)?.message ?? e) }; } };

describe('A3: an error part before any content moves the chain to the next model', () => {
  it('reported — 429 arrives as an error part right after stream-start', async () => {
    const a = mk('a', err429, 'part'); const b = mk('b');
    const s: any = await gnlOf(a.model, b.model).stream('bot', { prompt: 'hi', runId: 'a3-part-429' });
    expect(await settle(s)).toEqual({ text: 'from b' });
  });
  it('sibling — a 503 error part, after response-metadata (still no content)', async () => {
    const a = mk('a', err503, 'part-after-metadata'); const b = mk('b');
    const s: any = await gnlOf(a.model, b.model).stream('bot', { prompt: 'hi', runId: 'a3-part-503' });
    expect(await settle(s)).toEqual({ text: 'from b' });
  });
});

describe('A3: the other half of the rule — content started, no switch', () => {
  it('text already streamed from a, then an error part: b is never called and the answer is not "from b"', async () => {
    const a = mk('a', err429, 'part-after-text'); const b = mk('b');
    const s: any = await gnlOf(a.model, b.model).stream('bot', { prompt: 'hi', runId: 'a3-half' });
    const out = await settle(s);
    expect(b.calls.stream).toBe(0);
    expect(out).not.toEqual({ text: 'from b' });
  });
});

describe('A3 controls (green on 0.17.1): a thrown 429 already moves the chain', () => {
  it('run(): doGenerate throws 429', async () => {
    const r: any = await gnlOf(mk('a', err429).model, mk('b').model).run('bot', { prompt: 'hi', runId: 'a3-run' });
    expect(r.text).toBe('from b');
  });
  it('stream(): doStream throws 429', async () => {
    const s: any = await gnlOf(mk('a', err429).model, mk('b').model).stream('bot', { prompt: 'hi', runId: 'a3-stream' });
    expect(await settle(s)).toEqual({ text: 'from b' });
  });
  it('stream(): doStream throws 503 (the sibling status above, thrown)', async () => {
    const s: any = await gnlOf(mk('a', err503).model, mk('b').model).stream('bot', { prompt: 'hi', runId: 'a3-stream-503' });
    expect(await settle(s)).toEqual({ text: 'from b' });
  });
});
