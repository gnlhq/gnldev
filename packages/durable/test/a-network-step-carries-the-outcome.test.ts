// A network's router was told only the sub-agent's prose ("I handled it." over a failed booking). The
// step carries the outcome read from the sub-agent's tools, and the router is shown it.
import { it, expect } from 'vitest';
import { z } from 'zod';
import { InMemoryStorage, createGnl, gnlTool, STAFF } from '../src/index.js';
import { createMockModel, toolCallResult, finalTextResult } from './mock.js';
it('a network step carries the sub-agent\'s outcome', async () => {
  let seen = ''; let routed = 0;
  const book = gnlTool({ description: 'book', inputSchema: z.object({}).passthrough(), execute: async () => { throw new Error('provider down'); } }, { sideEffect: false } as any);
  const worker = createMockModel(async ({ prompt }: any) => prompt.some((m: any) => m.role === 'tool') ? finalTextResult('I handled it.') : toolCallResult('book', 'call_0', { id: 'R-1' }));
  const router = createMockModel(async ({ prompt }: any) => {
    if (routed++ === 0) return finalTextResult(JSON.stringify({ action: 'route', agent: 'w', task: 'book R-1' }));
    seen = (JSON.stringify(prompt).match(/agent=w.{0,200}/)?.[0]) ?? '';
    return finalTextResult(JSON.stringify({ action: 'final', answer: 'done' }));
  });
  const r: any = await createGnl({ storage: new InMemoryStorage(), agents: { w: { model: worker, tools: { book } } }, networks: { n: { router, agents: ['w'] } } } as any)
    .runNetwork('n', { runId: 'n1', task: 'book R-1', caller: STAFF } as any);
  expect(seen).toContain('FAILED (book: provider down)');
  expect(r.steps[0]).toMatchObject({ status: 'failed', failed: [{ tool: 'book', kind: 'error', message: 'provider down' }] });
});
