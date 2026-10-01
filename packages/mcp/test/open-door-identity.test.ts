// The MCP door, over the real streamable-HTTP transport: the same identity rule as the chat and AG-UI
// doors, the ways through it names actually work here, and the refusal is a JSON-RPC SERVER error.
//
// Measured by the round-2 panel, before:
//   · review2-C door-guard.mjs — `identify: () => undefined` (the way through the cross_site_refused
//     page named) hid every tool on this door: every row "no such tool", tools/list `[]`. A way through
//     that does not go through.
//   · review2-B doors.mjs — a host / cross-site refusal reached the client as `-32603` (InternalError):
//     the SDK maps any error without a numeric `code` to it, so a deliberate refusal read as a crash.
// Invariants: (1) a request that resolved no principal gets the host rule and the cross-site check, with
// or without `identify`; (2) each way through the refusal names — `allowedHosts`, `allowCrossSite: true`,
// an `identify` that resolves the caller — reaches the tool on this door; (3) the refusal is a JSON-RPC
// error in the implementation-defined server range (-32000..-32099), with the gnl code in `data`.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { createMcpServer, serveMcp } from '../src/server.js';
import { subject } from './principals.js';

const call = { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'purge', arguments: {} } };

async function rpc(opts: Record<string, unknown>, headers: Record<string, string>, body: unknown = call) {
  const ran: string[] = [];
  const server = createMcpServer({ tools: { purge: { description: 'purge', execute: async () => { ran.push('purge'); return 'ok'; } } }, ...opts } as any);
  const { WebStandardStreamableHTTPServerTransport } = (await import('@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js')) as any;
  const t = new WebStandardStreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
  await serveMcp(server, t);
  const res: Response = await t.handleRequest(new Request(`http://${headers.host ?? 'localhost'}/mcp`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream', ...headers },
    body: JSON.stringify(body),
  }));
  return { json: (await res.json()) as any, ran };
}
const crossSite = { host: 'localhost:4111', origin: 'https://customer.example', 'sec-fetch-site': 'cross-site' };
const rebound = { host: 'evil.example:4111', 'sec-fetch-site': 'same-origin' };
const byBearer = (req: Request) => (req.headers.get('authorization') === 'Bearer ok' ? subject('u1') : undefined);

beforeEach(() => { vi.spyOn(console, 'warn').mockImplementation(() => {}); });
afterEach(() => { delete process.env.GNL_ALLOWED_HOSTS; vi.restoreAllMocks(); });

describe('MCP refusal is a JSON-RPC server error', () => {
  it('panel: a cross-site call is refused with a code in -32000..-32099 (not -32603), the gnl code in data', async () => {
    const { json, ran } = await rpc({}, crossSite);
    expect(json.error.code).toBeGreaterThanOrEqual(-32099);
    expect(json.error.code).toBeLessThanOrEqual(-32000);
    expect(json.error.data.code).toBe('cross_site_refused');
    expect(json.error.message).toContain('allowCrossSite: true in the createMcpServer options');
    expect(ran).toEqual([]);
  });
  it('sibling: a rebound name is refused the same way, data names the host', async () => {
    const { json } = await rpc({}, rebound);
    expect(json.error.code).toBe(-32000);
    expect(json.error.data).toMatchObject({ code: 'host_not_allowed', host: 'evil.example' });
  });
});

describe('the ways through the refusal names work on MCP', () => {
  it('panel: an identify that answers undefined is no identity — the rebound call is refused by the host rule, not hidden as "no such tool"', async () => {
    const { json } = await rpc({ identify: () => undefined }, rebound);
    expect(json.error.data.code).toBe('host_not_allowed');
  });
  it('allowCrossSite: true reaches the tool from another site', async () => {
    const { json, ran } = await rpc({ allowCrossSite: true }, crossSite);
    expect(json.error).toBeUndefined();
    expect(ran).toEqual(['purge']);
  });
  it('allowedHosts reaches the tool on a listed name', async () => {
    const { json, ran } = await rpc({ allowedHosts: ['evil.example'] }, rebound);
    expect(json.error).toBeUndefined();
    expect(ran).toEqual(['purge']);
  });
  it('an identify that resolves the caller reaches the tool cross-site and on any name', async () => {
    const a = await rpc({ identify: byBearer }, { ...crossSite, authorization: 'Bearer ok' });
    const b = await rpc({ identify: byBearer }, { ...rebound, authorization: 'Bearer ok' });
    expect([a.json.error, b.json.error]).toEqual([undefined, undefined]);
    expect([...a.ran, ...b.ran]).toEqual(['purge', 'purge']);
  });
  it('the same identify with no token is refused cross-site (it resolved nobody)', async () => {
    const { json, ran } = await rpc({ identify: byBearer }, crossSite);
    expect(json.error.data.code).toBe('cross_site_refused');
    expect(ran).toEqual([]);
  });
});
