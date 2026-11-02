// A turn of a thread diagnosed: elimination over the turn's parts valued by what a right answer does,
// then fresh plays of each candidate changed in the capsule beside the turn unchanged, and a verdict by
// rules written before any play. Every model here is createMockModel; no tool runs (the lab's copies
// throw), and the run's records are only read.
import { describe, it, expect } from 'vitest';
import { runKeys } from '@gnldev/durable';
import { createMockModel } from '../../durable/test/mock.js';
import { windowMemory, agentModel, recordThread, call, final, text, trap, toolResults, usage } from './thread-fixtures.js';
import { threadPlan, diagnoseTurn, studioLab } from '../src/index.js';

const SHOP = 'You are a shop agent.';
const lastUser = (o: any) => JSON.stringify((o.prompt as any[]).filter((m) => m.role === 'user').at(-1) ?? '');
const ANKARA = { calls: [{ toolName: 'createOrder', args: { address: 'Ankara' } }] };

describe('a turn is diagnosed against what a right answer does', () => {
  it('a working memory holding the wrong address: the corrected copy is the cause', async () => {
    const ships = (o: any) => { const m = /address: (\w+)/.exec(text(o)); return m ? call('createOrder', { address: m[1] }) : final('Which address?'); };
    const memory = windowMemory(4, () => '# Working Memory\naddress: Izmir');
    const { journal, ids } = await recordThread(['Hello.', 'Ship my order.'], { memory, model: agentModel(ships), system: SHOP });
    const r = await diagnoseTurn({ journal, runId: ids[1]!, model: agentModel(ships), tools: trap(), expect: ANKARA, workingMemory: '# Working Memory\naddress: Ankara', trials: 10 });
    expect(r.verdict).toMatchObject({ kind: 'cause', arm: 'wm-replace:working memory', also: [] });
    const base = r.arms[0]!, wm = r.arms.find((a) => a.id === 'wm-replace:working memory')!;
    expect([base.passed, base.judged, wm.passed, wm.judged]).toEqual([0, 10, 10, 10]);
    expect(wm.difference!.low).toBeGreaterThan(0);
    // the right call was never recorded: each play stopped there and was judged by the calls it made
    expect(wm.paths[0]!.calls.map((c) => `${c.toolName}:${c.source}`)).toEqual(['createOrder:none']);
    // without the corrected text the working memory is only left out — which does not help here
    const off = await diagnoseTurn({ journal, runId: ids[1]!, model: agentModel(ships), tools: trap(), expect: ANKARA, trials: 6 });
    expect(off.verdict.kind).toBe('not-found');
  });

  it('what fell out of the recent window is a candidate of its own, put back from the thread', async () => {
    const ships = (o: any) => {
      if (!lastUser(o).includes('Ship')) return final('Noted.');
      const m = /address is (\w+)/.exec(text(o));
      return call('createOrder', { address: m ? m[1] : 'Izmir' });
    };
    const memory = windowMemory(2);
    const { journal, ids } = await recordThread(['My address is Ankara.', 'I like tea.', 'Ship my order.'], { memory, model: agentModel(ships), system: SHOP });
    const plan = await threadPlan({ journal, threadId: 't' });
    expect(plan.turns[2]!.experiments!.absences).toEqual([expect.objectContaining({ id: 'restore:window', kind: 'window', turns: [1] })]);
    expect(plan.turns[2]!.experiments!.absences[0]!.preview).toContain('Ankara');
    const r = await diagnoseTurn({ journal, runId: ids[2]!, model: agentModel(ships), tools: trap(), expect: ANKARA, trials: 8 });
    expect(r.verdict).toMatchObject({ kind: 'cause', arm: 'restore:window' });
    expect(r.arms.find((a) => a.id === 'restore:window')!.label).toBe('turn 1 put back (fell out of the recent window)');
  });

  it('two messages that each alone mislead: no single removal helps, both together do', async () => {
    const ships = (o: any) => (!lastUser(o).includes('Ship') ? final('Noted.') : call('createOrder', { address: text(o).includes('Izmir') ? 'Izmir' : 'Ankara' }));
    const memory = windowMemory(8);
    const { journal, ids } = await recordThread(['The old address was Izmir.', 'Izmir was the old address, yes.', 'Ship my order.'], { memory, model: agentModel(ships), system: SHOP });
    const r = await diagnoseTurn({ journal, runId: ids[2]!, model: agentModel(ships), tools: trap(), expect: ANKARA, trials: 8 });
    expect(r.elimination.shares.slice(0, 2).map((s) => [s.part, Math.round(s.blame * 100) / 100])).toEqual([['recent 1', 0.5], ['recent 2', 0.5]]);
    expect(r.arms.slice(1).every((a) => a.passed === 0)).toBe(true);
    expect(r.verdict).toMatchObject({ kind: 'joint', arms: ['remove:recent 1', 'remove:recent 2'] });
    expect(r.joint).toMatchObject({ passed: 8, judged: 8 });
  });

  it('two messages that mislead only together: either removal helps as much — they cannot be told apart', async () => {
    const ships = (o: any) => (!lastUser(o).includes('Ship') ? final('Noted.') : call('createOrder', { address: (text(o).match(/Izmir/g) ?? []).length >= 2 ? 'Izmir' : 'Ankara' }));
    const memory = windowMemory(8);
    const { journal, ids } = await recordThread(['The old address was Izmir.', 'Izmir was the old address, yes.', 'Ship my order.'], { memory, model: agentModel(ships), system: SHOP });
    const r = await diagnoseTurn({ journal, runId: ids[2]!, model: agentModel(ships), tools: trap(), expect: ANKARA, trials: 8 });
    expect(r.verdict).toMatchObject({ kind: 'indistinct', arms: ['remove:recent 1', 'remove:recent 2'] });
    expect(r.joint).toBeUndefined();
  });

  it("a tool's recorded result can be put aside: the override is the cause", async () => {
    const model = () => { const m = createMockModel(async (o: any) => {
      const results = toolResults(o);
      if (results.length === 0) return call('lookup', {}, 'l1');
      if (results.length === 1) { const a = /"address":"(\w+)"/.exec(JSON.stringify(results[0])); return call('createOrder', { address: a ? a[1] : 'unknown' }, 'c1'); }
      return final('Done.');
    }); m.modelId = 'cheap'; return m; };
    const { journal, ids } = await recordThread(['Ship my order to the address on file.'], { memory: windowMemory(4), model: model(), system: SHOP });
    const r = await diagnoseTurn({ journal, runId: ids[0]!, model: model(), tools: trap(), expect: ANKARA, overrides: [{ toolName: 'lookup', args: {}, output: { address: 'Ankara' } }], trials: 8 });
    expect(r.verdict).toMatchObject({ kind: 'cause', arm: 'override:lookup result' });
    const arm = r.arms.find((a) => a.id === 'override:lookup result')!;
    expect(arm.paths[0]!.calls.map((c) => `${c.toolName}:${c.source}`)).toEqual(['lookup:override', 'createOrder:none']);
    expect(r.arms[0]!.paths[0]!.calls.map((c) => `${c.toolName}:${c.source}`)).toEqual(['lookup:recorded', 'createOrder:recorded']);
  });

  it("the capsule takes the same override: the play is answered with it, and judged against the expectation", async () => {
    const model = () => { const m = createMockModel(async (o: any) => {
      const results = toolResults(o);
      if (results.length === 0) return call('lookup', {}, 'l1');
      if (results.length === 1) { const a = /"address":"(\w+)"/.exec(JSON.stringify(results[0])); return call('createOrder', { address: a ? a[1] : 'unknown' }, 'c1'); }
      return final('Done.');
    }); m.modelId = 'cheap'; return m; };
    const { journal, ids } = await recordThread(['Ship my order to the address on file.'], { memory: windowMemory(4), model: model() });
    const lab = studioLab({ config: { agents: { shop: { tools: trap() } } }, models: { cheap: model() } });
    const r = await lab.capsule(journal, { runId: ids[0]!, model: 'cheap', trials: 2, expect: ANKARA, overrides: [{ toolName: 'lookup', args: {}, output: { address: 'Ankara' } }] });
    expect(r.paths[0]!.calls.map((c) => `${c.toolName}:${c.source}`)).toEqual(['lookup:override', 'createOrder:none']);
    expect(r.sameAsRecorded.value).toBe(0);
    expect(r.expected).toEqual({ passRate: expect.objectContaining({ value: 1, n: 2 }), undetermined: 0, bounds: { low: expect.objectContaining({ value: 1, n: 2 }), high: expect.objectContaining({ value: 1, n: 2 }) } });
  });

  it('no play is counted twice: every verification play is a fresh model call', async () => {
    let firstSteps = 0;
    const ships = (o: any) => { if (toolResults(o).length === 0) firstSteps++; return call('createOrder', { address: text(o).includes('Izmir') ? 'Izmir' : 'Ankara' }); };
    const memory = windowMemory(4, () => '# Working Memory\naddress: Izmir');
    const { journal, ids } = await recordThread(['Ship my order.'], { memory, model: agentModel(ships), system: SHOP });
    firstSteps = 0;
    const r = await diagnoseTurn({ journal, runId: ids[0]!, model: agentModel(ships), tools: trap(), expect: ANKARA, trials: 5, eliminationTrials: 2 });
    const verification = r.arms.length * 5 + (r.joint ? 5 : 0);
    expect(r.elimination.plays).toBe(2 ** r.elimination.parts.length * 2);
    expect(r.plays).toBe(r.elimination.plays + verification);
    expect(firstSteps).toBe(r.plays);
    expect(r.arms.every((a) => a.passed + (a.judged - a.passed) + a.undetermined + a.failed === 5)).toBe(true);
  });

  it('a memory run without a layout: its memory candidates are named untestable, with the reason', async () => {
    const ships = (o: any) => {
      if (!lastUser(o).includes('Ship')) return final('Noted.');
      const m = /address is (\w+)/.exec(text(o));
      return call('createOrder', { address: m ? m[1] : 'Izmir' });
    };
    const memory = windowMemory(2);
    const { journal, ids } = await recordThread(['My address is Ankara.', 'I like tea.', 'Ship my order.'], { memory, model: agentModel(ships), system: SHOP });
    const rec: any = await journal.get(runKeys.memoryContext(ids[2]!));
    const { layout: _l, systemSpans: _s, ...legacy } = rec;
    await journal.put(runKeys.memoryContext(ids[2]!), legacy);
    const plan = await threadPlan({ journal, threadId: 't' });
    const t3 = plan.turns[2]!;
    expect(t3.layout).toMatchObject({ status: 'absent', reason: 'no-layout' });
    expect(t3.composition).toMatchObject({ labelled: false, bySource: {} });
    expect(t3.experiments!.absences).toEqual([]);
    expect(t3.experiments!.untestable.map((u) => u.candidate)).toEqual(['memory (working memory, observations, recall, recent window)', 'earlier turns missing from the input']);
    expect(t3.experiments!.untestable[0]!.reason).toMatch(/no memory layout/);
    expect(new Set(t3.experiments!.suspects.map((s) => s.source))).toEqual(new Set(['unknown']));
    const r = await diagnoseTurn({ journal, runId: ids[2]!, model: agentModel(ships), tools: trap(), expect: ANKARA, trials: 4 });
    expect(r.untestable).toHaveLength(2);
    expect(r.verdict.kind).toBe('not-found');
  });

  it('without what a right answer does, a diagnosis does not start — and no model is called', async () => {
    let calls = 0;
    const m = createMockModel(async () => { calls++; return { content: [{ type: 'text', text: 'x' }], finishReason: 'stop', usage }; });
    const { journal, ids } = await recordThread(['Ship my order.'], { memory: windowMemory(2), model: agentModel(() => final('ok')) });
    await expect(diagnoseTurn({ journal, runId: ids[0]!, model: m, expect: undefined as any })).rejects.toThrow(/needs `expect`/);
    await expect(diagnoseTurn({ journal, runId: ids[0]!, model: m, expect: {} })).rejects.toThrow(/needs `expect`/);
    await expect(diagnoseTurn({ journal, runId: 'nope', model: m, expect: ANKARA })).rejects.toThrow(/no recorded input/);
    await expect(diagnoseTurn({ journal, runId: ids[0]!, model: m, expect: ANKARA, trail: 3 } as any)).rejects.toThrow(/trail/);
    expect(calls).toBe(0);
  });
});
