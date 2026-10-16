// A reader's cursor that is not one a run's stream gave is refused (`invalid_cursor`, 400) — never read
// as "from the start", which sent a reader that said it holds everything the whole run again (release
// audit A8). The grammar is read once, by the engine (`readCursor`); the door hands the cursor on as it came.
import { describe, it, expect } from 'vitest';
import { InMemoryJournal } from '@gnldev/durable';
import { createRestApi } from '../src/index.js';
import { call } from './call.js';

const usage = { inputTokens: 1, outputTokens: 1, totalTokens: 2 };
function model(calls: { n: number }): any {
  return {
    specificationVersion: 'v2', provider: 'mock', modelId: 'm', supportedUrls: {},
    doGenerate: async () => { throw new Error('no gen'); },
    doStream: async () => {
      calls.n++;
      return {
        stream: new ReadableStream({
          start(c) {
            for (const p of [
              { type: 'stream-start', warnings: [] }, { type: 'text-start', id: '1' }, { type: 'text-delta', id: '1', delta: 'Done.' },
              { type: 'text-end', id: '1' }, { type: 'finish', finishReason: 'stop', usage },
            ]) c.enqueue(p);
            c.close();
          },
        }),
      };
    },
  };
}
const json = { 'content-type': 'application/json' };

describe('a cursor that is not one is refused', () => {
  for (const bad of ['99999999999999999999999', '9007199254740993', '5.99999999999999999999999', 'abc', '-1', '1e3']) {
    it(`GET /runs/:id/events with Last-Event-ID '${bad}' answers 400 invalid_cursor, and replays nothing`, async () => {
      const calls = { n: 0 };
      const journal = new InMemoryJournal();
      const api = createRestApi({ journal, agents: { chat: { model: model(calls) } } });
      await (await call(api, '/agents/chat/stream', { method: 'POST', headers: json, body: JSON.stringify({ runId: 'r1', prompt: 'hi' }) })).text();
      const res = await call(api, '/runs/r1/events', { headers: { 'Last-Event-ID': bad } });
      expect(res.status).toBe(400);
      expect((await res.json()).code).toBe('invalid_cursor');
    });
  }

  it('a stream asked with a cursor that is not one is refused before the run is started', async () => {
    const calls = { n: 0 };
    const journal = new InMemoryJournal();
    const api = createRestApi({ journal, agents: { chat: { model: model(calls) } } });
    const res = await call(api, '/agents/chat/stream', { method: 'POST', headers: { ...json, 'Last-Event-ID': '1e+23' }, body: JSON.stringify({ runId: 'r2', prompt: 'hi' }) });
    expect(res.status).toBe(400);
    expect((await res.json()).code).toBe('invalid_cursor');
    expect(calls.n).toBe(0);
    expect(await journal.get('r2:input')).toBeUndefined();
  });

  it('a cursor the stream gave still reads on from it (the largest one too)', async () => {
    const calls = { n: 0 };
    const journal = new InMemoryJournal();
    const api = createRestApi({ journal, agents: { chat: { model: model(calls) } } });
    await (await call(api, '/agents/chat/stream', { method: 'POST', headers: json, body: JSON.stringify({ runId: 'r3', prompt: 'hi' }) })).text();
    const all = await (await call(api, '/runs/r3/events')).text();
    expect(all).toContain('Done.');
    const res = await call(api, '/runs/r3/events', { headers: { 'Last-Event-ID': String(Number.MAX_SAFE_INTEGER) } });
    expect(res.status).toBe(200);
    expect(await res.text()).not.toContain('Done.');
  });
});
