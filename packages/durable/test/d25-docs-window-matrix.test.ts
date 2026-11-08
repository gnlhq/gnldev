// Measurement behind the exactly-once page's "what a repeat in a NEW message does" table (d25 docs).
// Prints, per window x profile, how many times the tool ran and whether a person was asked.
import { describe, it, expect, vi } from 'vitest';
import { z } from 'zod';
import { InMemoryJournal } from '../src/journal.js';
import { createGnl } from '../src/registry.js';
import { createMockModel, countToolResults, toolCallResult, finalTextResult } from './mock.js';

const once = createMockModel(async ({ prompt }: any) =>
  countToolResults(prompt) === 0 ? toolCallResult('pay', 'c' + Math.random().toString(36).slice(2), { ref: 'INV-1' }) : finalTextResult('done'));

async function cell(preset: string | undefined, window: 'run' | 'thread' | 'cross-run', mode: 'key' | 'args' = 'key') {
  let ran = 0;
  const journal = new InMemoryJournal();
  const tool: any = { sideEffect: true, inputSchema: z.any(), execute: async () => { ran++; return { ok: true }; } };
  if (mode === 'key') { tool.idempotencyKey = (i: any) => `pay:${i.ref}`; tool.idempotencyWindow = window; }
  else tool.idempotency = 'args';
  const gnl = createGnl({ journal, ...(preset ? { preset } : {}), agents: { a: { model: once, tools: { pay: tool } } } } as any);
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  try { await gnl.run('a', { runId: 'm1', threadId: 'T', resourceId: 'u', prompt: 'pay' } as any); } catch (e: any) { return { first: 'REFUSED: ' + String(e?.message ?? e).slice(0, 90) }; }
  const r2: any = await gnl.run('a', { runId: 'm2', threadId: 'T', resourceId: 'u', prompt: 'pay' } as any).catch((e: any) => ({ err: String(e?.message ?? e).slice(0, 60) }));
  return { ran, asked: (r2.interrupts ?? []).length, err: r2.err };
}
describe('window x profile — the table on the exactly-once page', () => {
  it('thread / cross-run answer from the journal under every profile; run asks (assistant, critical), refuses (headless), runs again (none)', async () => {
    for (const preset of [undefined, 'assistant', 'critical', 'headless']) {
      for (const w of ['thread', 'cross-run'] as const) expect(await cell(preset, w), `${preset}/${w}`).toEqual({ ran: 1, asked: 0, err: undefined });
    }
    expect(await cell(undefined, 'run')).toEqual({ ran: 2, asked: 0, err: undefined });
    expect(await cell('assistant', 'run')).toEqual({ ran: 1, asked: 1, err: undefined });
    expect(await cell('critical', 'run')).toEqual({ ran: 1, asked: 1, err: undefined });
    const h = await cell('headless', 'run');
    expect(h.ran).toBe(1); expect(h.asked).toBe(0); expect(h.err).toMatch(/already succeeded/);
    expect(await cell(undefined, 'run', 'args')).toEqual({ ran: 2, asked: 0, err: undefined });
    expect(await cell('assistant', 'run', 'args')).toEqual({ ran: 1, asked: 1, err: undefined });
    // critical refuses a side-effect tool with no recover()/idempotencyKey before the run starts
    expect((await cell('critical', 'run', 'args') as any).first).toMatch(/strict-critical/);
  });
});
