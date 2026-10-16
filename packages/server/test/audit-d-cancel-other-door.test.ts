// Audit D (red): an explicit cancel must stop a run in the process that executes it.
//
// POST /runs/:id/cancel aborts only the in-flight controllers of THIS handler, and `?durable=true` only
// writes the cancel flag. Since runs execute apart from the request (detached executor), a run started
// through another handler — another worker on the same store, here a second handler on the same journal —
// is not stopped: its generation in progress runs on (signal never aborted), every token billed.
import { describe, it, expect, vi } from 'vitest';
import { InMemoryJournal } from '@gnldev/durable';
import { createRestApi } from '../src/index.js';
import { call } from './call.js';

/** Streams one delta every 50 ms for ~2 s, then finishes; records the signal it was called with. */
function slowModel(captured: { signal?: AbortSignal; deltas: number }): any {
  return {
    specificationVersion: 'v2', provider: 'mock', modelId: 'm', supportedUrls: {},
    doGenerate: async () => { throw new Error('no gen'); },
    doStream: async (options: any) => {
      captured.signal = options.abortSignal;
      let i = 0;
      return {
        stream: new ReadableStream({
          start(c) { c.enqueue({ type: 'stream-start', warnings: [] }); c.enqueue({ type: 'text-start', id: 't' }); },
          async pull(c) {
            await new Promise((r) => setTimeout(r, 50));
            if (options.abortSignal?.aborted) { c.error(options.abortSignal.reason ?? new Error('aborted')); return; }
            if (i++ < 40) { captured.deltas++; c.enqueue({ type: 'text-delta', id: 't', delta: 'x' }); return; }
            c.enqueue({ type: 'text-end', id: 't' });
            c.enqueue({ type: 'finish', finishReason: 'stop', usage: { inputTokens: 1, outputTokens: 40, totalTokens: 41 } });
            c.close();
          },
        }),
      };
    },
  };
}

describe('POST /runs/:id/cancel reaching the executing run', () => {
  for (const durable of [false, true]) {
    it(`a cancel through a second handler on the same store stops the run (durable=${durable})`, async () => {
      const captured = { deltas: 0 } as { signal?: AbortSignal; deltas: number };
      const journal = new InMemoryJournal();
      const a = createRestApi({ journal, agents: { chat: { model: slowModel(captured) } } });
      const b = createRestApi({ journal, agents: { chat: { model: slowModel(captured) } } });
      const runId = `x-${durable}`;
      const res = await call(a, '/agents/chat/stream', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ runId, prompt: 'hi' }) });
      const r = res.body!.getReader();
      await r.read();
      await vi.waitFor(() => { if (captured.deltas < 3) throw new Error('not yet'); });
      const cancel = await call(b, `/runs/${runId}/cancel${durable ? '?durable=true' : ''}`, { method: 'POST' });
      expect(cancel.status).toBe(200);
      const atCancel = captured.deltas;
      await new Promise((res) => setTimeout(res, 2_500));
      while (!(await r.read()).done) { /* drain */ }
      const list = await (await call(a, `/runs`)).json(); const status = list.find((x: any) => x.runId === runId)?.status;
      expect({ aborted: captured.signal!.aborted, deltasAfterCancel: captured.deltas - atCancel > 5 ? 'many' : 'few', status })
        .toEqual({ aborted: true, deltasAfterCancel: 'few', status: 'canceled' });
    });
  }
});
