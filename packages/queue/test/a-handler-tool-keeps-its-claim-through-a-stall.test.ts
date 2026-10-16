// A side-effect tool a queue handler calls keeps its claim while the worker's process stalls.
//
// The handler's ctx is made by the worker, not the engine: the tool's claim was judged by its age, and a
// holder whose event loop stalled past the claim TTL could not renew it — a twin of the call ran the
// effect beside it (audit 2026-10-16). The claim is now this process's own while its attempt is held.
import { describe, it, expect, vi, beforeAll } from 'vitest';
import { InMemoryStorage, durableTool, RunBusyError } from '@gnldev/durable';
import { enqueue, createWorker } from '../src/index.js';

beforeAll(() => { vi.spyOn(console, 'warn').mockImplementation(() => {}); });
const TTL = 150;
const gate = () => { let open!: () => void; const p = new Promise<void>((r) => { open = r; }); return { p, open }; };
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const stall = (ms: number) => { const end = Date.now() + ms; while (Date.now() < end) { /* blocked */ } };

describe('a tool in a queue handler, its worker stalled past the claim TTL', () => {
  it('a twin of the call is busy: the effect runs once', async () => {
    const storage = new InMemoryStorage();
    let executions = 0;
    const inBody = gate();
    const finish = gate();
    const tool = {
      sideEffect: true, claimTtlMs: TTL, recover: async () => ({ done: false as const }),
      execute: async () => { executions++; inBody.open(); await finish.p; return { sent: executions }; },
    };
    let runId = '';
    const worker = createWorker(storage, {
      send: async (_p: any, ctx: any) => { runId = ctx.runId; return durableTool(tool as any, { journal: ctx.journal, runId: ctx.runId } as any, 'send').execute!({}, { toolCallId: 'c1' } as any); },
    }, { pollMs: 5 });
    await enqueue(storage.work, 'send', {}, { id: 'stall-1' } as any);
    const drained = worker.runOnce();
    await inBody.p;
    stall(TTL * 3);
    const twin = durableTool(tool as any, { journal: storage.runs, runId } as any, 'send').execute!({}, { toolCallId: 'c1' } as any).then((v) => v, (e) => e);
    await Promise.race([twin, sleep(TTL * 2)]);
    expect(executions).toBe(1);
    finish.open();
    expect(await twin).toBeInstanceOf(RunBusyError);
    await drained;
    expect(executions).toBe(1);
  });
}, 30_000);
