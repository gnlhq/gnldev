// d25 U14 — a model endpoint answering 404 (e.g. @ai-sdk/openai's default model → /v1/responses on an OpenAI-compatible host).
// What do the surfaces and the journal tell the developer? Measured live against NVIDIA in test/d25-real/u14.ts; this is the modelless twin.
// The fake error carries a credential in the URL's query and in the body, to pin that neither is ever shown or kept.
import { describe, it, expect, vi, afterEach } from 'vitest';
import { InMemoryStorage, toJournal, readRunOutcome, upstreamFailure, upstreamWire } from '@gnldev/durable';
import { createRestApi } from '../src/index.js';

const upstream = Object.assign(new Error('Not Found'), {
  name: 'AI_APICallError', statusCode: 404, isRetryable: false,
  url: 'https://integrate.example/v1/responses?key=SUPERSECRETKEY123',
  responseBody: '404 page not found. Authorization: Bearer abcdef1234567890 and key sk-abcd' + 'efghijklmnop1234',
});
const failing: any = { specificationVersion: 'v2', provider: 'openai.responses', modelId: 'm', supportedUrls: {}, doGenerate: async () => { throw upstream; }, doStream: async () => { throw upstream; } };

const SECRETS = /SUPERSECRETKEY123|abcdef1234567890|sk-abcd[e]fghijklmnop1234/;

describe('U14 upstream 404 detail', () => {
  afterEach(() => { vi.unstubAllEnvs(); });
  const mk = (storage = new InMemoryStorage()) => createRestApi({ storage, agents: { a: { model: failing } } } as never, { protectionsBanner: false }) as (r: Request) => Promise<Response>;
  const post = (api: any, path: string, body: any) => api(new Request('http://localhost' + path, { method: 'POST', headers: { 'content-type': 'application/json', host: 'localhost' }, body: JSON.stringify(body) }));

  it('/run: 502 with the upstream status, the URL (no query) and a masked body excerpt', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const r = await post(mk(), '/agents/a/run', { runId: 'u14a', prompt: 'x' });
    const j: any = await r.json();
    expect(r.status).toBe(502);
    expect(j.upstreamStatus).toBe(404);
    expect(j.upstreamUrl).toBe('https://integrate.example/v1/responses');
    expect(j.upstreamBody).toContain('404 page not found');
    expect(JSON.stringify(j)).not.toMatch(SECRETS);
  });
  it('in production the wire keeps the URL and drops the body excerpt (upstreamWire)', () => {
    vi.stubEnv('NODE_ENV', 'production');
    const up = upstreamFailure(upstream)!;
    expect(upstreamWire(up)).toEqual({ upstreamUrl: 'https://integrate.example/v1/responses' });
    vi.stubEnv('NODE_ENV', 'test');
    expect(upstreamWire(up).upstreamBody).toContain('404 page not found');
  });
  it('/stream error frame carries the status and the URL', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const r = await post(mk(), '/agents/a/stream', { runId: 'u14b', prompt: 'x' });
    const t = await r.text();
    expect(t).toContain('"upstreamStatus":404');
    expect(t).toContain('https://integrate.example/v1/responses');
    expect(t).not.toMatch(SECRETS);
  });
  it('the journal outcome keeps the status, the URL and the masked excerpt', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const storage = new InMemoryStorage();
    await post(mk(storage), '/agents/a/run', { runId: 'u14j', prompt: 'x' });
    const o: any = await readRunOutcome(toJournal(storage.runs), 'u14j');
    expect(o).toMatchObject({ status: 'failed', errorStatus: 404, errorUrl: 'https://integrate.example/v1/responses' });
    expect(o.errorBody).toContain('404 page not found');
    expect(JSON.stringify(o)).not.toMatch(SECRETS);
  });
});
