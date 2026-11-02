// The Lab's thread diagnosis routes: the plan reads a thread's runs through THIS request's org-scoped
// reader (another organization's thread is not found); a diagnosis needs what a right answer does, takes
// 'write', is validated before the lab is called, and is audited without what the person wrote — the
// expectation, a corrected working memory, the tool results they typed. Its result is kept under the
// run, so whatever deletes the run deletes it. Then the same routes over the real lab, end to end.
import { describe, it, expect } from 'vitest';
import { InMemoryJournal, purgeRun, withOrg } from '@gnldev/durable';
import { createStudioApi, type StudioLab } from '../src/server.js';
import { call } from './call.js';
import { studioLab } from '../../lab/src/index.js';
import { windowMemory, agentModel, recordThread, call as toolCall, final, text, tools } from '../../lab/test/thread-fixtures.js';

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
const post = (app: any, path: string, body: unknown, headers: Record<string, string> = {}) =>
  call(app, path, { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(body) });

async function seeded() {
  const j = new InMemoryJournal();
  for (const [org, run, thread] of [['acme', 'r-acme', 't-acme'], ['globex', 'r-globex', 't-globex']] as const) {
    await j.put(`org:${org}:${run}:input`, { prompt: 'Ship my order.', agent: 'support', threadId: thread, at: 1 });
    await j.put(`org:${org}:${run}:model:0`, { content: [{ type: 'text', text: 'ok' }], finishReason: 'stop', usage: { inputTokens: { total: 10 }, outputTokens: { total: 1 } } });
    await j.put(`org:${org}:${run}:outcome`, { status: 'completed', at: 3 });
  }
  return j;
}

/** A stand-in lab: the thread's runs as its reader lists them, and every diagnosis it was asked for. */
function recordingLab() {
  const asked: unknown[] = [];
  const lab = {
    catalog: () => ({ agents: ['support'], models: ['cheap/model'] }),
    threadPlan: async (journal: any, req: { threadId: string }) => {
      const turns = (await journal.listRuns()).filter((r: any) => r.threadId === req.threadId).map((r: any, i: number) => ({ turn: i + 1, runId: r.runId }));
      return { threadId: req.threadId, total: turns.length, offset: 0, turns };
    },
    thread: async (_journal: any, req: any) => { asked.push(req); return { runId: req.runId, verdict: { kind: 'cause', arm: 'wm-replace:working memory', sentence: 'Cause: AYSE-PRIVATE-WM' } }; },
  } as unknown as StudioLab;
  return { lab, asked };
}

const EXPECT = { calls: [{ toolName: 'createOrder', args: { address: 'AYSE-PRIVATE-ADDRESS' } }] };

describe('the thread diagnosis routes', () => {
  it("an organization plans on its own thread; another organization's thread is not found", async () => {
    const { lab } = recordingLab();
    const app = createStudioApi({ reader: await seeded(), auth: authProvider as any, lab });
    const own = await call(app, '/lab/thread-plan?threadId=t-acme&model=cheap/model', { headers: AS.acme });
    expect(own.status).toBe(200);
    expect((await own.json()).turns).toEqual([{ turn: 1, runId: 'r-acme' }]);
    expect((await call(app, '/lab/thread-plan?threadId=t-globex&model=cheap/model', { headers: AS.acme })).status).toBe(404);
    expect((await call(app, '/lab/thread-plan?threadId=t-acme&model=cheap/model', { headers: AS.globex })).status).toBe(404);
    expect((await call(app, '/lab/thread-plan?model=cheap/model', { headers: AS.acme })).status).toBe(400);
    expect((await call(app, '/lab/thread-plan?threadId=t-acme&model=pricey', { headers: AS.acme })).status).toBe(400);
    expect((await call(app, '/lab/thread-plan?threadId=t-acme&model=cheap/model&limit=51', { headers: AS.acme })).status).toBe(400);
    expect((await call(app, '/lab/thread-plan?threadId=t-acme&model=cheap/model&expect=nope', { headers: AS.acme })).status).toBe(400);
  });

  it('a diagnosis without what a right answer does, or of a run the caller cannot see, never reaches the lab', async () => {
    const { lab, asked } = recordingLab();
    const app = createStudioApi({ reader: await seeded(), auth: authProvider as any, lab });
    const go = (body: Record<string, unknown>) => post(app, '/lab/thread', { runId: 'r-acme', model: 'cheap/model', expect: EXPECT, ...body }, AS.acme);
    expect((await post(app, '/lab/thread', { runId: 'r-acme', model: 'cheap/model' }, AS.acme)).status).toBe(400);
    expect((await go({ expect: {} })).status).toBe(400);
    expect((await go({ expect: { calls: 'x' } })).status).toBe(400);
    expect((await go({ trials: 101 })).status).toBe(400);
    expect((await go({ eliminationTrials: 0 })).status).toBe(400);
    expect((await go({ topK: 9 })).status).toBe(400);
    expect((await go({ workingMemory: 3 })).status).toBe(400);
    expect((await go({ overrides: [{ toolName: 'lookup' }] })).status).toBe(400);
    expect((await go({ corrections: ['x'] })).status).toBe(400);
    expect((await go({ corrections: { 'recent 1': 3 } })).status).toBe(400);
    expect((await go({ corrections: { 'recent 1': 'x'.repeat(20_001) } })).status).toBe(400);
    expect((await go({ suggest: 'yes' })).status).toBe(400);
    expect((await go({ model: 'pricey' })).status).toBe(400);
    expect((await post(app, '/lab/thread', { runId: 'r-globex', model: 'cheap/model', expect: EXPECT }, AS.acme)).status).toBe(404);
    expect(asked).toEqual([]);
    const off = createStudioApi({ reader: await seeded() });
    expect((await post(off, '/lab/thread', { runId: 'r-acme', model: 'cheap/model', expect: EXPECT })).status).toBe(501);
    expect((await call(off, '/lab/thread-plan?threadId=t-acme&model=cheap/model')).status).toBe(501);
  });

  it('the audit names what was asked, never what was written; the result is kept under the run and goes with it', async () => {
    const { lab, asked } = recordingLab();
    const j = await seeded();
    const app = createStudioApi({ reader: j, auth: authProvider as any, lab });
    const r = await post(app, '/lab/thread', {
      runId: 'r-acme', model: 'cheap/model', expect: EXPECT, trials: 12, workingMemory: 'address: AYSE-PRIVATE-WM',
      overrides: [{ toolName: 'lookup', args: {}, output: { address: 'AYSE-PRIVATE-OVERRIDE' } }],
    }, AS.acme);
    expect(r.status).toBe(200);
    expect(asked).toEqual([expect.objectContaining({ runId: 'r-acme', trials: 12, workingMemory: 'address: AYSE-PRIVATE-WM', overrides: [expect.objectContaining({ toolName: 'lookup' })] })]);
    const audit = await (await call(app, '/audit?action=lab.thread', { headers: AS.acme })).json();
    expect(audit.items[0]).toMatchObject({ target: 'r-acme', detail: { runId: 'r-acme', model: 'cheap/model', trials: 12, arms: ['baseline', 'suspects:top-3', 'absences', 'wm-replace', 'override:lookup'] } });
    expect(JSON.stringify(audit)).not.toMatch(/AYSE-PRIVATE/);
    // kept for acme's admins, under the run
    const list = async (who: Record<string, string>) => (await (await call(app, '/lab/experiments?kind=thread&target=r-acme', { headers: who })).json()).items;
    const kept = await list(AS.acme);
    expect(kept).toHaveLength(1);
    expect(kept[0]).toMatchObject({ kind: 'thread', target: 'r-acme', request: { overrides: 1, answers: 0 } });
    expect(JSON.stringify(kept[0].request)).not.toContain('AYSE-PRIVATE-OVERRIDE');
    expect(await list(AS.globex)).toEqual([]);
    expect((await j.listKeys('org:acme:r-acme:derived:lab:exp:thread:')).length).toBe(1);
    await purgeRun(withOrg(j, 'acme') as any, 'r-acme');
    expect(await list(AS.acme)).toEqual([]);
    expect(JSON.stringify([...(j as any).store.entries()])).not.toMatch(/AYSE-PRIVATE/);
  });

  it('corrections reach the lab; the audit and the kept request name the parts, never the text', async () => {
    const { lab, asked } = recordingLab();
    const j = await seeded();
    const app = createStudioApi({ reader: j, auth: authProvider as any, lab });
    const r = await post(app, '/lab/thread', { runId: 'r-acme', model: 'cheap/model', expect: EXPECT, corrections: { 'recent 1': 'My address is CORRECTION-TEXT.' }, suggest: true }, AS.acme);
    expect(r.status).toBe(200);
    expect(asked[0]).toMatchObject({ corrections: { 'recent 1': 'My address is CORRECTION-TEXT.' }, suggest: true });
    const audit = await (await call(app, '/audit?action=lab.thread', { headers: AS.acme })).json();
    expect(audit.items[0].detail.arms).toEqual(['baseline', 'suspects:top-3', 'absences', 'correct:recent 1', 'suggested corrections']);
    const kept = (await (await call(app, '/lab/experiments?kind=thread&target=r-acme', { headers: AS.acme })).json()).items;
    expect(kept[0].request).toMatchObject({ corrections: ['recent 1'], suggest: true });
    expect(JSON.stringify([audit, kept])).not.toContain('CORRECTION-TEXT');
  });

  it("a capsule's overrides are checked like its answers, audited by tool name only, and kept as a count", async () => {
    const capsuled: any[] = [];
    const lab = { ...recordingLab().lab, capsule: async (_j: any, req: any) => { capsuled.push(req); return { runId: req.runId, paths: [] }; } } as unknown as StudioLab;
    const app = createStudioApi({ reader: await seeded(), auth: authProvider as any, lab });
    expect((await post(app, '/lab/capsule', { runId: 'r-acme', model: 'cheap/model', overrides: [{ args: {} }] }, AS.acme)).status).toBe(400);
    const ok = await post(app, '/lab/capsule', { runId: 'r-acme', model: 'cheap/model', overrides: [{ toolName: 'lookup', args: {}, output: { address: 'AYSE-PRIVATE-OVERRIDE' } }] }, AS.acme);
    expect(ok.status).toBe(200);
    expect(capsuled[0].overrides).toEqual([{ toolName: 'lookup', args: {}, output: { address: 'AYSE-PRIVATE-OVERRIDE' } }]);
    const audit = await (await call(app, '/audit?action=lab.capsule', { headers: AS.acme })).json();
    expect(audit.items[0].detail.overrides).toEqual(['lookup']);
    expect(JSON.stringify(audit)).not.toContain('AYSE-PRIVATE');
    const kept = (await (await call(app, '/lab/experiments?kind=capsule&target=r-acme', { headers: AS.acme })).json()).items;
    expect(kept[0].request.overrides).toBe(1);
  });

  it('over the real lab: the plan of a recorded thread, and a turn diagnosed — no tool runs', async () => {
    const ships = (o: any) => { const m = /address: (\w+)/.exec(text(o)); return m ? toolCall('createOrder', { address: m[1] }) : final('Which address?'); };
    const memory = windowMemory(4, () => '# Working Memory\naddress: Izmir');
    const { journal, ids } = await recordThread(['Hello.', 'Ship my order.'], { memory, model: agentModel(ships), system: 'You are a shop agent.' });
    const trap = tools() as any;
    for (const k of Object.keys(trap)) trap[k] = { ...trap[k], execute: async () => { throw new Error('the lab ran a tool'); } };
    const lab = studioLab({ config: { agents: { shop: { tools: trap } } }, models: { cheap: agentModel(ships) }, pricing: { cheap: { inputPer1M: 1, outputPer1M: 4 } } });
    const app = createStudioApi({ reader: journal, lab });
    const plan = await (await call(app, '/lab/thread-plan?threadId=t&model=cheap&trials=6')).json();
    expect(plan.turns.map((t: any) => [t.turn, t.class, t.diagnosable])).toEqual([[1, 'completed', true], [2, 'completed', true]]);
    expect(plan.turns[1].experiments.plan).toMatchObject({ trials: 6, underpowered: true });
    expect(plan.turns[1].experiments.plan.estimatedCostUsd).toBeGreaterThan(0);
    const r = await post(app, '/lab/thread', { runId: ids[1], model: 'cheap', expect: { calls: [{ toolName: 'createOrder', args: { address: 'Ankara' } }] }, trials: 6, workingMemory: '# Working Memory\naddress: Ankara' });
    expect(r.status).toBe(200);
    const d = await r.json();
    expect(d).toMatchObject({ agent: 'shop', model: 'cheap', turn: 2, threadId: 't', verdict: { kind: 'cause', arm: 'wm-replace:working memory' } });
  });
});
