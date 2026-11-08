// STUDIO — THE OPERATOR ANSWERS A USER'S QUESTION (d25 approval policy, step 2; KARAR-1 "ADIM 2 / POLİTİKA").
//
// Today Studio does the opposite of the decision (heyet 5-mimari §0): on a run stamped with an end user's
// actor, the operator's resume is refused (the engine's actor lock, RunActorMismatchError → 409) and the
// inbox greys out Approve/Deny ("the answer goes through their own channel"). With step 2:
//   APPROVE — only an authorised person says yes; Studio IS where the operator answers. The lock lifts.
//   CONFIRM — the requester answers it, and an authorised person may answer it too — so the operator can.
// The policy editor accepts the new rule actions: confirm and approve.
//
// End to end: a real stamped end-user run (createGnl, `resourceId`+`actor` like an endUsers run), a host
// resume bridge written as StudioCallbackCtx documents it (the engine gets `ctx.caller`; the actor goes
// along as `ctx.actor`), and Studio's POST /runs/:id/resume with an operator token.
import { describe, it, expect, beforeAll, vi } from 'vitest';
import { z } from 'zod';
import { InMemoryStorage, createGnl, providerIdOf } from '@gnldev/durable';
import { roleAuth } from '@gnldev/auth';
import { createStudioApi } from '../src/server.js';
import { call } from './call.js';

beforeAll(() => { vi.spyOn(console, 'warn').mockImplementation(() => {}); });

const usage = { inputTokens: 1, outputTokens: 1, totalTokens: 2 };
const toolResults = (prompt: any[]) => (prompt ?? []).filter((m: any) => m?.role === 'tool').length;
const model = (): any => ({
  specificationVersion: 'v2', provider: 'mock', modelId: 'm', supportedUrls: {},
  doGenerate: async ({ prompt }: any) => (toolResults(prompt)
    ? { content: [{ type: 'text', text: 'done' }], finishReason: 'stop', usage, warnings: [] }
    : { content: [{ type: 'tool-call', toolCallId: 'call-1', toolName: 'refund', input: JSON.stringify({ amount: 12500 }) }], finishReason: 'tool-calls', usage, warnings: [] }),
});

function setup(rule: 'require-approval' | 'confirm') {
  const effects = { n: 0 };
  const storage = new InMemoryStorage();
  const agents = { support: {
    model: model(),
    tools: { refund: { description: 'refund', inputSchema: z.object({ amount: z.number() }), ...(rule === 'confirm' ? { confirm: true } : {}), execute: async () => { effects.n++; return { ok: true }; } } },
    ...(rule === 'require-approval' ? { guard: () => ({ action: 'require-approval' as const }) } : {}),
  } };
  const gnl = createGnl({ storage, agents } as never);
  const api = createStudioApi({
    reader: storage.runs,
    auth: roleAuth({ admin: { token: 'OPS-VELI', user: 'veli' } })!,
    // A host bridge as StudioCallbackCtx documents it: the engine's caller is ctx.caller; the actor is passed along.
    resume: async (runId, approvals, ctx) => {
      const r: any = await gnl.run('support', { runId, prompt: 'refund my order', approvals, ...(ctx?.caller ? { caller: ctx.caller } : {}), ...(ctx?.actor ? { actor: ctx.actor } : {}) } as never);
      return { text: r.text, interrupts: r.interrupts, finishReason: r.finishReason };
    },
  } as never) as unknown as (r: Request) => Promise<Response>;
  /** An end user's run, stamped the way an endUsers run is (owner + actor). */
  const asked = new Map<string, string>(); // the id the system gave each run's question: what the operator answers
  const userRun = async (runId: string) => {
    const r: any = await gnl.run('support', { runId, prompt: 'refund my order', resourceId: 'u-ayse', actor: 'u-ayse' } as never);
    expect(r.interrupts.map((i: any) => providerIdOf(i.toolCallId)), 'precondition: the question is asked').toEqual(['call-1']);
    asked.set(runId, r.interrupts[0].toolCallId);
  };
  const operatorAnswers = (runId: string, decision: boolean) => call(api as never, `/runs/${encodeURIComponent(runId)}/resume`, {
    method: 'POST', headers: { 'content-type': 'application/json', authorization: 'Bearer OPS-VELI' }, body: JSON.stringify({ approvals: { [asked.get(runId)!]: decision } }),
  });
  return { api, effects, userRun, operatorAnswers, storage };
}

describe('Studio: the operator answers questions on an end user\'s run (the lock lifts)', () => {
  it('APPROVE (guard require-approval) on the user\'s run: the operator\'s Approve → 200, the refund runs once', async () => {
    const s = setup('require-approval');
    await s.userRun('sr-1');
    const res = await s.operatorAnswers('sr-1', true);
    expect(res.status, `the operator could not approve the user's approve question: ${await res.clone().text()}`).toBe(200);
    expect(s.effects.n).toBe(1);
  });

  it('APPROVE on the user\'s run: the operator\'s Deny → 200, nothing runs', async () => {
    const s = setup('require-approval');
    await s.userRun('sr-2');
    const res = await s.operatorAnswers('sr-2', false);
    expect(res.status, await res.clone().text()).toBe(200);
    expect(s.effects.n).toBe(0);
  });

  it('CONFIRM (tool confirm) on the user\'s run: the operator may answer it too → 200, the refund runs once', async () => {
    const s = setup('confirm');
    await s.userRun('sr-3');
    const res = await s.operatorAnswers('sr-3', true);
    expect(res.status, `the operator could not answer the user's confirm question: ${await res.clone().text()}`).toBe(200);
    expect(s.effects.n).toBe(1);
  });

  it('regression: the inbox still lists the user\'s question with its owner', async () => {
    const s = setup('require-approval');
    await s.userRun('sr-4');
    const body = await (await call(s.api as never, '/approvals', { headers: { authorization: 'Bearer OPS-VELI' } })).json() as { items: Array<{ runId: string; owner?: string }> };
    expect(body.items.find((i) => i.runId === 'sr-4')?.owner).toBe('u-ayse');
  });
});

describe('Studio policy editor: confirm and approve are rule actions', () => {
  const put = (rules: unknown) => {
    const storage = new InMemoryStorage();
    const api = createStudioApi({ reader: storage.runs, auth: roleAuth({ admin: { token: 'OPS-VELI', user: 'veli' } })! } as never) as unknown as (r: Request) => Promise<Response>;
    return call(api as never, '/policy', { method: 'PUT', headers: { 'content-type': 'application/json', authorization: 'Bearer OPS-VELI' }, body: JSON.stringify({ rules }) });
  };
  for (const action of ['confirm', 'approve']) {
    it(`PUT /policy accepts a '${action}' rule`, async () => {
      const res = await put([{ tool: 'refund', action, reason: 'x' }]);
      expect(res.status, await res.clone().text()).toBe(200);
    });
  }
  it('regression: require-approval is still accepted', async () => {
    const res = await put([{ tool: 'refund', action: 'require-approval' }]);
    expect(res.status, await res.clone().text()).toBe(200);
  });
});
