// DNS rebinding against the providerless (auth-off, loopback) Studio, over a real loopback socket.
//
// A rebound page is served from http://evil.example:<port>; once evil.example resolves to 127.0.0.1
// its requests are SAME-ORIGIN to the browser, so it sends `Sec-Fetch-Site: same-origin` and the
// cross-site check waves it through. The one header it cannot choose is Host. Measured before the
// fix: the rebound POST /api/retention/sweep purged the seeded run, and GET /api/runs answered 200
// with the run in it — which a same-origin page can read.
import { describe, it, expect, afterAll, vi } from 'vitest';
import http from 'node:http';
import { serve } from '@hono/node-server';
import { InMemoryJournal } from '@gnldev/durable';
import { roleAuth } from '@gnldev/auth';
import { createStudioApp } from '../src/server.js';

vi.spyOn(console, 'warn').mockImplementation(() => {});
const servers: { close(): void }[] = [];
afterAll(() => { for (const s of servers) s.close(); });

function listen(fetch: (r: Request) => Promise<Response> | Response): Promise<number> {
  return new Promise((resolve) => {
    const s = serve({ fetch, port: 0, hostname: '127.0.0.1' }, (info) => resolve(info.port));
    servers.push(s);
  });
}
type Answer = { status: number; body: string; type: string };
function send(port: number, method: string, path: string, headers: Record<string, string>, body?: string): Promise<Answer> {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, path, method, headers: { 'content-type': 'application/json', ...headers } }, (res) => {
      let b = '';
      const type = String(res.headers['content-type'] ?? '');
      // An SSE stream never ends on its own: the status and the first bytes are the answer.
      if (type.includes('text/event-stream')) { res.destroy(); resolve({ status: res.statusCode!, body: '', type }); return; }
      res.on('data', (d) => (b += d));
      res.on('end', () => resolve({ status: res.statusCode!, body: b, type }));
    });
    req.on('error', reject);
    req.end(body);
  });
}
const rebound = (port: number) => ({ host: `evil.example:${port}`, origin: `http://evil.example:${port}`, 'sec-fetch-site': 'same-origin', 'sec-fetch-mode': 'cors' });
const SWEEP = JSON.stringify({ olderThanMs: 0, keepSuspended: false });

async function seededStudio(extra: Record<string, unknown> = {}) {
  const journal = new InMemoryJournal();
  await journal.put('r-1:input', { _v: 2, prompt: 'a secret prompt' });
  await journal.put('r-1:model:0', { content: [{ type: 'text', text: 'a' }], finishReason: 'stop' });
  const port = await listen(createStudioApp({ reader: journal as never, ...extra } as never).fetch);
  return { journal, port };
}

describe('providerless Studio refuses a rebound page', () => {
  it('the retention sweep: 403 host_not_allowed, and the run is still there', async () => {
    const { journal, port } = await seededStudio();
    const r = await send(port, 'POST', '/api/retention/sweep', rebound(port), SWEEP);
    expect(r.status).toBe(403);
    expect(JSON.parse(r.body)).toMatchObject({ code: 'host_not_allowed', host: 'evil.example' });
    expect(await journal.get('r-1:model:0')).toBeTruthy();
  });

  it('the run list cannot be read', async () => {
    const { port } = await seededStudio();
    const r = await send(port, 'GET', '/api/runs', { host: `evil.example:${port}`, 'sec-fetch-site': 'same-origin' });
    expect({ status: r.status, leaks: r.body.includes('r-1') }).toEqual({ status: 403, leaks: false });
  });

  it('the live event stream cannot be opened', async () => {
    const { port } = await seededStudio();
    const r = await send(port, 'GET', '/api/events', { host: `evil.example:${port}`, 'sec-fetch-site': 'same-origin', accept: 'text/event-stream' });
    expect(r.status).toBe(403);
    expect(r.type).not.toContain('text/event-stream');
  });

  it('HEAD cannot probe it either', async () => {
    const { port } = await seededStudio();
    const r = await send(port, 'HEAD', '/api/runs', { host: `evil.example:${port}` });
    expect(r.status).toBe(403);
  });

  it('CONTROL: loopback names keep working — localhost, 127.0.0.1, [::1], localhost., app.localhost', async () => {
    const { port } = await seededStudio();
    for (const h of [`localhost:${port}`, `127.0.0.1:${port}`, `[::1]:${port}`, `localhost.:${port}`, `app.localhost:${port}`]) {
      const r = await send(port, 'GET', '/api/runs', { host: h, 'sec-fetch-site': 'same-origin' });
      expect({ h, status: r.status, has: r.body.includes('r-1') }).toEqual({ h, status: 200, has: true });
    }
    const w = await send(port, 'POST', '/api/retention/sweep', { host: `localhost:${port}`, 'sec-fetch-site': 'same-origin' }, SWEEP);
    expect(w.status).toBe(200);
  });

  it('the way through: allowedHosts serves a listed name', async () => {
    const { port } = await seededStudio({ allowedHosts: ['mybox.test'] });
    const ok = await send(port, 'GET', '/api/runs', { host: `mybox.test:${port}`, 'sec-fetch-site': 'same-origin' });
    expect(ok.status).toBe(200);
    const no = await send(port, 'GET', '/api/runs', { host: `evil.example:${port}`, 'sec-fetch-site': 'same-origin' });
    expect(no.status).toBe(403);
  });

  it('REFUTATION: with an identity-binding provider, the host rule does not apply — the token does', async () => {
    const { journal, port } = await seededStudio({ auth: roleAuth({ admin: { token: 'a-long-admin-token-xxxxxxxxxxxx' } }) });
    const bare = await send(port, 'POST', '/api/retention/sweep', rebound(port), SWEEP);
    expect([401, 403]).toContain(bare.status);
    expect(JSON.parse(bare.body).code).not.toBe('host_not_allowed');
    expect(await journal.get('r-1:model:0')).toBeTruthy();
    // A real deployment name with the token keeps working.
    const tok = await send(port, 'GET', '/api/runs', { host: `studio.example.com:${port}`, authorization: 'Bearer a-long-admin-token-xxxxxxxxxxxx' });
    expect(tok.status).toBe(200);
  });
});

describe('every Studio route, asked by a rebound page', () => {
  // The rule lives in the gate, so a route that never asks the gate is not covered by it. This walks
  // the whole inventory and names what still answers 2xx to a rebound name, so a new ungated route
  // that serves data fails here instead of shipping. The allowed entries are the ones that answer the
  // same thing to anybody with or without auth: the SPA shell and its assets, the API description,
  // the licence notices, health.
  const PUBLIC = new Set([
    'GET /', 'GET /assets/*', 'GET /*', 'GET /api/openapi.json', 'GET /api/swagger', 'GET /openapi.json', 'GET /swagger',
    'GET /api/third-party-notices', 'GET /third-party-notices', 'GET /THIRD-PARTY-NOTICES.txt', 'GET /api/health', 'GET /health',
    'GET /api/capabilities',
  ]);
  it('no route that the gate does not guard serves data to a rebound name', async () => {
    const journal = new InMemoryJournal();
    await journal.put('r-1:input', { _v: 2, prompt: 'a secret prompt' });
    const app = createStudioApp({ reader: journal as never } as never) as unknown as { routeTable: { method: string; path: string }[]; fetch: (r: Request) => Promise<Response> };
    const answered: string[] = [];
    for (const r of app.routeTable.filter((x) => x.method !== 'ALL')) {
      const url = r.path.replace(/:([A-Za-z_]\w*)/g, 'X').replace(/\*/g, 'probe');
      const init: RequestInit = { method: r.method, headers: { host: 'evil.example:4747', 'sec-fetch-site': 'same-origin', 'content-type': 'application/json' } };
      if (!['GET', 'HEAD'].includes(r.method)) init.body = '{}';
      const res = await Promise.race([app.fetch(new Request(`http://evil.example:4747${url}`, init)), new Promise<Response>((ok) => setTimeout(() => ok(new Response(null, { status: 599 })), 3000))]);
      await res.body?.cancel().catch(() => {});
      if (res.status < 300 && !PUBLIC.has(`${r.method} ${r.path}`)) answered.push(`${r.method} ${r.path} → ${res.status}`);
    }
    expect(answered).toEqual([]);
  }, 60_000);
});
