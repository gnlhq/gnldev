// A process that is shutting down fires no trigger: the trigger stays due, and a process that is not
// leaving fires it. Before, the scheduler's loop kept firing after the process's drain began.
import { describe, it, expect, afterEach } from 'vitest';
import { InMemoryJournal, beginDrain, endDrain } from '@gnldev/durable';
import { scheduleWorkflow, createScheduler, type WorkflowRunner } from '../src/index.js';

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

afterEach(() => endDrain());

describe('a draining process and its scheduler', () => {
  it('a due trigger is not fired while the process drains, and fires once it does not', async () => {
    const j = new InMemoryJournal();
    const calls: string[] = [];
    const runner: WorkflowRunner = { async runWorkflow(name, _i, o) { calls.push(name); return { runId: o?.runId ?? 'x', output: 'ok' }; } } as WorkflowRunner;
    await scheduleWorkflow(j, { id: 'due', name: 'wf', at: Date.now() }, Date.now());
    beginDrain();
    const leaving = createScheduler(j, runner, { pollMs: 10 });
    leaving.start();
    await sleep(150);
    leaving.stop();
    expect(calls, 'a trigger fired in a draining process').toEqual([]);
    endDrain(); // "another process": one that is not leaving
    const staying = createScheduler(j, runner, { pollMs: 10 });
    staying.start();
    for (let i = 0; i < 100 && !calls.length; i++) await sleep(10);
    staying.stop();
    expect(calls).toEqual(['wf']);
  });
});
