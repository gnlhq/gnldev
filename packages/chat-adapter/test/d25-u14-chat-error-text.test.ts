// d25 U14 (chat) — the chat stream's error part, for a provider that answered 404 at /v1/responses.
import { describe, it, expect, vi, afterEach } from 'vitest';
import { InMemoryJournal } from '@gnldev/durable';
import { createChatRoute } from '../src/index.js';

const upstream = Object.assign(new Error('Not Found'), {
  name: 'AI_APICallError', statusCode: 404, isRetryable: false,
  url: 'https://integrate.example/v1/responses?key=SUPERSECRETKEY123',
  responseBody: '404 page not found. key sk-abcd' + 'efghijklmnop1234',
});
const failing: any = { specificationVersion: 'v2', provider: 'openai.responses', modelId: 'm', supportedUrls: {}, doGenerate: async () => { throw upstream; }, doStream: async () => { throw upstream; } };
const boom: any = { specificationVersion: 'v2', provider: 'x', modelId: 'm', supportedUrls: {}, doGenerate: async () => { throw new Error('db password is hunter2'); }, doStream: async () => { throw new Error('db password is hunter2'); } };
const SECRETS = /SUPERSECRETKEY123|sk-abcd[e]fghijklmnop1234/;

async function chat(model: any, id: string) {
  const app = createChatRoute({ journal: new InMemoryJournal(), agents: { chat: { model } } } as any, { identify: () => ({ userId: 'u1' }) as any, allowedHosts: ['localhost'] } as any);
  const res = await app.request('http://localhost/agents/chat/chat', { method: 'POST', headers: { 'content-type': 'application/json', host: 'localhost' }, body: JSON.stringify({ id, messages: [{ id: 'm1', role: 'user', parts: [{ type: 'text', text: 'hi' }] }] }) });
  return res.text();
}

describe('U14 chat stream error text', () => {
  afterEach(() => { vi.unstubAllEnvs(); });
  it('a provider failure names its status and URL (no query, no credential)', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const t = await chat(failing, 'c1');
    expect(t).toContain('Model provider error (HTTP 404)');
    expect(t).toContain('https://integrate.example/v1/responses');
    expect(t).not.toMatch(SECRETS);
    expect(t).not.toContain('An error occurred.');
  });
  it('in production: the status only', async () => {
    vi.stubEnv('NODE_ENV', 'production');
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const t = await chat(failing, 'c2');
    expect(t).toContain('Model provider error (HTTP 404)');
    expect(t).not.toContain('integrate.example');
  });
  it('any other error stays masked (the host\'s own message is not shown to the end user)', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const t = await chat(boom, 'c3');
    expect(t).toContain('An error occurred.');
    expect(t).not.toContain('hunter2');
  });
});
