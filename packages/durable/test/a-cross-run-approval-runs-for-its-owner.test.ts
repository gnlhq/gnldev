// A cross-run call suspended for an END USER — confirm, a guard's require-approval, the taint ladder —
// recorded no owner, so the same user's approval was refused as someone else's and the effect never ran
// (measured on 0.9.x, directly and through a sub-agent). The owner is recorded by whoever first writes the
// record. Another user still cannot run it, and is told what the record is — not "already run".
import { describe, it, expect } from 'vitest';
import { z } from 'zod';
import { InMemoryStorage, createGnl, gnlTool, user } from '../src/index.js';
import { createMockModel, toolCallResult, finalTextResult } from './mock.js';

type Way = 'confirm' | 'guard' | 'taint';
async function suspendThenApprove(way: Way) {
  let given = 0; let othersSaw = '';
  const dose = gnlTool({ description: 'dose', inputSchema: z.object({}).passthrough(), execute: async () => { given++; return { given: true }; } },
    { sideEffect: true, idempotencyKey: (a: any) => a.p, idempotencyWindow: 'cross-run', ...(way === 'confirm' ? { confirm: true } : {}) } as any);
  const fetchPage = gnlTool({ description: 'f', inputSchema: z.object({}).passthrough(), execute: async () => ({ page: 'x' }) }, { sideEffect: false, untrusted: true });
  const calls: [string, object][] = way === 'taint' ? [['fetchPage', {}], ['dose', { p: 'P-1' }]] : [['dose', { p: 'P-1' }]];
  const m = createMockModel(async ({ prompt }: any) => {
    const t = prompt.filter((x: any) => x.role === 'tool'); const c = calls[t.length];
    if (!c && t.length) othersSaw = JSON.stringify(t.at(-1).content[0].output);
    return c ? toolCallResult(c[0], `c${t.length}`, c[1]) : finalTextResult('done');
  });
  const cfg = { agents: { a: { model: m, tools: { dose, fetchPage }, ...(way === 'guard' ? { guard: async (call: any) => (call.toolName === 'dose' ? { action: 'require-approval', reason: 'check' } : { action: 'allow' }) } : {}) } } };
  const limits = way === 'taint' ? { taintedSideEffects: 'suspend' } : undefined;
  const storage = new InMemoryStorage();
  const ayse = user('ayse', 'acme');
  const r1: any = await createGnl({ storage, ...cfg } as any).run('a', { runId: 'r1', prompt: 'go', caller: ayse, ...(limits ? { limits } : {}) } as any);
  await createGnl({ storage, ...cfg } as any).run('a', { runId: 'r1', prompt: 'go', caller: ayse, approvals: { [r1.interrupts[0].toolCallId]: true }, ...(limits ? { limits } : {}) } as any);
  const afterOwner = given;
  othersSaw = '';
  await createGnl({ storage, ...cfg } as any).run('a', { runId: 'r2', prompt: 'go', caller: user('bora', 'acme'), ...(limits ? { limits } : {}) } as any);
  return { afterOwner, ranForOther: given - afterOwner, othersSaw };
}

describe('a cross-run call approved by its owner runs', () => {
  for (const way of ['confirm', 'guard', 'taint'] as Way[]) {
    it(`suspended by ${way}: the owner's approval runs it once; another user does not run it`, async () => {
      const r = await suspendThenApprove(way);
      expect(r.afterOwner).toBe(1);
      expect(r.ranForOther).toBe(0);
    });
  }
  it('another user is told the record was done — and that this call did not run', async () => {
    const r = await suspendThenApprove('confirm');
    expect(r.othersSaw).toMatch(/was already done for these arguments by someone else\. This call did NOT run it/);
  });
});
