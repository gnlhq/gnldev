// d25 A5 (stream/KARAR-05, option A; kucuk/KARAR.md: "model adını ve sağlayıcıyı söylesin (üretimde de)"):
// a provider failure names the model that failed and its provider. 0.17.1 (U14) gives the HTTP status and URL, but
// the URL often has no model in it (`/v1/responses`), so a misspelled model id cannot be found from the error.
// Option A: a machine-readable `upstreamModel` on the error body, read by /run, /stream and chat alike — in
// production too (the model id is configuration, not user input).
//
// The provider's field name is not fixed by the decision; the test only requires the provider id to appear in the
// error body.
import { describe, it, expect, vi, afterEach } from 'vitest';
import { InMemoryJournal } from '@gnldev/durable';
import { createRestApi } from '../src/index.js';
import { call } from './call.js';

afterEach(() => { vi.unstubAllEnvs(); vi.restoreAllMocks(); });

const failing = (status: number, modelId: string, provider = 'openai.responses'): any => {
  const up = () => Object.assign(new Error(status === 404 ? 'Not Found' : 'Service Unavailable'), { name: 'AI_APICallError', statusCode: status, url: 'https://h.example/v1/responses' });
  return { specificationVersion: 'v2', provider, modelId, supportedUrls: {}, doGenerate: async () => { throw up(); }, doStream: async () => { throw up(); } };
};
const post = (api: any, p: string, b: any) => call(api, p, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(b) });
const apiWith = (model: any) => createRestApi({ journal: new InMemoryJournal(), agents: { a: { model } } }, { protectionsBanner: false, allowOpenAccess: true } as any);
function errorEvent(sseText: string) {
  const frame = sseText.split('\n\n').find((f) => /^event:\s*error/m.test(f));
  const data = frame?.split('\n').filter((l) => l.startsWith('data:')).map((l) => l.slice(5).trim()).join('');
  return data ? JSON.parse(data) : undefined;
}

for (const env of ['development', 'production'] as const) {
  describe(`A5 (${env}): a provider failure names the failing model and provider`, () => {
    it('/run — 404 on a misspelled model id', async () => {
      vi.stubEnv('NODE_ENV', env);
      vi.spyOn(console, 'error').mockImplementation(() => {});
      const res = await post(apiWith(failing(404, 'meta/llama-9')), '/agents/a/run', { runId: `a5-run-${env}`, prompt: 'x' });
      const body: any = await res.json();
      expect(body.upstreamStatus).toBe(404); // control: U14, already there
      expect(String(body.upstreamModel)).toContain('meta/llama-9');
      expect(JSON.stringify(body)).toContain('openai.responses');
    });
    it('/stream — the error event carries the same field', async () => {
      vi.stubEnv('NODE_ENV', env);
      vi.spyOn(console, 'error').mockImplementation(() => {});
      const res = await post(apiWith(failing(404, 'meta/llama-9')), '/agents/a/stream', { runId: `a5-stream-${env}`, prompt: 'x' });
      const text = await res.text();
      // The failure may be answered before the SSE body (JSON) or as an SSE error event; either carries the field.
      const body: any = res.headers.get('content-type')?.includes('event-stream') ? errorEvent(text) : JSON.parse(text);
      expect(body, text).toBeDefined();
      expect(String(body.upstreamModel)).toContain('meta/llama-9');
      expect(JSON.stringify(body)).toContain('openai.responses');
    });
    it('sibling — a different status (503) and provider: the field names that model', async () => {
      vi.stubEnv('NODE_ENV', env);
      vi.spyOn(console, 'error').mockImplementation(() => {});
      const res = await post(apiWith(failing(503, 'acme-large-2', 'acme.chat')), '/agents/a/run', { runId: `a5-503-${env}`, prompt: 'x' });
      const body: any = await res.json();
      expect(String(body.upstreamModel)).toContain('acme-large-2');
      expect(JSON.stringify(body)).toContain('acme.chat');
    });
  });
}
