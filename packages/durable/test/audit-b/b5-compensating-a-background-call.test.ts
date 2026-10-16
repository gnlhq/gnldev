// B5: compensateRun on the run that made a background call. The parent's own record of the call is the
// LAUNCHER's (`{ status: 'started', taskId }`); the effect and its real result are in the task run.
// Unwinding the parent must undo the effect with ITS result (what the body returned) — never hand the
// tool's compensate() the launcher's `started` answer as if it were the effect's result — and it must not
// report the effect as compensated twice when the task is unwound as well.
import { describe, it, expect } from 'vitest';
import { compensateRun, readRunOutcome } from '../../src/index.js';
import { app, turn, until, sleep } from './helpers.js';

describe('B5 compensating a background call', () => {
  it("compensateRun(parent) gives compensate() the effect's own result, not the launcher's `started`", async () => {
    const compensated: Array<{ input: unknown; output: unknown }> = [];
    const compensate = async (input: unknown, output: unknown) => { compensated.push({ input, output }); return 'undone'; };
    const { gnl, storage, effects } = app({ bodyMs: 20, toolOpts: { compensate } });
    await turn(gnl, { runId: 'k1', threadId: 'TK1', prompt: 'research', resourceId: 'alice' });
    expect(await until(async () => (await readRunOutcome(storage.runs as any, 'cont:k1:call-1'))?.status === 'completed')).toBe(true);
    await sleep(100);
    expect(effects).toEqual(['tides']);
    // The application's tools, as it passes them to compensateRun (the tool it declared: background + compensate).
    const research = { background: true, sideEffect: true, compensate };
    const report = await compensateRun('k1', { journal: storage.runs as any, tools: { research: research as any } });
    const reportTask = await compensateRun('task:k1:call-1', { journal: storage.runs as any, tools: { research: research as any } });
    expect({
      outputs: compensated.map((c) => c.output),
      parent: report.entries.map((e) => e.status),
      task: reportTask.entries.map((e) => e.status),
    }).toEqual({ outputs: ['report on tides'], parent: expect.anything(), task: expect.anything() });
  });
});
