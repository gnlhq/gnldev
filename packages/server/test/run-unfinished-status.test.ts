// A RUN THAT ENDED `run_unfinished` ANSWERS 502 — the stream was cut upstream of the caller.
//
// `run_unfinished` is what the executor writes when a run's stream closes with no `finish` part and
// nothing (cancel, release, timeout) stopped it (detached.ts; k2-sib-detached S2 drives that branch).
// Before it had a status it fell through every door's taxonomy to the generic 400 — "your request was
// malformed" — for a request that was fine. The status is WIRE_ERROR_STATUS's (upstream family, 502).
//
// What this drives: the run's ending as the engine RECORDS it — an error part carrying the code goes
// through the executor's ending, the event log, `followedRun`/`errorOf`, and the route's taxonomy, the
// same path a recorded `run_unfinished` ending takes. What it does not drive is the executor's
// no-finish branch itself: through the AI SDK a stream that closes without `finish` is given one above
// the recorder. The recorder reads the provider's own parts, so a cut reaches the door as this code
// (durable-model.ts `endedUnfinished`; a-cut-stream-is-no-answer.test.ts holds the shapes).
import { describe, it, expect } from 'vitest';
import { InMemoryJournal } from '@gnldev/durable';
import { createRestApi } from '../src/index.js';
import { call } from './call.js';

/** A run whose recorded ending is `run_unfinished`. */
function endsUnfinished() {
  const err = Object.assign(new Error(`the run's stream ended without finishing (no finish part, and nothing stopped it)`), { code: 'run_unfinished' });
  return {
    specificationVersion: 'v2' as const, provider: 'test', modelId: 'm', supportedUrls: {},
    async doGenerate(): Promise<never> { throw err; },
    async doStream(): Promise<never> { throw err; },
  };
}

/** A provider whose stream sends text and then closes: no `finish` part, no error, no abort. */
function truncatedModel() {
  return {
    specificationVersion: 'v2' as const, provider: 'test', modelId: 'm', supportedUrls: {},
    async doGenerate(): Promise<never> { throw new Error('stream only'); },
    async doStream() {
      return {
        stream: new ReadableStream({
          start(c) {
            c.enqueue({ type: 'stream-start', warnings: [] });
            c.enqueue({ type: 'text-start', id: 't' });
            c.enqueue({ type: 'text-delta', id: 't', delta: 'half an ans' });
            c.close();
          },
        }),
      };
    },
  };
}

const post = (model: unknown, runId: string) => call(
  createRestApi({ journal: new InMemoryJournal(), agents: { a: { model: model as never, maxSteps: 1 } } }),
  '/agents/a/run',
  { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ runId, prompt: 'selam' }) },
);

describe('a run that ended without finishing reaches the caller as an upstream failure', () => {
  it('answers 502 run_unfinished, not 400', async () => {
    const res = await post(endsUnfinished(), 'cut-1');
    const body = await res.json() as { code?: string };
    expect(body.code).toBe('run_unfinished');
    expect(res.status).toBe(502);
  });

  it('the same runId, re-driven, runs again and finishes (a failed run is not over)', async () => {
    // What the page tells the caller to do: retry with the same id. The failed execution's record is
    // gone (detached.ts finish), so the retry starts a fresh execution over the same journal.
    let calls = 0;
    const cut = endsUnfinished();
    const model = {
      ...cut,
      async doStream() {
        if (calls++ === 0) return cut.doStream();
        return { stream: new ReadableStream({ start(c) {
          c.enqueue({ type: 'stream-start', warnings: [] });
          c.enqueue({ type: 'text-start', id: 't' });
          c.enqueue({ type: 'text-delta', id: 't', delta: 'whole answer' });
          c.enqueue({ type: 'text-end', id: 't' });
          c.enqueue({ type: 'finish', finishReason: 'stop', usage: { inputTokens: 1, outputTokens: 2, totalTokens: 3 } });
          c.close();
        } }) };
      },
    };
    const h = createRestApi({ journal: new InMemoryJournal(), agents: { a: { model: model as never, maxSteps: 1 } } });
    const again = () => call(h, '/agents/a/run', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ runId: 'cut-3', prompt: 'selam' }) });
    expect((await again()).status).toBe(502);
    const res = await again();
    expect(res.status).toBe(200);
    expect((await res.json() as { text?: string }).text).toBe('whole answer');
    expect(calls).toBe(2);
  });

  it('a provider stream cut before `finish` answers 502, and the same runId answers whole', async () => {
    // It answered 200 with half a text, finishReason other, and every retry replayed the half.
    const cut = truncatedModel();
    let calls = 0;
    const model = {
      ...cut,
      async doStream() {
        if (calls++ === 0) return cut.doStream();
        return { stream: new ReadableStream({ start(c) {
          c.enqueue({ type: 'stream-start', warnings: [] });
          c.enqueue({ type: 'text-start', id: 't' });
          c.enqueue({ type: 'text-delta', id: 't', delta: 'whole answer' });
          c.enqueue({ type: 'text-end', id: 't' });
          c.enqueue({ type: 'finish', finishReason: 'stop', usage: { inputTokens: 1, outputTokens: 2, totalTokens: 3 } });
          c.close();
        } }) };
      },
    };
    const h = createRestApi({ journal: new InMemoryJournal(), agents: { a: { model: model as never, maxSteps: 1 } } });
    const again = () => call(h, '/agents/a/run', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ runId: 'cut-2', prompt: 'selam' }) });
    const res = await again();
    expect(res.status).toBe(502);
    expect((await res.json() as { code?: string }).code).toBe('run_unfinished');
    const retried = await again();
    expect(retried.status).toBe(200);
    expect((await retried.json() as { text?: string }).text).toBe('whole answer');
  });

  it('the stream door has already said 200: its error event carries the code', async () => {
    const h = createRestApi({ journal: new InMemoryJournal(), agents: { a: { model: truncatedModel() as never, maxSteps: 1 } } });
    const res = await call(h, '/agents/a/stream', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ runId: 'cut-4', prompt: 'selam' }) });
    const body = await res.text();
    const error = body.split('\n\n').find((b) => b.includes('event: error'));
    expect(error).toBeDefined();
    expect(JSON.parse(error!.match(/^data: (.+)$/m)![1]!).code).toBe('run_unfinished');
  });
});
