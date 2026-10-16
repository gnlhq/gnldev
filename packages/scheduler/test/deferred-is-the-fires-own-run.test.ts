// A fire is DEFERRED only when its OWN run is executing elsewhere (the engine refused it at that run's
// lock). The scheduler's sibling of the queue's audit R2-5: a workflow that did its work and then called
// another run held for good by a frozen process was read as "deferred" — its attempts were never counted,
// it fired again on every poll, and it never failed.
import { describe, it, expect } from 'vitest';
import { InMemoryJournal, RunBusyError } from '@gnldev/durable';
import { scheduleWorkflow, pollScheduler, type WorkflowRunner } from '../src/index.js';

const STATE = (id: string) => `sched:state:${id}`;
const T0 = Date.UTC(2026, 0, 1);

describe("a fire's deferral is its own run executing elsewhere, nothing else", () => {
  it('a fire refused by ANOTHER busy run counts its attempts and fails at maxAttempts', async () => {
    const journal = new InMemoryJournal();
    let effects = 0;
    const runner: WorkflowRunner = {
      async runWorkflow() {
        effects++; // the fire's own work, done before the call below
        // Shaped as every release has thrown it at a lock (the flag set on the error), so this reads the same on the code before the fix.
        throw Object.assign(new RunBusyError("run 'report-of-the-day' is already running — it is locked by another process"), { runId: 'report-of-the-day', atLockAcquisition: true });
      },
    };
    await scheduleWorkflow(journal, { id: 't', name: 'w', every: 60_000, maxAttempts: 2 }, T0);
    for (let i = 0, now = T0 + 60_000; i < 6; i++) {
      await pollScheduler(journal, runner, now);
      now = Math.max(now + 1, (await journal.get<{ nextRunAt: number }>(STATE('t')))!.nextRunAt);
    }
    const st = (await journal.get<{ status: string; attempts: number }>(STATE('t')))!;
    expect({ status: st.status, attempts: st.attempts, effects }).toEqual({ status: 'failed', attempts: 2, effects: 2 });
  });

  it("a fire refused at its OWN run's lock is still deferred: no attempt is spent", async () => {
    const journal = new InMemoryJournal();
    const runner: WorkflowRunner = {
      async runWorkflow(_n, _i, o) {
        throw new RunBusyError(`run '${o!.runId}' is already running — it is locked by another process`, { runId: o!.runId!, atLockAcquisition: true });
      },
    };
    await scheduleWorkflow(journal, { id: 't', name: 'w', every: 60_000, maxAttempts: 2 }, T0);
    for (let i = 0, now = T0 + 60_000; i < 4; i++) {
      await pollScheduler(journal, runner, now);
      now = Math.max(now + 1, (await journal.get<{ nextRunAt: number }>(STATE('t')))!.nextRunAt);
    }
    const st = (await journal.get<{ status: string; attempts: number }>(STATE('t')))!;
    expect({ status: st.status, attempts: st.attempts }).toEqual({ status: 'pending', attempts: 0 });
  });
});
