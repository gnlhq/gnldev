// THE APPROVAL RECORD NAMES WHO ANSWERED — Slack (d25 approval integrity, step 1; KARAR-1 "KULLANICI KARARI — ADIM 1").
//
// slack.ts checks who clicked (`by`, the Slack user id of the click) against the requester and the
// `approvers` hook — and then drops it: the decision job continues the run as `subject: slack:T:<requester>`,
// so the journal could only ever say "the requester answered". A team lead approving through `approvers`
// was recorded as the person who asked.
//
// Step 1: the approval record carries `answeredBy` — the clicker, named like the channel already names
// Slack people (`slack:<team>:<user>`, the same spelling as the run's subject) — and `answeredAs`.
// The requester's own click is `answeredAs: 'requester'`. What an `approvers` click is (staff or not) is
// NOT decided in step 1 and is not asserted here.
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

function setup(over: Record<string, unknown> = {}, rule: 'guard' | 'confirm' = 'guard') {
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
  const ch = slackChannel({ storage, agents: { support: { model, system: 's', maxSteps: 3, tools: { refund }, ...(rule === 'guard' ? { guard: () => ({ action: 'require-approval' }) } : {}) } } } as any, {
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

async function approvalRecord(storage: InMemoryStorage): Promise<Record<string, unknown>> {
  const keys = (await storage.runs.listKeys('')).filter((k) => isApprovalOf(k, 'c1'));
  expect(keys, 'exactly one approval row').toHaveLength(1);
  return (await storage.runs.get(keys[0]!)) as Record<string, unknown>;
}

describe('Slack: the approval record names who clicked', () => {
  // d25 step 2: the requester may answer a CONFIRM question, not an approve one (a guard's require-approval),
  // so her own click is recorded on a confirm question (it was the guard's).
  it('the requester\'s own click on a confirm question → answeredBy slack:T1:U_AYSE, answeredAs requester', async () => {
    const s = setup({}, 'confirm');
    await s.ch.handle(mention());
    await s.ch.worker().drain();
    await s.ch.handle(click('gnl_approve', buttons(s.posts[0])[0].value, 'U_AYSE'));
    await s.ch.worker().drain();
    expect(s.state.executed).toBe(1);
    expect(await approvalRecord(s.storage)).toMatchObject({ decision: true, answeredBy: 'slack:T1:U_AYSE', answeredAs: 'requester' });
  });

  it('an `approvers` click (team lead) → answeredBy names the lead, not the requester', async () => {
    const s = setup({ approvers: ({ userId }: { userId: string }) => userId === 'U_LEAD' });
    await s.ch.handle(mention());
    await s.ch.worker().drain();
    await s.ch.handle(click('gnl_approve', buttons(s.posts[0])[0].value, 'U_LEAD'));
    await s.ch.worker().drain();
    expect(s.state.executed).toBe(1);
    const rec = await approvalRecord(s.storage);
    expect(rec.decision).toBe(true);
    expect(rec.answeredBy, 'the lead approved; the record named someone else').toBe('slack:T1:U_LEAD');
    // answeredAs for an `approvers` click is a step-2 / open decision (KARAR-1): not asserted.
  });

  it('a lead\'s deny is recorded with the lead as answeredBy', async () => {
    const s = setup({ approvers: ({ userId }: { userId: string }) => userId === 'U_LEAD' });
    await s.ch.handle(mention());
    await s.ch.worker().drain();
    await s.ch.handle(click('gnl_deny', buttons(s.posts[0])[1].value, 'U_LEAD'));
    await s.ch.worker().drain();
    expect(s.state.executed).toBe(0);
    expect(await approvalRecord(s.storage)).toMatchObject({ decision: false, answeredBy: 'slack:T1:U_LEAD' });
  });
});
