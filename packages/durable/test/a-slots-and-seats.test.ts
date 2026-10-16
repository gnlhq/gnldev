// A slot under limits.maxConcurrency held by a process that died is freed when stale; a cancelled
// request stops waiting for one; and a timed-out attempt keeps its maxToolCalls seat until it ends
// (measured with each rule off: waits forever, waits after the cancel, two effects under a limit of 1).
import { it, expect } from 'vitest';
import { z } from 'zod';
import { InMemoryStorage, createGnl, gnlTool, STAFF, runKeys } from '../src/index.js';
import { createMockModel, toolCallResult, finalTextResult } from './mock.js';
const twoStep = (calls: { name: string; args: object }[]) => createMockModel(async ({ prompt }: any) => { const n = prompt.filter((m: any) => m.role === 'tool').length; const c = calls[n]; return c ? toolCallResult(c.name, `c${n}`, c.args) : finalTextResult('done'); });
it('concurrency slots and seats', async () => {
  const out: string[] = [];
  // R1 a slot left by a dead process (stamped an hour ago), cap 1: does the next call run?
  {
    let ran = 0;
    const storage = new InMemoryStorage();
    await (storage.runs as any).put(runKeys.proc('r', 'limits-slots'), { 'dead#x': Date.now() - 3_600_000 });
    const t = gnlTool({ description: 't', inputSchema: z.object({}).passthrough(), execute: async () => { ran++; return { ok: true }; } }, { sideEffect: false } as any);
    const p = createGnl({ storage, agents: { a: { model: twoStep([{ name: 't', args: {} }]), tools: { t } } } } as any).run('a', { runId: 'r', prompt: 'go', caller: STAFF, limits: { maxConcurrency: 1 } } as any);
    const res = await Promise.race([p.then(() => 'finished'), new Promise((r) => setTimeout(() => r('still waiting after 3s'), 3000))]);
    out.push(`R1 stale slot, cap 1: ${res}, ran ${ran}`);
  }
  // R2 waiting for a slot held by a live call; the request is cancelled meanwhile.
  {
    const storage = new InMemoryStorage();
    await (storage.runs as any).put(runKeys.proc('r', 'limits-slots'), { 'live#x': Date.now() + 3_600_000 });
    const ctrl = new AbortController();
    const t = gnlTool({ description: 't', inputSchema: z.object({}).passthrough(), execute: async () => ({ ok: true }) }, { sideEffect: false } as any);
    setTimeout(() => ctrl.abort(), 200);
    const p = createGnl({ storage, agents: { a: { model: twoStep([{ name: 't', args: {} }]), tools: { t } } } } as any).run('a', { runId: 'r', prompt: 'go', caller: STAFF, abortSignal: ctrl.signal, limits: { maxConcurrency: 1 } } as any).then(() => 'finished', (e: any) => `ended: ${String(e?.name ?? e).slice(0, 40)}`);
    const res = await Promise.race([p, new Promise((r) => setTimeout(() => r('still waiting 3s after the cancel'), 3200))]);
    out.push(`R2 cancel while waiting: ${res}`);
  }
  // R3 maxToolCalls 1: call A times out but keeps running; the model then calls B.
  {
    const did: string[] = [];
    const slow = gnlTool({ description: 's', inputSchema: z.object({}).passthrough(), execute: async (a: any) => { await new Promise((r) => setTimeout(r, 300)); did.push(a.id); return { ok: true }; } }, { sideEffect: true, idempotencyWindow: 'run', idempotencyKey: (a: any) => a.id } as any);
    try { await createGnl({ storage: new InMemoryStorage(), agents: { a: { model: twoStep([{ name: 'slow', args: { id: 'A' } }, { name: 'slow', args: { id: 'B' } }]), tools: { slow } } } } as any)
      .run('a', { runId: 'r', prompt: 'go', caller: STAFF, timeouts: { toolMs: 50 }, limits: { maxToolCalls: 1, sideEffectDuplicates: 'warn' } } as any); } catch { /* limit */ }
    await new Promise((r) => setTimeout(r, 800));
    out.push(`R3 limit 1, A timed out and still running, then B: effects ${JSON.stringify(did)}`);
  }
  expect(out).toEqual([
    'R1 stale slot, cap 1: finished, ran 1',
    // A run's abortSignal cancels the RUN (design decision D2): the waiting run ends canceled.
    'R2 cancel while waiting: ended: RunCanceledError',
    'R3 limit 1, A timed out and still running, then B: effects ["A"]',
  ]);
}, 60_000);
