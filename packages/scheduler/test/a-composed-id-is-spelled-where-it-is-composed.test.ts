// The scheduler and the queue compose run ids from a name a caller gives (`sched:<trigger>:<n>`,
// `job:<id>`), so they are where a name no run can carry is refused. Before, a trigger or job named
// `tool`, `wf` or `model` — a record family, where a run's own records start — was accepted and then
// never ran: the job failed every attempt, the trigger was deferred at every fire.
import { describe, it, expect } from 'vitest';
import { InMemoryStorage, createGnl, user } from '@gnldev/durable';
import { workflow, step } from '@gnldev/workflow';
import { scheduleWorkflow, pollScheduler, listTriggers } from '../src/index.js';
import { enqueue, createWorker, listJobs } from '../../queue/src/index.js';

describe('a composed id is spelled where it is composed', () => {
  for (const name of ['tool', 'wf', 'model']) {
    it(`a trigger named '${name}' is refused at scheduling and writes nothing`, async () => {
      const s: any = new InMemoryStorage();
      await expect(scheduleWorkflow(s.runs, { id: name, name: 'w', at: 1000 }, 1000)).rejects.toThrow(/record separator/);
      expect(await listTriggers(s.runs)).toEqual([]);
    });
    it(`a job named '${name}' is refused at enqueue and writes nothing`, async () => {
      const s: any = new InMemoryStorage();
      await expect(enqueue(s.work, 't', {}, { id: name, caller: user('alice') })).rejects.toThrow(/record separator/);
      expect(await listJobs(s.work)).toEqual([]);
    });
  }
  it('control: a plain name schedules, fires and runs; a plain job id runs once', async () => {
    const s: any = new InMemoryStorage();
    const gnl: any = createGnl({ storage: s, workflows: { w: workflow().then(step('s', async () => ({ ok: 1 }))) } } as never);
    await scheduleWorkflow(s.runs, { id: 'nightly', name: 'w', at: 1000 }, 1000);
    expect((await pollScheduler(s.runs, gnl, 2000)).fired).toBe(1);
    let ran = 0;
    await enqueue(s.work, 't', {}, { id: 'nightly', caller: user('alice') });
    await createWorker(s, { t: async () => { ran++; } }, { maxAttempts: 2, retryDelayMs: 0 } as never).drain();
    expect(ran).toBe(1);
  });
});
