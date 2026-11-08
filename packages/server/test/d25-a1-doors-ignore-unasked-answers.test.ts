// AN ANSWER NEEDS A QUESTION — every door (d25 approval integrity, step 1; KARAR-1 "KULLANICI KARARI — ADIM 1").
//
// The engine-level rule (packages/durable/test/d25-a1-an-answer-needs-a-question.test.ts) seen from the
// doors a client actually uses: REST /run, /stream, /resume, chatSurface, aguiSurface, the standalone
// AG-UI route and the A2A server. Each door forwards the request's `approvals` to the engine; none of them
// may turn an answer for a call nobody has asked about into a decision.
//
// Field shape (deneme-25 project 13): a refund above 500 sits behind a guard's require-approval. The
// customer, with the end-user token the application signed for them, starts the run with
// `approvals: { call_0: true }` — the id the provider will give the refund call is predictable — and the
// refund runs without the question ever being asked. Measured on release/0.17.1: 200, refund executed.
//
// Expected (RED until fixed): on every door, the run stops at the question, nothing is refunded, and no
// answer for the unasked call is in the journal. Regression (GREEN today, must stay): an asked question's
// answer still decides it on these doors. (d25 step 2: where the customer answers, the question is the
// tool's confirm — her yes on a guard's require-approval is refused since step 2.)
import { describe, it, expect, beforeAll, vi } from 'vitest';
import { z } from 'zod';
import { InMemoryStorage, InMemoryJournal, type Journal, providerIdOf } from '@gnldev/durable';
import { roleAuth, signSubjectToken } from '@gnldev/auth';
import { createRestApi } from '../src/index.js';
import { chatSurface } from '../../chat-adapter/src/index.js';
import { createAguiRoute, aguiSurface } from '../../agui/src/index.js';
import { createA2AServer } from '../../a2a/src/server.js';

// Call ids are GNL ids (`c1.gnl-<run>-<step>-<n>`, the provider's id is the prefix): an approval row is found by the provider's id.
const isApprovalOf = (key: string, providerId: string): boolean => key.includes(':approval:') && providerIdOf(key.slice(key.lastIndexOf(':approval:') + ':approval:'.length)) === providerId;

beforeAll(() => { vi.spyOn(console, 'warn').mockImplementation(() => {}); });

const SECRET = 'app-signing-secret-at-least-32-bytes!!';
const STAFF = 'Bearer STAFF';
const tok = (sub: string) => `Bearer ${signSubjectToken({ sub }, SECRET)}`;
const usage = { inputTokens: 1, outputTokens: 1, totalTokens: 2 };
const toolResults = (prompt: any[] | undefined) => (prompt ?? []).filter((m: any) => m.role === 'tool').length;

/** A provider that numbers its calls: refund `call_0` (12500), then refund `call_1` (9000) when `two`, then text. */
function numberingModel(two = false): any {
  const calls = [{ id: 'call_0', amount: 12500 }, ...(two ? [{ id: 'call_1', amount: 9000 }] : [])];
  const step = (prompt: any[]) => calls[toolResults(prompt)];
  return {
    specificationVersion: 'v2', provider: 'mock', modelId: 'm', supportedUrls: {},
    doGenerate: async ({ prompt }: any) => {
      const c = step(prompt);
      return c
        ? { content: [{ type: 'tool-call', toolCallId: c.id, toolName: 'refund', input: JSON.stringify({ amount: c.amount }) }], finishReason: 'tool-calls', usage, warnings: [] }
        : { content: [{ type: 'text', text: 'Done.' }], finishReason: 'stop', usage, warnings: [] };
    },
    doStream: async ({ prompt }: any) => {
      const c = step(prompt);
      const parts = c
        ? [{ type: 'stream-start', warnings: [] }, { type: 'tool-call', toolCallId: c.id, toolName: 'refund', input: JSON.stringify({ amount: c.amount }) }, { type: 'finish', finishReason: 'tool-calls', usage }]
        : [{ type: 'stream-start', warnings: [] }, { type: 'text-start', id: '1' }, { type: 'text-delta', id: '1', delta: 'Done.' }, { type: 'text-end', id: '1' }, { type: 'finish', finishReason: 'stop', usage }];
      return { stream: new ReadableStream({ start(ctl) { for (const p of parts) ctl.enqueue(p); ctl.close(); } }) };
    },
  };
}

const guard = ({ args }: any) => ((args as { amount: number }).amount > 500
  ? { action: 'require-approval' as const, reason: 'refund above 500 needs a representative' }
  : { action: 'allow' as const });

/**
 * `kind: 'guard'` — a guard's require-approval (an APPROVE question since d25 step 2: only an authorised
 * person says yes). `kind: 'confirm'` — the tool's own confirm (a CONFIRM question: the customer answers).
 * The tests where the CUSTOMER answers use 'confirm' (step 2 refuses her yes on an approve question).
 */
function agents(refunds: number[], two = false, kind: 'guard' | 'confirm' = 'guard') {
  return {
    support: {
      model: numberingModel(two),
      tools: {
        refund: {
          description: 'refund an order',
          inputSchema: z.object({ amount: z.number() }),
          ...(kind === 'confirm' ? { confirm: true } : {}),
          execute: async ({ amount }: { amount: number }) => { refunds.push(amount); return { ok: true }; },
        },
      },
      ...(kind === 'guard' ? { guard } : {}),
    },
  };
}
const auth = () => roleAuth({ admin: { token: 'STAFF', orgId: 'acme' }, endUsers: { secret: SECRET, orgId: 'acme' } })!;

type Handler = (r: Request) => Promise<Response>;
const post = async (h: Handler, path: string, authz: string, body: unknown) => {
  const res = await h(new Request(`http://localhost${path}`, { method: 'POST', headers: { 'content-type': 'application/json', authorization: authz }, body: JSON.stringify(body) }));
  return { status: res.status, text: await res.text() };
};

/** The id the system gave the question, read from the door's own answer (every door names it as `toolCallId`). */
const askedIn = (text: string): string => /"toolCallId":\s*"([^"]+)"/.exec(text)![1]!;

/** Every approval row for `toolCallId` in this journal, whatever run (or org partition) it sits under. */
async function answersFor(journal: Journal, toolCallId: string): Promise<unknown[]> {
  const keys = (await journal.listKeys('')).filter((k) => isApprovalOf(k, toolCallId));
  return Promise.all(keys.map((k) => journal.get(k)));
}

/** One door: how a client starts a run, how it answers, and where its journal is. */
interface Door {
  name: string;
  make(refunds: number[], two?: boolean, kind?: 'guard' | 'confirm'): { journal: Journal; start(authz: string, runId: string, approvals?: Record<string, boolean>): Promise<{ status: number; text: string; taskId?: string }>; answer?(authz: string, runId: string, approvals: Record<string, boolean>): Promise<{ status: number; text: string }> };
}

const rest = (path: '/run' | '/stream' | '/chat' | '/agui', surfaces: unknown[] = []) => (refunds: number[], two = false, kind: 'guard' | 'confirm' = 'guard') => {
  const storage = new InMemoryStorage();
  const api = createRestApi({ storage, memory: false, agents: agents(refunds, two, kind) } as never, {
    auth: auth(), org: {}, protectionsBanner: false, surfaces,
  } as never) as unknown as Handler;
  const body = (runId: string, approvals?: Record<string, boolean>) => (path === '/chat'
    ? { id: `conv-${runId}`, runId, messages: [{ id: 'm1', role: 'user', parts: [{ type: 'text', text: 'refund my 12500 order' }] }], ...(approvals ? { approvals } : {}) }
    : { runId, prompt: 'refund my 12500 order', ...(approvals ? { approvals } : {}) });
  return {
    journal: storage.runs as unknown as Journal,
    start: (authz: string, runId: string, approvals?: Record<string, boolean>) => post(api, `/agents/support${path}`, authz, body(runId, approvals)),
    answer: (authz: string, runId: string, approvals: Record<string, boolean>) => (path === '/run' || path === '/stream'
      ? post(api, '/agents/support/resume', authz, { runId, approvals })
      : post(api, `/agents/support${path}`, authz, body(runId, approvals))),
  };
};

const DOORS: Door[] = [
  { name: 'REST POST /agents/:name/run', make: rest('/run') },
  { name: 'REST POST /agents/:name/stream', make: rest('/stream') },
  { name: 'chatSurface POST /agents/:name/chat', make: rest('/chat', [chatSurface()]) },
  { name: 'aguiSurface POST /agents/:name/agui', make: rest('/agui', [aguiSurface()]) },
  {
    name: 'standalone AG-UI route (createAguiRoute)',
    make: (refunds, two = false, kind: 'guard' | 'confirm' = 'guard') => {
      const journal = new InMemoryJournal();
      const a = auth();
      const route = createAguiRoute({ journal, memory: false, agents: agents(refunds, two, kind) } as never, {
        identify: (req: Request) => a.authenticate(req) ?? undefined,
        authorize: (p: any, req: any, ctx: any) => a.authorize(p, req, ctx),
        protectionsBanner: false,
      } as never) as unknown as Handler;
      const go = (authz: string, runId: string, approvals?: Record<string, boolean>) => post(route, '/agents/support/run', authz, { runId, prompt: 'refund my 12500 order', ...(approvals ? { approvals } : {}) });
      return { journal, start: go, answer: go };
    },
  },
  {
    name: 'A2A server (message/send with a data part { approvals })',
    make: (refunds, two = false, kind: 'guard' | 'confirm' = 'guard') => {
      const journal = new InMemoryJournal();
      const a = auth();
      const serve = createA2AServer({ journal, memory: false, agents: agents(refunds, two, kind) } as never, {
        identify: (req: Request) => a.authenticate(req) ?? undefined,
        authorize: (p: any, req: any, ctx: any) => a.authorize(p, req, ctx),
        protectionsBanner: false,
      } as never) as unknown as Handler;
      const rpc = (authz: string, params: unknown) => post(serve, '/agents/support', authz, { jsonrpc: '2.0', id: 1, method: 'message/send', params });
      const tasks = new Map<string, string>();
      return {
        journal,
        start: async (authz: string, runId: string, approvals?: Record<string, boolean>) => {
          const r = await rpc(authz, { message: { kind: 'message', role: 'user', messageId: runId, parts: [{ kind: 'text', text: 'refund my 12500 order' }, ...(approvals ? [{ kind: 'data', data: { approvals } }] : [])] } });
          const taskId = JSON.parse(r.text)?.result?.id;
          if (taskId) tasks.set(runId, taskId);
          return { ...r, taskId };
        },
        answer: (authz: string, runId: string, approvals: Record<string, boolean>) =>
          rpc(authz, { message: { kind: 'message', role: 'user', messageId: `${runId}-reply-${Math.random()}`, taskId: tasks.get(runId), parts: [{ kind: 'data', data: { approvals } }] } }),
      };
    },
  },
];

const WHO = [['the customer (end-user token)', tok('u-ayse')], ['staff (admin token)', STAFF]] as const;

describe('a door does not turn an answer for an unasked call into a decision', () => {
  for (const door of DOORS) {
    for (const [who, authz] of WHO) {
      it(`PRE — ${door.name}: a fresh run carrying approvals { call_0: true } stops at the question (${who})`, async () => {
        const refunds: number[] = [];
        const d = door.make(refunds);
        const r = await d.start(authz, `pre-${who.length}`, { call_0: true });
        expect(r.status, r.text.slice(0, 200)).toBeLessThan(300);
        expect(refunds, `a pre-approval on a fresh run skipped the question (${r.status}: ${r.text.slice(0, 160)})`).toEqual([]);
        expect(r.text, 'the question was not surfaced to the client').toContain('call_0');
        expect(await answersFor(d.journal, 'call_0'), 'an answer to an unasked question was written to the journal').toEqual([]);
      });
    }

    // The customer answers here, so the question is a CONFIRM (d25 step 2; it was a guard's require-approval).
    it(`LATER — ${door.name}: the answer to call_0 carrying call_1: true as well — call_1 stops at its own question, and stays stopped`, async () => {
      const refunds: number[] = [];
      const d = door.make(refunds, true, 'confirm');
      const ayse = tok('u-ayse');
      const first = await d.start(ayse, 'later');
      expect(first.text, 'precondition: call_0 is asked').toContain('call_0');
      expect(refunds).toEqual([]);
      const second = await d.answer!(ayse, 'later', { [askedIn(first.text)]: true, call_1: true });
      expect(refunds, `call_1 ran on an answer given before its question existed (${second.status}: ${second.text.slice(0, 160)})`).toEqual([12500]);
      expect(second.text, 'call_1\'s question was not surfaced').toContain('call_1');
      expect(await answersFor(d.journal, 'call_1'), 'the unasked answer for call_1 was written').toEqual([]);
      // A follow-up that answers nothing new (an unrelated id) does not release call_1 either.
      await d.answer!(ayse, 'later', { unrelated: true });
      expect(refunds, 'call_1 was released without an answer to it').toEqual([12500]);
    });

    it(`ASKED (regression) — ${door.name}: the asked question's yes runs the refund once; its no runs nothing`, async () => {
      for (const decision of [true, false]) {
        const refunds: number[] = [];
        const d = door.make(refunds, false, 'confirm'); // the customer answers → a CONFIRM question (d25 step 2)
        const ayse = tok('u-ayse');
        const first = await d.start(ayse, `asked-${decision}`);
        expect(first.text, 'precondition: the question is asked').toContain('call_0');
        expect(refunds).toEqual([]);
        const r = await d.answer!(ayse, `asked-${decision}`, { [askedIn(first.text)]: decision });
        expect(r.status, r.text.slice(0, 200)).toBeLessThan(300);
        expect([decision, refunds]).toEqual([decision, decision ? [12500] : []]);
        expect((await answersFor(d.journal, 'call_0')).length, 'the asked question\'s answer is recorded').toBeGreaterThan(0);
      }
    });
  }
});

describe('REST /resume: the door built for answering', () => {
  it('PRE through /resume — approvals for a call of a run that has asked nothing yet... is refused as a decision (no run → 404, nothing written)', async () => {
    // /resume needs a run; a runId that does not exist yet is 404 today. Kept as a guard: the door that
    // exists only to carry answers must not become a way to leave one behind for a run about to start.
    const refunds: number[] = [];
    const storage = new InMemoryStorage();
    const api = createRestApi({ storage, memory: false, agents: agents(refunds) } as never, { auth: auth(), org: {}, protectionsBanner: false } as never) as unknown as Handler;
    const r = await post(api, '/agents/support/resume', tok('u-ayse'), { runId: 'not-yet', approvals: { call_0: true } });
    expect(r.status).toBe(404);
    expect(await answersFor(storage.runs as unknown as Journal, 'call_0')).toEqual([]);
    const started = await post(api, '/agents/support/run', tok('u-ayse'), { runId: 'not-yet', prompt: 'refund my 12500 order' });
    expect(refunds).toEqual([]);
    expect(started.text).toContain('call_0');
  });
});
