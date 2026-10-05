// The A2A door answers a caller conflict the way every door does (durable's callerConflictAnswer), asks
// the engine's target rule on its own read and cancel paths, and reports refusals to onDecision.
//
// Measured before:
//   · tasks/get and tasks/cancel ignored the agent the route named: a `pay` task was read AND canceled
//     through /agents/helper, by an anonymous caller and by its own user;
//   · a stranger's tasks/get on another user's task was reported to onDecision as allowed (REST: refused,
//     ownership);
//   · a user re-sending their own messageId with different text was told "Task not found";
//   · canceling a canceled task answered `canceled` again (the SDK reference: -32002);
//   · the client resolved `working` and `auth-required` as answers, so a durableTool journaled them done.
import { describe, it, expect } from 'vitest';
import { z } from 'zod';
import { InMemoryJournal } from '@gnldev/durable';
import { createA2AServer, A2A_ERROR_CODES } from '../src/server.js';
import { createA2ATool } from '../src/index.js';
import { textModel, chargeModel } from './models.js';

const identify = (req: Request): any => {
  const u = req.headers.get('x-user');
  return u ? { kind: 'subject', id: u, roles: [] } : undefined;
};
let seq = 0;
const rpc = async (serve: any, agent: string, method: string, params: unknown, user?: string) => {
  const res = await serve(new Request(`http://localhost/agents/${agent}`, {
    method: 'POST', headers: { 'content-type': 'application/json', ...(user ? { 'x-user': user } : {}) },
    body: JSON.stringify({ jsonrpc: '2.0', id: ++seq, method, params }),
  }));
  return (await res.json()) as any;
};
const send = (serve: any, agent: string, messageId: string, text: string, user?: string) =>
  rpc(serve, agent, 'message/send', { message: { kind: 'message', role: 'user', messageId, parts: [{ kind: 'text', text }] } }, user);

function server(onDecision?: (d: any) => void) {
  return createA2AServer({
    journal: new InMemoryJournal(),
    agents: {
      helper: { model: textModel('hi there') },
      pay: {
        model: chargeModel(),
        tools: { charge: { description: 'charge', inputSchema: z.object({ amount: z.number() }), execute: async () => ({ ok: true }) } },
        guard: async () => ({ action: 'require-approval' as const, reason: 'big amount' }),
      },
    },
  } as never, { identify, protectionsBanner: false, ...(onDecision ? { onDecision } : {}) } as never);
}

describe('the A2A door', () => {
  for (const user of [undefined, 'ayse']) {
    it(`a task is reached only through its own agent's route (${user ?? 'anonymous'})`, async () => {
      const serve = server();
      const task = (await send(serve, 'pay', 'p1', 'pay 500', user)).result;
      expect(task.status.state).toBe('input-required');
      expect((await rpc(serve, 'helper', 'tasks/get', { id: task.id }, user)).error.code).toBe(A2A_ERROR_CODES.taskNotFound);
      expect((await rpc(serve, 'helper', 'tasks/cancel', { id: task.id }, user)).error.code).toBe(A2A_ERROR_CODES.taskNotFound);
      expect((await rpc(serve, 'pay', 'tasks/get', { id: task.id }, user)).result.status.state).toBe('input-required');
    });
  }

  it("a stranger's read and cancel are reported to onDecision as refused, for ownership", async () => {
    const decisions: any[] = [];
    const serve = server((d) => decisions.push(d));
    const task = (await send(serve, 'helper', 'm1', 'q', 'ayse')).result;
    decisions.length = 0;
    for (const m of ['tasks/get', 'tasks/cancel']) {
      expect((await rpc(serve, 'helper', m, { id: task.id }, 'bora')).error.code).toBe(A2A_ERROR_CODES.taskNotFound);
      expect(decisions.pop()).toMatchObject({ allowed: false, reason: 'ownership' });
    }
  });

  it('a user re-sending their own messageId with different text is told so, not "task not found"', async () => {
    const serve = server();
    await send(serve, 'helper', 'm1', 'first', 'ayse');
    const again = await send(serve, 'helper', 'm1', 'something else', 'ayse');
    expect(again.error.code).toBe(A2A_ERROR_CODES.invalidParams);
    expect(again.error.data.code).toBe('run_input_mismatch');
  });

  it('a canceled task is not cancelable again (-32002), as the SDK reference answers', async () => {
    const serve = server();
    const task = (await send(serve, 'pay', 'p1', 'pay 500', 'ayse')).result;
    expect((await rpc(serve, 'pay', 'tasks/cancel', { id: task.id }, 'ayse')).result.status.state).toBe('canceled');
    expect((await rpc(serve, 'pay', 'tasks/cancel', { id: task.id }, 'ayse')).error.code).toBe(A2A_ERROR_CODES.taskNotCancelable);
  });
});

describe('the A2A client: only an answer resolves', () => {
  /** A minimal standard A2A agent answering every message/send with a task in the given state. */
  const remote = (state: string) => (async (url: string, init?: any) => {
    if (String(url).endsWith('.json')) return new Response(JSON.stringify({ name: 'r', url: 'http://remote/rpc', capabilities: {} }), { headers: { 'content-type': 'application/json' } });
    const { id } = JSON.parse(init.body);
    return new Response(JSON.stringify({ jsonrpc: '2.0', id, result: { kind: 'task', id: 't1', contextId: 'c', status: { state, message: { kind: 'message', role: 'agent', messageId: 'x', parts: [{ kind: 'text', text: 'Sign in at https://idp/x first' }] } } } }), { headers: { 'content-type': 'application/json' } });
  }) as typeof fetch;
  for (const state of ['working', 'submitted', 'auth-required', 'unknown']) {
    it(`a '${state}' task throws, naming the state — it is not an answer to journal`, async () => {
      const t: any = createA2ATool({ protocol: 'a2a', endpoint: 'http://remote', agentName: 'r', fetchImpl: remote(state) });
      await expect(t.execute({ task: 'x' }, { toolCallId: 'c1', messages: [] })).rejects.toThrow(new RegExp(`is '${state}', not an answer`));
    });
  }
});
