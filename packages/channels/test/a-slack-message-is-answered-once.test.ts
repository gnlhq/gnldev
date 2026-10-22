// slackChannel: a Slack message in, the agent run once, the reply sent once. Slack redelivers an event
// it thinks was missed (a slow answer, a 5xx) — the guarantees are measured against exactly that, and
// against a worker that dies between the run and the reply.
import { describe, it, expect, afterEach } from 'vitest';
import { createHmac } from 'node:crypto';
import { InMemoryStorage } from '@gnldev/durable';
import { jsonSchema } from 'ai';
import { slackChannel, verifySlackSignature } from '../src/index.js';

const SECRET = 'slack-signing-secret-0123456789';
const usage = { inputTokens: 1, outputTokens: 1, totalTokens: 2 };

/** A model that answers with the prompt it was given, and counts its calls. */
function echoModel() {
  const state = { calls: 0, prompts: [] as string[] };
  const last = (o: any) => { const m = [...o.prompt].reverse().find((x: any) => x.role === 'user'); return m?.content?.map((p: any) => p.text).join('') ?? ''; };
  const model: any = {
    specificationVersion: 'v2', provider: 'm', modelId: 'm', supportedUrls: {},
    doGenerate: async (o: any) => { state.calls++; state.prompts.push(last(o)); return { content: [{ type: 'text', text: `echo: ${last(o)}` }], finishReason: 'stop', usage, warnings: [] }; },
    doStream: async (o: any) => {
      state.calls++; state.prompts.push(last(o));
      const parts = [{ type: 'stream-start', warnings: [] }, { type: 'text-start', id: '1' }, { type: 'text-delta', id: '1', delta: `echo: ${last(o)}` }, { type: 'text-end', id: '1' }, { type: 'finish', finishReason: 'stop', usage }];
      return { stream: new ReadableStream({ start(c) { for (const p of parts) c.enqueue(p); c.close(); } }) };
    },
  };
  return { model, state };
}

/** Slack's Web API, as far as the channel uses it: posts kept with their metadata, replies read back. `cut` drops a connection once. */
function slackApi() {
  const posts: Array<{ channel: string; thread_ts: string; text: string; auth: string | null; metadata?: any }> = [];
  const state = { cut: undefined as undefined | 'after-delivery' | 'before-delivery', reads: 0 };
  const fetch = (async (url: string, init: RequestInit) => {
    const body = JSON.parse(String(init.body));
    if (url === 'https://slack.test/api/conversations.replies') {
      state.reads++;
      return Response.json({ ok: true, messages: posts.filter((p) => p.channel === body.channel && p.thread_ts === body.ts).map((p, i) => ({ ts: `${i + 1}.000`, text: p.text, metadata: p.metadata })) });
    }
    expect(url).toBe('https://slack.test/api/chat.postMessage');
    const cut = state.cut; state.cut = undefined;
    if (cut === 'before-delivery') throw new Error('socket hang up');
    posts.push({ ...body, auth: new Headers(init.headers).get('authorization') });
    if (cut === 'after-delivery') throw new Error('socket hang up');
    return Response.json({ ok: true, ts: `${posts.length}.000` });
  }) as unknown as typeof globalThis.fetch;
  return { posts, state, fetch };
}

const sign = (body: string, ts = Math.floor(Date.now() / 1000)) => ({
  'x-slack-request-timestamp': String(ts),
  'x-slack-signature': `v0=${createHmac('sha256', SECRET).update(`v0:${ts}:${body}`).digest('hex')}`,
});
const event = (over: Record<string, unknown> = {}, ev: Record<string, unknown> = {}) => JSON.stringify({
  type: 'event_callback', team_id: 'T1', event_id: 'Ev1',
  event: { type: 'app_mention', user: 'U_AYSE', text: '<@UBOT> what is the refund window?', channel: 'C1', ts: '100.1', ...ev },
  ...over,
});
const request = (body: string, headers = sign(body)) => new Request('http://app/slack/events', { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body });

const channels: Array<{ close(): Promise<void> }> = [];
afterEach(async () => { for (const c of channels.splice(0)) await c.close(); });

function setup(over: Record<string, unknown> = {}) {
  const storage = new InMemoryStorage();
  const { model, state } = echoModel();
  const slack = slackApi();
  const ch = slackChannel({ storage, agents: { support: { model, system: 'answer briefly', maxSteps: 2 } } } as any, {
    signingSecret: SECRET, botToken: 'test-bot-token-123', agent: 'support', workspaces: { T1: { orgId: 'acme' } },
    worker: false, workerOptions: { retryDelayMs: 0 }, apiUrl: 'https://slack.test/api', fetch: slack.fetch, studioUrl: 'https://studio.example', ...over,
  });
  channels.push(ch);
  return { storage, state, slack, ch };
}

describe('Slack signature', () => {
  it('only a request signed with the secret, and not older than five minutes, is Slack', () => {
    const body = event();
    const now = Date.now();
    expect(verifySlackSignature(body, new Headers(sign(body)), SECRET, now)).toBe(true);
    expect(verifySlackSignature(`${body} `, new Headers(sign(body)), SECRET, now)).toBe(false);
    expect(verifySlackSignature(body, new Headers(sign(body)), 'another-secret', now)).toBe(false);
    expect(verifySlackSignature(body, new Headers(sign(body, Math.floor(now / 1000) - 301)), SECRET, now)).toBe(false);
    expect(verifySlackSignature(body, new Headers({}), SECRET, now)).toBe(false);
  });

  it('an unsigned request is 401 and queues nothing; the URL check answers its challenge', async () => {
    const { ch, storage } = setup();
    const res = await ch.handle(request(event(), { 'x-slack-request-timestamp': '1', 'x-slack-signature': 'v0=00' }));
    expect(res.status).toBe(401);
    expect(await ch.worker().runOnce()).toBe(false);
    const challenge = JSON.stringify({ type: 'url_verification', challenge: 'abc' });
    expect(await (await ch.handle(request(challenge))).json()).toEqual({ challenge: 'abc' });
  });
});

describe('a Slack message is answered once', () => {
  it('a mention is acknowledged at once, run by the worker, and answered in its thread', async () => {
    const { ch, state, slack } = setup();
    expect((await ch.handle(request(event()))).status).toBe(200);
    expect(state.calls).toBe(0); // acknowledged before the agent ran
    await ch.worker().drain();
    expect(state.prompts).toEqual(['what is the refund window?']);
    expect(slack.posts).toEqual([expect.objectContaining({ channel: 'C1', thread_ts: '100.1', text: 'echo: what is the refund window?', auth: 'Bearer test-bot-token-123' })]);
  });

  it('Slack redelivering the same event — before or after it ran — runs the agent once and posts once', async () => {
    const { ch, state, slack } = setup();
    for (let i = 0; i < 3; i++) expect((await ch.handle(request(event()))).status).toBe(200);
    await ch.worker().drain();
    for (let i = 0; i < 3; i++) await ch.handle(request(event()));
    await ch.worker().drain();
    expect(state.calls).toBe(1);
    expect(slack.posts).toHaveLength(1);
  });

  it('a connection cut AFTER Slack took the reply: the retry reads the thread, finds it, and does not post again', async () => {
    const { ch, state, slack } = setup();
    await ch.handle(request(event()));
    slack.state.cut = 'after-delivery';
    await ch.worker().drain();
    expect(slack.posts).toHaveLength(1);
    expect(slack.state.reads).toBe(1); // settled by recover(), not by guessing
    expect(state.calls).toBe(1); // the job's retry replayed the run, the model was not asked again
  });

  it('a connection cut BEFORE Slack took the reply: the retry finds nothing, and posts it once', async () => {
    const { ch, state, slack } = setup();
    await ch.handle(request(event()));
    slack.state.cut = 'before-delivery';
    await ch.worker().drain();
    expect(slack.posts.map((p) => p.text)).toEqual(['echo: what is the refund window?']);
    expect(slack.posts[0]!.metadata).toMatchObject({ event_type: 'gnl_reply' });
    expect(state.calls).toBe(1);
  });

  it('a run that stops for an approval says so in the thread, with the run to open in Studio — once', async () => {
    const storage = new InMemoryStorage();
    const slack = slackApi();
    const refund = { description: 'refund an order', inputSchema: jsonSchema({ type: 'object' }), execute: async () => ({ refunded: true }) };
    const model: any = {
      specificationVersion: 'v2', provider: 'm', modelId: 'm', supportedUrls: {},
      doGenerate: async (o: any) => ((o.prompt ?? []).some((m: any) => m.role === 'tool')
        ? { content: [{ type: 'text', text: 'Refunded.' }], finishReason: 'stop', usage, warnings: [] }
        : { content: [{ type: 'tool-call', toolCallId: 'c1', toolName: 'refund', input: '{}' }], finishReason: 'tool-calls', usage, warnings: [] }),
    };
    const ch = slackChannel({ storage, agents: { support: { model, system: 's', maxSteps: 3, tools: { refund }, guard: () => ({ action: 'require-approval' }) } } } as any, {
      signingSecret: SECRET, botToken: 'test-bot-token-123', agent: 'support', workspaces: { T1: {} }, worker: false,
      workerOptions: { retryDelayMs: 0 }, apiUrl: 'https://slack.test/api', fetch: slack.fetch, studioUrl: 'https://studio.example/',
    });
    channels.push(ch);
    await ch.handle(request(event()));
    await ch.handle(request(event()));
    await ch.worker().drain();
    expect(slack.posts).toHaveLength(1);
    expect(slack.posts[0]!.text).toMatch(/^This needs an approval before I go on \(or in Studio: https:\/\/studio\.example\/runs\/run1_[0-9a-f]+\)\.$/);
  });

  it('two people in one Slack thread each talk to the agent in their own GNL thread', async () => {
    const { ch, state } = setup();
    await ch.handle(request(event({ event_id: 'Ev1' }, { user: 'U_AYSE', text: '<@UBOT> my order is 42', ts: '200.1' })));
    await ch.worker().drain();
    await ch.handle(request(event({ event_id: 'Ev2' }, { user: 'U_MEHMET', text: '<@UBOT> what is my order?', ts: '200.2', thread_ts: '200.1' })));
    await ch.worker().drain();
    expect(state.calls).toBe(2);
    // Mehmet's run did not see Ayşe's message: the model was given his question alone.
    expect(state.prompts).toEqual(['my order is 42', 'what is my order?']);
  });

  it('a workspace not listed, a bot\'s own message, an edit and a plain channel message are acknowledged and never run', async () => {
    const { ch, state } = setup();
    for (const body of [
      event({ team_id: 'T_STRANGER', event_id: 'E1' }),
      event({ event_id: 'E2' }, { bot_id: 'B1' }),
      event({ event_id: 'E3' }, { subtype: 'message_changed' }),
      event({ event_id: 'E4' }, { type: 'message', channel_type: 'channel' }),
    ]) expect((await ch.handle(request(body))).status).toBe(200);
    expect(await ch.worker().drain()).toBe(0);
    expect(state.calls).toBe(0);
  });

  it('a direct message is asked too, and refuses a misspelled option', async () => {
    const { ch, slack } = setup();
    await ch.handle(request(event({ event_id: 'Ev9' }, { type: 'message', channel_type: 'im', text: 'hello there', channel: 'D1', ts: '300.1' })));
    await ch.worker().drain();
    expect(slack.posts.map((p) => [p.channel, p.text])).toEqual([['D1', 'echo: hello there']]);
    expect(() => slackChannel({ storage: new InMemoryStorage(), agents: {} } as any, { signingSecret: 's', botToken: 't', agent: 'a', workspaces: {}, workspace: {} } as any)).toThrow(/workspace/);
  });
});
