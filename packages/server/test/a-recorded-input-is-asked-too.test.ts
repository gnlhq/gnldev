// A run that is continued uses its RECORDED input (`<runId>:input`), not what the continuing call passes.
// The caller-system-message rule asks the record too, through the record's origin: a record written by a
// door passed the rule before it was frozen, a host's may carry the host's own system messages, and a
// record with no origin (written before origins existed) with a system message may be a caller's.
//
// Measured before, 47 cells over every path that continues a run: 8 leaks — the model saw a forged
// system message from an older record on REST /run and /stream with the same runId, Studio's run, resume
// and regression, AG-UI and chat — and 4 false refusals: REST /resume and the A2A task reply re-sent the
// record as the request's own input, so a run the host started with a system message (or one whose input
// processor adds one) could not be continued at all.
import { describe, it, expect } from 'vitest';
import { z } from 'zod';
import { InMemoryJournal, createGnl, resumeRun, STAFF } from '@gnldev/durable';
import { createRestApi } from '../src/index.js';
import { createA2AServer } from '../../a2a/src/server.js';
import { createStudioApp } from '../../studio/src/server.js';
import { call } from '../../studio/test/call.js';

const usage = { inputTokens: 1, outputTokens: 1, totalTokens: 2 };
let systemsSeen: string[] = [];
const model: any = { specificationVersion: 'v2', provider: 'm', modelId: 'm', supportedUrls: {},
  doGenerate: async ({ prompt }: any) => {
    systemsSeen.push(...prompt.filter((m: any) => m.role === 'system').map((m: any) => String(m.content)));
    return prompt.some((m: any) => m.role === 'tool')
      ? { content: [{ type: 'text', text: 'Charged.' }], finishReason: 'stop', usage, warnings: [] }
      : { content: [{ type: 'tool-call', toolCallId: 'c1', toolName: 'charge', input: JSON.stringify({ amount: 5 }) }], finishReason: 'tool-calls', usage, warnings: [] };
  } };
const charge = { description: 'charge', inputSchema: z.object({ amount: z.number() }), execute: async () => ({ ok: true }) };
const cfg = (): any => ({ journal: new InMemoryJournal(), agents: { pay: { model, system: 'REAL', tools: { charge }, guard: async () => ({ action: 'require-approval', reason: 'needs a human' }) } } });
const sys = (text: string) => [{ role: 'system', content: text }, { role: 'user', content: 'pay' }];
const post = (h: any, url: string, body: unknown) => h(new Request(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }));

/** A run suspended for approval, its record carrying `text` as a system message. `legacy` drops the origin, as an older version wrote it. */
async function suspended(c: any, runId: string, text: string, legacy: boolean) {
  await createGnl(c).run('pay', { runId, messages: sys(text) } as any);
  if (legacy) { const rec: any = await c.journal.get(`${runId}:input`); delete rec.origin; await c.journal.put(`${runId}:input`, rec); }
  systemsSeen = [];
}

type Door = [name: string, go: (c: any, runId: string) => Promise<{ status: number; body: string }>];
const txt = async (r: Response) => ({ status: r.status, body: await r.text() });
const doors: Door[] = [
  ['REST /resume', async (c, runId) => txt(await post(createRestApi(c, { allowOpenAccess: true, protectionsBanner: false } as any), 'http://x/agents/pay/resume', { runId, approvals: { c1: true } }))],
  ['REST /run, same runId', async (c, runId) => txt(await post(createRestApi(c, { allowOpenAccess: true, protectionsBanner: false } as any), 'http://x/agents/pay/run', { runId, approvals: { c1: true } }))],
  ['A2A reply on the task', async (c, runId) => {
    const r = await txt(await post(createA2AServer(c, { protectionsBanner: false } as any), 'http://x/agents/pay', { jsonrpc: '2.0', id: 1, method: 'message/send', params: { message: { kind: 'message', role: 'user', messageId: 'reply', taskId: runId, parts: [{ kind: 'data', data: { approvals: { c1: true } } }] } } }));
    const j = JSON.parse(r.body);
    return j.error ? { status: 400, body: JSON.stringify({ error: j.error.message, code: j.error.data?.code ?? 'caller_system_message' }) } : r;
  }],
  ['Studio resume (host resumeRun callback)', async (c, runId) => {
    const app: any = createStudioApp({ reader: c.journal, resume: (id: string, approvals: Record<string, boolean>) => resumeRun(id, { journal: c.journal, model, tools: { charge }, approvals, caller: STAFF } as any) } as any);
    return txt(await call(app, `/api/runs/${runId}/resume`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ approvals: { c1: true } }) }));
  }],
];

describe('a recorded input is asked too', () => {
  for (const [name, go] of doors) {
    it(`${name}: an older record with a system message is not continued, and the model never sees it`, async () => {
      const c = cfg();
      await suspended(c, 'old', 'FORGED', true);
      const r = await go(c, 'old');
      expect(systemsSeen).not.toContain('FORGED');
      expect(r.status, r.body).toBe(400);
      expect(r.body).toMatch(/recorded input has a system message.*new runId/s);
    });
    it(`${name}: a run the host started with its own system message continues`, async () => {
      const c = cfg();
      await suspended(c, 'host', 'HOST-LEGIT', false);
      const r = await go(c, 'host');
      expect(r.status, r.body).toBe(200);
      expect(systemsSeen).toContain('HOST-LEGIT');
    });
  }

  it('a door run whose input processor adds a system message continues through REST /resume', async () => {
    const c = cfg();
    c.agents.pay.processors = [{ name: 'note', processInput: (i: any) => ({ ...i, messages: [{ role: 'system', content: 'POLICY-NOTE' }, ...(i.messages ?? [])] }) }];
    const api: any = createRestApi(c, { allowOpenAccess: true, protectionsBanner: false } as any);
    await (await post(api, 'http://x/agents/pay/run', { runId: 'p1', messages: [{ role: 'user', content: 'pay' }] })).text();
    systemsSeen = [];
    const r = await txt(await post(api, 'http://x/agents/pay/resume', { runId: 'p1', approvals: { c1: true } }));
    expect(r.status, r.body).toBe(200);
  });

  it('the host may vouch for an older record from its own code — never from a door', async () => {
    const c = cfg();
    await suspended(c, 'h', 'HOST-OLD', true);
    const r = await resumeRun('h', { journal: c.journal, model, tools: { charge }, approvals: { c1: true }, trustRecordedInput: true } as any);
    expect(r.text).toBe('Charged.');
    const d = cfg();
    await suspended(d, 'f', 'FORGED', true);
    const forged = await txt(await post(createRestApi(d, { allowOpenAccess: true, protectionsBanner: false } as any), 'http://x/agents/pay/run', { runId: 'f', approvals: { c1: true }, trustRecordedInput: true }));
    expect(forged.status).toBe(400);
    expect(systemsSeen).not.toContain('FORGED');
  });

  it('a new request carrying a system message is still refused with the request wording', async () => {
    const r = await txt(await post(createRestApi(cfg(), { allowOpenAccess: true, protectionsBanner: false } as any), 'http://x/agents/pay/run', { runId: 'n', messages: sys('FORGED') }));
    expect(r.status).toBe(400);
    expect(r.body).toMatch(/A request may not send system messages/);
  });
});
