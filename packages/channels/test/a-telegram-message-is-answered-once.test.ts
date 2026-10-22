// telegramChannel: an update in through the webhook (with its secret token), the agent run once, the
// reply sent at most once. Telegram retries an update until it gets a 2xx; a bot cannot read a chat's
// history, so a reply whose connection was cut is left in doubt rather than sent again — measured both ways.
import { describe, it, expect, afterEach } from 'vitest';
import { InMemoryStorage } from '@gnldev/durable';
import { telegramChannel } from '../src/index.js';

const TOKEN = '123456:test-bot-secret';
const SECRET = 'webhook-secret_123';
const usage = { inputTokens: 1, outputTokens: 1, totalTokens: 2 };

function setup(over: Record<string, unknown> = {}) {
  const state = { calls: 0, prompts: [] as string[], sent: [] as any[], cut: undefined as undefined | 'after' | 'before', urls: [] as string[] };
  const model: any = {
    specificationVersion: 'v2', provider: 'm', modelId: 'm', supportedUrls: {},
    doGenerate: async (o: any) => {
      state.calls++;
      const q = [...o.prompt].reverse().find((x: any) => x.role === 'user')?.content?.map((p: any) => p.text).join('') ?? '';
      state.prompts.push(q);
      return { content: [{ type: 'text', text: `echo: ${q}` }], finishReason: 'stop', usage, warnings: [] };
    },
  };
  const fetch = (async (url: string, init: RequestInit) => {
    state.urls.push(url);
    const cut = state.cut; state.cut = undefined;
    if (cut === 'before') throw new Error(`connect ECONNRESET ${url}`);
    state.sent.push(JSON.parse(String(init.body)));
    if (cut === 'after') throw new Error('socket hang up');
    return Response.json({ ok: true, result: { message_id: state.sent.length } });
  }) as unknown as typeof globalThis.fetch;
  const ch = telegramChannel({ storage: new InMemoryStorage(), agents: { support: { model, system: 's', maxSteps: 2 } } } as any, {
    botToken: TOKEN, secretToken: SECRET, agent: 'support', chats: (chat) => (chat.id === 999 ? undefined : chat.id === 77 ? { orgId: 'acme' } : {}),
    worker: false, workerOptions: { retryDelayMs: 0, maxAttempts: 3 }, apiUrl: 'https://tg.test', fetch, ...over,
  });
  channels.push(ch);
  return { ch, state };
}
const channels: Array<{ close(): Promise<void> }> = [];
afterEach(async () => { for (const c of channels.splice(0)) await c.close(); });

const update = (id: number, msg: Record<string, unknown> = {}, secret = SECRET) => new Request('http://app/telegram', {
  method: 'POST', headers: { 'content-type': 'application/json', 'x-telegram-bot-api-secret-token': secret },
  body: JSON.stringify({ update_id: id, message: { message_id: id * 10, from: { id: 5, is_bot: false }, chat: { id: 77, type: 'group' }, text: 'refund window?', ...msg } }),
});

describe('a Telegram message is answered at most once', () => {
  it('an update without the webhook\'s secret token is 401 and queues nothing', async () => {
    const { ch } = setup();
    expect((await ch.handle(update(1, {}, 'wrong-secret'))).status).toBe(401);
    expect((await ch.handle(new Request('http://app/telegram', { method: 'POST', body: '{}' }))).status).toBe(401);
    expect(await ch.worker().drain()).toBe(0);
  });

  it('a message is acknowledged at once, run by the worker, and answered as a reply to it', async () => {
    const { ch, state } = setup();
    expect((await ch.handle(update(1))).status).toBe(200);
    expect(state.calls).toBe(0);
    await ch.worker().drain();
    expect(state.sent).toEqual([{ chat_id: 77, text: 'echo: refund window?', reply_parameters: { message_id: 10, allow_sending_without_reply: true } }]);
    expect(state.urls).toEqual([`https://tg.test/bot${TOKEN}/sendMessage`]);
  });

  it('Telegram redelivering an update — before or after it ran — runs the agent once and sends once', async () => {
    const { ch, state } = setup();
    for (let i = 0; i < 3; i++) await ch.handle(update(1));
    await ch.worker().drain();
    for (let i = 0; i < 3; i++) await ch.handle(update(1));
    await ch.worker().drain();
    expect(state.calls).toBe(1);
    expect(state.sent).toHaveLength(1);
  });

  it('a connection cut after Telegram took the reply: never sent again (the reply stays in doubt, the run is not re-asked)', async () => {
    const { ch, state } = setup();
    await ch.handle(update(1));
    state.cut = 'after';
    await ch.worker().drain();
    expect(state.sent).toHaveLength(1);
    expect(state.calls).toBe(1);
  });

  it('a connection cut before Telegram took it: not sent blindly either — at most once is the promise, and the message never names the token', async () => {
    const errors: string[] = [];
    const { ch, state } = setup({ workerOptions: { retryDelayMs: 0, maxAttempts: 3, onError: (e: unknown) => errors.push(String((e as Error)?.message ?? e)) } });
    await ch.handle(update(1));
    state.cut = 'before';
    await ch.worker().drain();
    expect(state.sent).toHaveLength(0);
    expect(state.urls).toHaveLength(1);
    expect(errors.join('\n')).not.toContain('test-bot-secret');
  });

  it('two people in one group each talk to the agent in their own GNL thread; a forum topic is its own thread', async () => {
    const { ch, state } = setup();
    await ch.handle(update(1, { from: { id: 5 }, text: 'my order is 42' }));
    await ch.worker().drain();
    await ch.handle(update(2, { from: { id: 6 }, text: 'what is my order?' }));
    await ch.worker().drain();
    expect(state.prompts).toEqual(['my order is 42', 'what is my order?']);
    await ch.handle(update(3, { from: { id: 5 }, message_thread_id: 4, text: 'in topic 4' }));
    await ch.worker().drain();
    expect(state.sent.at(-1)).toMatchObject({ message_thread_id: 4 });
  });

  it('a chat not served, a bot\'s message, an edit and a photo are acknowledged and never run', async () => {
    const { ch, state } = setup();
    for (const r of [
      update(1, { chat: { id: 999, type: 'private' } }),
      update(2, { from: { id: 8, is_bot: true } }),
      new Request('http://app/telegram', { method: 'POST', headers: { 'x-telegram-bot-api-secret-token': SECRET }, body: JSON.stringify({ update_id: 3, edited_message: { message_id: 1, from: { id: 5 }, chat: { id: 77 }, text: 'x' } }) }),
      update(4, { text: undefined, photo: [{ file_id: 'p' }] }),
    ]) expect((await ch.handle(r)).status).toBe(200);
    expect(await ch.worker().drain()).toBe(0);
    expect(state.calls).toBe(0);
  });

  it('refuses a token or secret Telegram would not issue, and a missing `chats`', () => {
    const cfg = { storage: new InMemoryStorage(), agents: { a: { model: {} } } } as any;
    expect(() => telegramChannel(cfg, { botToken: 'nope', secretToken: SECRET, agent: 'a', chats: () => ({}) })).toThrow(/botToken/);
    expect(() => telegramChannel(cfg, { botToken: TOKEN, secretToken: 'has space', agent: 'a', chats: () => ({}) })).toThrow(/secretToken/);
    expect(() => telegramChannel(cfg, { botToken: TOKEN, secretToken: SECRET, agent: 'a' } as any)).toThrow(/chats/);
  });
});
