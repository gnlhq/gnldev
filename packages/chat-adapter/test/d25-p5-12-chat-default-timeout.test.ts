// d25 P5 / karar 12, chat door: no timeouts configured, a frozen provider ends the turn after the 120 s default.
import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';
import { InMemoryJournal } from '@gnldev/durable';
import { createChatRoute } from '../src/index.js';

const hang: any = { specificationVersion: 'v2', provider: 'mock', modelId: 'm', supportedUrls: {}, doGenerate: async () => new Promise(() => {}), doStream: async () => new Promise(() => {}) };
beforeEach(() => { vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] }); vi.spyOn(console, 'error').mockImplementation(() => {}); vi.spyOn(console, 'warn').mockImplementation(() => {}); });
afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); });

describe('12: chat inherits the default model-step limit', () => {
  it('the frozen turn ends with a finished response after 120 s, not before', async () => {
    const app = createChatRoute({ journal: new InMemoryJournal(), agents: { chat: { model: hang } } } as any);
    const res = await app.request('/agents/chat/chat', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ id: 'c', messages: [{ id: 'm1', role: 'user', parts: [{ type: 'text', text: 'hi' }] }] }) });
    let done = false; const t = res.text().then((x) => { done = true; return x; });
    await vi.advanceTimersByTimeAsync(100_000);
    expect(done).toBe(false);
    await vi.advanceTimersByTimeAsync(30_000);
    expect(done).toBe(true);
    expect(await t).toContain('error');
  });
});
