// "Would removing this section change what the agent does?" and "which words decided it?" through
// Studio: a run the caller can see, read through the caller's organization; checked before a model is
// asked; audited by counts, never by the person's words; and nothing kept — a prune's messages and a
// word's text are the person's own.
import { describe, it, expect } from 'vitest';
import { tool } from 'ai';
import { z } from 'zod';
import { InMemoryJournal, runDurable, gnlTool, withOrg } from '@gnldev/durable';
import { createMockModel } from '../../durable/test/mock.js';
import { createStudioApi } from '../src/server.js';
import { studioLab } from '../../lab/src/index.js';
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
const usage = { inputTokens: 100, outputTokens: 10 };
const system = 'You are a shop agent.\n\nAlways look the order up first.\n\nBe brief.';

/** Looks up first when the rule is in its prompt, then answers. */
const model = () => { const m = createMockModel(async (o: any) => {
  const sys = JSON.stringify(o.prompt.filter((p: any) => p.role === 'system'));
  if (sys.includes('look the order up') && !o.prompt.some((p: any) => p.role === 'tool')) return { content: [{ type: 'tool-call', toolCallId: 'l', toolName: 'lookup', input: '{"orderId":"7"}' }], finishReason: 'tool-calls', usage };
  return { content: [{ type: 'text', text: 'Done.' }], finishReason: 'stop', usage };
}); (m as any).modelId = 'cheap'; return m; };
const lookup = () => gnlTool(tool({ description: 'Look an order up', inputSchema: z.object({ orderId: z.string() }), execute: async () => ({ item: 'AYSE-PRIVATE-ITEM' }) }), { sideEffect: false });

async function setup() {
  const j = new InMemoryJournal();
  await runDurable({ runId: 'r1', journal: withOrg(j, 'acme'), agentName: 'shop', resourceId: 'ayse', prompt: 'Where is AYSE-ORDER-7?', system, model: model(), tools: { lookup: lookup() } } as any);
  const trap = { lookup: { ...lookup(), execute: async () => { throw new Error('the lab ran lookup'); } } };
  const lab = studioLab({ config: { agents: { shop: { tools: trap, system } } }, models: { cheap: model() } });
  return { j, app: createStudioApi({ reader: j, auth: authProvider as any, lab }) };
}
const post = (app: any, path: string, body: unknown, headers: Record<string, string>) =>
  call(app, path, { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(body) });

describe('the prune and words routes', () => {
  it('a section removed beside the noise, on a run of the caller; nothing kept, the audit counts', async () => {
    const { j, app } = await setup();
    const plan = await call(app, '/lab/prune-plan?runId=r1&model=cheap&prompts=1&trials=2&control=1', { headers: AS.acme });
    expect(plan.status).toBe(200);
    expect(await plan.json()).toMatchObject({ arms: 4, runs: 8, sections: [{ id: 'system 1' }, { id: 'system 2' }, { id: 'system 3' }], tools: [{ name: 'lookup' }] });
    const r = await post(app, '/lab/prune', { runId: 'r1', model: 'cheap', remove: 'system 3', control: 'system 2', prompts: ['MY-OWN-WORDS where is 7?'], otherwise: { lookup: { item: 'lamp' } }, trials: 2 }, AS.acme);
    expect(r.status).toBe(200);
    expect(await r.json()).toMatchObject({ harmless: true, controlSeparates: true, unanswered: [] });
    expect(await j.listKeys('org:acme:__lab__:exp:')).toEqual([]);
    const audit = JSON.stringify(await (await call(app, '/audit?action=lab.prune', { headers: AS.acme })).json());
    expect(audit).toContain('"prompts":1');
    expect(audit).not.toContain('MY-OWN-WORDS');
    // another organization does not find the run
    expect((await call(app, '/lab/prune-plan?runId=r1&model=cheap', { headers: AS.globex })).status).toBe(404);
    expect((await post(app, '/lab/prune', { runId: 'r1', model: 'cheap', remove: 'system 3', prompts: ['x'] }, AS.globex)).status).toBe(404);
  });

  it('prune is checked before a model is asked', async () => {
    const { app } = await setup();
    const bad = async (body: Record<string, unknown>) => (await post(app, '/lab/prune', { runId: 'r1', model: 'cheap', remove: 'system 3', prompts: ['x'], ...body }, AS.acme)).status;
    expect(await bad({ remove: '' })).toBe(400);
    expect(await bad({ control: 'system 3' })).toBe(400);
    expect(await bad({ prompts: [] })).toBe(400);
    expect(await bad({ prompts: ['x'.repeat(4001)] })).toBe(400);
    expect(await bad({ trials: 46 })).toBe(400);
    expect(await bad({ answers: [{ toolName: 'lookup' }] })).toBe(400);
    expect(await bad({ remove: 'nope' })).toBe(422);
  });

  it("which words decided: the share of tries, the audit says how many words — not which", async () => {
    const { j, app } = await setup();
    const plan = await (await call(app, `/lab/words-plan?runId=r1&model=cheap&samples=2`, { headers: AS.acme })).json();
    expect(plan).toMatchObject({ method: 'sampled', samples: 2, tool: 'lookup', words: ['Where', 'is', 'AYSE-ORDER-7?'], calls: 16 });
    const custom = await (await call(app, `/lab/words-plan?runId=r1&model=cheap&words=${encodeURIComponent(JSON.stringify(['Where is', 'AYSE-ORDER-7?']))}`, { headers: AS.acme })).json();
    expect(custom.subsets).toBe(4);
    const r = await post(app, '/lab/words', { runId: 'r1', model: 'cheap', tool: 'lookup', words: ['Where is', 'AYSE-ORDER-7?'], samples: 2 }, AS.acme);
    expect(r.status).toBe(200);
    // the rule in the prompt makes the lookup whatever the words: every share 0, each with its chance
    const w = await r.json();
    expect(w).toMatchObject({ method: 'sampled', full: 1, none: 1 });
    expect(w.shares.every((s: any) => s.share === 0 && s.sd > 0)).toBe(true);
    expect(await j.listKeys('org:acme:__lab__:exp:')).toEqual([]);
    const audit = JSON.stringify(await (await call(app, '/audit?action=lab.words', { headers: AS.acme })).json());
    expect(audit).toContain('"words":2');
    expect(audit).not.toContain('AYSE-ORDER-7');
    expect((await post(app, '/lab/words', { runId: 'r1', model: 'cheap', tool: 'lookup', words: Array(11).fill('x') }, AS.acme)).status).toBe(400);
    expect((await post(app, '/lab/words', { runId: 'r1', model: 'cheap', words: ['x'] }, AS.acme)).status).toBe(400);
    expect((await post(app, '/lab/words', { runId: 'r1', model: 'cheap', tool: 'nope', words: ['x'] }, AS.acme)).status).toBe(422);
    expect((await call(app, '/lab/words-plan?runId=r1&model=cheap', { headers: AS.globex })).status).toBe(404);
  });

  it('a new agent\'s forms: a tool taken away and one written on the page, checked first', async () => {
    const { app } = await setup();
    const q = `/lab/form-plan?agent=shop&trials=1&withoutTools=getOrder&addTools=${encodeURIComponent(JSON.stringify([{ name: 'handOver', description: 'Hand over', parameters: { type: 'object' }, output: { ok: true } }]))}`;
    const plan = await call(app, q, { headers: AS.acme });
    expect(plan.status).toBe(200);
    expect((await plan.json()).components.map((c: any) => c.id)).toEqual(['section 1', 'section 2', 'section 3', 'without getOrder', 'with handOver']);
    expect((await call(app, '/lab/form-plan?agent=shop&addTools=nope', { headers: AS.acme })).status).toBe(400);
    expect((await call(app, `/lab/form-plan?agent=shop&addTools=${encodeURIComponent(JSON.stringify([{ name: 'bad name', description: '', parameters: { type: 'object' }, output: 1 }]))}`, { headers: AS.acme })).status).toBe(400);
    expect((await call(app, '/lab/form-plan?agent=shop&withoutTools=nope', { headers: AS.acme })).status).toBe(422);
  });
});
