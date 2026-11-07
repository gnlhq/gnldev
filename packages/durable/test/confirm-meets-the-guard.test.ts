// d25 U8: a tool with `confirm` meets the guard — before its question and again after a human's yes. Its
// question used to come first, and the approved call took the suspended-record arm, never the guard's: a
// deny-everything guard was asked 0 times and the call ran on the yes (test/d25-u8-confirm-before-guard).
// These are the rule's other sides: what the guard refuses AFTER the question (its policy changed, the run was
// tainted meanwhile) does not run on the yes; what it allows runs once; and its `require-approval` is the same
// one question as `confirm`, not two.
import { describe, it, expect } from 'vitest';
import { stepCountIs } from 'ai';
import { InMemoryJournal, runKeys } from '../src/journal.js';
import { runDurable } from '../src/run.js';
import { createMockModel, countToolResults, toolCallResult, finalTextResult } from './mock.js';

const model = () => createMockModel(async ({ prompt }: any) => countToolResults(prompt) === 0 ? toolCallResult('payFee', 'c1', { shipment: 's-1' }) : finalTextResult('done'));

async function askThenAnswer(guard: (a: any) => Promise<any>, answer = true) {
  const j = new InMemoryJournal(); let bodyRuns = 0;
  const tools = { payFee: { sideEffect: true, confirm: true, execute: async () => { bodyRuns++; return { ok: 1 }; } } };
  const args = { runId: 'u8', journal: j, model: model(), tools, guard, prompt: 'x', stopWhen: stepCountIs(4) } as any;
  await runDurable(args);
  const asked = await j.get<any>(runKeys.tool('u8', 'c1'));
  await runDurable({ ...args, model: model(), approvals: { c1: answer } });
  const after = await j.get<any>(runKeys.tool('u8', 'c1'));
  return { asked, after, bodyRuns };
}

describe('confirm meets the guard (d25 U8)', () => {
  it('a guard that refuses after the question: the yes does not run it', async () => {
    let calls = 0;
    const o = await askThenAnswer(async () => (++calls === 1 ? { action: 'allow' } : { action: 'deny', reason: 'shipment changed hands' }));
    expect(o.asked?.status).toBe('suspended');
    expect(o.asked?.output?.__gnl_suspend?.kind).toBe('confirm');
    expect(calls).toBe(2);
    expect(o.after).toMatchObject({ status: 'denied', output: { __denied: true, reason: 'shipment changed hands' } });
    expect(o.bodyRuns).toBe(0);
  });

  it('a guard that allows: asked before and after, the yes runs it once', async () => {
    let calls = 0;
    const o = await askThenAnswer(async () => { calls++; return { action: 'allow' }; });
    expect(o.asked?.status).toBe('suspended');
    expect(calls).toBe(2);
    expect(o.after?.status).toBe('succeeded');
    expect(o.bodyRuns).toBe(1);
  });

  it("the guard's require-approval and confirm are one question; its yes runs it once", async () => {
    let calls = 0;
    const o = await askThenAnswer(async () => { calls++; return { action: 'require-approval', reason: 'over the limit' }; });
    expect(o.asked?.output?.__gnl_suspend?.kind).toBe('confirm');
    expect(o.after?.status).toBe('succeeded');
    expect(o.bodyRuns).toBe(1);
  });

  it('a no stays a no, the guard is not asked to overrule it', async () => {
    let calls = 0;
    const o = await askThenAnswer(async () => { calls++; return { action: 'allow' }; }, false);
    expect(o.after?.status).toBe('denied');
    expect(calls).toBe(1);
    expect(o.bodyRuns).toBe(0);
  });
});
