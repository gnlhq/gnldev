// A runId belongs to the target that started it — on every door and for every run kind.
//
// Measured before the rule existed (durable run-identity.ts assertRunTarget): agent `b` called with
// agent `a`'s runId answered 200 with `a`'s text and `b`'s model never ran — on the REST run, resume
// and stream routes, the AG-UI door and the chat door — and workflow `y` answered with workflow `x`'s
// output. A check on the REST door alone (measured as a candidate) left AG-UI and chat open and told a
// stranger which agent the run was for; the rule lives at the run entries the doors share instead.
import { describe, it, expect } from 'vitest';
import { InMemoryJournal, InMemoryStorage, BasicMemory, createGnl, STAFF, runKeys } from '@gnldev/durable';
import { workflow, step } from '@gnldev/workflow';
import { createRestApi } from '../src/index.js';
import { createAguiRoute } from '../../agui/src/route.js';
import { createChatRoute } from '../../chat-adapter/src/index.js';
import { call } from './call.js';

const usage = { inputTokens: 1, outputTokens: 1, totalTokens: 2 };
const mkStream = (arr: any[]) => new ReadableStream({ start(c) { for (const p of arr) c.enqueue(p); c.close(); } });
const calls: Record<string, number> = {};
function mkModel(name: string): any {
  const text = `answer-from-${name}`;
  return {
    specificationVersion: 'v2', provider: 'mock', modelId: name, supportedUrls: {},
    doGenerate: async () => { calls[name] = (calls[name] ?? 0) + 1; return { content: [{ type: 'text', text }], finishReason: 'stop', usage, warnings: [] }; },
    doStream: async () => { calls[name] = (calls[name] ?? 0) + 1; return { stream: mkStream([
      { type: 'stream-start', warnings: [] }, { type: 'text-start', id: '1' }, { type: 'text-delta', id: '1', delta: text },
      { type: 'text-end', id: '1' }, { type: 'finish', finishReason: 'stop', usage }]) }; },
  };
}
const textModel = (text: string) => ({
  specificationVersion: 'v4' as const, provider: 'm', modelId: 'm', supportedUrls: {},
  doGenerate: async () => ({
    content: [{ type: 'text' as const, text }],
    finishReason: { unified: 'stop' as const, raw: 'stop' },
    usage: { inputTokens: { total: 1 }, outputTokens: { total: 1 } },
    warnings: [],
  }),
});
const reset = () => { for (const k of Object.keys(calls)) delete calls[k]; };
const json = (body: unknown) => ({ method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
const jsonAs = (body: unknown, who: string) => ({ method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${who}` }, body: JSON.stringify(body) });
const twoAgents = () => ({ a: { model: mkModel('a') }, b: { model: mkModel('b') } });

/** The refusal every door must give: 409, a typed code, and agent b's model never ran. */
async function expectRefused(res: Response) {
  const text = await res.text();
  expect(res.status, `body: ${text.slice(0, 200)}`).toBe(409);
  expect(text).not.toContain('answer-from-a');
  expect(JSON.parse(text).code).toBe('run_target_mismatch');
  expect(calls.b ?? 0).toBe(0);
}

describe('a runId belongs to the target that started it — every door', () => {
  it('S1 REST /run: agent b with agent a\'s runId', async () => {
    reset();
    const api = createRestApi({ journal: new InMemoryJournal(), agents: twoAgents() });
    expect((await call(api, '/agents/a/run', json({ runId: 'r1', prompt: 'hi' }))).status).toBe(200);
    await expectRefused(await call(api, '/agents/b/run', json({ runId: 'r1', prompt: 'hi' })));
  });
  it('S2 REST /resume: agent b resumes agent a\'s run', async () => {
    reset();
    const api = createRestApi({ journal: new InMemoryJournal(), agents: twoAgents() });
    await (await call(api, '/agents/a/run', json({ runId: 'r1', prompt: 'hi' }))).text();
    await expectRefused(await call(api, '/agents/b/resume', json({ runId: 'r1' })));
  });
  it('S3 REST /stream: agent b streams agent a\'s runId', async () => {
    reset();
    const api = createRestApi({ journal: new InMemoryJournal(), agents: twoAgents() });
    await (await call(api, '/agents/a/stream', json({ runId: 'r1', prompt: 'hi' }))).text();
    await expectRefused(await call(api, '/agents/b/stream', json({ runId: 'r1', prompt: 'hi' })));
  });
  it('S4 REST workflow: workflow y with workflow x\'s runId', async () => {
    const api = createRestApi({ journal: new InMemoryJournal(), workflows: {
      x: workflow<unknown>().then(step('s', async () => 'output-of-X')),
      y: workflow<unknown>().then(step('s', async () => 'output-of-Y')),
    } } as any);
    expect((await call(api, '/workflows/x/run', json({ runId: 'w1', input: {} }))).status).toBe(200);
    const res = await call(api, '/workflows/y/run', json({ runId: 'w1', input: {} }));
    const text = await res.text();
    expect(res.status, text.slice(0, 200)).toBe(409);
    expect(text).not.toContain('output-of-X');
    expect(JSON.parse(text).code).toBe('run_target_mismatch');
  });
  it('S5 AG-UI door: agent b with agent a\'s runId', async () => {
    reset();
    const app = createAguiRoute({ journal: new InMemoryJournal(), agents: twoAgents() });
    await (await call(app, '/agents/a/run', json({ runId: 'r1', threadId: 't', prompt: 'hi' }))).text();
    await expectRefused(await call(app, '/agents/b/run', json({ runId: 'r1', threadId: 't', prompt: 'hi' })));
  });
  it('S6 chat door: agent b with agent a\'s runId', async () => {
    reset();
    const app = createChatRoute({ journal: new InMemoryJournal(), agents: { a: { model: mkModel('a'), maxSteps: 2 }, b: { model: mkModel('b'), maxSteps: 2 } } });
    const msg = { id: 'm1', role: 'user', parts: [{ type: 'text', text: 'hi' }] };
    await (await app.request('/agents/a/chat', json({ id: 'conv', runId: 'shared', messages: [msg] }))).text();
    await expectRefused(await app.request('/agents/b/chat', json({ id: 'conv', runId: 'shared', messages: [msg] })));
  });
  it('S7 control: the same agent re-running its own runId is served from the journal', async () => {
    reset();
    const api = createRestApi({ journal: new InMemoryJournal(), agents: twoAgents() });
    await (await call(api, '/agents/a/run', json({ runId: 'r1', prompt: 'hi' }))).text();
    const res = await call(api, '/agents/a/run', json({ runId: 'r1', prompt: 'hi' }));
    expect(res.status).toBe(200);
    expect((await res.json()).text).toBe('answer-from-a');
    expect(calls.a).toBe(1);
  });
  it('S8 a run recorded with no target (0.9 and earlier) is not refused: absence is not evidence', async () => {
    reset();
    const journal = new InMemoryJournal();
    const api = createRestApi({ journal, agents: twoAgents() });
    await (await call(api, '/agents/a/run', json({ runId: 'r1', prompt: 'hi' }))).text();
    const rec = await journal.get<Record<string, unknown>>(runKeys.input('r1'));
    const { agent: _drop, ...legacy } = rec!;
    await journal.put(runKeys.input('r1'), legacy);
    const res = await call(api, '/agents/b/run', json({ runId: 'r1', prompt: 'hi' }));
    expect(res.status).toBe(200);
  });
  it('S9 a refused call leaves the target\'s run as it was (no "failed" stamped over "completed")', async () => {
    reset();
    const journal = new InMemoryJournal();
    const api = createRestApi({ journal, agents: twoAgents() });
    await (await call(api, '/agents/a/run', json({ runId: 'r1', prompt: 'hi' }))).text();
    const before = await journal.get<any>('r1:outcome');
    await (await call(api, '/agents/b/run', json({ runId: 'r1', prompt: 'hi' }))).text();
    const after = await journal.get<any>('r1:outcome');
    expect(after?.status ?? after).toEqual(before?.status ?? before);
  });
  it('S10 approvals sent with a refused call are not written', async () => {
    reset();
    const journal = new InMemoryJournal();
    const api = createRestApi({ journal, agents: twoAgents() });
    await (await call(api, '/agents/a/run', json({ runId: 'r1', prompt: 'hi' }))).text();
    const keysBefore = (await journal.listKeys!('r1:')).length;
    await (await call(api, '/agents/b/run', json({ runId: 'r1', prompt: 'hi', approvals: { tc1: true } }))).text();
    expect((await journal.listKeys!('r1:')).length).toBe(keysBefore);
  });
});

describe('a runId belongs to the target that started it — the engine, a stranger, every kind', () => {
  it('S11 the engine directly: gnl.run of agent b with agent a\'s runId throws RunTargetMismatchError', async () => {
    const gnl = createGnl({ journal: new InMemoryJournal(), agents: { a: { model: textModel('answer-from-a') }, b: { model: textModel('answer-from-b') } } } as any);
    await gnl.run('a', { runId: 'r1', prompt: 'hi' });
    const err = await gnl.run('b', { runId: 'r1', prompt: 'hi' }).then(() => undefined, (e) => e);
    expect(err?.name).toBe('RunTargetMismatchError');
    expect(err?.detail).toEqual({ runId: 'r1', startedFor: { kind: 'agent', name: 'a' }, requested: { kind: 'agent', name: 'b' } });
  });
  it('S12 a stranger with somebody else\'s runId is refused as a stranger and learns no target', async () => {
    const PRINCIPALS: Record<string, unknown> = { ayse: { kind: 'subject', id: 'u-ayse', roles: ['admin'] }, mallory: { kind: 'subject', id: 'u-mallory', roles: ['admin'] } };
    const auth = { authenticate: (req: Request) => PRINCIPALS[req.headers.get('authorization')?.replace('Bearer ', '') ?? ''] ?? null, authorize: () => ({ allow: true }) };
    const api = createRestApi({ journal: new InMemoryJournal(), agents: { a: { model: textModel('answer-from-a') }, b: { model: textModel('answer-from-b') } } } as any, { auth: auth as never, protectionsBanner: false });
    expect((await call(api, '/agents/a/run', jsonAs({ runId: 'r1', prompt: 'hi' }, 'ayse'))).status).toBe(200);
    const res = await call(api, '/agents/b/run', jsonAs({ runId: 'r1', prompt: 'hi' }, 'mallory'));
    const text = await res.text();
    expect(text).not.toContain('answer-from-a');
    expect(text).not.toContain('run_target_mismatch');
    expect(text).not.toContain("'a'");
    expect([403, 404, 409]).toContain(res.status);
  });
  it('S13 cross-kind: a workflow door with an agent\'s runId', async () => {
    const api = createRestApi({ journal: new InMemoryJournal(), agents: { a: { model: textModel('answer-from-a') } },
      workflows: { x: workflow<unknown>().then(step('s', async () => 'output-of-X')) } } as any, { protectionsBanner: false });
    expect((await call(api, '/agents/a/run', json({ runId: 'r1', prompt: 'hi' }))).status).toBe(200);
    const res = await call(api, '/workflows/x/run', json({ runId: 'r1', input: {} }));
    const text = await res.text();
    expect(res.status, text.slice(0, 200)).toBe(409);
    expect(JSON.parse(text).code).toBe('run_target_mismatch');
  });
  it('S14 a named network: network n2 with network n1\'s runId', async () => {
    const route = (agent: string, task: string) => JSON.stringify({ action: 'route', agent, task });
    const final = (answer: string) => JSON.stringify({ action: 'final', answer });
    const routerFor = (answer: string) => { let i = 0; return { ...textModel(''), doGenerate: async () => ({
      content: [{ type: 'text' as const, text: [route('e', 'T'), final(answer)][Math.min(i++, 1)]! }],
      finishReason: { unified: 'stop' as const, raw: 'stop' }, usage: { inputTokens: { total: 1 }, outputTokens: { total: 1 } }, warnings: [] }) }; };
    const storage = new InMemoryStorage();
    const gnl = createGnl({ storage, memory: new BasicMemory(storage.runs), agents: { e: { description: 'x', model: textModel('e') } },
      networks: { n1: { router: routerFor('N1'), agents: ['e'] }, n2: { router: routerFor('N2'), agents: ['e'] } } } as any);
    await gnl.runNetwork('n1', { runId: 'nr', task: 't', caller: STAFF });
    const err = await gnl.runNetwork('n2', { runId: 'nr', task: 't', caller: STAFF }).then((r: any) => r, (e: any) => e);
    expect(err?.name, JSON.stringify(err).slice(0, 200)).toBe('RunTargetMismatchError');
  });
  it('S15 the same workflow re-running its own runId still replays', async () => {
    const api = createRestApi({ journal: new InMemoryJournal(), workflows: { x: workflow<unknown>().then(step('s', async () => 'output-of-X')) } } as any, { protectionsBanner: false });
    await (await call(api, '/workflows/x/run', json({ runId: 'w1', input: {} }))).text();
    const res = await call(api, '/workflows/x/run', json({ runId: 'w1', input: {} }));
    expect(res.status).toBe(200);
    expect((await res.json()).output).toBe('output-of-X');
  });
});
