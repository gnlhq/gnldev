// A stranger cannot learn that a run exists. Every door answers "this run is someone else's" and "there
// is no such run" with the same bytes — status, body, headers — once the id itself is set aside.
//
// Measured before the fix, on the REST door: a stranger naming another user's run on
// `POST /agents/:name/run` got 403 "access denied: this run belongs to a different resourceId"; naming
// an engine-begun id nobody has made (`task:…`, `agent:…`, …) got 409 `run_owner_mismatch` "there is no
// such run for this caller". Two answers, so the 403 said "this one exists".
//
// Three kinds of id per door:
//   - foreign:      a run that exists and belongs to another user;
//   - engine:       an id of a family only the engine begins, which does not exist;
//   - ordinary:     a caller's own spelling, which does not exist.
// On a door that READS or CONTINUES a run, all three answer alike. On a door that STARTS a run, an absent
// ordinary id is the caller's to start (it must keep working), so there the foreign and the engine ids
// answer alike and the ordinary one starts a run.
import { describe, it, expect } from 'vitest';
import { InMemoryStorage } from '@gnldev/durable';
import { workflow, step, waitForResume } from '@gnldev/workflow';
import { createRestApi } from '../src/index.js';
import { createChatRoute, chatSurface } from '../../chat-adapter/src/index.js';
import { createAguiRoute, aguiSurface } from '../../agui/src/route.js';
import { createA2AServer } from '../../a2a/src/server.js';

const usage = { inputTokens: 1, outputTokens: 1, totalTokens: 2 };
const model: any = {
  specificationVersion: 'v2', provider: 'mock', modelId: 'm', supportedUrls: {},
  doGenerate: async () => ({ content: [{ type: 'text', text: 'ok' }], finishReason: 'stop', usage, warnings: [] }),
  doStream: async () => ({ stream: new ReadableStream({ start(c) {
    for (const p of [{ type: 'stream-start', warnings: [] }, { type: 'text-start', id: '1' }, { type: 'text-delta', id: '1', delta: 'ok' }, { type: 'text-end', id: '1' }, { type: 'finish', finishReason: 'stop', usage }]) c.enqueue(p);
    c.close();
  } }) }),
};
const PRINCIPALS: Record<string, unknown> = {
  alice: { kind: 'subject', id: 'alice', roles: ['admin'] },
  mallory: { kind: 'subject', id: 'mallory', roles: ['admin'] },
};
const whoOf = (req: Request) => PRINCIPALS[req.headers.get('authorization')?.replace('Bearer ', '') ?? ''] as any;
const auth = { authenticate: (req: Request) => whoOf(req) ?? null, authorize: () => ({ allow: true }) };

const ENGINE_IDS = ['task:ghost:tc1', 'cont:ghost:tc1', 'agent:ghost:tc1', 'wf:ghost:tc1', 'net:ghost:0'];
const ORDINARY = 'r-ghost';

type Wire = { status: number; headers: Record<string, string>; body: string };
type Handler = (req: Request) => Promise<Response>;
const fetchOf = (h: any): Handler => (typeof h === 'function' ? h : (req: Request) => h.fetch(req));

/** The response with the id it was asked about set aside — everything else must match byte for byte. */
async function wire(res: Response, id: string): Promise<Wire> {
  const strip = (s: string) => s.split(id).join('<ID>');
  const headers: Record<string, string> = {};
  res.headers.forEach((v, k) => { if (k !== 'date' && k !== 'content-length') headers[k] = strip(v); });
  return { status: res.status, headers, body: strip(await res.text()) };
}

function setup() {
  const storage = new InMemoryStorage();
  const config = {
    storage, memory: false,
    agents: { a: { model } },
    workflows: { w: workflow<unknown>().then(step('draft', async () => 'ALICE-STEP')).then(waitForResume<{ ok: boolean }>('approve')) },
  } as any;
  const surfaces = [chatSurface(), aguiSurface()];
  const rest = fetchOf(createRestApi(config, { auth: auth as never, protectionsBanner: false, surfaces } as never));
  const chat = fetchOf(createChatRoute({ storage, memory: false, agents: { a: { model } } } as any, { identify: whoOf, protectionsBanner: false } as never));
  const agui = fetchOf(createAguiRoute({ storage, memory: false, agents: { a: { model } } } as any, { identify: whoOf, protectionsBanner: false } as never));
  const a2a = fetchOf(createA2AServer({ journal: storage.runs, agents: { a: { model } } } as never, { identify: whoOf, protectionsBanner: false } as never));
  const req = (who: string, path: string, body?: unknown, method = body === undefined ? 'GET' : 'POST') =>
    new Request(`http://x${path}`, {
      method,
      headers: { authorization: `Bearer ${who}`, 'content-type': 'application/json' },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
  return { storage, rest, chat, agui, a2a, req };
}

/** Alice's runs: an agent run, a suspended workflow run and an A2A task. Returns their ids. */
async function aliceRuns(s: ReturnType<typeof setup>): Promise<{ agent: string; workflow: string; task: string }> {
  expect((await s.rest(s.req('alice', '/agents/a/run', { runId: 'r-alice', prompt: 'ALICE-SECRET' }))).status).toBe(200);
  expect((await s.rest(s.req('alice', '/workflows/w/run', { runId: 'wf-alice', input: {} }))).status).toBe(200);
  const sent = await (await s.a2a(s.req('alice', '/agents/a', { jsonrpc: '2.0', id: 1, method: 'message/send', params: { message: { kind: 'message', role: 'user', messageId: 'm-alice', parts: [{ kind: 'text', text: 'hi' }] } } }))).json() as any;
  return { agent: 'r-alice', workflow: 'wf-alice', task: sent.result.id };
}

type Door = {
  /** Starts a run under an absent ordinary id (so that id is not part of the identity). */
  starts: boolean;
  /** Which of alice's runs is the foreign one for this door. */
  foreign: 'agent' | 'workflow' | 'task';
  call: (s: ReturnType<typeof setup>, id: string) => Promise<Response>;
};
const rpc = (method: string, params: unknown) => ({ jsonrpc: '2.0', id: 7, method, params });
const DOORS: Record<string, Door> = {
  'REST POST /agents/:name/run': { starts: true, foreign: 'agent', call: (s, id) => s.rest(s.req('mallory', '/agents/a/run', { runId: id, prompt: 'x' })) },
  'REST POST /agents/:name/stream': { starts: true, foreign: 'agent', call: (s, id) => s.rest(s.req('mallory', '/agents/a/stream', { runId: id, prompt: 'x' })) },
  'REST chat surface': { starts: true, foreign: 'agent', call: (s, id) => s.rest(s.req('mallory', '/agents/a/chat', { runId: id, messages: [{ id: 'u1', role: 'user', parts: [{ type: 'text', text: 'x' }] }] })) },
  'REST AG-UI surface': { starts: true, foreign: 'agent', call: (s, id) => s.rest(s.req('mallory', '/agents/a/agui', { runId: id, prompt: 'x' })) },
  'REST POST /agents/:name/resume': { starts: false, foreign: 'agent', call: (s, id) => s.rest(s.req('mallory', '/agents/a/resume', { runId: id, approvals: { c1: true } })) },
  'REST GET /runs/:id': { starts: false, foreign: 'agent', call: (s, id) => s.rest(s.req('mallory', `/runs/${encodeURIComponent(id)}`)) },
  'REST GET /runs/:id/events': { starts: false, foreign: 'agent', call: (s, id) => s.rest(s.req('mallory', `/runs/${encodeURIComponent(id)}/events`)) },
  'REST POST /runs/:id/cancel': { starts: false, foreign: 'agent', call: (s, id) => s.rest(s.req('mallory', `/runs/${encodeURIComponent(id)}/cancel`, {})) },
  'REST POST /workflows/:name/run': { starts: true, foreign: 'workflow', call: (s, id) => s.rest(s.req('mallory', '/workflows/w/run', { runId: id, input: {} })) },
  'REST POST /workflows/:name/run (resume)': { starts: false, foreign: 'workflow', call: (s, id) => s.rest(s.req('mallory', '/workflows/w/run', { runId: id, resume: { approve: { ok: true } } })) },
  'REST POST /workflows/runs/:id/cancel': { starts: false, foreign: 'workflow', call: (s, id) => s.rest(s.req('mallory', `/workflows/runs/${encodeURIComponent(id)}/cancel`, {})) },
  'chat route (standalone)': { starts: true, foreign: 'agent', call: (s, id) => s.chat(s.req('mallory', '/agents/a/chat', { runId: id, messages: [{ id: 'u1', role: 'user', parts: [{ type: 'text', text: 'x' }] }] })) },
  'AG-UI route (standalone)': { starts: true, foreign: 'agent', call: (s, id) => s.agui(s.req('mallory', '/agents/a/run', { runId: id, prompt: 'x' })) },
  'A2A tasks/get': { starts: false, foreign: 'task', call: (s, id) => s.a2a(s.req('mallory', '/agents/a', rpc('tasks/get', { id }))) },
  'A2A tasks/cancel': { starts: false, foreign: 'task', call: (s, id) => s.a2a(s.req('mallory', '/agents/a', rpc('tasks/cancel', { id }))) },
  'A2A message/send (taskId)': { starts: false, foreign: 'task', call: (s, id) => s.a2a(s.req('mallory', '/agents/a', rpc('message/send', { message: { kind: 'message', role: 'user', messageId: 'm-x', taskId: id, parts: [{ kind: 'text', text: 'x' }] } }))) },
};

describe('no door tells a stranger that a run exists', () => {
  for (const [name, door] of Object.entries(DOORS)) {
    it(`${name}: someone else's run and an absent one answer the same`, async () => {
      const s = setup();
      const foreignId = (await aliceRuns(s))[door.foreign];
      const foreign = await wire(await door.call(s, foreignId), foreignId);
      expect(foreign.status, `${name} must refuse a foreign run`).toBeGreaterThanOrEqual(200);
      expect(foreign.body).not.toContain('ALICE');
      for (const id of ENGINE_IDS) {
        expect(await wire(await door.call(s, id), id), `${name}: '${id}' vs a foreign run`).toEqual(foreign);
        expect(await (s.storage.runs as any).listKeys(id)).toEqual([]);
      }
      const ordinary = await door.call(s, ORDINARY);
      if (door.starts) {
        // Legitimate creation keeps working: an absent id of the caller's own spelling is theirs to start.
        expect(ordinary.status, `${name} starts a run under a fresh id of the caller's own`).toBe(200);
        await ordinary.text();
      } else {
        expect(await wire(ordinary, ORDINARY), `${name}: an absent ordinary id vs a foreign run`).toEqual(foreign);
      }
    });
  }
});

describe('siblings: the same answer holds where the old one leaked through another gate', () => {
  it('an over-budget organization: the budget gate does not answer an absent engine id before the run gate does', async () => {
    // Before: the absent `task:` id was "missing" to the run gate, so the budget gate answered it 402,
    // while the foreign run got the run gate's answer — "over budget" meant "this id is free".
    const storage = new InMemoryStorage();
    const rest = fetchOf(createRestApi({ storage, memory: false, agents: { a: { model } } } as any, { auth: auth as never, protectionsBanner: false, budgets: { default: { tokenLimit: 1 } } } as never));
    const req = (who: string, body: unknown) => new Request('http://x/agents/a/run', { method: 'POST', headers: { authorization: `Bearer ${who}`, 'content-type': 'application/json' }, body: JSON.stringify(body) });
    expect((await rest(req('alice', { runId: 'r-alice', prompt: 'x' }))).status).toBe(200);
    expect((await rest(req('mallory', { runId: 'r-new', prompt: 'x' }))).status).toBe(402); // the budget is spent
    const foreign = await wire(await rest(req('mallory', { runId: 'r-alice', prompt: 'x' })), 'r-alice');
    expect(foreign.status).toBe(404);
    for (const id of ENGINE_IDS) expect(await wire(await rest(req('mallory', { runId: id, prompt: 'x' })), id)).toEqual(foreign);
  });

  it('the owner still continues her own run, and staff still learn that a run they can list is not the named user\'s', async () => {
    const s = setup();
    await aliceRuns(s);
    expect((await s.rest(s.req('alice', '/agents/a/run', { runId: 'r-alice', prompt: 'ALICE-SECRET' }))).status).toBe(200);
    expect((await s.rest(s.req('alice', '/runs/r-alice'))).status).toBe(200);
    const staff = fetchOf(createRestApi({ storage: s.storage, memory: false, agents: { a: { model } } } as any, {
      auth: { authenticate: () => ({ kind: 'operator', id: 'ops', roles: ['admin'] }), authorize: () => ({ allow: true }) } as never, protectionsBanner: false,
    } as never));
    const asStaff = (body: unknown) => staff(new Request('http://x/agents/a/run', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }));
    // Staff naming mallory on alice's run: the 403 it always was (staff list every run; nothing to hide).
    expect((await asStaff({ runId: 'r-alice', resourceId: 'mallory', prompt: 'x' })).status).toBe(403);
    // An engine-begun id nobody made is no run at all, for staff too.
    const ghost = await asStaff({ runId: 'task:ghost:tc1', resourceId: 'mallory', prompt: 'x' });
    expect(ghost.status).toBe(404);
    expect(await ghost.json()).toEqual({ error: 'run not found', code: 'run_not_found' });
  });

  it('the engine path renders the same bytes as the gate: every "not your run" refusal is run_not_found', async () => {
    const { callerConflictAnswer, runNotFound, RunOwnerMismatchError, RunActorMismatchError, RunInputMismatchError } = await import('@gnldev/durable') as any;
    for (const e of [
      new RunOwnerMismatchError('belongs to a different subject', { runId: 'r1', owner: 'alice', requested: 'mallory' }),
      new RunOwnerMismatchError('composed by the engine; no such run for this caller', { runId: 'r1', owner: '', requested: '' }),
      new RunActorMismatchError('belongs to a different actor', { runId: 'r1', ownerActor: 'alice', requestedActor: 'mallory' }),
    ]) {
      const a = callerConflictAnswer(e, 'invoice-7');
      expect({ status: a.status, body: a.body }).toEqual(runNotFound());
      expect(a.ownership).toBe(true);
    }
    // The rest of the family is the caller's mistake about its own work: its 409 and its detail stay.
    const own = callerConflictAnswer(new RunInputMismatchError('different input', { runId: 'r1', expectedHash: 'a', actualHash: 'b' }), 'invoice-7');
    expect(own.status).toBe(409);
    expect(own.body).toMatchObject({ code: 'run_input_mismatch', detail: { runId: 'r1', workKey: 'invoice-7' } });
  });
});
