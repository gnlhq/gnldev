// TELEGRAM — WHO MAY PRESS, under the general rule (d25 approval policy, step 2; KARAR-1 "ADIM 2 / POLİTİKA").
//
// Telegram answers only the person who asked (telegram.ts). Step 2's general rule applies to every door:
//   CONFIRM — the requester's Approve runs it (consent; regression).
//   APPROVE (a guard's require-approval) — the requester's Approve does NOT run it and is not recorded;
//     Telegram has no approvers hook, so an approve question is answered elsewhere (Studio, an operator).
//   The requester's Deny always goes through.
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

function setup(rule: 'approve' | 'confirm') {
  const state = { executed: 0 };
  const refund = { description: 'refund an order', inputSchema: jsonSchema({ type: 'object' }), ...(rule === 'confirm' ? { confirm: true } : {}), execute: async () => { state.executed++; return { refunded: true }; } };
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
  const ch = telegramChannel({ storage, agents: { support: { model, system: 's', maxSteps: 3, tools: { refund }, ...(rule === 'approve' ? { guard: () => ({ action: 'require-approval' }) } : {}) } } } as any, {
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

async function flow(rule: 'approve' | 'confirm', press: 'a' | 'd') {
  const s = setup(rule);
  await s.ch.handle(post({ update_id: 1, message: { message_id: 10, from: { id: 5 }, chat: { id: 77, type: 'group' }, text: 'refund 42' } }));
  await s.ch.worker().drain();
  await s.ch.handle(post({ update_id: 2, callback_query: { id: 'q1', from: { id: 5 }, data: `${press}:${buttonId(s.sent)}`, message: { message_id: 1001, chat: { id: 77, type: 'group' }, reply_to_message: { message_id: 10, from: { id: 5 }, text: 'refund 42' } } } }));
  await s.ch.worker().drain();
  const keys = (await s.storage.runs.listKeys('')).filter((k) => isApprovalOf(k, CALL));
  const rows = await Promise.all(keys.map((k) => s.storage.runs.get<any>(k)));
  return { executed: s.state.executed, decisions: rows.map((r) => r?.decision) };
}

describe('Telegram follows the general rule', () => {
  it('APPROVE: the requester\'s own Approve does not run it, and nothing is recorded', async () => {
    expect(await flow('approve', 'a'), 'the requester approved her own approve question from Telegram').toEqual({ executed: 0, decisions: [] });
  });
  it('APPROVE: the requester\'s own Deny goes through (recorded as denied)', async () => {
    expect(await flow('approve', 'd')).toEqual({ executed: 0, decisions: [false] });
  });
  it('CONFIRM: the requester\'s own Approve runs it once (regression)', async () => {
    expect((await flow('confirm', 'a')).executed).toBe(1);
  });
});
