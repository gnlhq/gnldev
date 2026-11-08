// d25 P5 / karar 15, chat door: same rule as REST — reasoning parts off by default, `stream: { reasoning: true }` turns them on.
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { InMemoryJournal } from '@gnldev/durable';
import { createChatRoute } from '../src/index.js';

const usage = { inputTokens: 1, outputTokens: 1, totalTokens: 2 };
const model = (): any => ({ specificationVersion: 'v2', provider: 'mock', modelId: 'm', supportedUrls: {}, doGenerate: async () => { throw new Error('x'); },
  doStream: async () => ({ stream: new ReadableStream({ start(c) { for (const p of [{ type: 'stream-start', warnings: [] }, { type: 'reasoning-start', id: 'r' }, { type: 'reasoning-delta', id: 'r', delta: 'secret thought' }, { type: 'reasoning-end', id: 'r' }, { type: 'text-start', id: '1' }, { type: 'text-delta', id: '1', delta: 'ok-answer' }, { type: 'text-end', id: '1' }, { type: 'finish', finishReason: 'stop', usage }]) c.enqueue(p); c.close(); } }) }) });
async function turn(extra: Record<string, unknown>, id: string) {
  const app = createChatRoute({ journal: new InMemoryJournal(), agents: { chat: { model: model() } }, ...extra } as any, { identify: () => ({ userId: 'u1' }) as any, allowedHosts: ['localhost'] } as any);
  return (await app.request('http://localhost/agents/chat/chat', { method: 'POST', headers: { 'content-type': 'application/json', host: 'localhost' }, body: JSON.stringify({ id, messages: [{ id: 'm1', role: 'user', parts: [{ type: 'text', text: 'hi' }] }] }) })).text();
}
beforeEach(() => { vi.spyOn(console, 'warn').mockImplementation(() => {}); });

describe('15: chat reasoning is opt-in', () => {
  it('default: no reasoning chunk, answer present', async () => {
    const t = await turn({}, 'c15a');
    expect(t).not.toContain('secret thought');
    expect(t).not.toContain('reasoning-');
    expect(t).toContain('ok-answer');
  });
  it('config stream.reasoning=true: the reasoning chunks arrive', async () => {
    const t = await turn({ stream: { reasoning: true } }, 'c15b');
    expect(t).toContain('secret thought');
  });
});
