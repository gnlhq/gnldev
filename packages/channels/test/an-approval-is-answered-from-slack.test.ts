// Approving from Slack: a run that stops for an approval posts Approve / Deny buttons; a click from the
// person who asked (or an `approvers` yes) continues the same run, and its answer is posted once. A
// button's value is signed: a changed one decides nothing. A second click, or Slack redelivering one,
// is the same decision.
import { describe, it, expect, afterEach } from 'vitest';
import { createHmac } from 'node:crypto';
import { InMemoryStorage } from '@gnldev/durable';
import { jsonSchema } from 'ai';
import { slackChannel } from '../src/index.js';

const SECRET = 'slack-signing-secret-0123456789';
const usage = { inputTokens: 1, outputTokens: 1, totalTokens: 2 };

function setup(over: Record<string, unknown> = {}) {
  const posts: any[] = [];
  const fetch = (async (url: string, init: RequestInit) => {
    const body = JSON.parse(String(init.body));
    if (url.endsWith('/conversations.replies')) return Response.json({ ok: true, messages: posts.filter((p) => p.channel === body.channel && p.thread_ts === body.ts).map((p, i) => ({ ts: `${i}.0`, metadata: p.metadata })) });
    posts.push(body);
    return Response.json({ ok: true, ts: `${posts.length}.0` });
  }) as unknown as typeof globalThis.fetch;
  const state = { executed: 0 };
  const refund = { description: 'refund an order', inputSchema: jsonSchema({ type: 'object' }), execute: async () => { state.executed++; return { refunded: true }; } };
  const model: any = {
    specificationVersion: 'v2', provider: 'm', modelId: 'm', supportedUrls: {},
    doGenerate: async (o: any) => {
      const tool = (o.prompt ?? []).flatMap((m: any) => (m.role === 'tool' ? m.content : []))[0];
      if (!tool) return { content: [{ type: 'tool-call', toolCallId: 'c1', toolName: 'refund', input: '{"order":42}' }], finishReason: 'tool-calls', usage, warnings: [] };
      const denied = JSON.stringify(tool.output ?? '').includes('denied') || JSON.stringify(tool.output ?? '').includes('rejected');
      return { content: [{ type: 'text', text: denied ? 'Not refunded.' : 'Refunded.' }], finishReason: 'stop', usage, warnings: [] };
    },
  };
  const ch = slackChannel({ storage: new InMemoryStorage(), agents: { support: { model, system: 's', maxSteps: 3, tools: { refund }, guard: () => ({ action: 'require-approval' }) } } } as any, {
    signingSecret: SECRET, botToken: 'test-bot-token-123', agent: 'support', workspaces: { T1: { orgId: 'acme' } }, worker: false,
    workerOptions: { retryDelayMs: 0 }, apiUrl: 'https://slack.test/api', fetch, ...over,
  });
  channels.push(ch);
  return { ch, posts, state };
}
const channels: Array<{ close(): Promise<void> }> = [];
afterEach(async () => { for (const c of channels.splice(0)) await c.close(); });

const signed = (body: string, type: string) => {
  const ts = Math.floor(Date.now() / 1000);
  return new Request('http://app/slack', { method: 'POST', body, headers: {
    'content-type': type, 'x-slack-request-timestamp': String(ts),
    'x-slack-signature': `v0=${createHmac('sha256', SECRET).update(`v0:${ts}:${body}`).digest('hex')}`,
  } });
};
const mention = () => signed(JSON.stringify({ type: 'event_callback', team_id: 'T1', event_id: 'Ev1', event: { type: 'app_mention', user: 'U_AYSE', text: '<@UBOT> refund 42', channel: 'C1', ts: '100.1' } }), 'application/json');
const click = (actionId: string, value: string, userId = 'U_AYSE', team = 'T1') =>
  signed(new URLSearchParams({ payload: JSON.stringify({ type: 'block_actions', team: { id: team }, user: { id: userId }, actions: [{ action_id: actionId, value }] }) }).toString(), 'application/x-www-form-urlencoded');
const buttons = (post: any) => post.blocks.filter((b: any) => b.type === 'actions').flatMap((b: any) => b.elements);

async function stopped() {
  const s = setup();
  await s.ch.handle(mention());
  await s.ch.worker().drain();
  return s;
}

describe('an approval is answered from Slack', () => {
  it('a stop posts one message with Approve and Deny for the call, naming the tool and its input', async () => {
    const { posts, state } = await stopped();
    expect(posts).toHaveLength(1);
    expect(state.executed).toBe(0);
    expect(JSON.stringify(posts[0].blocks)).toContain('*refund* `{\\"order\\":42}`');
    expect(buttons(posts[0]).map((b: any) => b.action_id)).toEqual(['gnl_approve', 'gnl_deny']);
  });

  it('the person who asked approves: the same run goes on, the tool runs once, the answer is posted once', async () => {
    const { ch, posts, state } = await stopped();
    const approve = buttons(posts[0])[0];
    expect((await ch.handle(click('gnl_approve', approve.value))).status).toBe(200);
    await ch.handle(click('gnl_approve', approve.value)); // a double click, or Slack sending it again
    await ch.worker().drain();
    expect(state.executed).toBe(1);
    expect(posts.map((p) => p.text)).toEqual([expect.stringMatching(/^This needs an approval/), 'Refunded.']);
    expect(posts[1].thread_ts).toBe('100.1');
  });

  it('deny: the tool never runs, and the answer says so — a later Approve on the same call changes nothing', async () => {
    const { ch, posts, state } = await stopped();
    const [approve, deny] = buttons(posts[0]);
    await ch.handle(click('gnl_deny', deny.value));
    await ch.handle(click('gnl_approve', approve.value));
    await ch.worker().drain();
    expect(state.executed).toBe(0);
    expect(posts.map((p) => p.text).slice(1)).toEqual(['Not refunded.']);
  });

  it('someone else clicking is told only the requester can answer, and nothing is queued', async () => {
    const { ch, posts, state } = await stopped();
    const res = await ch.handle(click('gnl_approve', buttons(posts[0])[0].value, 'U_MEHMET'));
    expect(await res.json()).toMatchObject({ response_type: 'ephemeral', text: 'Only <@U_AYSE> can answer this.' });
    expect(await ch.worker().drain()).toBe(0);
    expect(state.executed).toBe(0);
  });

  it('an `approvers` yes lets someone else decide', async () => {
    const s = setup({ approvers: ({ userId, toolName }: { userId: string; toolName: string }) => userId === 'U_LEAD' && toolName === 'refund' });
    await s.ch.handle(mention());
    await s.ch.worker().drain();
    await s.ch.handle(click('gnl_approve', buttons(s.posts[0])[0].value, 'U_LEAD'));
    await s.ch.worker().drain();
    expect(s.state.executed).toBe(1);
  });

  it('a button value changed after it was signed decides nothing: 401, for another call, another requester, or another workspace', async () => {
    const { ch, posts, state } = await stopped();
    const v = JSON.parse(buttons(posts[0])[0].value);
    for (const d of [{ ...v.d, toolCallId: 'c2' }, { ...v.d, user: 'U_MEHMET' }, { ...v.d, teamId: 'T2' }]) {
      expect((await ch.handle(click('gnl_approve', JSON.stringify({ d, mac: v.mac }), d.user))).status).toBe(401);
    }
    expect((await ch.handle(click('gnl_approve', 'not json'))).status).toBe(401);
    expect(await ch.worker().drain()).toBe(0);
    expect(state.executed).toBe(0);
  });

  it('a click from another workspace than the button\'s is ignored', async () => {
    const { ch, posts } = await stopped();
    expect((await ch.handle(click('gnl_approve', buttons(posts[0])[0].value, 'U_AYSE', 'T_OTHER'))).status).toBe(200);
    expect(await ch.worker().drain()).toBe(0);
  });
});
