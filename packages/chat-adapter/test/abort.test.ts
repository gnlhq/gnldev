// A run executes apart from the request that started it (@gnldev/durable, design decision D2):
//  · registry: RunOptions.abortSignal is the caller saying STOP — it cancels the run, and the generation
//    in progress is aborted (the model's own signal), not merely the caller's reading of it;
//  · route: a client that disconnects (a closed tab) does NOT stop the turn — the route never wires the
//    request's signal into the run; the answer is there when the user comes back.
import { describe, it, expect } from 'vitest';
import { InMemoryJournal, createGnl } from '@gnldev/durable';
import { createChatRoute } from '../src/index.js';

/** A model whose stream never finishes (no 'finish' chunk, stream left open) — lets the test abort
 *  mid-generation and observe the captured abortSignal, instead of racing a stream that already closed. */
function controllableMock(captured: { signal?: AbortSignal }): any {
  return {
    specificationVersion: 'v2',
    provider: 'mock',
    modelId: 'm',
    supportedUrls: {},
    doGenerate: async () => {
      throw new Error('no gen');
    },
    doStream: async (options: any) => {
      captured.signal = options?.abortSignal;
      const stream = new ReadableStream({
        start(c) {
          c.enqueue({ type: 'stream-start', warnings: [] });
          c.enqueue({ type: 'text-start', id: '1' });
          c.enqueue({ type: 'text-delta', id: '1', delta: 'chunk1 ' });
          // deliberately no 'finish'/close — simulates a long-running generation.
        },
      });
      return { stream };
    },
  };
}

function userMessage(text: string) {
  return { id: 'u1', role: 'user', parts: [{ type: 'text', text }] };
}

/** Reads from a stream reader until `predicate(value)` is true (or the stream ends) — needed because
 *  streamText's fullStream/UI-chunk stream emits a synthetic 'start'/'start-step' chunk BEFORE the
 *  underlying model's doStream is actually invoked (verified empirically), so reading exactly one chunk
 *  races the model call. */
async function readUntil(reader: ReadableStreamDefaultReader<any>, predicate: (v: any) => boolean, maxReads = 10): Promise<void> {
  for (let i = 0; i < maxReads; i++) {
    const { done, value } = await reader.read();
    if (done || predicate(value)) return;
  }
}

describe('@gnldev/chat-adapter abort forwarding', () => {
  it('registry: RunOptions.abortSignal cancels the run — the generation in progress is aborted', async () => {
    const captured: { signal?: AbortSignal } = {};
    const gnl = createGnl({ journal: new InMemoryJournal(), agents: { chat: { model: controllableMock(captured), maxSteps: 4 } } });
    const controller = new AbortController();

    const result: any = await gnl.stream('chat', { runId: 'a1', prompt: 'hi', abortSignal: controller.signal });
    const reader = result.fullStream.getReader();
    await readUntil(reader, (v) => v?.type === 'text-delta');

    expect(captured.signal).toBeInstanceOf(AbortSignal);
    expect(captured.signal?.aborted).toBe(false);
    controller.abort();
    // The cancellation is recorded first (durably), then the execution here is stopped.
    for (let i = 0; i < 50 && !captured.signal?.aborted; i++) await new Promise((r) => setTimeout(r, 10));
    expect(captured.signal?.aborted).toBe(true);
  });

  it('route: a client that disconnects does not stop the turn — the request signal never reaches the run', async () => {
    const captured: { signal?: AbortSignal } = {};
    const app = createChatRoute({ journal: new InMemoryJournal(), agents: { chat: { model: controllableMock(captured), maxSteps: 4 } } });
    const controller = new AbortController();

    const res = await app.request('/agents/chat/chat', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ id: 's1', messages: [userMessage('hi')] }),
      signal: controller.signal,
    });
    // Drain bytes (decoding) until we've seen a 'text-delta' SSE data chunk, so we know doStream has
    // actually run and captured the signal (the response body starts with synthetic 'start'/'start-step'
    // UI chunks emitted BEFORE the model is called — see readUntil's doc comment above).
    const reader = res.body!.getReader();
    const decoder = new TextDecoder();
    let buf = '';
    for (let i = 0; i < 20 && !buf.includes('"type":"text-delta"'); i++) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true });
    }

    expect(captured.signal).toBeInstanceOf(AbortSignal);
    controller.abort();
    await reader.cancel().catch(() => undefined);
    await new Promise((r) => setTimeout(r, 100));
    expect(captured.signal?.aborted, 'a closed tab stopped the generation').toBe(false);
  });
});
