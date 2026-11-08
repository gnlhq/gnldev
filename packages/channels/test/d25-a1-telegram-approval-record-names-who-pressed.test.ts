// THE APPROVAL RECORD NAMES WHO ANSWERED — Telegram (d25 approval integrity, step 1; KARAR-1 "KULLANICI KARARI — ADIM 1").
//
// Telegram answers only the person who asked (telegram.ts decide: `q.from.id !== asked.from.id` → refused).
// Step 1: that press is recorded as `answeredBy: telegram:<botId>:<userId>` (the channel's own spelling of
// a person, the same as the run's subject) and `answeredAs: 'requester'`.
import { describe, it, expect, afterEach, beforeAll, vi } from 'vitest';
import { InMemoryStorage, providerIdOf } from '@gnldev/durable';
import { jsonSchema } from 'ai';
import { telegramChannel } from '../src/index.js';

// Call ids are GNL ids (`c1.gnl-<run>-<step>-<n>`, the provider's id is the prefix): an approval row is found by the provider's id.
const isApprovalOf = (key: string, providerId: string): boolean => key.includes(':approval:') && providerIdOf(key.slice(key.lastIndexOf(':approval:') + ':approval:'.length)) === providerId;

beforeAll(() => { vi.spyOn(console, 'warn').mockImplementation(() => {}); });

const TOKEN = '123456:test-bot-secret';
const SECRET = 'webhook-secret_123';
const usage = { inputTokens: 1, outputTokens: 1, totalTokens: 2 };
const CALL = 'call_abcdefghijklmnopqrstuvwx';

function setup() {
  const state = { executed: 0 };
  const refund = { description: 'refund an order', inputSchema: jsonSchema({ type: 'object' }), confirm: true, execute: async () => { state.executed++; return { refunded: true }; } };
  const model: any = {
    specificationVersion: 'v2', provider: 'm', modelId: 'm', supportedUrls: {},
    doGenerate: async (o: any) => {
      const tool = (o.prompt ?? []).flatMap((m: any) => (m.role === 'tool' ? m.content : []))[0];
      if (!tool) return { content: [{ type: 'tool-call', toolCallId: CALL, toolName: 'refund', input: '{"order":42}' }], finishReason: 'tool-calls', usage, warnings: [] };
      return { content: [{ type: 'text', text: 'Refunded.' }], finishReason: 'stop', usage, warnings: [] };
    },
  };
  const sent: string[] = []; // what the channel posted: the buttons carry the id the system gave the question
  const fetch = (async (url: string, init?: RequestInit) => { sent.push(String(init?.body ?? '')); return url.endsWith('/answerCallbackQuery') ? Response.json({ ok: true, result: true }) : Response.json({ ok: true, result: { message_id: 1001 } }); }) as unknown as typeof globalThis.fetch;
  const storage = new InMemoryStorage();
  const ch = telegramChannel({ storage, agents: { support: { model, system: 's', maxSteps: 3, tools: { refund } } } } as any, {
    botToken: TOKEN, secretToken: SECRET, agent: 'support', chats: () => ({ orgId: 'acme' }),
    worker: false, workerOptions: { retryDelayMs: 0 }, apiUrl: 'https://tg.test', fetch,
  });
  channels.push(ch);
  return { ch, state, storage, sent };
}
const channels: Array<{ close(): Promise<void> }> = [];
afterEach(async () => { for (const c of channels.splice(0)) await c.close(); });

/** The id the system gave the question, read from the button the channel posted (`<a|d>:<id>`). */
const buttonId = (sent: string[]): string => /"callback_data":\s*"[ad]:([^"]+)"/.exec(sent.join('\n'))![1]!;
const post = (body: unknown) => new Request('http://app/telegram', { method: 'POST', headers: { 'content-type': 'application/json', 'x-telegram-bot-api-secret-token': SECRET }, body: JSON.stringify(body) });

describe('Telegram: the approval record names who pressed', () => {
  // d25 step 2: the requester may answer a CONFIRM question, not an approve one (a guard's require-approval),
  // so her press is recorded on the tool's confirm question (it was a guard's require-approval).
  it('the requester\'s own press on a confirm question → answeredBy telegram:123456:5, answeredAs requester', async () => {
    const { ch, state, storage, sent } = setup();
    await ch.handle(post({ update_id: 1, message: { message_id: 10, from: { id: 5 }, chat: { id: 77, type: 'group' }, text: 'refund 42' } }));
    await ch.worker().drain();
    await ch.handle(post({ update_id: 2, callback_query: { id: 'q1', from: { id: 5 }, data: `a:${buttonId(sent)}`, message: { message_id: 1001, chat: { id: 77, type: 'group' }, reply_to_message: { message_id: 10, from: { id: 5 }, text: 'refund 42' } } } }));
    await ch.worker().drain();
    expect(state.executed).toBe(1);
    const keys = (await storage.runs.listKeys('')).filter((k) => isApprovalOf(k, CALL));
    expect(keys).toHaveLength(1);
    expect(await storage.runs.get(keys[0]!)).toMatchObject({ decision: true, answeredBy: 'telegram:123456:5', answeredAs: 'requester' });
  });
});
