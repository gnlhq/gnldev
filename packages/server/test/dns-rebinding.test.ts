// DNS rebinding against a providerless REST API (what `gnl dev` serves by default), over a real
// loopback socket. The rebound page's requests are same-origin to the browser, so `Sec-Fetch-Site`
// says `same-origin`; only the Host header tells this server the page was not addressed to it.
// Measured before the fix: POST /agents/a/run from Host evil.example answered 200 and called the model.
import { describe, it, expect, afterAll, vi } from 'vitest';
import http from 'node:http';
import { serve } from '@hono/node-server';
import { InMemoryStorage } from '@gnldev/durable';
import { echoModel } from '@gnldev/durable/mock';
import { createRestApi } from '../src/index.js';

vi.spyOn(console, 'warn').mockImplementation(() => {});
const servers: { close(): void }[] = [];
afterAll(() => { for (const s of servers) s.close(); });

function listen(fetch: (r: Request) => Promise<Response> | Response): Promise<number> {
  return new Promise((resolve) => {
    const s = serve({ fetch, port: 0, hostname: '127.0.0.1' }, (info) => resolve(info.port));
    servers.push(s);
  });
}
function send(port: number, method: string, path: string, headers: Record<string, string>, body?: string): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, path, method, headers: { 'content-type': 'application/json', ...headers } }, (res) => {
      let b = '';
      if (String(res.headers['content-type'] ?? '').includes('text/event-stream')) { res.destroy(); resolve({ status: res.statusCode!, body: '' }); return; }
      res.on('data', (d) => (b += d));
      res.on('end', () => resolve({ status: res.statusCode!, body: b }));
    });
    req.on('error', reject);
    req.end(body);
  });
}
const rebound = (port: number) => ({ host: `evil.example:${port}`, origin: `http://evil.example:${port}`, 'sec-fetch-site': 'same-origin', 'sec-fetch-mode': 'cors' });

function countingApi(opts: Record<string, unknown> = {}) {
  const state = { calls: 0 };
  const inner = echoModel() as unknown as Record<string, (o: unknown) => Promise<unknown>>;
  const model = {
    ...inner,
    doGenerate: async (o: unknown) => { state.calls++; return inner.doGenerate!(o); },
    doStream: async (o: unknown) => { state.calls++; return inner.doStream!(o); },
  };
  const api = createRestApi({ storage: new InMemoryStorage(), memory: false, agents: { a: { model } } } as never, { protectionsBanner: false, ...opts } as never);
  return { api, state };
}

describe('providerless REST refuses a rebound page', () => {
  it('an agent run: 403 host_not_allowed, and the model is never called', async () => {
    const { api, state } = countingApi();
    const port = await listen(api.fetch);
    const r = await send(port, 'POST', '/agents/a/run', rebound(port), JSON.stringify({ runId: 'x1', prompt: 'hi' }));
    expect({ status: r.status, modelCalls: state.calls }).toEqual({ status: 403, modelCalls: 0 });
    expect(JSON.parse(r.body)).toMatchObject({ code: 'host_not_allowed' });
    expect(JSON.parse(r.body).error).toContain('GNL_ALLOWED_HOSTS');
  });

  it('a stream: refused before any model call', async () => {
    const { api, state } = countingApi();
    const port = await listen(api.fetch);
    const r = await send(port, 'POST', '/agents/a/stream', rebound(port), JSON.stringify({ runId: 'x2', prompt: 'hi' }));
    expect({ status: r.status, modelCalls: state.calls }).toEqual({ status: 403, modelCalls: 0 });
  });

  it('the run list cannot be read', async () => {
    const { api } = countingApi();
    const port = await listen(api.fetch);
    await send(port, 'POST', '/agents/a/run', { host: `localhost:${port}` }, JSON.stringify({ runId: 'seen-1', prompt: 'a secret prompt' }));
    const r = await send(port, 'GET', '/runs', { host: `evil.example:${port}`, 'sec-fetch-site': 'same-origin' });
    expect({ status: r.status, leaks: r.body.includes('seen-1') }).toEqual({ status: 403, leaks: false });
  });

  it('CONTROL: localhost, [::1] and a LAN address run the agent', async () => {
    const { api, state } = countingApi();
    const port = await listen(api.fetch);
    for (const [i, h] of [`localhost:${port}`, `[::1]:${port}`, `192.168.1.20:${port}`].entries()) {
      const r = await send(port, 'POST', '/agents/a/run', { host: h, 'sec-fetch-site': 'same-origin' }, JSON.stringify({ runId: `ok-${i}`, prompt: 'hi' }));
      expect({ h, status: r.status }).toEqual({ h, status: 200 });
    }
    expect(state.calls).toBe(3);
  });

  it('the way through: allowedHosts (a tunnel\'s domain) runs the agent', async () => {
    const { api, state } = countingApi({ allowedHosts: ['.ngrok-free.app'] });
    const port = await listen(api.fetch);
    const r = await send(port, 'POST', '/agents/a/run', { host: 'ab12.ngrok-free.app', 'sec-fetch-site': 'same-origin' }, JSON.stringify({ runId: 't1', prompt: 'hi' }));
    expect(r.status).toBe(200);
    expect(state.calls).toBe(1);
  });

  it('health stays answerable by any name (it answers the same with auth on)', async () => {
    const { api } = countingApi();
    const port = await listen(api.fetch);
    expect((await send(port, 'GET', '/health', { host: `evil.example:${port}` })).status).toBe(200);
  });
});
