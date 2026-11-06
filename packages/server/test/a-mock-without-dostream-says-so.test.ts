// A mock model written with only `doGenerate` used to reach the REST caller as a bare
// `400 {"error":"Not implemented"}`: an agent runs on the streaming path, and the AI SDK's mock
// answers every method it was not given with that one sentence. The answer must name the model, the
// method and the way out.
import { describe, it, expect } from 'vitest';
import { MockLanguageModelV4 } from 'ai/test';
import { InMemoryJournal } from '@gnldev/durable';
import { createRestApi } from '../src/index.js';
import { call } from './call.js';

const usage = { inputTokens: { total: 1, noCache: 1 }, outputTokens: { total: 1, text: 1 } };
const generateOnly: any = new MockLanguageModelV4({
  modelId: 'my-mock',
  doGenerate: async () => ({ content: [{ type: 'text', text: 'ok' }], finishReason: { unified: 'stop', raw: 'stop' }, usage, warnings: [] }),
} as never);

describe('a model missing the method GNL calls', () => {
  it('POST /agents/:name/run names the model, the method and the way out', async () => {
    const api = createRestApi({ journal: new InMemoryJournal(), agents: { a: { model: generateOnly } } }) as any;
    const res = await call(api, '/agents/a/run', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ runId: 'r1', prompt: 'hi' }) });
    const { error } = await res.json();
    expect(error).toContain("'my-mock'");
    expect(error).toContain('doStream');
    expect(error).toContain('echoModel');
    expect(error).not.toBe('Not implemented');
  });
});
