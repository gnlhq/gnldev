// d25 P5 / karar 15, AG-UI door: same rule — reasoning events off by default, `stream: { reasoning: true }` on.
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { InMemoryJournal } from '@gnldev/durable';
import { createAguiRoute } from '../src/index.js';

const usage = { inputTokens: 1, outputTokens: 1, totalTokens: 2 };
const model = (): any => ({ specificationVersion: 'v2', provider: 'mock', modelId: 'm', supportedUrls: {}, doGenerate: async () => { throw new Error('x'); },
  doStream: async () => ({ stream: new ReadableStream({ start(c) { for (const p of [{ type: 'stream-start', warnings: [] }, { type: 'reasoning-start', id: 'r' }, { type: 'reasoning-delta', id: 'r', delta: 'secret thought' }, { type: 'reasoning-end', id: 'r' }, { type: 'text-start', id: '1' }, { type: 'text-delta', id: '1', delta: 'ok-answer' }, { type: 'text-end', id: '1' }, { type: 'finish', finishReason: 'stop', usage }]) c.enqueue(p); c.close(); } }) }) });
const run = async (extra: Record<string, unknown>, runId: string) => {
  const h = createAguiRoute({ journal: new InMemoryJournal(), agents: { a: { model: model() } }, ...extra } as any);
  return (await h(new Request('http://localhost/agents/a/run', { method: 'POST', headers: { host: 'localhost:4111', 'content-type': 'application/json' }, body: JSON.stringify({ runId, prompt: 'hello' }) }))).text();
};
beforeEach(() => { vi.spyOn(console, 'warn').mockImplementation(() => {}); });

describe('15: AG-UI reasoning is opt-in', () => {
  it('default: no reasoning event, the answer streams', async () => {
    const t = await run({}, 'a15a');
    expect(t).not.toContain('secret thought');
    expect(t).not.toMatch(/reasoning/i);
    expect(t).toContain('ok-answer');
  });
  it('config stream.reasoning=true: the reasoning arrives', async () => {
    expect(await run({ stream: { reasoning: true } }, 'a15b')).toContain('secret thought');
  });
});
