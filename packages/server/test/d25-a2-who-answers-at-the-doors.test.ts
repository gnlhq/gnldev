// WHO ANSWERS — at every door (d25 approval policy, step 2; KARAR-1 "KULLANICI KARARI — ADIM 2 / POLİTİKA").
//
// CONFIRM (consent): the requester answers it; an authorised person may answer it too.
// APPROVE (permission): only an authorised person says yes. The requester's yes is refused with HTTP 403
//   and a string `code` — the SAME code the engine's typed error carries, on every door — it is not
//   journaled and nothing happens. Anybody's NO goes through (nothing happens, recorded as denied).
// Authorised by default: staff (admin/operator token) and the application server (client token).
//   Not authorised: end users (endUsers tokens). An open install (allowOpenAccess) works as today.
// `approvers` (createGnl config): the ready-made `fourEyes()` — the approver must be an authorised person
//   OTHER than the one who started the work — or your own `(ctx) => boolean`, called and applied.
//
// Doors: REST /run, /stream, /resume; chatSurface; aguiSurface; the standalone AG-UI route; A2A.
// New API (guard 'approve'/'confirm', tool `approve`, config `approvers`) goes through `as never`.
import { describe, it, expect, beforeAll, vi } from 'vitest';
import { z } from 'zod';
import * as durable from '@gnldev/durable';
import * as auth from '@gnldev/auth';
import { InMemoryStorage, InMemoryJournal, createGnl, user, mintCallId, type Journal, providerIdOf } from '@gnldev/durable';
import { roleAuth, signSubjectToken } from '@gnldev/auth';
import { createRestApi } from '../src/index.js';
import { chatSurface } from '../../chat-adapter/src/index.js';
import { createAguiRoute, aguiSurface } from '../../agui/src/index.js';
import { createA2AServer } from '../../a2a/src/server.js';

// Call ids are GNL ids (`c1.gnl-<run>-<step>-<n>`, the provider's id is the prefix): an approval row is found by the provider's id.
const isApprovalOf = (key: string, providerId: string): boolean => key.includes(':approval:') && providerIdOf(key.slice(key.lastIndexOf(':approval:') + ':approval:'.length)) === providerId;

beforeAll(() => { vi.spyOn(console, 'warn').mockImplementation(() => {}); });

const SECRET = 'app-signing-secret-at-least-32-bytes!!';
const VELI = 'Bearer STAFF-VELI';
const ZEYNEP = 'Bearer STAFF-ZEYNEP';
const APP = 'Bearer APP-SERVER';
const tok = (sub: string) => `Bearer ${signSubjectToken({ sub }, SECRET)}`;
const AYSE = tok('u-ayse');
const usage = { inputTokens: 1, outputTokens: 1, totalTokens: 2 };
const toolResults = (prompt: any[] | undefined) => (prompt ?? []).filter((m: any) => m.role === 'tool').length;

/** A model that calls `refund` (12500) once per id in `ids`, one per step, then answers. */
function model(ids: string[] = ['c1']): any {
  const callOf = (prompt: any[]) => { const id = ids[toolResults(prompt)]; return id ? { type: 'tool-call', toolCallId: id, toolName: 'refund', input: JSON.stringify({ amount: 12500 }) } : undefined; };
  return {
    specificationVersion: 'v2', provider: 'mock', modelId: 'm', supportedUrls: {},
    doGenerate: async ({ prompt }: any) => { const call = callOf(prompt); return (!call
      ? { content: [{ type: 'text', text: 'Done.' }], finishReason: 'stop', usage, warnings: [] }
      : { content: [call], finishReason: 'tool-calls', usage, warnings: [] }); },
    doStream: async ({ prompt }: any) => {
      const call = callOf(prompt);
      const parts = !call
        ? [{ type: 'stream-start', warnings: [] }, { type: 'text-start', id: '1' }, { type: 'text-delta', id: '1', delta: 'Done.' }, { type: 'text-end', id: '1' }, { type: 'finish', finishReason: 'stop', usage }]
        : [{ type: 'stream-start', warnings: [] }, call, { type: 'finish', finishReason: 'tool-calls', usage }];
      return { stream: new ReadableStream({ start(c) { for (const p of parts) c.enqueue(p); c.close(); } }) };
    },
  };
}

type RuleName = "guard 'approve'" | "guard 'require-approval'" | 'tool approve' | "guard 'confirm'" | 'tool confirm';
const APPROVE: RuleName[] = ["guard 'approve'", "guard 'require-approval'", 'tool approve'];
const CONFIRM: RuleName[] = ["guard 'confirm'", 'tool confirm'];

function agents(refunds: number[], rule: RuleName) {
  const toolRule = rule === 'tool approve' ? { approve: true } : rule === 'tool confirm' ? { confirm: true } : {};
  const guardAction = rule === "guard 'approve'" ? 'approve' : rule === "guard 'require-approval'" ? 'require-approval' : rule === "guard 'confirm'" ? 'confirm' : undefined;
  return {
    support: {
      model: model(),
      tools: {
        refund: {
          description: 'refund an order', inputSchema: z.object({ amount: z.number() }), ...toolRule,
          execute: async ({ amount }: { amount: number }) => { refunds.push(amount); return { ok: true }; },
        },
      },
      ...(guardAction ? { guard: () => ({ action: guardAction, reason: 'a representative decides' }) } : {}),
    },
  };
}

/** Two named operators (Veli, Zeynep), the application server, and end users. roleAuth takes one admin, so a second roleAuth names Zeynep. */
function authProvider() {
  const a = roleAuth({ admin: { token: 'STAFF-VELI', user: 'veli', orgId: 'acme' }, client: { token: 'APP-SERVER', orgId: 'acme' }, endUsers: { secret: SECRET, orgId: 'acme' } })!;
  const z2 = roleAuth({ admin: { token: 'STAFF-ZEYNEP', user: 'zeynep', orgId: 'acme' } })!;
  return { ...a, authenticate: async (req: Request) => (await a.authenticate(req)) ?? (await z2.authenticate(req)) } as typeof a;
}

type Handler = (r: Request) => Promise<Response>;
const post = async (h: Handler, path: string, authz: string | undefined, body: unknown) => {
  const headers: Record<string, string> = { 'content-type': 'application/json' };
  if (authz) headers.authorization = authz;
  const res = await h(new Request(`http://localhost${path}`, { method: 'POST', headers, body: JSON.stringify(body) }));
  return { status: res.status, text: await res.text() };
};
async function rowsFor(journal: Journal, toolCallId: string): Promise<any[]> {
  const keys = (await journal.listKeys('')).filter((k) => isApprovalOf(k, toolCallId));
  return Promise.all(keys.map((k) => journal.get(k)));
}
/** The id the system gave the question, read from the door's own answer (every door names it as `toolCallId`). */
const askedIn = (text: string): string => /"toolCallId":\s*"([^"]+)"/.exec(text)![1]!;
const codeOf = (text: string): string | undefined => { try { const j = JSON.parse(text); return j?.code ?? j?.error?.data?.code; } catch { return undefined; } };

/** The engine's own refusal (a requester's yes on a guard 'approve'): every door must answer with this code. */
let ENGINE_CODE = '<engine refusal missing>';
beforeAll(async () => {
  const gnl = createGnl({ storage: new InMemoryStorage(), agents: agents([], "guard 'approve'") } as never);
  await gnl.run('support', { runId: 'ref', prompt: 'x', caller: user('u-ayse') } as never);
  try { await gnl.run('support', { runId: 'ref', prompt: 'x', caller: user('u-ayse'), approvals: { [mintCallId('c1', 'ref', 0, 0)]: true } } as never); } catch (e: any) { if (typeof e?.code === 'string') ENGINE_CODE = e.code; }
});

function restApi(rule: RuleName, extra: { config?: Record<string, unknown>; surfaces?: unknown[]; open?: boolean } = {}) {
  const refunds: number[] = [];
  const storage = new InMemoryStorage();
  const api = createRestApi({ storage, memory: false, agents: agents(refunds, rule), ...(extra.config ?? {}) } as never, {
    ...(extra.open ? { allowOpenAccess: true } : { auth: authProvider() }), org: {}, protectionsBanner: false, surfaces: extra.surfaces ?? [],
  } as never) as unknown as Handler;
  const asked = new Map<string, string>();
  const ask = async (authz: string | undefined, runId: string) => {
    const r = await post(api, '/agents/support/run', authz, { runId, prompt: 'refund my 12500 order' });
    expect(r.status, r.text).toBe(200);
    const interrupts = JSON.parse(r.text).interrupts ?? [];
    expect(interrupts.map((i: any) => providerIdOf(i.toolCallId)), `precondition (${rule}): the question is asked`).toEqual(['c1']);
    asked.set(runId, interrupts[0].toolCallId); // the id the system gave the question: what a client answers
    expect(refunds).toEqual([]);
  };
  /** The answer to the question asked for `runId`, keyed by the id the system gave it. */
  const ans = (runId: string, decision: boolean): Record<string, boolean> => ({ [asked.get(runId)!]: decision });
  return { api, refunds, journal: storage.runs as unknown as Journal, ask, ans };
}

/** The three REST ways to answer. `/run` and `/stream` carry `approvals` in a body that names the run. */
const ANSWER_PATHS = {
  '/resume': (api: Handler, authz: string, runId: string, approvals: Record<string, boolean>) => post(api, '/agents/support/resume', authz, { runId, approvals }),
  '/run': (api: Handler, authz: string, runId: string, approvals: Record<string, boolean>) => post(api, '/agents/support/run', authz, { runId, prompt: 'refund my 12500 order', approvals }),
  '/stream': (api: Handler, authz: string, runId: string, approvals: Record<string, boolean>) => post(api, '/agents/support/stream', authz, { runId, prompt: 'refund my 12500 order', approvals }),
} as const;

function expectRefused(r: { status: number; text: string }, what: string) {
  expect(r.status, `${what}: the end user's yes on an approve question was not refused (${r.text.slice(0, 200)})`).toBe(403);
  expect(codeOf(r.text), `${what}: the 403 does not carry the engine's code`).toBe(ENGINE_CODE);
}

describe('REST — APPROVE: the end user\'s yes is refused (403, the engine\'s code), staff and the application server approve', () => {
  it('the engine refusal exists (reference for every door)', () => {
    expect(ENGINE_CODE, 'the engine does not refuse a requester\'s yes on an approve question with a coded error').not.toBe('<engine refusal missing>');
  });

  for (const rule of APPROVE) {
    for (const [path, answer] of Object.entries(ANSWER_PATHS)) {
      it(`${rule}, ${path}: the end user's yes → 403 + code; no refund; nothing journaled; the question stays open for staff`, async () => {
        const s = restApi(rule);
        await s.ask(AYSE, `r-${path}`);
        expectRefused(await answer(s.api, AYSE, `r-${path}`, s.ans(`r-${path}`, true)), `${rule} ${path}`);
        expect(s.refunds).toEqual([]);
        expect(await rowsFor(s.journal, 'c1'), 'a refused answer was journaled').toEqual([]);
        const staff = await ANSWER_PATHS['/resume'](s.api, VELI, `r-${path}`, s.ans(`r-${path}`, true));
        expect(staff.status, staff.text).toBe(200);
        expect(s.refunds).toEqual([12500]);
      });
    }

    it(`${rule}: the end user's no goes through (200), no refund, recorded as denied`, async () => {
      const s = restApi(rule);
      await s.ask(AYSE, 'r-no');
      const r = await ANSWER_PATHS['/resume'](s.api, AYSE, 'r-no', s.ans('r-no', false));
      expect(r.status, r.text).toBe(200);
      expect(s.refunds).toEqual([]);
      expect((await rowsFor(s.journal, 'c1')).map((x) => x?.decision)).toEqual([false]);
    });

    it(`${rule}: staff (operator token) approve on /resume → refund once`, async () => {
      const s = restApi(rule);
      await s.ask(AYSE, 'r-staff');
      const r = await ANSWER_PATHS['/resume'](s.api, VELI, 'r-staff', s.ans('r-staff', true));
      expect(r.status, r.text).toBe(200);
      expect(s.refunds).toEqual([12500]);
    });

    it(`${rule}: the application server (client token) approves on /resume → refund once`, async () => {
      const s = restApi(rule);
      await s.ask(AYSE, 'r-app');
      const r = await post(s.api, '/agents/support/resume', APP, { runId: 'r-app', resourceId: 'u-ayse', approvals: s.ans('r-app', true) });
      expect(r.status, r.text).toBe(200);
      expect(s.refunds).toEqual([12500]);
    });
  }

  it('an open install (allowOpenAccess, no identity): the approve question is answered as today → refund once', async () => {
    const s = restApi("guard 'approve'", { open: true });
    await s.ask(undefined, 'r-open');
    const r = await ANSWER_PATHS['/resume'](s.api, undefined as never, 'r-open', s.ans('r-open', true));
    expect(r.status, r.text).toBe(200);
    expect(s.refunds).toEqual([12500]);
  });

  it('regression: an open install, require-approval, answered without identity → refund once', async () => {
    const s = restApi("guard 'require-approval'", { open: true });
    await s.ask(undefined, 'r-open2');
    const r = await ANSWER_PATHS['/resume'](s.api, undefined as never, 'r-open2', s.ans('r-open2', true));
    expect(r.status, r.text).toBe(200);
    expect(s.refunds).toEqual([12500]);
  });
});

describe('REST — CONFIRM: the requester answers, staff may answer too', () => {
  for (const rule of CONFIRM) {
    for (const [path, answer] of Object.entries(ANSWER_PATHS)) {
      it(`${rule}, ${path}: the end user's own yes → refund once`, async () => {
        const s = restApi(rule);
        await s.ask(AYSE, `c-${path}`);
        const r = await answer(s.api, AYSE, `c-${path}`, s.ans(`c-${path}`, true));
        expect(r.status, r.text.slice(0, 200)).toBe(200);
        expect(s.refunds).toEqual([12500]);
      });
    }
    it(`${rule}: staff's yes on /resume → refund once`, async () => {
      const s = restApi(rule);
      await s.ask(AYSE, 'c-staff');
      const r = await ANSWER_PATHS['/resume'](s.api, VELI, 'c-staff', s.ans('c-staff', true));
      expect(r.status, r.text).toBe(200);
      expect(s.refunds).toEqual([12500]);
    });
  }
});

describe('REST — no rule, no question (regression)', () => {
  it('an end user\'s run with no guard and no confirm/approve: the refund runs without a question', async () => {
    const refunds: number[] = [];
    const api = createRestApi({ storage: new InMemoryStorage(), memory: false, agents: { support: { model: model(), tools: { refund: { description: 'refund', inputSchema: z.object({ amount: z.number() }), execute: async ({ amount }: { amount: number }) => { refunds.push(amount); return { ok: true }; } } } } } } as never, {
      auth: authProvider(), org: {}, protectionsBanner: false,
    } as never) as unknown as Handler;
    const r = await post(api, '/agents/support/run', AYSE, { runId: 'nr', prompt: 'refund my 12500 order' });
    expect(r.status, r.text).toBe(200);
    expect(JSON.parse(r.text).interrupts ?? []).toEqual([]);
    expect(refunds).toEqual([12500]);
  });
});

/** Other doors: the end user's yes on an approve question (guard 'require-approval') is refused with the engine's code; her no goes through. */
interface Door { name: string; make(refunds: number[]): { journal: Journal; start(authz: string, runId: string): Promise<{ status: number; text: string }>; answer(authz: string, runId: string, approvals: Record<string, boolean>): Promise<{ status: number; text: string }> } }
const surfaceDoor = (path: '/chat' | '/agui', surface: unknown): Door['make'] => (refunds) => {
  const storage = new InMemoryStorage();
  const api = createRestApi({ storage, memory: false, agents: { support: agents(refunds, "guard 'require-approval'").support } } as never, {
    auth: authProvider(), org: {}, protectionsBanner: false, surfaces: [surface],
  } as never) as unknown as Handler;
  const body = (runId: string, approvals?: Record<string, boolean>) => (path === '/chat'
    ? { id: `conv-${runId}`, runId, messages: [{ id: 'm1', role: 'user', parts: [{ type: 'text', text: 'refund my 12500 order' }] }], ...(approvals ? { approvals } : {}) }
    : { runId, prompt: 'refund my 12500 order', ...(approvals ? { approvals } : {}) });
  return {
    journal: storage.runs as unknown as Journal,
    start: (authz, runId) => post(api, `/agents/support${path}`, authz, body(runId)),
    answer: (authz, runId, approvals) => post(api, `/agents/support${path}`, authz, body(runId, approvals)),
  };
};
const identifyOpts = () => { const a = authProvider(); return { identify: (req: Request) => a.authenticate(req) ?? undefined, authorize: (p: any, req: any, ctx: any) => a.authorize(p, req, ctx), protectionsBanner: false }; };
const DOORS: Door[] = [
  { name: 'chatSurface', make: surfaceDoor('/chat', chatSurface()) },
  { name: 'aguiSurface', make: surfaceDoor('/agui', aguiSurface()) },
  {
    name: 'standalone AG-UI route (createAguiRoute)',
    make: (refunds) => {
      const journal = new InMemoryJournal();
      const route = createAguiRoute({ journal, memory: false, agents: agents(refunds, "guard 'require-approval'") } as never, identifyOpts() as never) as unknown as Handler;
      const go = (authz: string, runId: string, approvals?: Record<string, boolean>) => post(route, '/agents/support/run', authz, { runId, prompt: 'refund my 12500 order', ...(approvals ? { approvals } : {}) });
      return { journal: journal as unknown as Journal, start: (a, r) => go(a, r), answer: go };
    },
  },
  {
    name: 'A2A (message/send, data part { approvals })',
    make: (refunds) => {
      const journal = new InMemoryJournal();
      const serve = createA2AServer({ journal, memory: false, agents: agents(refunds, "guard 'require-approval'") } as never, identifyOpts() as never) as unknown as Handler;
      const tasks = new Map<string, string>();
      const rpc = (authz: string, params: unknown) => post(serve, '/agents/support', authz, { jsonrpc: '2.0', id: 1, method: 'message/send', params });
      return {
        journal: journal as unknown as Journal,
        start: async (authz, runId) => {
          const r = await rpc(authz, { message: { kind: 'message', role: 'user', messageId: runId, parts: [{ kind: 'text', text: 'refund my 12500 order' }] } });
          const id = JSON.parse(r.text)?.result?.id;
          if (id) tasks.set(runId, id);
          return r;
        },
        answer: (authz, runId, approvals) => rpc(authz, { message: { kind: 'message', role: 'user', messageId: `${runId}-${Math.random()}`, taskId: tasks.get(runId), parts: [{ kind: 'data', data: { approvals } }] } }),
      };
    },
  },
];

describe('the other doors — the same rule, the same code', () => {
  for (const door of DOORS) {
    it(`${door.name}: the end user's yes on an approve question is refused with the engine's code; no refund; nothing journaled`, async () => {
      const refunds: number[] = [];
      const d = door.make(refunds);
      const first = await d.start(AYSE, 'd-yes');
      expect(first.text, 'precondition: the question is asked').toContain('c1');
      const r = await d.answer(AYSE, 'd-yes', { [askedIn(first.text)]: true });
      expect(refunds, `${door.name}: the end user approved her own refund (${r.status}: ${r.text.slice(0, 160)})`).toEqual([]);
      if (door.name.startsWith('A2A')) {
        // JSON-RPC: the refusal is an error object; its data carries the same code (and the 403 status, in data or on the wire).
        const body = JSON.parse(r.text);
        expect(body.error, `A2A: no JSON-RPC error (${r.text.slice(0, 160)})`).toBeDefined();
        expect(body.error?.data?.code).toBe(ENGINE_CODE);
        expect(r.status === 403 || body.error?.data?.status === 403, 'A2A: the refusal does not say 403').toBe(true);
      } else {
        expect(r.status, r.text.slice(0, 200)).toBe(403);
        expect(r.text, `${door.name}: the refusal does not carry the engine's code`).toContain(ENGINE_CODE);
      }
      expect(await rowsFor(d.journal, 'c1')).toEqual([]);
    });

    it(`${door.name}: the end user's no on an approve question goes through (no refund)`, async () => {
      const refunds: number[] = [];
      const d = door.make(refunds);
      const first = await d.start(AYSE, 'd-no');
      const r = await d.answer(AYSE, 'd-no', { [askedIn(first.text)]: false });
      expect(r.status, r.text.slice(0, 200)).toBeLessThan(300);
      expect(r.text).not.toContain('"error":{');
      expect(refunds).toEqual([]);
      expect((await rowsFor(d.journal, 'c1')).map((x) => x?.decision)).toEqual([false]);
    });
  }
});

describe('approvers (createGnl) — fourEyes() and your own rule', () => {
  const fourEyes = ((durable as any).fourEyes ?? (auth as any).fourEyes) as (() => unknown) | undefined;

  it('fourEyes is exported (by @gnldev/durable or @gnldev/auth)', () => {
    expect(typeof fourEyes, 'fourEyes() is not exported').toBe('function');
  });

  it('fourEyes: staff who started the work cannot approve it (403, the engine\'s code); another operator can', async () => {
    const s = restApi("guard 'require-approval'", { config: { approvers: fourEyes?.() } });
    await s.ask(VELI, 'fe-1');
    expectRefused(await ANSWER_PATHS['/resume'](s.api, VELI, 'fe-1', s.ans('fe-1', true)), 'fourEyes self-approval');
    expect(s.refunds).toEqual([]);
    const r = await ANSWER_PATHS['/resume'](s.api, ZEYNEP, 'fe-1', s.ans('fe-1', true));
    expect(r.status, r.text).toBe(200);
    expect(s.refunds).toEqual([12500]);
  });

  it('fourEyes: an end user\'s run is approved by an operator (different from the requester)', async () => {
    const s = restApi("guard 'require-approval'", { config: { approvers: fourEyes?.() } });
    await s.ask(AYSE, 'fe-2');
    const r = await ANSWER_PATHS['/resume'](s.api, VELI, 'fe-2', s.ans('fe-2', true));
    expect(r.status, r.text).toBe(200);
    expect(s.refunds).toEqual([12500]);
  });

  it('fourEyes: the end user is still refused on her own run', async () => {
    const s = restApi("guard 'require-approval'", { config: { approvers: fourEyes?.() } });
    await s.ask(AYSE, 'fe-3');
    expectRefused(await ANSWER_PATHS['/resume'](s.api, AYSE, 'fe-3', s.ans('fe-3', true)), 'fourEyes end user');
    expect(s.refunds).toEqual([]);
  });

  it('fourEyes: the starter\'s own NO still goes through', async () => {
    const s = restApi("guard 'require-approval'", { config: { approvers: fourEyes?.() } });
    await s.ask(VELI, 'fe-4');
    const r = await ANSWER_PATHS['/resume'](s.api, VELI, 'fe-4', s.ans('fe-4', false));
    expect(r.status, r.text).toBe(200);
    expect(s.refunds).toEqual([]);
  });

  it('your own approvers(ctx): it is called with who answers, the tool and its arguments, and its answer is applied', async () => {
    const seen: unknown[] = [];
    const onlyZeynep = (ctx: unknown) => { seen.push(ctx); return JSON.stringify(ctx).includes('zeynep'); };
    const s = restApi("guard 'require-approval'", { config: { approvers: onlyZeynep } });
    await s.ask(AYSE, 'own-1');
    expectRefused(await ANSWER_PATHS['/resume'](s.api, VELI, 'own-1', s.ans('own-1', true)), 'approvers says no to Veli');
    expect(s.refunds).toEqual([]);
    expect(seen.length, 'approvers was never called').toBeGreaterThan(0);
    const flat = JSON.stringify(seen[0]);
    expect(flat, 'ctx does not name who answers').toContain('veli');
    expect(flat, 'ctx does not name the tool').toContain('refund');
    expect(flat, 'ctx does not carry the arguments').toContain('12500');
    const r = await ANSWER_PATHS['/resume'](s.api, ZEYNEP, 'own-1', s.ans('own-1', true));
    expect(r.status, r.text).toBe(200);
    expect(s.refunds).toEqual([12500]);
  });

  it('your own approvers(ctx) does not touch CONFIRM: the requester still confirms her own refund', async () => {
    const s = restApi('tool confirm', { config: { approvers: () => false } });
    await s.ask(AYSE, 'own-2');
    const r = await ANSWER_PATHS['/resume'](s.api, AYSE, 'own-2', s.ans('own-2', true));
    expect(r.status, r.text).toBe(200);
    expect(s.refunds).toEqual([12500]);
  });
});

describe('an in-doubt question ("may already have happened") is approve — over REST', () => {
  // A side-effecting refund (idempotency 'args') whose first attempt (c1) failed after leaving. The model
  // asks again with the same args (c2): the engine refuses the retry (SideEffectRetryBlockedError) until
  // somebody answers the id it names. That answer is an approve.
  function inDoubtApi() {
    let n = 0;
    const storage = new InMemoryStorage();
    const api = createRestApi({ storage, memory: false, agents: { support: { model: model(['c1', 'c2']), tools: { refund: {
      description: 'refund', inputSchema: z.object({ amount: z.number() }), sideEffect: true, idempotency: 'args', maxRetries: 5,
      execute: async () => { n++; if (n === 1) throw new Error('provider 502 after the request left'); return { ok: true }; },
    } } } } } as never, { auth: authProvider(), org: {}, protectionsBanner: false } as never) as unknown as Handler;
    return { api, effects: () => n, journal: storage.runs as unknown as Journal };
  }

  it('the end user\'s yes to retry is refused (403, the engine\'s code); staff\'s yes retries once', async () => {
    const s = inDoubtApi();
    await post(s.api, '/agents/support/run', AYSE, { runId: 'd1', prompt: 'refund' });
    expect(s.effects(), 'precondition: one attempt').toBe(1);
    // Measured on release/0.17.1 (a separate finding, not this decision): the refusal names approvals['c2'],
    // but answering c2 alone is refused again naming 'c1' (the replay meets c1's failed record first);
    // answering both releases it. The test answers both ids — what works today for staff.
    const refused = await post(s.api, '/agents/support/run', AYSE, { runId: 'd1', prompt: 'refund' });
    expect(refused.text, 'precondition: the retry is refused as in doubt').toContain('side_effect_retry_blocked');
    const both = { [mintCallId('c1', 'd1', 0, 0)]: true, [mintCallId('c2', 'd1', 1, 0)]: true };
    expectRefused(await post(s.api, '/agents/support/run', AYSE, { runId: 'd1', prompt: 'refund', approvals: both }), 'in-doubt end user (/run)');
    expectRefused(await post(s.api, '/agents/support/resume', AYSE, { runId: 'd1', approvals: both }), 'in-doubt end user (/resume)');
    expect(s.effects(), 'the end user released a retry that may double the refund').toBe(1);
    expect([...(await rowsFor(s.journal, 'c1')), ...(await rowsFor(s.journal, 'c2'))]).toEqual([]);
    const ok = await post(s.api, '/agents/support/resume', VELI, { runId: 'd1', approvals: both });
    expect(ok.status, ok.text).toBe(200);
    expect(s.effects()).toBe(2);
  });
});
