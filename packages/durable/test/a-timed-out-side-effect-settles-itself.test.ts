// A timeout stops the wait, not the attempt: the effect may still land. It was journaled 'failed' at once,
// so with recover() the retry asked "done?" while the first attempt was still running, heard "no", and the
// effect ran twice (measured). The attempt now journals its own outcome when it ends; a retry waits for it.
import { describe, it, expect } from 'vitest';
import { z } from 'zod';
import { InMemoryStorage, createGnl, gnlTool, STAFF } from '../src/index.js';
import { createMockModel, toolCallResult, finalTextResult } from './mock.js';

describe('a timed-out side effect settles itself', () => {
  for (const withRecover of [false, true]) {
    it(`${withRecover ? 'with' : 'without'} recover(): the retry gets the real outcome, the effect runs once`, async () => {
      const did: string[] = [];
      const slow = gnlTool({ description: 'slow', inputSchema: z.object({}).passthrough(), execute: async (a: any) => { await new Promise((r) => setTimeout(r, 300)); did.push(a.id); return { ok: true }; } },
        { sideEffect: true, idempotencyWindow: 'run', idempotencyKey: (a: any) => a.id, ...(withRecover ? { recover: async (a: any) => (did.includes(a.id) ? { done: true as const, output: { ok: true } } : { done: false as const }) } : {}) });
      const m = createMockModel(async ({ prompt }: any) => { const n = prompt.filter((x: any) => x.role === 'tool').length; return n < 2 ? toolCallResult('slow', `c${n}`, { id: 'X' }) : finalTextResult('done'); });
      try { await createGnl({ storage: new InMemoryStorage(), agents: { a: { model: m, tools: { slow } } } } as any).run('a', { runId: 'r', prompt: 'go', caller: STAFF, timeouts: { toolMs: 50 } } as any); } catch { /* a refused retry ends the run */ }
      await new Promise((r) => setTimeout(r, 700));
      expect(did).toEqual(['X']);
    });
  }
});
