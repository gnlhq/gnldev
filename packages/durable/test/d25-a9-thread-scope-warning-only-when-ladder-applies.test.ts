// d25 A9 (saga/KARAR-6, option A): the "'<tool>' asked for thread-scoped sideEffectDuplicates scope but this call
// has NO threadId — falling back to run scope" warning is printed only for a call the duplicate ladder actually
// applies to. Reported: `preset: 'assistant'` asks for thread scope; a READ tool (`sideEffect: false`) called
// without a threadId printed the warning although the ladder never runs for it — noise that hides real warnings.
//
// Option A moves the scope fall-back (and its warning) after "does the ladder apply here": side-effecting tool,
// a window/mode the ladder covers, action not 'off'. The decision names the siblings: a side-effecting tool in the
// 'cross-run' window (no ladder) also stops warning. The negative control: a side-effecting tool the ladder DOES
// cover still warns — the warning is right there.
//
// The warning is printed once per tool per process, so every case uses its own tool name.
import { describe, it, expect, vi, afterEach } from 'vitest';
import { z } from 'zod';
import { InMemoryJournal } from '../src/journal.js';
import { createGnl } from '../src/registry.js';
import { createMockModel, countToolResults, toolCallResult, finalTextResult } from './mock.js';

afterEach(() => vi.restoreAllMocks());

const once = (toolName: string, args: unknown) => createMockModel(async ({ prompt }: any) =>
  countToolResults(prompt) === 0 ? toolCallResult(toolName, 'c' + Math.random().toString(36).slice(2), args) : finalTextResult('done'));

async function warningsFor(toolName: string, toolDef: Record<string, unknown>, cfg: { preset?: 'assistant' | 'critical'; limits?: unknown } = { preset: 'assistant' }) {
  const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
  const ran: number[] = [];
  const gnl = createGnl({
    journal: new InMemoryJournal(),
    ...(cfg.preset ? { preset: cfg.preset } : {}),
    agents: { r: { model: once(toolName, { u: 1 }), tools: { [toolName]: { inputSchema: z.any(), execute: async () => { ran.push(1); return { ok: true }; }, ...toolDef } } } as any },
  } as any);
  // No threadId on purpose.
  await gnl.run('r', { runId: `w-${toolName}`, resourceId: 'u', prompt: 'go', ...(cfg.limits ? { limits: cfg.limits } : {}) } as any);
  const lines = warn.mock.calls.map((c) => c.map(String).join(' ')).filter((l) => l.includes(`'${toolName}'`) && l.includes('thread-scoped') && l.includes('sideEffectDuplicates'));
  return { lines, ran: ran.length };
}

describe('A9: no thread-scope warning where the duplicate ladder does not apply', () => {
  it('reported — a read tool (sideEffect: false) under preset assistant', async () => {
    const o = await warningsFor('myRentals', { sideEffect: false });
    expect(o.ran).toBe(1);
    expect(o.lines).toEqual([]);
  });
  it('sibling — the same read tool under preset critical', async () => {
    const o = await warningsFor('listInvoices', { sideEffect: false }, { preset: 'critical' });
    expect(o.lines).toEqual([]);
  });
  it("sibling (named by the decision) — a side-effecting tool in the 'cross-run' window", async () => {
    const o = await warningsFor('bookOnce', { sideEffect: true, idempotency: 'args', idempotencyWindow: 'cross-run' });
    expect(o.ran).toBe(1);
    expect(o.lines).toEqual([]);
  });
  it("sibling — the ladder switched off (action 'off', scope 'thread'), no preset", async () => {
    const o = await warningsFor('sendNote', { sideEffect: true }, { limits: { sideEffectDuplicates: { action: 'off', scope: 'thread' } } });
    expect(o.ran).toBe(1);
    expect(o.lines).toEqual([]);
  });
});

describe('A9 negative control: the warning stays where the ladder applies', () => {
  it('a side-effecting tool under preset assistant, no threadId: warned once', async () => {
    const o = await warningsFor('chargeCard', { sideEffect: true });
    expect(o.lines.length).toBe(1);
  });
  it("a side-effecting tool, explicit { action: 'suspend', scope: 'thread' }, no preset: warned once", async () => {
    const o = await warningsFor('transferMoney', { sideEffect: true }, { limits: { sideEffectDuplicates: { action: 'suspend', scope: 'thread' } } });
    expect(o.lines.length).toBe(1);
  });
});
