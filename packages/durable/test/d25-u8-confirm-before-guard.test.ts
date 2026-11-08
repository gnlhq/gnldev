// d25 U8 — a tool with `confirm` asks the human BEFORE the guard (and before the tool body, where an ownership
// check normally lives) can refuse. A guard that would deny never gets to: the question is asked first.
// Red = claim holds (the first outcome is a question, not a denial).
import { describe, it, expect } from 'vitest';
import { stepCountIs } from 'ai';
import { InMemoryJournal, runKeys } from '../src/journal.js';
import { runDurable } from '../src/run.js';
import { mintCallId } from '../src/call-identity.js';
import { createMockModel, countToolResults, toolCallResult, finalTextResult } from './mock.js';

const model = () => createMockModel(async ({ prompt }: any) => countToolResults(prompt) === 0 ? toolCallResult('payFee', 'c1', { shipment: 's-not-mine' }) : finalTextResult('done'));
const c1 = (run: string) => mintCallId('c1', run, 0, 0); // the call's id once it entered GNL
const denyAll = async () => ({ action: 'deny' as const, reason: 'not your shipment' });

describe('U8 confirm vs guard vs body ordering', () => {
  it('guard says deny, tool has confirm: the human is still asked first', async () => {
    const j = new InMemoryJournal(); let bodyRuns = 0;
    const tools = { payFee: { sideEffect: true, confirm: { reason: (a: any) => `29.90 TL will be charged for ${a.shipment}` }, execute: async () => { bodyRuns++; return { ok: 1 }; } } };
    await runDurable({ runId: 'u8a', journal: j, model: model(), tools, guard: denyAll, prompt: 'x', stopWhen: stepCountIs(4) } as any);
    const rec = await j.get<any>(runKeys.tool('u8a', c1('u8a')));
    console.log('confirm + deny-guard: first status =', rec?.status, '| body ran =', bodyRuns);
    expect(rec?.status).toBe('denied');     // red => the question came first
  });
  it('control: same guard, no confirm → denied at once', async () => {
    const j = new InMemoryJournal();
    const tools = { payFee: { sideEffect: true, execute: async () => ({ ok: 1 }) } };
    await runDurable({ runId: 'u8b', journal: j, model: model(), tools, guard: denyAll, prompt: 'x', stopWhen: stepCountIs(4) } as any);
    expect((await j.get<any>(runKeys.tool('u8b', c1('u8b'))))?.status).toBe('denied');
  });
  it('and the guard is consulted only AFTER the human approved', async () => {
    const j = new InMemoryJournal(); let guardCalls = 0; let bodyRuns = 0;
    const tools = { payFee: { sideEffect: true, confirm: true, execute: async () => { bodyRuns++; return { ok: 1 }; } } };
    const guard = async () => { guardCalls++; return { action: 'deny' as const, reason: 'no' }; };
    await runDurable({ runId: 'u8c', journal: j, model: model(), tools, guard, prompt: 'x', stopWhen: stepCountIs(4) } as any);
    const callsBeforeApproval = guardCalls;
    await runDurable({ runId: 'u8c', journal: j, model: model(), tools, guard, prompt: 'x', stopWhen: stepCountIs(4), approvals: { c1: true } } as any);
    const rec = await j.get<any>(runKeys.tool('u8c', c1('u8c')));
    console.log('guard calls before approval =', callsBeforeApproval, ', after approval =', guardCalls, '| record after approval =', rec?.status, '| body ran =', bodyRuns);
    expect(callsBeforeApproval).toBeGreaterThan(0); // red => guard not consulted until a human said yes
  });
  it('contrast: a PRE-supplied approval on a fresh call does reach the guard (so the guard is skipped only in the usual ask-then-approve flow)', async () => {
    const j = new InMemoryJournal(); let guardCalls = 0;
    const tools = { payFee: { sideEffect: true, confirm: true, execute: async () => ({ ok: 1 }) } };
    const guard = async () => { guardCalls++; return { action: 'deny' as const, reason: 'no' }; };
    await runDurable({ runId: 'u8d', journal: j, model: model(), tools, guard, prompt: 'x', stopWhen: stepCountIs(4), approvals: { c1: true } } as any);
    console.log('pre-supplied approval: guard calls =', guardCalls, '| record =', (await j.get<any>(runKeys.tool('u8d', c1('u8d'))))?.status);
    expect(guardCalls).toBeGreaterThan(0);
  });
});
