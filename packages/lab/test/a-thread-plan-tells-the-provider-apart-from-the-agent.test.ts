// The thread plan, read before anything is spent: a turn the provider refused or the network dropped is
// told apart from one the agent got wrong — by the outcome record's status and code, never its text — and
// is never offered for diagnosis; each turn's input is measured in characters by source, its first model
// step's input tokens as the provider counted them; a long thread is read a page at a time.
import { describe, it, expect } from 'vitest';
import { runDurable, runKeys } from '@gnldev/durable';
import { createMockModel } from '../../durable/test/mock.js';
import { windowMemory, agentModel, recordThread, call, final, trap, recordingTools } from './thread-fixtures.js';
import { threadPlan, diagnoseTurn } from '../src/index.js';
import { classifyTurn } from '../src/thread-diagnose.js';

const ships = () => agentModel(() => call('createOrder', { address: 'Izmir' }));
const failing = (err: Error) => { const m = createMockModel(async () => { throw err; }); m.modelId = 'cheap'; return m; };

describe('a thread plan tells the provider apart from the agent', () => {
  it('a 429 and a dropped connection are infrastructure; a failure after the model answered is the agent\'s', async () => {
    const memory = windowMemory(4);
    const { journal } = await recordThread(['Ship my order.'], { memory, model: ships() });
    const rate = Object.assign(new Error('Too many requests'), { name: 'AI_APICallError', statusCode: 429 });
    const reset = Object.assign(new Error('socket hang up'), { code: 'ECONNRESET' });
    const base = { journal, agentName: 'shop', memory, threadId: 't', tools: recordingTools() };
    await runDurable({ ...base, runId: 'r2', prompt: 'Again?', model: failing(rate) } as any).catch(() => undefined);
    await runDurable({ ...base, runId: 'r3', prompt: 'Again??', model: failing(reset) } as any).catch(() => undefined);
    await runDurable({ ...base, runId: 'r4', prompt: 'And now?', model: ships() } as any);
    // r4 answered and then broke (a tool that threw past its retries, a limit): its outcome says so
    await journal.put(runKeys.outcome('r4'), { status: 'failed', at: Date.now(), error: 'the refund service refused', errorName: 'ToolExecutionError' });
    const plan = await threadPlan({ journal, threadId: 't', expect: { calls: [{ toolName: 'createOrder', args: { address: 'Ankara' } }] } });
    expect(plan.turns.map((t) => [t.turn, t.runId, t.class, t.diagnosable])).toEqual([
      [1, 'r1', 'completed', true], [2, 'r2', 'infrastructure', false], [3, 'r3', 'infrastructure', false], [4, 'r4', 'failed', true],
    ]);
    expect(plan.turns[1]).toMatchObject({ classReason: 'the provider refused the request (429)', error: { status: 429, name: 'AI_APICallError' }, modelSteps: 0 });
    expect(plan.turns[1]!.whyNot).toMatch(/nothing in it says how the agent behaves/);
    expect(plan.turns[2]).toMatchObject({ classReason: 'the connection failed (ECONNRESET)', error: { code: 'ECONNRESET' } });
    expect(plan.turns[3]).toMatchObject({ classReason: 'ToolExecutionError', error: { message: 'the refund service refused' } });
    // judged against what a right answer does: the turns that ran are marked, the infrastructure ones are not
    expect(plan.turns.map((t) => t.expected?.pass)).toEqual([false, undefined, undefined, false]);
    // an infrastructure turn is refused before a model is called
    await expect(diagnoseTurn({ journal, runId: 'r2', model: ships(), tools: trap(), expect: { calls: [{ toolName: 'createOrder' }] } })).rejects.toThrow(/before the model could be asked/);
  });

  it('the policy, case by case: status first, then code, then a timeout, then no model step', () => {
    const f = (o: object, modelSteps = 1) => classifyTurn({ status: 'failed', modelSteps }, o).class;
    expect(f({ errorStatus: 503 })).toBe('infrastructure');
    expect(f({ errorStatus: 400 })).toBe('failed');
    expect(f({ errorCode: 'UND_ERR_SOCKET' })).toBe('infrastructure');
    expect(f({ errorName: 'TimeoutError' })).toBe('infrastructure');
    expect(f({ errorName: 'TypeError' }, 0)).toBe('infrastructure');
    expect(f({ errorName: 'TypeError' }, 2)).toBe('failed');
    expect(classifyTurn({ status: 'suspended', modelSteps: 1 }, undefined).class).toBe('suspended');
  });

  it('each turn: its first step\'s input tokens, its input by source in characters, what diagnosing it costs', async () => {
    const memory = windowMemory(4, () => '# Working Memory\naddress: Izmir');
    const { journal } = await recordThread(['Hello.', 'Ship my order.'], { memory, model: agentModel((o) => (JSON.stringify(o.prompt).includes('Ship') ? call('createOrder', { address: 'Izmir' }) : final('Hi.'))), system: 'You are a shop agent.' });
    const plan = await threadPlan({ journal, threadId: 't', modelId: 'cheap', pricing: { cheap: { inputPer1M: 1, outputPer1M: 4 } }, trials: 10 });
    const t2 = plan.turns[1]!;
    expect(t2.firstStepInputTokens).toBe(100);
    expect(t2.composition).toMatchObject({ unit: 'characters', labelled: true });
    const by = t2.composition!.bySource;
    expect(by.system).toBe('You are a shop agent.'.length + 2); // the caller's prompt and the blank line that joins the working memory
    expect(by.wm).toBe('# Working Memory\naddress: Izmir'.length);
    expect(by.recent).toBeGreaterThan(0);
    expect(by.turn).toBe(JSON.stringify({ role: 'user', content: 'Ship my order.' }).length);
    expect(Object.values(by).reduce((a, b) => a + b!, 0)).toBe(t2.composition!.total);
    const x = t2.experiments!;
    expect(x.suspects.map((s) => [s.id, s.intervention])).toEqual([['system 1', 'remove'], ['working memory', 'wm-remove'], ['recent 1', 'remove'], ['createOrder result', 'hide-result']]);
    expect(x.plan).toMatchObject({ trials: 10, underpowered: true, eliminationPlays: 2 ** 4 * 2 });
    expect(x.plan.estimatedCostUsd).toBeCloseTo(x.plan.totalPlays * (200 / 1e6 + 80 / 1e6), 12);
    // the hypotheses the person will bring, named only, are arms the plan counts
    const withHyp = (await threadPlan({ journal, threadId: 't', trials: 10, hypotheses: { workingMemory: true, overrides: ['lookup'] } })).turns[1]!.experiments!;
    expect(withHyp.plan.arms).toBe(x.plan.arms + 2);
    expect(withHyp.suspects.find((s) => s.kind === 'wm')!.intervention).toBe('wm-replace');
  });

  it('a long thread is read a page at a time, at most 50 turns', async () => {
    const memory = windowMemory(2);
    const { journal } = await recordThread(Array.from({ length: 7 }, (_, i) => `message ${i + 1}`), { memory, model: agentModel(() => final('ok')) });
    const p1 = await threadPlan({ journal, threadId: 't', limit: 3 });
    expect([p1.total, p1.offset, p1.turns.map((t) => t.turn), p1.nextOffset]).toEqual([7, 0, [1, 2, 3], 3]);
    const p3 = await threadPlan({ journal, threadId: 't', offset: 6, limit: 3 });
    expect([p3.turns.map((t) => t.turn), p3.nextOffset]).toEqual([[7], undefined]);
    // turn 7's window holds turn 6 alone: turns 4 and 5 are the latest that fell out (at most three are put back)
    expect(p3.turns[0]!.experiments!.absences[0]!.turns).toEqual([3, 4, 5]);
    const capped = await threadPlan({ journal, threadId: 't', limit: 500 });
    expect(capped.turns).toHaveLength(7);
    await expect(threadPlan({ journal, threadId: 't', offset: -1 })).rejects.toThrow(RangeError);
    expect((await threadPlan({ journal, threadId: 'nobody' })).turns).toEqual([]);
  });
});
