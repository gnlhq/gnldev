// SLACK — WHO MAY CLICK, under the one rule (d25 approval policy, step 2; KARAR-1 "ADIM 2 / POLİTİKA").
//
// slack.ts today: "only the requester, or whoever `approvers` names, can answer" — the same for every
// question. Step 2 makes the channel follow the general rule:
//   CONFIRM — the requester may click Approve (consent).
//   APPROVE (a guard's require-approval/approve) — the requester's Approve does NOT run it, unless an
//     approvers rule names her; with no approvers nobody in Slack can approve it (Studio can).
//   Anybody allowed to click may click Deny; the requester's Deny always goes through.
// The channel's `approvers` hook and the general `approvers` (createGnl config) are one rule: either names
// the team lead, and the lead's Approve runs it.
import { describe, it, expect, afterEach, beforeAll, vi } from 'vitest';
import { createHmac } from 'node:crypto';
import { InMemoryStorage, providerIdOf } from '@gnldev/durable';
import { jsonSchema } from 'ai';
import { slackChannel } from '../src/index.js';

// Call ids are GNL ids (`c1.gnl-<run>-<step>-<n>`, the provider's id is the prefix): an approval row is found by the provider's id.
const isApprovalOf = (key: string, providerId: string): boolean => key.includes(':approval:') && providerIdOf(key.slice(key.lastIndexOf(':approval:') + ':approval:'.length)) === providerId;

beforeAll(() => { vi.spyOn(console, 'warn').mockImplementation(() => {}); });

const SECRET = 'slack-signing-secret-0123456789';
const usage = { inputTokens: 1, outputTokens: 1, totalTokens: 2 };

type Rule = 'approve' | 'confirm';
function setup(rule: Rule, over: Record<string, unknown> = {}, config: Record<string, unknown> = {}) {
  const posts: any[] = [];
  const fetch = (async (url: string, init: RequestInit) => {
    const body = JSON.parse(String(init.body));
    if (url.endsWith('/conversations.replies')) return Response.json({ ok: true, messages: posts.filter((p) => p.channel === body.channel && p.thread_ts === body.ts).map((p, i) => ({ ts: `${i}.0`, metadata: p.metadata })) });
    posts.push(body);
    return Response.json({ ok: true, ts: `${posts.length}.0` });
  }) as unknown as typeof globalThis.fetch;
  const state = { executed: 0 };
  const refund = { description: 'refund an order', inputSchema: jsonSchema({ type: 'object' }), ...(rule === 'confirm' ? { confirm: true } : {}), execute: async () => { state.executed++; return { refunded: true }; } };
  const model: any = {
    specificationVersion: 'v2', provider: 'm', modelId: 'm', supportedUrls: {},
    doGenerate: async (o: any) => {
      const tool = (o.prompt ?? []).flatMap((m: any) => (m.role === 'tool' ? m.content : []))[0];
      if (!tool) return { content: [{ type: 'tool-call', toolCallId: 'c1', toolName: 'refund', input: '{"order":42}' }], finishReason: 'tool-calls', usage, warnings: [] };
      return { content: [{ type: 'text', text: 'Refunded.' }], finishReason: 'stop', usage, warnings: [] };
    },
  };
  const storage = new InMemoryStorage();
  const ch = slackChannel({ storage, ...config, agents: { support: { model, system: 's', maxSteps: 3, tools: { refund }, ...(rule === 'approve' ? { guard: () => ({ action: 'require-approval' }) } : {}) } } } as any, {
    signingSecret: SECRET, botToken: 'test-bot-token-123', agent: 'support', workspaces: { T1: { orgId: 'acme' } }, worker: false,
    workerOptions: { retryDelayMs: 0 }, apiUrl: 'https://slack.test/api', fetch, ...over,
  });
  channels.push(ch);
  return { ch, posts, state, storage };
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
const click = (actionId: string, value: string, userId: string) =>
  signed(new URLSearchParams({ payload: JSON.stringify({ type: 'block_actions', team: { id: 'T1' }, user: { id: userId }, actions: [{ action_id: actionId, value }] }) }).toString(), 'application/x-www-form-urlencoded');
const buttons = (post: any) => post.blocks.filter((b: any) => b.type === 'actions').flatMap((b: any) => b.elements);

async function rows(storage: InMemoryStorage): Promise<any[]> {
  const keys = (await storage.runs.listKeys('')).filter((k) => isApprovalOf(k, 'c1'));
  return Promise.all(keys.map((k) => storage.runs.get(k)));
}
async function ask(s: ReturnType<typeof setup>) {
  await s.ch.handle(mention());
  await s.ch.worker().drain();
  expect(s.posts.length, 'precondition: the question was posted').toBeGreaterThan(0);
  expect(buttons(s.posts[0]).length, 'precondition: Approve/Deny buttons').toBe(2);
}
async function press(s: ReturnType<typeof setup>, which: 'approve' | 'deny', userId: string) {
  const [approve, deny] = buttons(s.posts[0]);
  await s.ch.handle(click(which === 'approve' ? 'gnl_approve' : 'gnl_deny', (which === 'approve' ? approve : deny).value, userId));
  await s.ch.worker().drain();
}

describe('Slack follows the general rule', () => {
  it('APPROVE, no approvers: the requester\'s own Approve does not run it, and nothing is recorded', async () => {
    const s = setup('approve');
    await ask(s);
    await press(s, 'approve', 'U_AYSE');
    expect(s.state.executed, 'the requester approved her own approve question from Slack').toBe(0);
    expect(await rows(s.storage)).toEqual([]);
  });

  it('APPROVE: the requester\'s own Deny goes through (no refund, recorded as denied)', async () => {
    const s = setup('approve');
    await ask(s);
    await press(s, 'deny', 'U_AYSE');
    expect(s.state.executed).toBe(0);
    expect((await rows(s.storage)).map((r) => r?.decision)).toEqual([false]);
  });

  it('CONFIRM: the requester\'s own Approve runs it once (regression)', async () => {
    const s = setup('confirm');
    await ask(s);
    await press(s, 'approve', 'U_AYSE');
    expect(s.state.executed).toBe(1);
  });

  it('APPROVE with the channel\'s approvers naming the lead: the lead\'s Approve runs it once (regression)', async () => {
    const s = setup('approve', { approvers: ({ userId }: { userId: string }) => userId === 'U_LEAD' });
    await ask(s);
    await press(s, 'approve', 'U_LEAD');
    expect(s.state.executed).toBe(1);
  });

  it('APPROVE with the channel\'s approvers naming the lead: the requester\'s Approve still does not run it', async () => {
    const s = setup('approve', { approvers: ({ userId }: { userId: string }) => userId === 'U_LEAD' });
    await ask(s);
    await press(s, 'approve', 'U_AYSE');
    expect(s.state.executed, 'the requester is not an approver, yet her Approve ran it').toBe(0);
    expect(await rows(s.storage)).toEqual([]);
  });

  it('one rule: the GENERAL approvers (createGnl config) naming the lead lets the lead approve from Slack, with no channel hook', async () => {
    const s = setup('approve', {}, { approvers: (ctx: unknown) => JSON.stringify(ctx).includes('U_LEAD') });
    await ask(s);
    await press(s, 'approve', 'U_LEAD');
    expect(s.state.executed, 'the general approvers rule did not reach the Slack channel').toBe(1);
  });

  it('one rule: under the general approvers, the requester\'s Approve does not run it', async () => {
    const s = setup('approve', {}, { approvers: (ctx: unknown) => JSON.stringify(ctx).includes('U_LEAD') });
    await ask(s);
    await press(s, 'approve', 'U_AYSE');
    expect(s.state.executed).toBe(0);
  });
});
