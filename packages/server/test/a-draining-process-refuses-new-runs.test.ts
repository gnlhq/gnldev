// A process that is shutting down (SIGTERM → `drain()`) answers a new run with 503 and Retry-After:
// the load balancer's signal to send it elsewhere. The request is correct; this process is leaving.
// Before, the refusal (`DrainingError`) reached the caller as a generic error.
import { describe, it, expect, afterEach } from 'vitest';
import { InMemoryJournal, endDrain } from '@gnldev/durable';
import { createRestApi } from '../src/index.js';
import { call } from './call.js';

const usage = { inputTokens: 1, outputTokens: 1, totalTokens: 2 };
const model: any = {
  specificationVersion: 'v2', provider: 'mock', modelId: 'm', supportedUrls: {},
  doGenerate: async () => ({ content: [{ type: 'text', text: 'ok' }], finishReason: 'stop', usage, warnings: [] }),
};
const post = (api: any, path: string, body: unknown) =>
  call(api, path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });

afterEach(() => endDrain());

describe('a draining process refuses new runs with 503', () => {
  for (const path of ['/agents/a/run', '/agents/a/stream']) {
    it(`POST ${path} after drain() → 503 + Retry-After, code 'draining'`, async () => {
      const api = createRestApi({ journal: new InMemoryJournal(), agents: { a: { model } } }) as any;
      const before = await post(api, path, { runId: 'before', prompt: 'hi' });
      expect(before.status).toBe(200);
      await before.text();
      await api.drain();
      const res = await post(api, path, { runId: 'after', prompt: 'hi' });
      expect(res.status).toBe(503);
      expect(res.headers.get('retry-after')).toBeTruthy();
      expect((await res.json()).code).toBe('draining');
    });
  }
});
