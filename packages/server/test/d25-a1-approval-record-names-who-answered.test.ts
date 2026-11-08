// THE APPROVAL RECORD NAMES WHO ANSWERED — doors (d25 approval integrity, step 1; KARAR-1 "KULLANICI KARARI — ADIM 1").
//
// `ApprovalRecord.actor` is documented as "WHO answered" (durable run.ts) but is filled with the run's
// ownership stamp: the registry writes `serverIdentity.resourceId ?? opts.actor` (registry.ts), and
// REST /resume seals the run's RECORDED owner (server index.ts). Measured by heyet 4 on a real run:
// employee Veli approved customer Ali's refund, and the journal said `{"decision":true,"actor":"u-ali"}`
// — "Ali approved his own refund". The audit trail erased exactly the fact it exists to keep.
//
// Step 1 adds two fields, and keeps `actor` as it is (backward compatible):
//   answeredBy — the verified identity of whoever answered, in the one naming every identity comparison
//                already uses (@gnldev/auth `actorIdOf`: an end user's own id, `operator:<id>` for staff);
//   answeredAs — 'staff' | 'requester'.
// WHO MAY answer was not changed by step 1; step 2 (KARAR-1 "ADIM 2") decides it — see the "who may answer" tests.
//
// Read back through the public journal API (`runKeys.approval`, exported by @gnldev/durable).
import { describe, it, expect, beforeAll, vi } from 'vitest';
import { z } from 'zod';
import { InMemoryStorage, InMemoryJournal, type Journal, providerIdOf } from '@gnldev/durable';
import { roleAuth, signSubjectToken } from '@gnldev/auth';
import { createRestApi } from '../src/index.js';
import { chatSurface } from '../../chat-adapter/src/index.js';
import { aguiSurface } from '../../agui/src/index.js';
import { createA2AServer } from '../../a2a/src/server.js';

// Call ids are GNL ids (`c1.gnl-<run>-<step>-<n>`, the provider's id is the prefix): an approval row is found by the provider's id.
const isApprovalOf = (key: string, providerId: string): boolean => key.includes(':approval:') && providerIdOf(key.slice(key.lastIndexOf(':approval:') + ':approval:'.length)) === providerId;

beforeAll(() => { vi.spyOn(console, 'warn').mockImplementation(() => {}); });

const SECRET = 'app-signing-secret-at-least-32-bytes!!';
/** Staff with a name: roleAuth's admin credential carrying `user` → principal id 'veli' → actorIdOf 'operator:veli'. */
const VELI = 'Bearer STAFF-VELI';
const tok = (sub: string) => `Bearer ${signSubjectToken({ sub }, SECRET)}`;
const usage = { inputTokens: 1, outputTokens: 1, totalTokens: 2 };
const toolResults = (prompt: any[] | undefined) => (prompt ?? []).filter((m: any) => m.role === 'tool').length;

function model(): any {
  return {
    specificationVersion: 'v2', provider: 'mock', modelId: 'm', supportedUrls: {},
    doGenerate: async ({ prompt }: any) => (toolResults(prompt)
      ? { content: [{ type: 'text', text: 'Done.' }], finishReason: 'stop', usage, warnings: [] }
      : { content: [{ type: 'tool-call', toolCallId: 'c1', toolName: 'refund', input: JSON.stringify({ amount: 12500 }) }], finishReason: 'tool-calls', usage, warnings: [] }),
    doStream: async ({ prompt }: any) => {
      const parts = toolResults(prompt)
        ? [{ type: 'stream-start', warnings: [] }, { type: 'text-start', id: '1' }, { type: 'text-delta', id: '1', delta: 'Done.' }, { type: 'text-end', id: '1' }, { type: 'finish', finishReason: 'stop', usage }]
        : [{ type: 'stream-start', warnings: [] }, { type: 'tool-call', toolCallId: 'c1', toolName: 'refund', input: JSON.stringify({ amount: 12500 }) }, { type: 'finish', finishReason: 'tool-calls', usage }];
      return { stream: new ReadableStream({ start(c) { for (const p of parts) c.enqueue(p); c.close(); } }) };
    },
  };
}

/** `kind: 'guard'` → a guard's require-approval; `kind: 'confirm'` → the tool's own confirm question. */
function agents(refunds: number[], kind: 'guard' | 'confirm') {
  return {
    support: {
      model: model(),
      tools: {
        refund: {
          description: 'refund an order',
          inputSchema: z.object({ amount: z.number() }),
          ...(kind === 'confirm' ? { confirm: true } : {}),
          execute: async ({ amount }: { amount: number }) => { refunds.push(amount); return { ok: true }; },
        },
      },
      ...(kind === 'guard' ? { guard: () => ({ action: 'require-approval' as const, reason: 'a representative decides' }) } : {}),
    },
  };
}
const auth = () => roleAuth({ admin: { token: 'STAFF-VELI', user: 'veli', orgId: 'acme' }, endUsers: { secret: SECRET, orgId: 'acme' } })!;

type Handler = (r: Request) => Promise<Response>;
const post = async (h: Handler, path: string, authz: string, body: unknown) => {
  const res = await h(new Request(`http://x${path}`, { method: 'POST', headers: { 'content-type': 'application/json', authorization: authz }, body: JSON.stringify(body) }));
  return { status: res.status, text: await res.text() };
};

/** The one approval row for `toolCallId` (the org partition prefixes keys, so it is found by suffix). */
async function recordOf(journal: Journal, toolCallId: string): Promise<Record<string, unknown>> {
  const keys = (await journal.listKeys('')).filter((k) => isApprovalOf(k, toolCallId));
  expect(keys, `exactly one approval row for ${toolCallId}`).toHaveLength(1);
  return (await journal.get(keys[0]!)) as Record<string, unknown>;
}

function restApi(kind: 'guard' | 'confirm', surfaces: unknown[] = []) {
  const refunds: number[] = [];
  const storage = new InMemoryStorage();
  const api = createRestApi({ storage, memory: false, agents: agents(refunds, kind) } as never, {
    auth: auth(), org: {}, protectionsBanner: false, surfaces,
  } as never) as unknown as Handler;
  const suspendFor = async (sub: string, runId: string) => {
    const r = await post(api, '/agents/support/run', tok(sub), { runId, prompt: 'refund my 12500 order' });
    expect(r.status, r.text).toBe(200);
    expect(JSON.parse(r.text).interrupts, 'precondition: the question is asked').toHaveLength(1);
  };
  return { api, refunds, journal: storage.runs as unknown as Journal, suspendFor };
}

describe('the approval record names who answered (REST)', () => {
  it('staff (operator token) approve the customer\'s run on /resume → answeredBy the operator, answeredAs staff, actor unchanged', async () => {
    const { api, refunds, journal, suspendFor } = restApi('guard');
    await suspendFor('u-ayse', 'r-staff');
    const r = await post(api, '/agents/support/resume', VELI, { runId: 'r-staff', approvals: { c1: true } });
    expect(r.status, r.text).toBe(200);
    expect(refunds).toEqual([12500]);
    const rec = await recordOf(journal, 'c1');
    expect(rec.decision).toBe(true);
    expect(rec.answeredBy, 'the record must name the operator who answered, not the run\'s owner').toBe('operator:veli');
    expect(rec.answeredAs).toBe('staff');
    // `actor` keeps today's meaning (the run's ownership stamp) — backward compatible, not repurposed.
    expect(rec.actor).toBe('u-ayse');
  });

  it('staff deny is recorded the same way (decision false, answeredBy the operator)', async () => {
    const { api, refunds, journal, suspendFor } = restApi('guard');
    await suspendFor('u-ayse', 'r-staff-deny');
    await post(api, '/agents/support/resume', VELI, { runId: 'r-staff-deny', approvals: { c1: false } });
    expect(refunds).toEqual([]);
    const rec = await recordOf(journal, 'c1');
    expect(rec).toMatchObject({ decision: false, answeredBy: 'operator:veli', answeredAs: 'staff' });
  });

  it('the customer answers their own confirm question on /resume → answeredBy the customer, answeredAs requester', async () => {
    const { api, refunds, journal, suspendFor } = restApi('confirm');
    await suspendFor('u-ayse', 'r-cust');
    const r = await post(api, '/agents/support/resume', tok('u-ayse'), { runId: 'r-cust', approvals: { c1: true } });
    expect(r.status, r.text).toBe(200);
    expect(refunds).toEqual([12500]);
    const rec = await recordOf(journal, 'c1');
    expect(rec).toMatchObject({ decision: true, answeredBy: 'u-ayse', answeredAs: 'requester', actor: 'u-ayse' });
  });

  it('the customer answers their own confirm question on /run (approvals in the body) → requester', async () => {
    const { api, refunds, journal, suspendFor } = restApi('confirm');
    await suspendFor('u-ayse', 'r-cust-run');
    const r = await post(api, '/agents/support/run', tok('u-ayse'), { runId: 'r-cust-run', prompt: 'refund my 12500 order', approvals: { c1: true } });
    expect(r.status, r.text).toBe(200);
    expect(refunds).toEqual([12500]);
    expect(await recordOf(journal, 'c1')).toMatchObject({ answeredBy: 'u-ayse', answeredAs: 'requester' });
  });

  it('the customer answers their own confirm question on /stream → requester', async () => {
    const { api, refunds, journal, suspendFor } = restApi('confirm');
    await suspendFor('u-ayse', 'r-cust-stream');
    const r = await post(api, '/agents/support/stream', tok('u-ayse'), { runId: 'r-cust-stream', prompt: 'refund my 12500 order', approvals: { c1: true } });
    expect(r.status, r.text.slice(0, 200)).toBe(200);
    expect(refunds).toEqual([12500]);
    expect(await recordOf(journal, 'c1')).toMatchObject({ answeredBy: 'u-ayse', answeredAs: 'requester' });
  });

  it('the customer\'s NO on her own pending GUARD question is recorded as hers → answeredBy the customer, requester', async () => {
    // d25 step 2: the customer's YES on an approve question is refused (see below) and journals nothing;
    // her NO always goes through — and the record names her.
    const { api, refunds, journal, suspendFor } = restApi('guard');
    await suspendFor('u-ayse', 'r-own-guard-rec');
    const r = await post(api, '/agents/support/resume', tok('u-ayse'), { runId: 'r-own-guard-rec', approvals: { c1: false } });
    expect(r.status, r.text).toBe(200);
    expect(refunds).toEqual([]);
    expect(await recordOf(journal, 'c1')).toMatchObject({ decision: false, answeredBy: 'u-ayse', answeredAs: 'requester', actor: 'u-ayse' });
  });

  it('staff answer on /run (approvals in the body, the customer\'s run) → staff, the operator', async () => {
    const { api, refunds, journal, suspendFor } = restApi('guard');
    await suspendFor('u-ayse', 'r-staff-run');
    const r = await post(api, '/agents/support/run', VELI, { runId: 'r-staff-run', resourceId: 'u-ayse', prompt: 'refund my 12500 order', approvals: { c1: true } });
    expect(r.status, r.text).toBe(200);
    expect(refunds).toEqual([12500]);
    expect(await recordOf(journal, 'c1')).toMatchObject({ answeredBy: 'operator:veli', answeredAs: 'staff' });
  });
});

describe('the approval record names who answered (chatSurface, aguiSurface, A2A)', () => {
  it('chatSurface: the customer answers their own confirm question (approvalPayload) → requester', async () => {
    const { api, refunds, journal, suspendFor } = restApi('confirm', [chatSurface()]);
    await suspendFor('u-ayse', 'r-chat');
    const r = await post(api, '/agents/support/chat', tok('u-ayse'), {
      id: 'conv', runId: 'r-chat', approvals: { c1: true },
      messages: [{ id: 'm1', role: 'user', parts: [{ type: 'text', text: 'refund my 12500 order' }] }],
    });
    expect(r.status, r.text.slice(0, 200)).toBe(200);
    expect(refunds).toEqual([12500]);
    expect(await recordOf(journal, 'c1')).toMatchObject({ answeredBy: 'u-ayse', answeredAs: 'requester' });
  });

  it('aguiSurface: the customer answers their own confirm question → requester', async () => {
    const { api, refunds, journal, suspendFor } = restApi('confirm', [aguiSurface()]);
    await suspendFor('u-ayse', 'r-agui');
    const r = await post(api, '/agents/support/agui', tok('u-ayse'), { runId: 'r-agui', prompt: 'refund my 12500 order', approvals: { c1: true } });
    expect(r.status, r.text.slice(0, 200)).toBe(200);
    expect(refunds).toEqual([12500]);
    expect(await recordOf(journal, 'c1')).toMatchObject({ answeredBy: 'u-ayse', answeredAs: 'requester' });
  });

  it('A2A: the customer replies on their task with { approvals } → requester', async () => {
    const refunds: number[] = [];
    const journal = new InMemoryJournal();
    const a = auth();
    const serve = createA2AServer({ journal, memory: false, agents: agents(refunds, 'confirm') } as never, {
      identify: (req: Request) => a.authenticate(req) ?? undefined,
      authorize: (p: any, req: any, ctx: any) => a.authorize(p, req, ctx),
      protectionsBanner: false,
    } as never) as unknown as Handler;
    const rpc = async (params: unknown) => JSON.parse((await post(serve, '/agents/support', tok('u-ayse'), { jsonrpc: '2.0', id: 1, method: 'message/send', params })).text);
    const task = (await rpc({ message: { kind: 'message', role: 'user', messageId: 'm1', parts: [{ kind: 'text', text: 'refund my 12500 order' }] } })).result;
    expect(task?.status?.state, 'precondition').toBe('input-required');
    const askedId: string = task.status.message.parts.find((p: any) => p.kind === 'data').data.interrupts[0].toolCallId; // the id the system gave the question
    await rpc({ message: { kind: 'message', role: 'user', messageId: 'm2', taskId: task.id, parts: [{ kind: 'data', data: { approvals: { [askedId]: true } } }] } });
    expect(refunds).toEqual([12500]);
    expect(await recordOf(journal as unknown as Journal, 'c1')).toMatchObject({ answeredBy: 'u-ayse', answeredAs: 'requester' });
  });
});

describe('who may answer (d25 step 2 decides; step 1 left it unchanged)', () => {
  it('step 2: the customer\'s YES on her own pending GUARD (approve) question is refused — 403, no refund, nothing recorded', async () => {
    // Was "today's behaviour is kept … still runs" (step 1 pinned it unchanged and said it would change with
    // step 2). KARAR-1 step 2: a guard's require-approval is an approve question; only an authorised person says yes.
    const { api, refunds, journal, suspendFor } = restApi('guard');
    await suspendFor('u-ayse', 'r-own-guard');
    const r = await post(api, '/agents/support/resume', tok('u-ayse'), { runId: 'r-own-guard', approvals: { c1: true } });
    expect(r.status, r.text).toBe(403);
    expect(refunds).toEqual([]);
    expect((await journal.listKeys('')).filter((k) => isApprovalOf(k, 'c1'))).toEqual([]);
  });

  it('today\'s behaviour is kept: another customer still cannot answer somebody else\'s question (404, nothing recorded)', async () => {
    const { api, refunds, journal, suspendFor } = restApi('guard');
    await suspendFor('u-ayse', 'r-other');
    const r = await post(api, '/agents/support/resume', tok('u-mallory'), { runId: 'r-other', approvals: { c1: true } });
    expect(r.status).toBe(404);
    expect(refunds).toEqual([]);
    expect((await journal.listKeys('')).filter((k) => isApprovalOf(k, 'c1'))).toEqual([]);
  });
});
