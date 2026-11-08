// k3 channels (Telegram) — one run, two steps, both calls named `call_0` by the provider (it numbers per
// response), both need an approval (refund order 42, then order 43). The person presses Approve on the first
// question's button. The second refund must be asked with its own question (its own button), not run on the
// first press; pressing the second button runs it. Control: distinct ids per step.
// The buttons pressed are read from the messages the bot sent — no id is assumed.
import { describe, it, expect, afterEach } from 'vitest';
import { InMemoryStorage } from '@gnldev/durable';
import { jsonSchema } from 'ai';
import { telegramChannel } from '../src/index.js';

const TOKEN = '123456:test-bot-secret';
const SECRET = 'webhook-secret_123';
const usage = { inputTokens: 1, outputTokens: 1, totalTokens: 2 };

function setup(ids: 'same' | 'unique') {
  const state = { refunded: [] as number[], sent: [] as any[] };
  const refund = { description: 'refund an order', inputSchema: jsonSchema({ type: 'object' }), execute: async (a: any) => { state.refunded.push(a.order); return { refunded: a.order }; } };
  const model: any = {
    specificationVersion: 'v2', provider: 'm', modelId: 'm', supportedUrls: {},
    doGenerate: async (o: any) => {
      const n = (o.prompt ?? []).flatMap((m: any) => (m.role === 'tool' ? m.content : [])).length;
      const id = ids === 'same' ? 'call_0' : `call_${n}`;
      if (n < 2) return { content: [{ type: 'tool-call', toolCallId: id, toolName: 'refund', input: JSON.stringify({ order: n === 0 ? 42 : 43 }) }], finishReason: 'tool-calls', usage, warnings: [] };
      return { content: [{ type: 'text', text: 'Refunded both.' }], finishReason: 'stop', usage, warnings: [] };
    },
  };
  const fetch = (async (url: string, init: RequestInit) => {
    const body = JSON.parse(String(init.body));
    if (url.endsWith('/answerCallbackQuery')) return Response.json({ ok: true, result: true });
    state.sent.push(body);
    return Response.json({ ok: true, result: { message_id: 1000 + state.sent.length } });
  }) as unknown as typeof globalThis.fetch;
  const ch = telegramChannel({ storage: new InMemoryStorage(), agents: { support: { model, system: 's', maxSteps: 4, tools: { refund }, guard: () => ({ action: 'confirm' }) } } } as any, {
    botToken: TOKEN, secretToken: SECRET, agent: 'support', chats: () => ({ orgId: 'acme' }),
    worker: false, workerOptions: { retryDelayMs: 0 }, apiUrl: 'https://tg.test', fetch,
  });
  channels.push(ch);
  return { ch, state };
}
const channels: Array<{ close(): Promise<void> }> = [];
afterEach(async () => { for (const c of channels.splice(0)) await c.close(); });

const post = (body: unknown) => new Request('http://app/telegram', { method: 'POST', headers: { 'content-type': 'application/json', 'x-telegram-bot-api-secret-token': SECRET }, body: JSON.stringify(body) });
let qn = 0;
const press = (data: string, messageId: number) => post({
  update_id: 100 + ++qn,
  callback_query: { id: `q${qn}`, from: { id: 5 }, data, message: { message_id: messageId, chat: { id: 77, type: 'group' }, reply_to_message: { message_id: 10, from: { id: 5 }, text: 'refund 42 and 43' } } },
});
/** The Approve buttons the bot has sent so far, with the message each came in. */
const approveButtons = (sent: any[]) => sent.flatMap((m, i) => (m.reply_markup?.inline_keyboard ?? []).flat().filter((b: any) => String(b.callback_data).startsWith('a:')).map((b: any) => ({ data: b.callback_data as string, messageId: 1001 + i, text: m.text as string })));

describe('k3 Telegram — two approvals in one run with a repeated call id', () => {
  for (const ids of ['same', 'unique'] as const) {
    it(`ids=${ids}: one press approves one refund; the second is asked with its own button`, async () => {
      const { ch, state } = setup(ids);
      await ch.handle(post({ update_id: 1, message: { message_id: 10, from: { id: 5 }, chat: { id: 77, type: 'group' }, text: 'refund 42 and 43' } }));
      await ch.worker().drain();
      const b1 = approveButtons(state.sent);
      expect(b1.length, 'precondition: the first refund is asked with a button').toBe(1);
      await ch.handle(press(b1[0].data, b1[0].messageId));
      await ch.worker().drain();
      const b2 = approveButtons(state.sent).slice(1);
      console.log(`[TG ${ids}] after first press: refunded=${JSON.stringify(state.refunded)} sent=${JSON.stringify(state.sent.map((m) => String(m.text).slice(0, 70)))} buttons=${JSON.stringify(approveButtons(state.sent).map((b) => b.data))}`);
      expect(state.refunded, 'order 43 refunded on the first press').toEqual([42]);
      expect(b2.length, 'order 43 asked with its own button').toBe(1);
      expect(b2[0].text).toContain('43');
      await ch.handle(press(b2[0].data, b2[0].messageId));
      await ch.worker().drain();
      expect(state.refunded).toEqual([42, 43]);
    });
  }
});
