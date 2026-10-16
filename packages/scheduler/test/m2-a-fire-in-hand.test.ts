// A scheduler fire, read by the two rules of the work in hand (siblings of audit C5 and C7):
//   · what counts as an attempt is @gnldev/durable `attemptEndOf`'s answer, the queue's too: a lost
//     liveness session (LivenessUnavailableError) released the fire — the trigger stays due, attempts 0;
//   · a fire under way is held: `pendingWork` lists it, and a drain waits for it even when the poll was
//     called by hand (no poll loop).
import { describe, it, expect, afterEach } from 'vitest';
import { InMemoryJournal, LivenessUnavailableError, endDrain, drainProcess, pendingWork } from '@gnldev/durable';
import { scheduleWorkflow, pollScheduler, listTriggers, type WorkflowRunner } from '../src/index.js';

afterEach(() => endDrain());

describe('a fire in hand', () => {
  it('a lost liveness session releases the fire: the trigger stays due, its attempt not spent', async () => {
    const j = new InMemoryJournal();
    const runner = { async runWorkflow() { throw new LivenessUnavailableError(); } } as unknown as WorkflowRunner;
    const now = Date.now();
    await scheduleWorkflow(j, { id: 'nightly', name: 'wf', at: now, maxAttempts: 1 }, now);
    await pollScheduler(j, runner, now);
    const t = (await listTriggers(j)).find((x) => x.id === 'nightly')!;
    expect({ status: t.status, attempts: t.attempts }).toEqual({ status: 'pending', attempts: 0 });
  });

  it('is listed by pendingWork while it runs, and a drain waits for it', async () => {
    const j = new InMemoryJournal();
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    let entered = false;
    const runner = { async runWorkflow(_n: string, _i: unknown, o: { runId: string }) { entered = true; await gate; return { runId: o.runId }; } } as unknown as WorkflowRunner;
    const now = Date.now();
    await scheduleWorkflow(j, { id: 'nightly', name: 'wf', at: now }, now);
    const polled = pollScheduler(j, runner, now);
    while (!entered) await new Promise((r) => setTimeout(r, 5));
    const p = await pendingWork(j as never);
    expect({ running: p.running.map((r) => r.runId), blocking: p.blocking }).toEqual({ running: ['sched:nightly:0'], blocking: true });
    expect(await drainProcess({ deadlineMs: 200 })).toEqual({ drained: false });
    release();
    await polled;
    expect(await drainProcess({ deadlineMs: 2_000 })).toEqual({ drained: true });
    expect((await pendingWork(j as never)).blocking).toBe(false);
  });
});
