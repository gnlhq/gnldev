// The A2A door's siblings of the evidence test: every way a task maps onto a GNL run.
import { describe, it, expect } from 'vitest';
import { z } from 'zod';
import { InMemoryJournal } from '@gnldev/durable';
import { createA2AServer, A2A_ERROR_CODES } from '../src/server.js';
import { textModel, chargeModel } from './models.js';

// identify reads a test header: `x-user: <id>@<org>`, `x-app: <org>` (an application credential).
const identify = (req: Request): any => {
  const u = req.headers.get('x-user');
  if (u) { const [id, orgId] = u.split('@'); return { kind: 'subject', id, ...(orgId ? { orgId } : {}), roles: [] }; }
  const app = req.headers.get('x-app');
  if (app) return { kind: 'application', id: 'app', orgId: app, roles: [] };
  return undefined;
};

function mkServer(opts: { identify?: boolean; calls?: { n: number } } = {}) {
  const executed: number[] = [];
  const journal = new InMemoryJournal();
  const serve = createA2AServer({
    journal,
    agents: {
      helper: { model: textModel('hi there', opts.calls) },
      pay: {
        model: chargeModel(),
        tools: { charge: { description: 'charge a card', inputSchema: z.object({ amount: z.number() }), execute: async ({ amount }: { amount: number }) => { executed.push(amount); return { ok: true }; } } },
        guard: async () => ({ action: 'require-approval' as const, reason: 'big amount' }),
      },
    },
  } as never, opts.identify ? { identify } : {});
  return { serve, executed, journal };
}

let seq = 0;
async function rpc(serve: (r: Request) => Promise<Response>, agent: string, method: string, params: unknown, headers: Record<string, string> = {}) {
  const res = await serve(new Request(`http://localhost/agents/${agent}`, {
    method: 'POST', headers: { 'content-type': 'application/json', ...headers },
    body: JSON.stringify({ jsonrpc: '2.0', id: ++seq, method, params }),
  }));
  return { status: res.status, body: await res.json() as any };
}
const send = (serve: any, agent: string, messageId: string, extra: Record<string, unknown> = {}, headers: Record<string, string> = {}) =>
  rpc(serve, agent, 'message/send', { message: { kind: 'message', role: 'user', messageId, parts: [{ kind: 'text', text: 'do it' }], ...extra } }, headers);
const approve = (serve: any, agent: string, taskId: string, ok: boolean, headers: Record<string, string> = {}) =>
  rpc(serve, agent, 'message/send', { message: { kind: 'message', role: 'user', messageId: `${taskId}-reply`, taskId, parts: [{ kind: 'data', data: { approvals: { c1: ok } } }] } }, headers);

describe('A2A door: message/send is a GNL run', () => {
  it('re-sending the same messageId is the same task — the model runs once', async () => {
    const calls = { n: 0 };
    const { serve } = mkServer({ calls });
    const a = await send(serve, 'helper', 'same');
    const b = await send(serve, 'helper', 'same');
    expect(a.body.result.status.state).toBe('completed');
    expect(b.body.result.id).toBe(a.body.result.id);
    expect(b.body.result.artifacts[0].parts[0].text).toBe('hi there');
    expect(calls.n).toBe(1);
    const c = await send(serve, 'helper', 'other');
    expect(c.body.result.id).not.toBe(a.body.result.id);
    expect(calls.n).toBe(2);
  });

  it('the same messageId from two users is two tasks (a workKey is unique within its user)', async () => {
    const calls = { n: 0 };
    const { serve } = mkServer({ identify: true, calls });
    const a = await send(serve, 'helper', 'm', {}, { 'x-user': 'ayse' });
    const b = await send(serve, 'helper', 'm', {}, { 'x-user': 'bora' });
    expect(a.body.result.id).not.toBe(b.body.result.id);
    expect(calls.n).toBe(2);
  });

  it('a run that suspends for approval is input-required, and an approval reply completes it', async () => {
    const { serve, executed } = mkServer();
    const first = await send(serve, 'pay', 'p1');
    const task = first.body.result;
    expect(task.status.state).toBe('input-required');
    const data = task.status.message.parts.find((p: any) => p.kind === 'data').data;
    expect(data.interrupts[0]).toMatchObject({ toolCallId: 'c1', toolName: 'charge' });
    expect(executed).toEqual([]);

    const got = await rpc(serve, 'pay', 'tasks/get', { id: task.id });
    expect(got.body.result.status.state).toBe('input-required');
    expect(got.body.result.status.message.parts[1].data.interrupts[0]).toMatchObject({ toolCallId: 'c1', toolName: 'charge', args: { amount: 5000 } });

    const done = await approve(serve, 'pay', task.id, true);
    expect(done.body.result).toMatchObject({ id: task.id, status: { state: 'completed' } });
    expect(done.body.result.artifacts[0].parts[0].text).toBe('Charged.');
    expect(executed).toEqual([5000]);

    // Approving again replays: the charge is not made twice.
    await approve(serve, 'pay', task.id, true);
    expect(executed).toEqual([5000]);
    const after = await rpc(serve, 'pay', 'tasks/get', { id: task.id });
    expect(after.body.result.status.state).toBe('completed');
    expect(after.body.result.artifacts[0].parts[0].text).toBe('Charged.');
  });

  it('tasks/cancel ends an input-required task for good; a completed task is not cancelable', async () => {
    const { serve, executed } = mkServer();
    const task = (await send(serve, 'pay', 'p2')).body.result;
    const canceled = await rpc(serve, 'pay', 'tasks/cancel', { id: task.id });
    expect(canceled.body.result.status.state).toBe('canceled');
    expect((await rpc(serve, 'pay', 'tasks/get', { id: task.id })).body.result.status.state).toBe('canceled');
    const late = await approve(serve, 'pay', task.id, true);
    expect(late.body.result.status.state).toBe('canceled');
    expect(executed).toEqual([]);

    const fin = (await send(serve, 'helper', 'h1')).body.result;
    const no = await rpc(serve, 'helper', 'tasks/cancel', { id: fin.id });
    expect(no.body.error.code).toBe(A2A_ERROR_CODES.taskNotCancelable);
  });
});

describe('A2A door: a task is its owner\'s', () => {
  it('another user cannot read, cancel or continue a task — it does not exist for them', async () => {
    const { serve, executed } = mkServer({ identify: true });
    const task = (await send(serve, 'pay', 'own', {}, { 'x-user': 'ayse@acme' })).body.result;
    expect(task.status.state).toBe('input-required');
    for (const h of [{ 'x-user': 'mallory@acme' }, { 'x-user': 'ayse@other' }, {}]) {
      expect((await rpc(serve, 'pay', 'tasks/get', { id: task.id }, h)).body.error.code).toBe(A2A_ERROR_CODES.taskNotFound);
      expect((await rpc(serve, 'pay', 'tasks/cancel', { id: task.id }, h)).body.error.code).toBe(A2A_ERROR_CODES.taskNotFound);
      expect((await approve(serve, 'pay', task.id, true, h)).body.error.code).toBe(A2A_ERROR_CODES.taskNotFound);
    }
    expect(executed).toEqual([]);
    expect((await rpc(serve, 'pay', 'tasks/get', { id: task.id }, { 'x-user': 'ayse@acme' })).body.result.status.state).toBe('input-required');
  });

  it('an application credential names its user in metadata.resourceId, or is refused', async () => {
    const { serve, journal } = mkServer({ identify: true });
    const refused = await send(serve, 'helper', 'x', {}, { 'x-app': 'acme' });
    expect(refused.status).toBe(400);
    expect(refused.body.error.code).toBe(A2A_ERROR_CODES.refused);
    const ok = await rpc(serve, 'helper', 'message/send', { message: { kind: 'message', role: 'user', messageId: 'y', parts: [{ kind: 'text', text: 'q' }] }, metadata: { resourceId: 'ayse' } }, { 'x-app': 'acme' });
    expect(ok.body.result.status.state).toBe('completed');
    // The user the application named owns it: she reads it, another user does not.
    expect((await rpc(serve, 'helper', 'tasks/get', { id: ok.body.result.id }, { 'x-user': 'ayse@acme' })).body.result.status.state).toBe('completed');
    expect((await rpc(serve, 'helper', 'tasks/get', { id: ok.body.result.id }, { 'x-user': 'bora@acme' })).body.error.code).toBe(A2A_ERROR_CODES.taskNotFound);
    expect(journal).toBeDefined();
  });
});

describe('A2A door: JSON-RPC errors', () => {
  const raw = (serve: any, body: string, path = '/agents/helper') =>
    serve(new Request(`http://localhost${path}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body })).then(async (r: Response) => ({ status: r.status, body: await r.json() as any }));

  it('parse error, invalid request, method not found, invalid params, unsupported, task not found', async () => {
    const { serve } = mkServer();
    expect((await raw(serve, '{not json')).body).toMatchObject({ jsonrpc: '2.0', id: null, error: { code: -32700 } });
    expect((await raw(serve, '[]')).body.error.code).toBe(-32600); // valid JSON, not a request (JSON-RPC 2.0's own example)
    expect((await raw(serve, JSON.stringify({ id: 1, method: 'message/send' }))).body.error.code).toBe(-32600);
    expect((await raw(serve, JSON.stringify({ jsonrpc: '2.0', id: 1, method: 7 }))).body.error.code).toBe(-32600);
    expect((await rpc(serve, 'helper', 'agent/dance', {})).body.error.code).toBe(-32601);
    expect((await rpc(serve, 'helper', 'message/stream', {})).body.error.code).toBe(A2A_ERROR_CODES.unsupportedOperation);
    expect((await rpc(serve, 'helper', 'message/send', undefined)).body.error.code).toBe(-32602);
    expect((await rpc(serve, 'helper', 'message/send', { message: { role: 'user', parts: [] } })).body.error.code).toBe(-32602);
    expect((await rpc(serve, 'helper', 'tasks/get', {})).body.error.code).toBe(-32602);
    expect((await rpc(serve, 'helper', 'tasks/get', { id: 'nope' })).body.error.code).toBe(-32001);
    const ok = await rpc(serve, 'helper', 'tasks/get', { id: 'nope' });
    expect(ok.body.id).toBe(seq);
  });

  it('an unknown agent has no card and no endpoint', async () => {
    const { serve } = mkServer();
    expect((await serve(new Request('http://localhost/agents/ghost/.well-known/agent.json'))).status).toBe(404);
    const r = await rpc(serve, 'ghost', 'message/send', { message: { kind: 'message', role: 'user', messageId: 'g', parts: [{ kind: 'text', text: 'x' }] } });
    expect(r.status).toBe(404);
    expect(r.body.error.data.code).toBe('agent_not_found');
    expect((await serve(new Request('http://localhost/agents/helper/.well-known/agent-card.json'))).status).toBe(200);
    expect((await serve(new Request('http://localhost/agents/helper'))).status).toBe(405);
  });
});

describe('A2A door: the JSON-RPC envelope', () => {
  const post = async (serve: any, body: string) => serve(new Request('http://localhost/agents/helper', { method: 'POST', headers: { 'content-type': 'application/json' }, body }));
  it('a batch is valid JSON, so it is -32600 (not supported), not -32700 (parse error)', async () => {
    const { serve } = mkServer();
    const r = await (await post(serve, JSON.stringify([{ jsonrpc: '2.0', id: 1, method: 'tasks/get', params: { id: 'x' } }]))).json() as any;
    expect(r.error.code).toBe(A2A_ERROR_CODES.invalidRequest);
    expect(r.error.message).toMatch(/batch requests are not supported/);
    const bad = await (await post(serve, '{not json')).json() as any;
    expect(bad.error.code).toBe(A2A_ERROR_CODES.parseError);
  });
  it('a notification (no id) gets no reply and runs nothing', async () => {
    const calls = { n: 0 };
    const { serve } = mkServer({ calls });
    const res = await post(serve, JSON.stringify({ jsonrpc: '2.0', method: 'message/send', params: { message: { kind: 'message', role: 'user', messageId: 'n1', parts: [{ kind: 'text', text: 'hi' }] } } }));
    expect(res.status).toBe(204);
    expect(await res.text()).toBe('');
    expect(calls.n).toBe(0);
  });
});
