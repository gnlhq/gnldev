// d25 A15 (cli/KARAR-6, option A), Studio's twin of toNodeHandler (packages/studio/src/node.ts — the decision says
// the copy must change with the server's, so the two cannot drift): a function is accepted and served; anything
// else is refused at construction, by name.
import { describe, it, expect, afterEach } from 'vitest';
import { createServer, type Server } from 'node:http';
import { AddressInfo } from 'node:net';
import { InMemoryJournal } from '@gnldev/durable';
import { createStudioApi } from '../src/server.js';
import { toNodeHandler } from '../src/node.js';

const servers: Server[] = [];
afterEach(async () => { await Promise.all(servers.splice(0).map((s) => new Promise<void>((r) => s.close(() => r())))); });

async function serve(handler: unknown, path: string): Promise<{ status: number; body: string }> {
  const server = createServer(toNodeHandler(handler as never));
  servers.push(server);
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
  const res = await fetch(`http://127.0.0.1:${(server.address() as AddressInfo).port}${path}`);
  return { status: res.status, body: await res.text() };
}
const thrown = (f: () => unknown) => { try { f(); return undefined; } catch (e) { return String((e as Error)?.message ?? e); } };

describe('A15 (Studio): toNodeHandler accepts a function', () => {
  it('a plain function wrapping the studio api answers exactly as the api itself', async () => {
    const studio: any = createStudioApi({ reader: new InMemoryJournal() } as any);
    const direct = await serve(studio, '/api/runs');
    expect(direct.status, 'control: the real handler is served').not.toBe(500);
    const wrapped = await serve((req: Request) => studio(req), '/api/runs');
    expect(wrapped).toEqual(direct);
  });
  it('sibling — any async (Request) => Response function is served as-is', async () => {
    expect(await serve(async () => new Response('fn ok', { status: 202 }), '/x')).toEqual({ status: 202, body: 'fn ok' });
  });
});

describe('A15 (Studio): a non-handler is refused at construction, by name', () => {
  for (const [label, value] of [['an object without .fetch', { handle: () => new Response('x') }], ['undefined', undefined]] as const) {
    it(label, () => {
      const m = thrown(() => toNodeHandler(value as never));
      expect(m).toBeDefined();
      expect(m).toMatch(/toNodeHandler/);
      expect(m).toMatch(/fetch|createStudio/);
    });
  }
});
