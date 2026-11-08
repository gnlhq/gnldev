// d25 A14 (cli/KARAR-5, option A): /openapi.json lists every path the API serves, including the wire formats
// mounted through `surfaces` (chat, AG-UI, a custom one). The chat route `useChat` calls worked but was absent from
// the schema; a reader (or a generated client) could not find it. One owner: createRestApi hands the surface paths
// to the schema builder. Option A lists each surface path with a POST operation and a generic body; a per-surface
// body schema (option B) is a later enrichment and is NOT required here.
//
// Builds on fix/d25-cli 29898fd8 (stub surfaces); siblings use the REAL chat and AG-UI surfaces.
import { describe, it, expect } from 'vitest';
import { InMemoryStorage } from '@gnldev/durable';
import { createRestApi, type StreamSurface } from '../src/index.js';
import { chatSurface } from '../../chat-adapter/src/index.js';
import { aguiSurface } from '../../agui/src/route.js';

const model: any = { specificationVersion: 'v2', provider: 'm', modelId: 'm', supportedUrls: {}, doGenerate: async () => { throw new Error('x'); }, doStream: async () => { throw new Error('x'); } };
const stub = (path: string): StreamSurface => ({ path, decode: () => ({ prompt: 'x' }), encode: () => new Response('') });

async function schema(surfaces: StreamSurface[]) {
  const api = createRestApi({ storage: new InMemoryStorage(), memory: false, agents: { a: { model }, b: { model } } } as never, { surfaces, protectionsBanner: false } as never);
  const res = await api(new Request('http://x/openapi.json'));
  expect(res.status).toBe(200);
  return (await res.json()) as { paths: Record<string, Record<string, unknown>> };
}
const expectPost = (s: { paths: Record<string, Record<string, unknown>> }, p: string) => {
  expect(Object.keys(s.paths), `paths: ${Object.keys(s.paths).join(', ')}`).toContain(p);
  expect(Object.keys(s.paths[p]!).map((m) => m.toLowerCase())).toContain('post');
};

describe('A14: /openapi.json lists the surfaces the API serves', () => {
  it('reported — the real chat surface: /agents/a/chat and /agents/b/chat, as POST', async () => {
    const s = await schema([chatSurface() as unknown as StreamSurface]);
    expect(Object.keys(s.paths)).toContain('/agents/a/run'); // control: REST paths already listed
    expectPost(s, '/agents/a/chat');
    expectPost(s, '/agents/b/chat');
  });
  it('sibling — the real AG-UI surface: /agents/a/agui', async () => {
    const s = await schema([aguiSurface() as unknown as StreamSurface]);
    expectPost(s, '/agents/a/agui');
    expectPost(s, '/agents/b/agui');
  });
  it('sibling — chat and AG-UI mounted together: both listed', async () => {
    const s = await schema([chatSurface() as unknown as StreamSurface, aguiSurface() as unknown as StreamSurface]);
    expectPost(s, '/agents/a/chat');
    expectPost(s, '/agents/a/agui');
  });
  it('sibling — a chat surface on a custom path is listed under that path', async () => {
    const s = await schema([chatSurface({ path: '/agents/:name/talk' }) as unknown as StreamSurface]);
    expectPost(s, '/agents/a/talk');
    expect(Object.keys(s.paths)).not.toContain('/agents/a/chat');
  });
  it('sibling — a custom (non-chat) surface is listed too', async () => {
    const s = await schema([stub('/agents/:name/echo')]);
    expectPost(s, '/agents/a/echo');
  });
  it('control (green on 0.17.1) — no surfaces: no surface paths appear', async () => {
    const s = await schema([]);
    expect(Object.keys(s.paths).filter((p) => /\/(chat|agui|talk|echo)$/.test(p))).toEqual([]);
  });
});
