// d25 A15 (cli/KARAR-6, option A): `toNodeHandler(x)` handled only the object createRestApi returns. A plain
// function wrapping it (`(req) => api(req)`) or an object without `.fetch` answered every request with an empty 500
// and logged nothing (deneme 13 lost hours to it). Option A: a function IS a fetch handler, so it is accepted and
// served; anything else is refused at construction, by name (toNodeHandler / what it expects).
// Studio's twin (packages/studio/src/node.ts) is covered in packages/studio/test/d25-a15-*.
//
// Builds on fix/d25-cli b3951963, made specific to option A (accept functions; refuse the rest by name).
import { describe, it, expect, afterEach } from 'vitest';
import { createServer, type Server } from 'node:http';
import { AddressInfo } from 'node:net';
import { InMemoryJournal } from '@gnldev/durable';
import { createRestApi } from '../src/index.js';
import { toNodeHandler } from '../src/node.js';

const servers: Server[] = [];
afterEach(async () => { await Promise.all(servers.splice(0).map((s) => new Promise<void>((r) => s.close(() => r())))); });

async function serve(handler: unknown, path = '/health'): Promise<{ status: number; body: string }> {
  const server = createServer(toNodeHandler(handler as never));
  servers.push(server);
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
  const res = await fetch(`http://127.0.0.1:${(server.address() as AddressInfo).port}${path}`);
  return { status: res.status, body: await res.text() };
}
const thrown = (f: () => unknown) => { try { f(); return undefined; } catch (e) { return String((e as Error)?.message ?? e); } };
const api = () => createRestApi({ journal: new InMemoryJournal(), agents: {} }, { protectionsBanner: false } as any);

describe('A15: toNodeHandler accepts a function', () => {
  it('control (green) — the createRestApi handler answers 200', async () => {
    expect((await serve(api())).status).toBe(200);
  });
  it('reported — a plain function wrapping the api is served (200, same body as the api itself)', async () => {
    const inner = api();
    const direct = await serve(inner);
    const wrapped = await serve((req: Request) => inner(req));
    expect(wrapped).toEqual(direct);
  });
  it('sibling — any async (Request) => Response function is served as-is', async () => {
    expect(await serve(async () => new Response('hello from fn', { status: 201 }), '/anything')).toEqual({ status: 201, body: 'hello from fn' });
  });
});

describe('A15: anything that is not a fetch handler is refused at construction, by name', () => {
  const cases: Array<[string, unknown]> = [
    ['an object without .fetch', { handle: () => new Response('x') }],
    ['undefined', undefined],
    ['a string', 'http://localhost:3000'],
  ];
  for (const [label, value] of cases) {
    it(label, () => {
      const m = thrown(() => toNodeHandler(value as never));
      expect(m, 'refused at construction (not a silent 500 later)').toBeDefined();
      expect(m).toMatch(/toNodeHandler/);
      expect(m).toMatch(/fetch|createRestApi/);
    });
  }
});
