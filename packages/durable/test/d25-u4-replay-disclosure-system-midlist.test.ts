// d25 U4 — `replayDisclosure:'explain'` (default of preset 'assistant') appends a `system` message AFTER the
// tool result; providers that refuse a mid-list system message (NVIDIA/Mistral, 400) fail. And a config-level
// 'silent' is overridden on the preset path.
// Red = claim holds.
import { describe, it, expect, vi } from 'vitest';
import { InMemoryJournal } from '../src/journal.js';
import { createGnl } from '../src/registry.js';
import { createMockModel, countToolResults, toolCallResult, finalTextResult } from './mock.js';

async function scenario(configExtra: Record<string, unknown>, callExtra: Record<string, unknown> = {}) {
  const prompts: any[][] = [];
  const model = createMockModel(async ({ prompt }: any) => {
    prompts.push(prompt);
    const roles = prompt.map((m: any) => m.role);
    const lastTool = roles.lastIndexOf('tool');
    if (lastTool >= 0 && roles.slice(lastTool + 1).includes('system')) throw new Error('400 Bad Request: system message must be first (mid-list system rejected)');
    return countToolResults(prompt.slice(roles.lastIndexOf('user'))) === 0 ? toolCallResult('charge', 'c' + Math.random().toString(36).slice(2), { order: 'A1' }) : finalTextResult('done');
  });
  const gnl = createGnl({
    journal: new InMemoryJournal(), preset: 'assistant', ...configExtra,
    agents: { shop: { model, tools: { charge: { sideEffect: true, idempotencyKey: (a: any) => a.order, idempotencyWindow: 'cross-run', execute: async () => ({ ok: 1 }) } } } as any },
  } as any);
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  await gnl.run('shop', { runId: 'r1', threadId: 'T', resourceId: 'u', prompt: 'pay A1' } as any);
  prompts.length = 0;
  let err: any;
  try { await gnl.run('shop', { runId: 'r2', threadId: 'T2', resourceId: 'u', prompt: 'pay A1 again', ...callExtra } as any); } catch (e) { err = e; }
  const midSystem = prompts.some((p) => { const r = p.map((m: any) => m.role); const t = r.lastIndexOf('tool'); return t >= 0 && r.slice(t + 1).includes('system'); });
  return { err, midSystem, calls: prompts.length };
}

describe('U4 replayDisclosure', () => {
  it("assistant preset default ('explain'): a replayed result is followed by a mid-list system message", async () => {
    const o = await scenario({});
    console.log('default assistant: midSystem =', o.midSystem, 'err =', o.err?.message?.slice(0, 70));
    expect(o.midSystem).toBe(false);          // red = claim holds
  });
  it("config replayDisclosure:'silent' on preset 'assistant' is ignored", async () => {
    const o = await scenario({ replayDisclosure: 'silent' });
    console.log("config silent: midSystem =", o.midSystem, 'err =', o.err?.message?.slice(0, 70));
    expect(o.midSystem).toBe(false);          // red = config silent has no effect
  });
  it("per-call replayDisclosure:'silent' works (the only working off-switch)", async () => {
    const o = await scenario({}, { replayDisclosure: 'silent' });
    console.log("per-call silent: midSystem =", o.midSystem);
    expect(o.midSystem).toBe(false);
  });
  it("preset 'headless' (no preset-disclosure) never adds it", async () => {
    const o = await scenario({ preset: 'headless' });
    console.log("headless: midSystem =", o.midSystem);
    expect(o.midSystem).toBe(false);
  });
});

describe('U4 fix: the note is still delivered, at the head of the prompt, beside the agent\'s own system text', () => {
  it("default 'explain': the head system carries the agent's instructions AND the [gnl] note; nothing sits after a tool result", async () => {
    const prompts: any[][] = [];
    const model = createMockModel(async ({ prompt }: any) => {
      prompts.push(prompt);
      const roles = prompt.map((m: any) => m.role);
      return countToolResults(prompt.slice(roles.lastIndexOf('user'))) === 0 ? toolCallResult('charge', 'c' + Math.random().toString(36).slice(2), { order: 'A1' }) : finalTextResult('done');
    });
    const gnl = createGnl({
      journal: new InMemoryJournal(), preset: 'assistant',
      agents: { shop: { model, system: 'You are the shop assistant.', tools: { charge: { sideEffect: true, idempotencyKey: (a: any) => a.order, idempotencyWindow: 'cross-run', execute: async () => ({ ok: 1 }) } } } as any },
    } as any);
    await gnl.run('shop', { runId: 'n1', threadId: 'T', resourceId: 'u', prompt: 'pay A1' } as any);
    prompts.length = 0;
    await gnl.run('shop', { runId: 'n2', threadId: 'T2', resourceId: 'u', prompt: 'pay A1 again' } as any);
    const last = prompts[prompts.length - 1]!;
    const head = last.filter((m: any, i: number) => m.role === 'system' && i === 0 || (m.role === 'system' && last.slice(0, i).every((x: any) => x.role === 'system')));
    const headText = head.map((m: any) => (typeof m.content === 'string' ? m.content : JSON.stringify(m.content))).join('\n');
    expect(headText).toContain('You are the shop assistant.');
    expect(headText).toContain('[gnl]');
    const roles = last.map((m: any) => m.role);
    expect(roles.slice(roles.lastIndexOf('tool') + 1)).not.toContain('system');
  });
});
