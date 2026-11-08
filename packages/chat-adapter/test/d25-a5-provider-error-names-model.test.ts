// d25 A5 (stream/KARAR-05, option A), the chat door: what the browser is told about a provider failure names the
// model that failed and its provider — in production too. Today production hides even the URL, so the chat
// error says only "Model provider error (HTTP 404)".
import { describe, it, expect, vi, afterEach } from 'vitest';
import { InMemoryJournal } from '@gnldev/durable';
import { createChatRoute } from '../src/index.js';

afterEach(() => { vi.unstubAllEnvs(); vi.restoreAllMocks(); });

const up = () => Object.assign(new Error('Not Found'), { name: 'AI_APICallError', statusCode: 404, url: 'https://h.example/v1/responses' });
const bad: any = { specificationVersion: 'v2', provider: 'openai.responses', modelId: 'meta/llama-9', supportedUrls: {}, doGenerate: async () => { throw up(); }, doStream: async () => { throw up(); } };

for (const env of ['development', 'production'] as const) {
  it(`A5 (chat, ${env}): the chat answer to a 404 names the model and the provider`, async () => {
    vi.stubEnv('NODE_ENV', env);
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const app = createChatRoute({ journal: new InMemoryJournal(), agents: { chat: { model: bad } } } as any, { identify: () => ({ userId: 'u1' }) as any, allowedHosts: ['localhost'] } as any);
    const res = await app.request('http://localhost/agents/chat/chat', { method: 'POST', headers: { 'content-type': 'application/json', host: 'localhost' }, body: JSON.stringify({ id: `a5-${env}`, messages: [{ id: 'm1', role: 'user', parts: [{ type: 'text', text: 'hi' }] }] }) });
    const text = await res.text();
    expect(text).toMatch(/404/); // control: the status is already said
    expect(text).toContain('meta/llama-9');
    expect(text).toContain('openai.responses');
  });
}
