// The Lab tab's routes: on only when the host gives `lab`; a run is looked up through THIS request's
// org-scoped reader (another organization's run is not found); an explanation calls a model many times,
// so it takes 'write', is validated against what the host offers, and is audited. A plan calls no model.
import { describe, it, expect } from 'vitest';
import { InMemoryJournal, purgeRun, withOrg } from '@gnldev/durable';
import { createStudioApi, type StudioLab } from '../src/server.js';
import { call } from './call.js';

const authProvider = {
  authenticate: (req: Request) => {
    const t = req.headers.get('authorization')?.replace('Bearer ', '');
    if (t === 'acme') return { kind: 'operator', roles: ['admin'], id: 'u-acme', orgId: 'acme' };
    if (t === 'globex') return { kind: 'operator', roles: ['admin'], id: 'u-globex', orgId: 'globex' };
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

/** A stand-in lab that reports what it was asked and what its reader can see. */
function recordingLab() {
  const explained: unknown[] = [];
  const formed: unknown[] = [];
  const capsuled: unknown[] = [];
  const lab: StudioLab = {
    catalog: () => ({ agents: ['support'], models: ['cheap/model'] }),
    plan: async (journal, req) => ({ ...req, input: await journal.get(`${req.runId}:input`) }),
    explain: async (_journal, req) => { explained.push(req); return { runId: req.runId, shares: [] }; },
    scenarios: () => [{ id: 'refund-full', category: 'support', prompt: 'Refund order 1042.' }],
    formPlan: (req) => { if (req.scenarios?.includes('nope')) throw new RangeError("@gnldev/lab: no scenario 'nope'"); return { ...req, forms: 4 }; },
    bestForm: async (req) => { formed.push(req); return { best: { components: ['section 1'] } }; },
    capsuleBase: async (journal, req) => ({ runId: req.runId, input: await journal.get(`${req.runId}:input`) }),
    capsule: async (_journal, req) => { capsuled.push(req); return { runId: req.runId, paths: [] }; },
  };
  return { lab, explained, formed, capsuled };
}

const post = (app: any, path: string, body: unknown, headers: Record<string, string> = {}) =>
  call(app, path, { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(body) });

describe('the lab tab', () => {
  it('capabilities.lab only when the host gives one; without it every route answers 501', async () => {
    const off = createStudioApi({ reader: await seeded() });
    expect((await (await call(off, '/capabilities')).json()).lab).toBe(false);
    expect((await call(off, '/lab')).status).toBe(501);
    expect((await call(off, '/lab/plan?runId=r-acme&model=cheap/model')).status).toBe(501);
    expect((await post(off, '/lab/explain', { runId: 'r-acme', model: 'cheap/model' })).status).toBe(501);
    const on = createStudioApi({ reader: await seeded(), lab: recordingLab().lab });
    expect((await (await call(on, '/capabilities')).json()).lab).toBe(true);
    expect(await (await call(on, '/lab')).json()).toEqual({ agents: ['support'], models: ['cheap/model'] });
  });

  it("an organization plans on its own run, and another organization's run is not found", async () => {
    const { lab, explained } = recordingLab();
    const app = createStudioApi({ reader: await seeded(), auth: authProvider as any, lab });
    const plan = await (await call(app, '/lab/plan?runId=r-acme&model=cheap/model', { headers: AS.acme })).json();
    expect(plan).toMatchObject({ runId: 'r-acme', model: 'cheap/model', trials: 3, input: { agent: 'support' } });
    expect((await call(app, '/lab/plan?runId=r-globex&model=cheap/model', { headers: AS.acme })).status).toBe(404);
    expect((await post(app, '/lab/explain', { runId: 'r-globex', model: 'cheap/model' }, AS.acme)).status).toBe(404);
    expect(explained).toEqual([]);
  });

  it('an explanation is validated against what the host offers, and audited', async () => {
    const { lab, explained } = recordingLab();
    const app = createStudioApi({ reader: await seeded(), auth: authProvider as any, lab });
    const ex = (body: unknown) => post(app, '/lab/explain', body, AS.acme);
    expect((await ex({ model: 'cheap/model' })).status).toBe(400);
    expect((await ex({ runId: 'r-nobody', model: 'cheap/model' })).status).toBe(404);
    expect((await ex({ runId: 'r-acme', model: 'pricey/model' })).status).toBe(400);
    expect((await ex({ runId: 'r-acme', model: 'cheap/model', trials: 11 })).status).toBe(400);
    expect((await ex({ runId: 'r-acme', model: 'cheap/model', trials: 0 })).status).toBe(400);
    expect(explained).toEqual([]);
    const ok = await ex({ runId: 'r-acme', model: 'cheap/model', trials: 2 });
    expect(ok.status).toBe(200);
    expect(explained).toEqual([{ runId: 'r-acme', model: 'cheap/model', trials: 2 }]);
    const audit = await (await call(app, '/audit?action=lab.explain', { headers: AS.acme })).json();
    expect(audit.items).toHaveLength(1);
    expect(audit.items[0]).toMatchObject({ target: 'r-acme', detail: { model: 'cheap/model', trials: 2 } });
  });

  it('asked as a stream, an explanation reports each replay as it goes and ends with the result', async () => {
    const lab: StudioLab = { ...recordingLab().lab, explain: async (_j, req, control) => {
      for (let done = 1; done <= 3; done++) control?.onProgress?.({ done, total: 3, failed: done === 2 ? 1 : 0, ...(done === 2 ? { lastError: '429 Too Many Requests' } : {}) });
      return { runId: req.runId, shares: [] };
    } };
    const app = createStudioApi({ reader: await seeded(), auth: authProvider as any, lab });
    const r = await post(app, '/lab/explain', { runId: 'r-acme', model: 'cheap/model' }, { ...AS.acme, accept: 'text/event-stream' });
    expect(r.headers.get('content-type')).toMatch(/text\/event-stream/);
    const text = await r.text();
    expect(text.match(/event: progress/g)).toHaveLength(3);
    expect(text).toContain('"lastError":"429 Too Many Requests"');
    expect(text).toMatch(/event: done\ndata: \{"runId":"r-acme","shares":\[\]\}/);
  });

  it('an explanation that fails half way says why on the stream, and was audited before it spent', async () => {
    const lab: StudioLab = { ...recordingLab().lab, explain: async (_j, _req, control) => {
      control?.onProgress?.({ done: 1, total: 64, failed: 1, lastError: '429 Too Many Requests' });
      throw new Error('@gnldev/lab: explainRun: every replay of {a} failed; the first: 429 Too Many Requests');
    } };
    const app = createStudioApi({ reader: await seeded(), auth: authProvider as any, lab });
    const text = await (await post(app, '/lab/explain', { runId: 'r-acme', model: 'cheap/model' }, { ...AS.acme, accept: 'text/event-stream' })).text();
    expect(text).toMatch(/event: error\ndata: .*429 Too Many Requests.*"status":500/);
    const audit = await (await call(app, '/audit?action=lab.explain', { headers: AS.acme })).json();
    expect(audit.items).toHaveLength(1);
  });

  it('the provider stopped answering: a 503 with its reason, as JSON and on the stream', async () => {
    const stopped = Object.assign(new Error('@gnldev/experiment: stopped after 3 of 64 — the provider kept refusing requests (429) after slowing down: Too Many Requests'), { name: 'ProviderStoppedError' });
    const lab: StudioLab = { ...recordingLab().lab, explain: async () => { throw stopped; } };
    const app = createStudioApi({ reader: await seeded(), auth: authProvider as any, lab });
    const r = await post(app, '/lab/explain', { runId: 'r-acme', model: 'cheap/model' }, AS.acme);
    expect(r.status).toBe(503);
    expect((await r.json()).error).toMatch(/kept refusing requests \(429\)/);
    const text = await (await post(app, '/lab/explain', { runId: 'r-acme', model: 'cheap/model' }, { ...AS.acme, accept: 'text/event-stream' })).text();
    expect(text).toMatch(/event: error\ndata: .*"status":503/);
  });

  it("a capsule: another organization's run is not found; a play is validated, audited by what changed — not its text", async () => {
    const { lab, capsuled } = recordingLab();
    const app = createStudioApi({ reader: await seeded(), auth: authProvider as any, lab });
    expect(await (await call(app, '/lab/capsule?runId=r-acme', { headers: AS.acme })).json()).toMatchObject({ runId: 'r-acme', input: { agent: 'support' } });
    expect((await call(app, '/lab/capsule?runId=r-globex', { headers: AS.acme })).status).toBe(404);
    const play = (body: Record<string, unknown>) => post(app, '/lab/capsule', { runId: 'r-acme', model: 'cheap/model', ...body }, AS.acme);
    expect((await post(app, '/lab/capsule', { runId: 'r-globex', model: 'cheap/model' }, AS.acme)).status).toBe(404);
    expect((await play({ system: 3 })).status).toBe(400);
    expect((await play({ history: 'no' })).status).toBe(400);
    expect((await play({ tools: [{ name: 'refund' }] })).status).toBe(400);
    expect((await play({ tools: [{ name: 'a', description: '' }, { name: 'a', description: '' }] })).status).toBe(400);
    expect((await play({ answers: [{ toolName: 'refund' }] })).status).toBe(400);
    expect(capsuled).toEqual([]);
    const body = { system: 'Refund broken items. SECRET-PROMPT', history: false, tools: [{ name: 'refund', description: 'Refund', parameters: { type: 'object' } }], answers: [{ toolName: 'refund', args: { orderId: '42' }, output: { ok: true } }] };
    expect((await play(body)).status).toBe(200);
    expect(capsuled).toEqual([{ runId: 'r-acme', model: 'cheap/model', trials: 3, ...body }]);
    const audit = await (await call(app, '/audit?action=lab.capsule', { headers: AS.acme })).json();
    expect(audit.items[0]).toMatchObject({ target: 'r-acme', detail: { history: false, systemChanged: true, tools: ['refund'], answers: 1 } });
    expect(JSON.stringify(audit.items[0])).not.toContain('SECRET-PROMPT');
    // kept for the organization's admins: the request as asked, the answers counted and not kept
    const kept = await (await call(app, '/lab/experiments?kind=capsule&target=r-acme', { headers: AS.acme })).json();
    expect(kept.items).toHaveLength(1);
    expect(kept.items[0]).toMatchObject({ v: 1, kind: 'capsule', target: 'r-acme', actor: expect.stringContaining('u-acme'),
      request: { runId: 'r-acme', model: 'cheap/model', system: 'Refund broken items. SECRET-PROMPT', history: false, answers: 1 }, result: { runId: 'r-acme', paths: [] } });
    expect(JSON.stringify(kept.items[0])).not.toContain('"refunded"');
    expect(JSON.stringify(kept.items[0])).not.toContain('"ok":true');
    expect((await (await call(app, '/lab/experiments?kind=capsule&target=r-acme', { headers: AS.globex })).json()).items).toEqual([]);
    expect((await call(app, '/lab/experiments?target=r-acme', { headers: AS.acme })).status).toBe(400);
    expect((await call(app, '/lab/experiments', { headers: AS.acme })).status).toBe(400);
    expect((await call(app, '/lab/experiments?kind=capsule', { headers: AS.acme })).status).toBe(400); // listed by its run
  });

  it('a failed experiment is audited and not kept; a kept one lists newest first', async () => {
    const { lab } = recordingLab();
    let n = 0;
    const app = createStudioApi({ reader: await seeded(), auth: authProvider as any, lab: { ...lab, explain: async (_j, req) => { if (n++ === 1) throw new Error('boom'); return { runId: req.runId, n }; } } });
    for (let i = 0; i < 3; i++) await post(app, '/lab/explain', { runId: 'r-acme', model: 'cheap/model' }, AS.acme).catch(() => undefined);
    const kept = (await (await call(app, '/lab/experiments?kind=explain&target=r-acme', { headers: AS.acme })).json()).items;
    expect(kept.map((x: any) => x.result.n)).toEqual([3, 1]);
  });

  it('GDPR: an experiment on a run is kept UNDER the run, so deleting the run deletes it; best-form stays', async () => {
    const { lab } = recordingLab();
    const j = await seeded();
    const app = createStudioApi({ reader: j, auth: authProvider as any, lab });
    expect((await post(app, '/lab/explain', { runId: 'r-acme', model: 'cheap/model' }, AS.acme)).status).toBe(200);
    expect((await post(app, '/lab/capsule', { runId: 'r-acme', model: 'cheap/model', system: 'Ayse SECRET' }, AS.acme)).status).toBe(200);
    expect((await post(app, '/lab/best-form', { agent: 'support', model: 'cheap/model' }, AS.acme)).status).toBe(200);
    const list = async (q: string) => (await (await call(app, `/lab/experiments?${q}`, { headers: AS.acme })).json()).items;
    expect(await list('kind=explain&target=r-acme')).toHaveLength(1);
    expect(await list('kind=capsule&target=r-acme')).toHaveLength(1);
    expect((await j.listKeys('org:acme:r-acme:derived:lab:exp:')).length).toBe(2);
    expect((await j.listKeys('org:acme:__lab__:exp:capsule:')).length).toBe(0); // nothing of the run's left outside it
    await purgeRun(withOrg(j, 'acme') as any, 'r-acme');
    expect(await list('kind=explain&target=r-acme')).toEqual([]);
    expect(await list('kind=capsule&target=r-acme')).toEqual([]);
    expect(JSON.stringify([...(j as any).store.entries()])).not.toContain('Ayse SECRET');
    expect(await list('kind=best-form')).toHaveLength(1); // an agent's, no run's: not the run's to take
  });

  it('a run the lab cannot explain is a 422 with the reason, not a 500', async () => {
    const lab: StudioLab = { ...recordingLab().lab, plan: async () => { throw new RangeError("@gnldev/lab: run 'r-acme' is not a run of an agent the lab offers"); } };
    const app = createStudioApi({ reader: await seeded(), auth: authProvider as any, lab });
    const r = await call(app, '/lab/plan?runId=r-acme&model=cheap/model', { headers: AS.acme });
    expect(r.status).toBe(422);
    expect((await r.json()).error).toMatch(/not a run of an agent the lab offers/);
  });

  it("the real lab names why a run is refused: a scheduler run has no agent, another agent was not given it", async () => {
    const { studioLab } = await import('../../lab/src/index.js');
    const j = await seeded();
    await j.put('org:acme:r-sched:input', { prompt: 'tick', at: 1 });
    await j.put('org:acme:r-sched:outcome', { status: 'completed', at: 2 });
    const lab = studioLab({ config: { agents: { billing: {} } }, models: { 'cheap/model': 'cheap/model' as never } });
    const app = createStudioApi({ reader: j, auth: authProvider as any, lab: lab as never });
    const none = await call(app, '/lab/plan?runId=r-sched&model=cheap/model', { headers: AS.acme });
    expect(none.status).toBe(422);
    expect(await none.json()).toMatchObject({ code: 'agent-not-offered', agent: null });
    const other = await call(app, '/lab/plan?runId=r-acme&model=cheap/model', { headers: AS.acme });
    expect(await other.json()).toMatchObject({ code: 'agent-not-offered', agent: 'support' });
  });

  it("a new agent's form: the plan reads no journal; trying the forms is validated and audited", async () => {
    const { lab, formed } = recordingLab();
    const app = createStudioApi({ reader: await seeded(), lab });
    expect((await (await call(app, '/lab/scenarios?agent=support')).json()).items[0].id).toBe('refund-full');
    expect((await call(app, '/lab/scenarios?agent=nobody')).status).toBe(400);
    expect(await (await call(app, '/lab/form-plan?agent=support&trials=3&scenarios=refund-full')).json()).toEqual({ agent: 'support', trials: 3, scenarios: ['refund-full'], forms: 4 });
    expect((await call(app, '/lab/form-plan?agent=support&scenarios=nope')).status).toBe(422);
    expect((await post(app, '/lab/best-form', { agent: 'support', model: 'pricey/model' })).status).toBe(400);
    expect((await post(app, '/lab/best-form', { agent: 'support', model: 'cheap/model', trials: 6 })).status).toBe(400);
    expect((await post(app, '/lab/best-form', { agent: 'support', model: 'cheap/model', scenarios: [1] })).status).toBe(400);
    expect(formed).toEqual([]);
    const ok = await post(app, '/lab/best-form', { agent: 'support', model: 'cheap/model', scenarios: ['refund-full'] }, { 'x-gnl-actor': 'ops@acme.co' });
    expect(ok.status).toBe(200);
    expect(formed).toEqual([{ agent: 'support', model: 'cheap/model', trials: 2, scenarios: ['refund-full'] }]);
    const audit = await (await call(app, '/audit?action=lab.best-form')).json();
    expect(audit.items[0]).toMatchObject({ actor: 'ops@acme.co', target: 'support', detail: { model: 'cheap/model', trials: 2 } });
    const off = createStudioApi({ reader: await seeded() });
    expect((await post(off, '/lab/best-form', { agent: 'support', model: 'cheap/model' })).status).toBe(501);
  });

  it("a capsule's expectation is checked by shape before it reaches the lab, and passed on as given", async () => {
    const { lab, capsuled } = recordingLab();
    const app = createStudioApi({ reader: await seeded(), auth: authProvider as any, lab });
    const cap = (want: unknown) => post(app, "/lab/capsule", { runId: "r-acme", model: "cheap/model", expect: want }, AS.acme);
    for (const bad of ['refund', [], { calls: 'refund' }, { calls: [{ args: {} }] }, { calls: [{ toolName: 'x', args: [1] }] }, { forbidden: [''] }, { answerIncludes: [[]] }, { judge: 'gpt' }]) {
      expect((await cap(bad)).status, JSON.stringify(bad)).toBe(400);
    }
    expect(capsuled).toEqual([]);
    const want = { calls: [{ toolName: 'refund', args: { orderId: '1042' } }], forbidden: ['cancel'], answerIncludes: ['refunded', ['30 days', '30-day']] };
    expect((await cap(want)).status).toBe(200);
    expect(capsuled).toEqual([expect.objectContaining({ runId: 'r-acme', expect: want })]);
  });
});
