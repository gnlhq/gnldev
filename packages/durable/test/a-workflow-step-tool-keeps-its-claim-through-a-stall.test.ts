// A side-effect tool a workflow step calls keeps its claim while the process stalls.
//
// The step's ctx is made by the workflow engine, not the agent engine: the tool's claim was judged by its
// age, and a holder whose event loop stalled past the claim TTL could not renew it — a twin of the call
// ran the effect beside it (audit 2026-10-16). The claim is now this process's own while its attempt is held.
import { describe, it, expect, vi, beforeAll } from 'vitest';
import { InMemoryStorage, durableTool, RunBusyError, toJournal } from '../src/index.js';
import { step, workflow } from '@gnldev/workflow';

beforeAll(() => { vi.spyOn(console, 'warn').mockImplementation(() => {}); });
const TTL = 150;
const gate = () => { let open!: () => void; const p = new Promise<void>((r) => { open = r; }); return { p, open }; };
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const stall = (ms: number) => { const end = Date.now() + ms; while (Date.now() < end) { /* blocked */ } };

describe('a tool in a workflow step, the process stalled past the claim TTL', () => {
  it('a twin of the call is busy: the effect runs once', async () => {
    const journal = toJournal(new InMemoryStorage().runs);
    let executions = 0;
    const inBody = gate();
    const finish = gate();
    const tool = {
      sideEffect: true, claimTtlMs: TTL, recover: async () => ({ done: false as const }),
      execute: async () => { executions++; inBody.open(); await finish.p; return { shipped: executions }; },
    };
    const runId = 'wf-stall-1';
    const wf = workflow<number>().then(step('ship', async (_: number, ctx: any) =>
      durableTool(tool as any, { journal: ctx.journal, runId: ctx.runId } as any, 'ship').execute!({}, { toolCallId: 'c1' } as any)));
    const run = wf.run(1, { runId, journal } as any);
    await inBody.p;
    stall(TTL * 3);
    const twin = durableTool(tool as any, { journal, runId } as any, 'ship').execute!({}, { toolCallId: 'c1' } as any).then((v) => v, (e) => e);
    await Promise.race([twin, sleep(TTL * 2)]);
    expect(executions).toBe(1);
    finish.open();
    expect(await twin).toBeInstanceOf(RunBusyError);
    await run;
    expect(executions).toBe(1);
  });
}, 30_000);
