// An MCP server with no `identify`, reached over HTTP, gets the protections a providerless REST API has.
// Over HTTP the transport hands each message the request it arrived in (`caller.request`); a DNS-rebound
// page is same-origin, so it can send the JSON and the Accept header the streamable-HTTP transport asks
// for — only its Host gives it away. Over stdio there is no request, and nothing changes.
// K1 = the review's case carried to this door; K2/K3 = siblings.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { InMemoryJournal } from '@gnldev/durable';
import { createMcpServer } from '../src/server.js';
import { subject } from './principals.js';

const reqWith = (headers: Record<string, string>) => new Request('http://localhost:4111/mcp', { method: 'POST', headers });

function setup(opts: Record<string, unknown> = {}) {
  const ran: string[] = [];
  const server = createMcpServer({
    journal: new InMemoryJournal(),
    tools: { purge: { description: 'purge', execute: async () => { ran.push('purge'); return 'ok'; } } },
    ...opts,
  } as any);
  return { server, ran };
}

beforeEach(() => { vi.spyOn(console, 'warn').mockImplementation(() => {}); });
afterEach(() => { delete process.env.GNL_ALLOWED_HOSTS; vi.restoreAllMocks(); });

describe('createMcpServer over HTTP with no identify', () => {
  it('K1: a call addressed to a rebound name is refused before the tool runs, naming the way through', async () => {
    const { server, ran } = setup();
    await expect(server.callTool({ name: 'purge', caller: { request: reqWith({ host: 'evil.example:4111', 'sec-fetch-site': 'same-origin' }) } }))
      .rejects.toThrow(/host_not_allowed.*allowedHosts: \['evil\.example'\] in the createMcpServer options/s);
    expect(ran).toEqual([]);
  });

  it('K1: the tool list is refused to it too (a rebound page could read it)', async () => {
    const { server } = setup();
    await expect(server.listTools({ caller: { request: reqWith({ host: 'evil.example' }) } })).rejects.toThrow(/host_not_allowed/);
  });

  it('K2: a cross-site call is refused', async () => {
    const { server, ran } = setup();
    await expect(server.callTool({ name: 'purge', caller: { request: reqWith({ host: 'localhost:4111', 'sec-fetch-site': 'cross-site' }) } })).rejects.toThrow(/cross_site_refused/);
    expect(ran).toEqual([]);
  });

  it('K2: localhost over HTTP, stdio (no request) and an in-process call are answered; allowedHosts lets a name in', async () => {
    const { server, ran } = setup();
    await server.callTool({ name: 'purge', caller: { request: reqWith({ host: 'localhost:4111' }) } });
    await server.callTool({ name: 'purge' });
    const listed = setup({ allowedHosts: ['api'] });
    await listed.server.callTool({ name: 'purge', caller: { request: reqWith({ host: 'api:4111' }) } });
    expect([...ran, ...listed.ran]).toEqual(['purge', 'purge', 'purge']);
  });

  it('K3: with identify the application owns the boundary (its caller is served on any host)', async () => {
    const { server, ran } = setup({ identify: () => subject('acme') });
    await server.callTool({ name: 'purge', caller: { request: reqWith({ host: 'evil.example' }) } });
    expect(ran).toEqual(['purge']);
  });
});
