// The optimizer tab's routes: on only when the host gives `optimizer`; every call handed THIS request's
// org-scoped reader (an organization's admin diagnoses and replays its own runs, never another's); a
// replay calls a model, so it takes 'write', is validated against what the host offers, and is audited.
import { describe, it, expect } from 'vitest';
import { InMemoryJournal } from '@gnldev/durable';
import { PLATFORM_ADMIN_ROLE } from '@gnldev/auth';
import { createStudioApi, type StudioOptimizer } from '../src/server.js';
import { call } from './call.js';

const authProvider = {
  authenticate: (req: Request) => {
    const t = req.headers.get('authorization')?.replace('Bearer ', '');
    if (t === 'acme') return { kind: 'operator', roles: ['admin'], id: 'u-acme', orgId: 'acme' };
    if (t === 'globex') return { kind: 'operator', roles: ['admin'], id: 'u-globex', orgId: 'globex' };
    if (t === 'ops') return { kind: 'operator', roles: ['admin', PLATFORM_ADMIN_ROLE], id: 'u-ops' };
    return null;
  },
  authorize: () => ({ allow: true }),
  capabilities: () => ({ sso: false, rbac: false, audit: false, multiOrganization: false, users: false }),
};
const AS = { acme: { authorization: 'Bearer acme' }, globex: { authorization: 'Bearer globex' } };

async function seeded() {
  const j = new InMemoryJournal();
  for (const [org, run] of [['acme', 'r-acme'], ['globex', 'r-globex']] as const) {
    await j.put(`org:${org}:${run}:input`, { prompt: 'hi', agent: 'support', at: 1 });
    await j.put(`org:${org}:${run}:model:0`, { content: [{ type: 'text', text: 'ok' }], finishReason: 'stop', usage: { inputTokens: { total: 10 }, outputTokens: { total: 1 } } });
    await j.put(`org:${org}:${run}:outcome`, { status: 'completed', at: 3 });
  }
  return j;
}

/** A stand-in optimizer that reports which runs the reader it was handed can see. */
function recordingOptimizer() {
  const replays: unknown[] = [];
  const seen = async (journal: any, agent: string) => (await journal.listRunsPaged({ agent, limit: 100 })).items.map((r: any) => r.runId);
  const optimizer: StudioOptimizer = {
    catalog: () => ({ agents: ['support'], models: ['cheap/model'] }),
    diagnose: async (journal, agent) => ({ agent, runs: await seen(journal, agent) }),
    replay: async (journal, req) => { replays.push(req); return { agent: req.agent, runs: await seen(journal, req.agent) }; },
    history: async (journal, agent) => [{ agent, runs: await seen(journal, agent) }],
    report: async (journal, agent) => ({ markdown: `# ${agent}\n${(await seen(journal, agent)).join(',')}` }),
  };
  return { optimizer, replays };
}

const post = (app: any, path: string, body: unknown, headers: Record<string, string> = {}) =>
  call(app, path, { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(body) });

describe('the optimizer tab', () => {
  it('capabilities.optimizer only when the host gives one; without it every route answers 501', async () => {
    const off = createStudioApi({ reader: await seeded() });
    expect((await (await call(off, '/capabilities')).json()).optimizer).toBe(false);
    expect((await call(off, '/optimizer')).status).toBe(501);
    expect((await call(off, '/optimizer/diagnosis?agent=support')).status).toBe(501);
    expect((await post(off, '/optimizer/replay', { agent: 'support', model: 'cheap/model' })).status).toBe(501);
    const on = createStudioApi({ reader: await seeded(), optimizer: recordingOptimizer().optimizer });
    expect((await (await call(on, '/capabilities')).json()).optimizer).toBe(true);
    expect(await (await call(on, '/optimizer')).json()).toEqual({ agents: ['support'], models: ['cheap/model'] });
  });

  it("each organization's admin is handed a reader that sees only its own runs", async () => {
    const app = createStudioApi({ reader: await seeded(), auth: authProvider as any, optimizer: recordingOptimizer().optimizer });
    const acme = await (await call(app, '/optimizer/diagnosis?agent=support', { headers: AS.acme })).json();
    const globex = await (await call(app, '/optimizer/diagnosis?agent=support', { headers: AS.globex })).json();
    expect(acme.runs).toEqual(['r-acme']);
    expect(globex.runs).toEqual(['r-globex']);
    const replay = await (await post(app, '/optimizer/replay', { agent: 'support', model: 'cheap/model' }, AS.acme)).json();
    expect(replay.runs).toEqual(['r-acme']);
  });

  it('a replay is validated against what the host offers, and audited', async () => {
    const { optimizer, replays } = recordingOptimizer();
    const app = createStudioApi({ reader: await seeded(), optimizer });
    expect((await post(app, '/optimizer/replay', { agent: 'support', model: 'pricey/model' })).status).toBe(400);
    expect((await post(app, '/optimizer/replay', { agent: 'nobody', model: 'cheap/model' })).status).toBe(400);
    expect((await post(app, '/optimizer/replay', { agent: 'support', model: 'cheap/model', limit: 51 })).status).toBe(400);
    expect((await post(app, '/optimizer/replay', { agent: 'support', model: 'cheap/model', keepLast: -1 })).status).toBe(400);
    expect(replays).toEqual([]);
    const ok = await post(app, '/optimizer/replay', { agent: 'support', model: 'cheap/model', limit: 5, keepLast: 2 }, { 'x-gnl-actor': 'ops@acme.co' });
    expect(ok.status).toBe(200);
    expect(replays).toEqual([{ agent: 'support', model: 'cheap/model', limit: 5, keepLast: 2 }]);
    const audit = await (await call(app, '/audit?action=optimizer.replay')).json();
    expect(audit.items).toHaveLength(1);
    expect(audit.items[0]).toMatchObject({ actor: 'ops@acme.co', target: 'support', detail: { model: 'cheap/model', limit: 5 } });
  });

  it("history and report are read through the caller's organization too", async () => {
    const app = createStudioApi({ reader: await seeded(), auth: authProvider as any, optimizer: recordingOptimizer().optimizer });
    const h = await (await call(app, '/optimizer/history?agent=support', { headers: AS.globex })).json();
    expect(h.items[0].runs).toEqual(['r-globex']);
    const r = await (await call(app, '/optimizer/report?agent=support', { headers: AS.acme })).json();
    expect(r.markdown).toBe('# support\nr-acme');
    expect((await call(app, '/optimizer/report?agent=nobody', { headers: AS.acme })).status).toBe(404);
  });

  it('a diagnosis names an agent the host offers', async () => {
    const app = createStudioApi({ reader: await seeded(), optimizer: recordingOptimizer().optimizer });
    expect((await call(app, '/optimizer/diagnosis')).status).toBe(400);
    expect((await call(app, '/optimizer/diagnosis?agent=nobody')).status).toBe(404);
  });
});
