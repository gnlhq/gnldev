// A background call's outcome is its TASK's: the parent's own record is the launcher's answer
// (`{ status: 'started', taskId }`), not the effect. Unwinding the call is unwinding the task's call —
// once, with one key, whichever run is unwound first, and never on a guess while the task's call is in
// doubt (siblings of release audit B5).
import { describe, it, expect, beforeAll, vi } from 'vitest';
import { compensateRun, readRunOutcome, runCompensated, runKeys } from '../../src/index.js';
import { app, turn, until, sleep } from '../audit-b/helpers.js';

beforeAll(() => { vi.spyOn(console, 'warn').mockImplementation(() => {}); });

type Comp = { output: unknown; key: string; runId: string };
function research(compensated: Comp[]) {
  return {
    background: true, sideEffect: true,
    compensate: async (_input: unknown, output: unknown, ctx: { idempotencyKey: string; runId: string }) => {
      compensated.push({ output, key: ctx.idempotencyKey, runId: ctx.runId });
      return 'undone';
    },
  } as any;
}

async function finished(gnl: any, storage: any, runId: string) {
  await turn(gnl, { runId, threadId: `T-${runId}`, prompt: 'research', resourceId: 'alice' });
  expect(await until(async () => (await readRunOutcome(storage.runs as any, `cont:${runId}:call-1`))?.status === 'completed')).toBe(true);
  await sleep(50);
}

describe('unwinding a background call', () => {
  it("the task unwound first, then the parent: compensate() runs once, with the effect's result", async () => {
    const compensated: Comp[] = [];
    const { gnl, storage } = app({ bodyMs: 20, toolOpts: { compensate: research(compensated).compensate } });
    await finished(gnl, storage, 'k2');
    const tools = { research: research(compensated) };
    const task = await compensateRun('task:k2:call-1', { journal: storage.runs as any, tools });
    const parent = await compensateRun('k2', { journal: storage.runs as any, tools });
    expect({ outputs: compensated.map((c) => c.output), task: task.entries.map((e) => e.status), parent: parent.entries.map((e) => e.status) })
      .toEqual({ outputs: ['report on tides'], task: ['compensated'], parent: ['already-compensated'] });
  });

  it("both unwinds hand the provider one key — the task call's — and a preview of the parent shows the task's effect", async () => {
    const compensated: Comp[] = [];
    const { gnl, storage } = app({ bodyMs: 20, toolOpts: { compensate: research(compensated).compensate } });
    await finished(gnl, storage, 'k3');
    const tools = { research: research(compensated) };
    const dry = await compensateRun('k3', { journal: storage.runs as any, tools, dryRun: true });
    expect({ dry: dry.entries.map((e) => e.status), condemned: await runCompensated(storage.runs as any, 'task:k3:call-1') })
      .toEqual({ dry: ['would-compensate'], condemned: false });
    await compensateRun('k3', { journal: storage.runs as any, tools });
    await compensateRun('task:k3:call-1', { journal: storage.runs as any, tools });
    expect(compensated.map((c) => [c.key, c.runId])).toEqual([['task:k3:call-1:comp:call-1', 'task:k3:call-1']]);
  });

  it("the parent unwound while the task's call is in its body: nothing is undone on a guess, the task is condemned, and a re-run undoes the effect once it is recorded", async () => {
    const compensated: Comp[] = [];
    let release!: () => void;
    let entered = false;
    const { gnl, storage, effects } = app({
      bodyMs: 0,
      toolOpts: { compensate: research(compensated).compensate },
      body: async (topic) => { entered = true; await new Promise<void>((r) => { release = r; }); effects.push(topic); return `report on ${topic}`; },
    });
    await turn(gnl, { runId: 'k4', threadId: 'TK4', prompt: 'research', resourceId: 'alice' });
    expect(await until(() => entered)).toBe(true);
    const tools = { research: research(compensated) };
    const first = await compensateRun('k4', { journal: storage.runs as any, tools });
    expect({ outputs: compensated.length, first: first.entries.map((e) => e.status), condemned: await runCompensated(storage.runs as any, 'task:k4:call-1') })
      .toEqual({ outputs: 0, first: ['uncertain'], condemned: true });
    release();
    expect(await until(async () => (await storage.runs.get<any>(runKeys.tool('task:k4:call-1', 'call-1')))?.status === 'succeeded')).toBe(true);
    const again = await compensateRun('k4', { journal: storage.runs as any, tools });
    const third = await compensateRun('task:k4:call-1', { journal: storage.runs as any, tools });
    expect({ effects, outputs: compensated.map((c) => c.output), again: again.entries.map((e) => e.status), third: third.entries.map((e) => e.status) })
      .toEqual({ effects: ['tides'], outputs: ['report on tides'], again: ['compensated'], third: ['already-compensated'] });
  });
});
