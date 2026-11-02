// An agent's kept scenarios through Studio: kept from a run the caller can see, in the caller's
// organization, under the person whose conversation it copies — so erasing them erases it; listed only
// to that organization; played against the agent as the host defines it, with no record of the play
// kept (its failures quote the people's data); removed by id. Every route takes 'write' and is audited
// by title and run, never content.
import { describe, it, expect } from 'vitest';
import { tool } from 'ai';
import { z } from 'zod';
import { InMemoryJournal, runDurable, gnlTool, withOrg, purgeResource } from '@gnldev/durable';
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
const ANKARA = { calls: [{ toolName: 'createOrder', args: { address: 'Ankara' } }] };

/** Orders to the address the lookup returned. */
const model = () => { const m = createMockModel(async (o: any) => {
  const results = (o.prompt as any[]).filter((p) => p.role === 'tool');
  const call = (toolName: string, args: unknown, id: string) => ({ content: [{ type: 'tool-call', toolCallId: id, toolName, input: JSON.stringify(args) }], finishReason: 'tool-calls', usage });
  if (results.length === 0) return call('lookup', {}, 'l1');
  if (results.length === 1) { const a = /"address":"(\w+)"/.exec(JSON.stringify(results[0])); return call('createOrder', { address: a ? a[1] : '?' }, 'c1'); }
  return { content: [{ type: 'text', text: 'Done.' }], finishReason: 'stop', usage };
}); (m as any).modelId = 'cheap'; return m; };
const real = () => ({
  lookup: gnlTool(tool({ description: 'Look the address up', inputSchema: z.object({}), execute: async () => ({ address: 'AYSE-PRIVATE-ADDR' }) }), { sideEffect: false }),
  createOrder: gnlTool(tool({ description: 'Order', inputSchema: z.object({ address: z.string() }), execute: async () => ({ ok: true }) }), { sideEffect: true }),
});
const trap = () => Object.fromEntries(Object.entries(real()).map(([k, v]) => [k, { ...v, execute: async () => { throw new Error(`the lab ran ${k}`); } }])) as any;

async function setup() {
  const j = new InMemoryJournal();
  await runDurable({ runId: 'r1', journal: withOrg(j, 'acme'), agentName: 'shop', resourceId: 'ayse', prompt: 'Ship my order.', system: 'You are a shop agent.', model: model(), tools: real() } as any);
  const lab = studioLab({ config: { agents: { shop: { tools: trap(), system: 'You are a shop agent.' } } }, models: { cheap: model() } });
  return { j, app: createStudioApi({ reader: j, auth: authProvider as any, lab }) };
}
const post = (app: any, path: string, body: unknown, headers: Record<string, string>) =>
  call(app, path, { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(body) });
const list = async (app: any, who: Record<string, string>) => (await (await call(app, '/lab/saved-scenarios?agent=shop', { headers: who })).json()).items as any[];

describe('the saved scenario routes', () => {
  it('kept in the organization under its person, listed to that organization only, played, removed', async () => {
    const { j, app } = await setup();
    const saved = await post(app, '/lab/saved-scenarios', { runId: 'r1', title: 'Ship to Ankara', expect: ANKARA, overrides: [{ toolName: 'lookup', args: {}, output: { address: 'Ankara' } }] }, AS.acme);
    expect(saved.status).toBe(201);
    const s = await saved.json();
    expect(s).toMatchObject({ agent: 'shop', owner: 'ayse', title: 'Ship to Ankara', by: 'u-acme' });
    expect((await list(app, AS.acme)).map((x) => x.id)).toEqual([s.id]);
    expect(await list(app, AS.globex)).toEqual([]);
    // the copy holds the person's replacement in place of what the tool said
    expect(JSON.stringify(s.results)).not.toContain('AYSE-PRIVATE-ADDR');
    // played against the agent: the replaced lookup leads to the right order
    const ran = await post(app, '/lab/saved-scenarios/run', { agent: 'shop', model: 'cheap', trials: 2 }, AS.acme);
    expect(ran.status).toBe(200);
    expect((await ran.json()).scenarios[0]).toMatchObject({ id: s.id, passed: 2 });
    // the play is not kept, and the audit names the title and run, never the content
    expect(await j.listKeys('org:acme:__lab__:exp:')).toEqual([]);
    const audit = await (await call(app, '/audit?action=lab.scenario-save', { headers: AS.acme })).json();
    expect(audit.items[0]).toMatchObject({ target: 'shop', detail: { runId: 'r1', scenario: s.id, title: 'Ship to Ankara' } });
    // its tool results are changed in place by its own organization only; the audit names what changed, not to what
    const patch = (who: Record<string, string>, body: unknown) => call(app, `/lab/saved-scenarios/shop/${s.id}`, { method: 'PATCH', headers: { 'content-type': 'application/json', ...who }, body: JSON.stringify(body) });
    expect((await patch(AS.globex, { title: 'taken' })).status).toBe(404);
    expect((await patch(AS.acme, { title: '' })).status).toBe(400);
    expect((await patch(AS.acme, {})).status).toBe(400);
    const changed = await patch(AS.acme, { title: 'Ship to Ankara, edited', results: [{ toolName: 'lookup', args: {}, output: { address: 'EDITED-ADDR' } }] });
    expect(changed.status).toBe(200);
    expect((await list(app, AS.acme))[0]).toMatchObject({ title: 'Ship to Ankara, edited', owner: 'ayse', results: [{ toolName: 'lookup', output: { address: 'EDITED-ADDR' } }] });
    const edits = await (await call(app, '/audit?action=lab.scenario-edit', { headers: AS.acme })).json();
    expect(edits.items[0]).toMatchObject({ detail: { scenario: s.id, changed: ['title', 'results'] } });
    expect(JSON.stringify(edits)).not.toContain('EDITED-ADDR');
    // another organization cannot remove it; its own can
    expect((await call(app, `/lab/saved-scenarios/shop/${s.id}`, { method: 'DELETE', headers: AS.globex })).status).toBe(404);
    expect((await call(app, `/lab/saved-scenarios/shop/${s.id}`, { method: 'DELETE', headers: AS.acme })).status).toBe(200);
    expect(await list(app, AS.acme)).toEqual([]);
  });

  it("erasing the person erases the scenario copied from their conversation", async () => {
    const { j, app } = await setup();
    expect((await post(app, '/lab/saved-scenarios', { runId: 'r1', title: 'kept', expect: ANKARA }, AS.acme)).status).toBe(201);
    expect(JSON.stringify([...(j as any).store.entries()])).toContain('AYSE-PRIVATE-ADDR');
    await purgeResource(withOrg(j, 'acme'), 'ayse');
    expect(await list(app, AS.acme)).toEqual([]);
    expect(JSON.stringify([...(j as any).store.entries()])).not.toContain('AYSE-PRIVATE-ADDR');
  });

  it('a request without a title, an expectation, or a run the caller can see never reaches the lab', async () => {
    const { app } = await setup();
    expect((await post(app, '/lab/saved-scenarios', { runId: 'r1', expect: ANKARA }, AS.acme)).status).toBe(400);
    expect((await post(app, '/lab/saved-scenarios', { runId: 'r1', title: 't' }, AS.acme)).status).toBe(400);
    expect((await post(app, '/lab/saved-scenarios', { runId: 'r1', title: 't', expect: ANKARA }, AS.globex)).status).toBe(404);
    expect((await post(app, '/lab/saved-scenarios/run', { agent: 'shop', model: 'pricey' }, AS.acme)).status).toBe(400);
    expect((await post(app, '/lab/saved-scenarios/run', { agent: 'shop', model: 'cheap' }, AS.acme)).status).toBe(422); // none kept yet
  });

  it("the playground: an agent's definition to start from, a play answered from the page, a measure, a scenario — content in no audit", async () => {
    const { j, app } = await setup();
    const b = await (await call(app, '/lab/playground/base?agent=shop', { headers: AS.acme })).json();
    expect(b).toMatchObject({ agent: 'shop', system: 'You are a shop agent.', systemFixed: true });
    expect(b.tools.map((x: any) => x.name).sort()).toEqual(['createOrder', 'lookup']);
    const agent = { system: 'You are a shop agent.', tools: [
      { name: 'lookup', description: 'Look the address up', parameters: { type: 'object', properties: {} }, answers: [{ args: {}, output: { address: 'PLAYGROUNDADDR' } }] },
      { name: 'createOrder', description: 'Order', parameters: { type: 'object', properties: { address: { type: 'string' } } }, otherwise: { output: { ok: true } } },
    ] };
    const messages = [{ role: 'user', content: 'Ship my order.' }];
    const played = await post(app, '/lab/playground/play', { agent, model: 'cheap', messages }, AS.acme);
    expect(played.status).toBe(200);
    expect((await played.json()).calls.map((c: any) => `${c.toolName}:${c.source}`)).toEqual(['lookup:answer', 'createOrder:otherwise']);
    const measured = await post(app, '/lab/playground/measure', { agent, model: 'cheap', messages, trials: 2, expect: { calls: [{ toolName: 'createOrder', args: { address: 'PLAYGROUNDADDR' } }] } }, AS.acme);
    expect((await measured.json()).measure).toMatchObject({ passed: 2 });
    const saved = await post(app, '/lab/playground/scenario', { agent: 'shop', title: 'From the playground', definition: agent, messages, expect: { calls: [{ toolName: 'createOrder' }] } }, AS.acme);
    expect(saved.status).toBe(201);
    expect(await saved.json()).toMatchObject({ agent: 'shop', from: { playground: true }, answers: [{ toolName: 'lookup', output: { address: 'PLAYGROUNDADDR' } }] });
    expect((await list(app, AS.acme)).map((x) => x.title)).toEqual(['From the playground']);
    expect(await list(app, AS.globex)).toEqual([]);
    const audit = await (await call(app, '/audit?action=lab.playground', { headers: AS.acme })).json();
    expect(audit.items.map((x: any) => x.target).sort()).toEqual(['measure', 'play']);
    expect(JSON.stringify(audit)).not.toContain('PLAYGROUNDADDR');
    expect(await j.listKeys('org:acme:__lab__:exp:')).toEqual([]);
    // the definition is checked before any model is asked
    expect((await post(app, '/lab/playground/play', { agent: { system: 'x', tools: [{ name: 'a' }] }, model: 'cheap', messages }, AS.acme)).status).toBe(400);
    expect((await post(app, '/lab/playground/play', { agent, model: 'cheap', messages: [{ role: 'assistant', content: 'hi' }] }, AS.acme)).status).toBe(400);
    expect((await post(app, '/lab/playground/play', { agent: { system: 'x', tools: [{ name: 'bad name', description: '', parameters: { type: 'object' } }] }, model: 'cheap', messages }, AS.acme)).status).toBe(422);
    expect((await post(app, '/lab/playground/scenario', { agent: 'no name!', title: 't', definition: agent, messages, expect: { calls: [{ toolName: 'x' }] } }, AS.acme)).status).toBe(422);
    // kept under a name of its own — no agent of the code — and played against the definition sent
    expect((await post(app, '/lab/playground/scenario', { agent: 'destek-v2', title: 'new agent', definition: agent, messages, expect: { calls: [{ toolName: 'createOrder', args: { address: 'PLAYGROUNDADDR' } }] } }, AS.acme)).status).toBe(201);
    const ran = await post(app, '/lab/playground/scenarios/run', { agent: 'destek-v2', definition: agent, model: 'cheap', trials: 2 }, AS.acme);
    expect(ran.status).toBe(200);
    expect((await ran.json()).scenarios[0]).toMatchObject({ title: 'new agent', passed: 2 });
    expect((await post(app, '/lab/playground/scenarios/run', { agent: 'destek-v2', definition: agent, model: 'cheap' }, AS.globex)).status).toBe(422); // none of globex's
    // only those ticked are played
    const second = await (await post(app, '/lab/playground/scenario', { agent: 'destek-v2', title: 'second', definition: agent, messages, expect: { calls: [{ toolName: 'createOrder' }] } }, AS.acme)).json();
    const picked = await (await post(app, '/lab/playground/scenarios/run', { agent: 'destek-v2', definition: agent, model: 'cheap', trials: 1, ids: [second.id] }, AS.acme)).json();
    expect(picked.scenarios.map((x: any) => x.title)).toEqual(['second']);
    expect((await post(app, '/lab/playground/scenarios/run', { agent: 'destek-v2', definition: agent, model: 'cheap', ids: ['nope'] }, AS.acme)).status).toBe(422);
    expect((await post(app, '/lab/playground/scenarios/run', { agent: 'destek-v2', definition: agent, model: 'cheap', ids: 'x' }, AS.acme)).status).toBe(400);
  });
});
