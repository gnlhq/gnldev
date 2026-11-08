// Approving from Telegram: a run that stops for an approval asks with Approve / Deny buttons (inline
// keyboard) in a reply to the person's message. A press is checked against the author of that message —
// Telegram sends it with the press — and continues the same run; the answer is sent once.
//
// d25 step 2 (KARAR-1 "ADIM 2 / POLİTİKA"): the requester answers a CONFIRM (consent) question; an APPROVE
// question (a guard's require-approval) takes an authorised person. These tests are about the channel's
// mechanics with the requester answering, so the question is the tool's `confirm` (it was a guard's
// require-approval). The approve side is in d25-a2-telegram-who-may-press.test.ts.
import { describe, it, expect, afterEach } from 'vitest';
import { InMemoryStorage, mintCallId } from '@gnldev/durable';
import { jsonSchema } from 'ai';
import { telegramChannel } from '../src/index.js';

const TOKEN = '123456:test-bot-secret';
const SECRET = 'webhook-secret_123';
const usage = { inputTokens: 1, outputTokens: 1, totalTokens: 2 };

function setup(callId = 'call_abcdefghijklmnopqrstuvwx') {
  const state = { executed: 0, sent: [] as any[], answered: [] as any[] };
  const refund = { description: 'refund an order', inputSchema: jsonSchema({ type: 'object' }), confirm: true, execute: async () => { state.executed++; return { refunded: true }; } };
  const model: any = {
    specificationVersion: 'v2', provider: 'm', modelId: 'm', supportedUrls: {},
    doGenerate: async (o: any) => {
      const tool = (o.prompt ?? []).flatMap((m: any) => (m.role === 'tool' ? m.content : []))[0];
      if (!tool) return { content: [{ type: 'tool-call', toolCallId: callId, toolName: 'refund', input: '{"order":42}' }], finishReason: 'tool-calls', usage, warnings: [] };
      const out = JSON.stringify(tool.output ?? '');
      return { content: [{ type: 'text', text: /denied|rejected/.test(out) ? 'Not refunded.' : 'Refunded.' }], finishReason: 'stop', usage, warnings: [] };
    },
  };
  const fetch = (async (url: string, init: RequestInit) => {
    const body = JSON.parse(String(init.body));
    if (url.endsWith('/answerCallbackQuery')) { state.answered.push(body); return Response.json({ ok: true, result: true }); }
    state.sent.push(body);
    return Response.json({ ok: true, result: { message_id: 1000 + state.sent.length } });
  }) as unknown as typeof globalThis.fetch;
  const ch = telegramChannel({ storage: new InMemoryStorage(), agents: { support: { model, system: 's', maxSteps: 3, tools: { refund } } } } as any, {
    botToken: TOKEN, secretToken: SECRET, agent: 'support', chats: (chat) => (chat.id === 999 ? undefined : { orgId: 'acme' }),
    worker: false, workerOptions: { retryDelayMs: 0 }, apiUrl: 'https://tg.test', fetch, studioUrl: 'https://studio.example',
  });
  channels.push(ch);
  return { ch, state };
}
const channels: Array<{ close(): Promise<void> }> = [];
afterEach(async () => { for (const c of channels.splice(0)) await c.close(); });

const post = (body: unknown) => new Request('http://app/telegram', { method: 'POST', headers: { 'content-type': 'application/json', 'x-telegram-bot-api-secret-token': SECRET }, body: JSON.stringify(body) });
const ask = () => post({ update_id: 1, message: { message_id: 10, from: { id: 5 }, chat: { id: 77, type: 'group' }, text: 'refund 42' } });
let qn = 0;
const press = (data: string, by = 5, chat = 77) => post({
  update_id: 100 + ++qn,
  callback_query: { id: `q${qn}`, from: { id: by }, data, message: { message_id: 1001, chat: { id: chat, type: 'group' }, reply_to_message: { message_id: 10, from: { id: 5 }, text: 'refund 42' } } },
});

async function stopped(callId?: string) {
  const s = setup(callId);
  await s.ch.handle(ask());
  await s.ch.worker().drain();
  // The run id is the channel's own; read it from the question's Studio link, then name the call the
  // way the model boundary does (the button carries the GNL id of the call, not the provider's).
  const runId = /\/runs\/(run1_[0-9a-f]+)\./.exec(String(s.state.sent[0]?.text))?.[1] ?? '';
  return { ...s, id: mintCallId(callId ?? 'call_abcdefghijklmnopqrstuvwx', runId, 0, 0) };
}

describe('an approval is answered from Telegram', () => {
  it('a stop asks once, in a reply to the person\'s message, with Approve and Deny for the call', async () => {
    const { state, id } = await stopped();
    expect(state.sent).toHaveLength(1);
    expect(state.sent[0].reply_parameters).toMatchObject({ message_id: 10 });
    expect(state.sent[0].text).toMatch(/^This needs an approval before I go on — or in Studio: https:\/\/studio\.example\/runs\/run1_[0-9a-f]+\.\n• refund \{"order":42\}$/);
    expect(state.sent[0].reply_markup.inline_keyboard).toEqual([[{ text: 'Approve refund', callback_data: `a:${id}` }, { text: 'Deny', callback_data: `d:${id}` }]]);
  });

  it('the person who asked approves: the same run goes on, the tool runs once, the answer is sent once', async () => {
    const { ch, state, id } = await stopped();
    await ch.handle(press(`a:${id}`));
    await ch.handle(press(`a:${id}`)); // a double press
    await ch.worker().drain();
    expect(state.executed).toBe(1);
    expect(state.sent.map((m) => m.text).slice(1)).toEqual(['Refunded.']);
    expect(state.answered.map((a) => a.callback_query_id)).toEqual(['q1', 'q2']); // the spinner is stopped
  });

  it('deny: the tool never runs; a later Approve on the same call changes nothing', async () => {
    const { ch, state, id } = await stopped();
    await ch.handle(press(`d:${id}`));
    await ch.handle(press(`a:${id}`));
    await ch.worker().drain();
    expect(state.executed).toBe(0);
    expect(state.sent.map((m) => m.text).slice(1)).toEqual(['Not refunded.']);
  });

  it('someone else pressing is told only the person who asked can answer, and nothing is queued', async () => {
    const { ch, state, id } = await stopped();
    await ch.handle(press(`a:${id}`, 6));
    expect(await ch.worker().drain()).toBe(0);
    expect(state.executed).toBe(0);
    expect(state.answered.at(-1)).toMatchObject({ text: 'Only the person who asked can answer this.', show_alert: true });
  });

  it('a call id too long for Telegram\'s 64 bytes gets no button; it is approved in Studio', async () => {
    const { state } = await stopped(`delegation_call_0123456789/${'x'.repeat(40)}`);
    expect(state.sent[0].reply_markup).toBeUndefined();
    expect(state.sent[0].text).toMatch(/or in Studio: https:\/\/studio\.example\/runs\/run1_/);
  });

  it('a press in a chat the bot does not serve is ignored', async () => {
    const { ch, state, id } = await stopped();
    await ch.handle(press(`a:${id}`, 5, 999));
    expect(await ch.worker().drain()).toBe(0);
    expect(state.executed).toBe(0);
  });
});
