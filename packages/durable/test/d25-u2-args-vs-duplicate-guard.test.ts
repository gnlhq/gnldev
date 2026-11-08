// d25 U2 — `idempotency:'args'` (window 'run', the default) skips the sideEffectDuplicates ladder that
// the 'critical'/'assistant' presets rely on for "every repeat is a human question".
// Scenario: one conversation, two user messages (two runs), the model issues the same transfer twice.
// Red = claim holds (second transfer ran silently).
import { describe, it, expect, vi } from 'vitest';
import { InMemoryJournal } from '../src/journal.js';
import { createGnl } from '../src/registry.js';
import { createMockModel, countToolResults, toolCallResult, finalTextResult } from './mock.js';

const transferModel = () => createMockModel(async ({ prompt }: any) =>
  countToolResults(prompt) === 0 ? toolCallResult('transfer', 'c' + Math.random().toString(36).slice(2), { to: 'B', amount: 100 }) : finalTextResult('done'));

async function twoMessages(preset: 'critical' | 'assistant', toolDecl: Record<string, unknown>) {
  const ran: number[] = [];
  const gnl = createGnl({
    journal: new InMemoryJournal(),
    preset,
    agents: { bank: { model: transferModel(),
      tools: { transfer: { sideEffect: true, effectClass: 'transactional', ...toolDecl, execute: async () => { ran.push(1); return { ok: true }; } } } } as any },
  } as any);
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  const r1 = await gnl.run('bank', { runId: 'm1', threadId: 'T', resourceId: 'u', prompt: 'B hesabına 100 TL gönder' } as any);
  let r2: any, err: any;
  try { r2 = await gnl.run('bank', { runId: 'm2', threadId: 'T', resourceId: 'u', prompt: 'B hesabına 100 TL gönder' } as any); } catch (e) { err = e; }
  return { ran: ran.length, r1, r2, err };
}

describe('U2: duplicate guard vs idempotency:"args"', () => {
  it('control: critical + NO idempotency (recover declared) → second identical transfer is NOT silently run', async () => {
    const o = await twoMessages('critical', { recover: async () => ({ found: false }) });
    console.log('control critical/call  executions =', o.ran, 'r2.status =', o.r2?.status, 'err =', o.err?.message?.slice(0, 120));
    expect(o.ran).toBe(1);
  });
  it("critical + bare idempotency:'args' is REFUSED at run start (strict-critical wants recover or idempotencyKey)", async () => {
    await expect(twoMessages('critical', { idempotency: 'args' })).rejects.toThrow(/strict-critical/);
  });
  it("claim: critical + idempotency:'args' + recover → second identical transfer (new message) runs silently", async () => {
    const o = await twoMessages('critical', { idempotency: 'args', recover: async () => ({ found: false }) });
    console.log("critical/args executions =", o.ran, 'r2.status =', o.r2?.status, 'err =', o.err?.message?.slice(0, 160));
    expect(o.ran).toBe(1);   // red => claim holds
  });
  it("claim: assistant + idempotency:'args' → same", async () => {
    const o = await twoMessages('assistant', { idempotency: 'args' });
    console.log("assistant/args executions =", o.ran, 'r2.status =', o.r2?.status, 'err =', o.err?.message?.slice(0, 160));
    expect(o.ran).toBe(1);
  });
  it("claim: critical + idempotencyKey (window 'run', as the docs' example without cross-run) → silent second transfer", async () => {
    const o = await twoMessages('critical', { idempotencyKey: (a: any) => `${a.to}:${a.amount}`, idempotencyWindow: 'run' });
    console.log("critical/key+run executions =", o.ran);
    expect(o.ran).toBe(1);
  });
  it("remedy: idempotencyKey + idempotencyWindow:'thread' → once", async () => {
    const o = await twoMessages('critical', { idempotencyKey: (a: any) => `${a.to}:${a.amount}`, idempotencyWindow: 'thread' });
    console.log("critical/args+thread executions =", o.ran);
    expect(o.ran).toBe(1);
  });
});
