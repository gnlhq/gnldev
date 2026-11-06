// A misfire nobody asked for is stored as "the default", not as a value: the default may change, and a
// stored copy of it would then look like a different spec on the next boot. Triggers 0.16 stored as
// 'skip' (given or not, it could not tell) read as the default too, with or without the migration.
import { describe, it, expect, vi, afterEach } from 'vitest';
import { InMemoryJournal, InMemoryStorage, argsHash } from '@gnldev/durable';
import { scheduleWorkflow, pollScheduler, upgradeTriggers, listTriggers, schedulerUpgrade, type WorkflowRunner } from '../src/index.js';

afterEach(() => vi.restoreAllMocks());

function recorder() {
  const slots: number[] = [];
  const runner: WorkflowRunner = {
    async runWorkflow(_name, _input, opts) {
      slots.push(opts!.scheduledFor!);
      return { runId: opts!.runId! };
    },
  };
  return { slots, runner };
}
async function drain(j: InMemoryJournal, runner: WorkflowRunner, now: number) {
  for (let p = 0; p < 100; p++) {
    const r = await pollScheduler(j, runner, now);
    if (!r.fired && !r.rescheduled) break;
  }
}
async function snapshot(j: InMemoryJournal) {
  return Object.fromEntries(await Promise.all((await j.listKeys('sched:')).sort().map(async (k) => [k, await j.get(k)] as const)));
}
/** A trigger as 0.16 wrote it: `misfire: 'skip'` on the definition whether the caller gave one or not, state stamped for it. */
async function legacy(j: InMemoryJournal, id = 'a') {
  await scheduleWorkflow(j, { id, name: 'wf', every: 1000 }, 0);
  const def = { ...(await j.get<Record<string, unknown>>(`sched:def:${id}`))!, misfire: 'skip' };
  const state = { ...(await j.get<Record<string, unknown>>(`sched:state:${id}`))!, of: argsHash(def) };
  await j.put(`sched:def:${id}`, def);
  await j.put(`sched:state:${id}`, state);
}

describe('a misfire that was not given is stored as the default', () => {
  it('writes no concrete value, and the same call again is a no-op', async () => {
    const j = new InMemoryJournal();
    await scheduleWorkflow(j, { id: 'a', name: 'wf', every: 1000 }, 0);
    expect(await j.get('sched:def:a')).not.toHaveProperty('misfire');
    const before = await snapshot(j);
    await scheduleWorkflow(j, { id: 'a', name: 'wf', every: 1000 }, 5000);
    expect(await snapshot(j)).toEqual(before);
    expect((await listTriggers(j))[0]!.misfire).toBe('latest');
  });

  it('a stored default and an explicit value are different specs: refused (and an explicit one is not equal to a call without)', async () => {
    const j = new InMemoryJournal();
    await scheduleWorkflow(j, { id: 'a', name: 'wf', every: 1000 }, 0);
    await expect(scheduleWorkflow(j, { id: 'a', name: 'wf', every: 1000, misfire: 'earliest' }, 0)).rejects.toThrow(/already scheduled with a different spec \(differs in misfire\)/);
    await scheduleWorkflow(j, { id: 'b', name: 'wf', every: 1000, misfire: 'earliest' }, 0);
    await expect(scheduleWorkflow(j, { id: 'b', name: 'wf', every: 1000 }, 0)).rejects.toThrow(/differs in misfire/);
  });

  it("'skip' is still an unknown value for a caller", async () => {
    const j = new InMemoryJournal();
    await expect(scheduleWorkflow(j, { id: 'x', name: 'w', every: 1000, misfire: 'skip' } as never, 0)).rejects.toThrow(/misfire must be 'latest', 'earliest', 'none' or 'catchup', got "skip"/);
    expect(await j.listKeys('sched:')).toEqual([]);
  });

  it('a boot after the default changed finds no difference: the record says "default", not a value', async () => {
    const j = new InMemoryJournal();
    await scheduleWorkflow(j, { id: 'a', name: 'wf', every: 1000 }, 0);
    // Whatever the default is later, the record holds none of it.
    expect(JSON.stringify(await j.get('sched:def:a'))).not.toMatch(/latest|earliest|none|catchup|skip/);
  });
});

describe('a trigger 0.16 stored as "skip", before any migration', () => {
  it('scheduling without a misfire is a no-op (no opening error)', async () => {
    const j = new InMemoryJournal();
    await legacy(j);
    const before = await snapshot(j);
    await scheduleWorkflow(j, { id: 'a', name: 'wf', every: 1000 }, 0);
    expect(await snapshot(j)).toEqual(before);
  });

  it("scheduling with an explicit value differs; the stored 'skip' is not named in the refusal as a value", async () => {
    const j = new InMemoryJournal();
    await legacy(j);
    await expect(scheduleWorkflow(j, { id: 'a', name: 'wf', every: 1000, misfire: 'earliest' }, 0)).rejects.toThrow(/differs in misfire/);
  });

  it('the poller does not fail it: it fires like the default (the latest of 5 missed occurrences)', async () => {
    const j = new InMemoryJournal();
    await legacy(j);
    const { slots, runner } = recorder();
    await drain(j, runner, 5500);
    expect(slots).toEqual([5000]);
    const [info] = await listTriggers(j);
    expect(info!.status).toBe('pending');
    expect(info!.misfire).toBe('latest');
    expect(info!.nextRunAt).toBe(6000);
  });
});

describe('upgradeTriggers: stored misfire "skip" becomes the default', () => {
  it('rewrites the definition and its state fingerprint together; a second run changes nothing', async () => {
    const j = new InMemoryJournal();
    await legacy(j);
    await scheduleWorkflow(j, { id: 'b', name: 'wf', every: 1000, misfire: 'catchup' }, 0); // not touched
    const before = await snapshot(j);
    expect(await upgradeTriggers(j)).toEqual({ dryRun: false, migrated: ['a'] });
    const def = (await j.get<Record<string, unknown>>('sched:def:a'))!;
    const state = (await j.get<{ of: string; nextRunAt: number }>('sched:state:a'))!;
    expect(def).not.toHaveProperty('misfire');
    expect(state.of).toBe(argsHash(def));
    expect(state.nextRunAt).toBe(1000);
    expect((await snapshot(j))['sched:def:b']).toEqual(before['sched:def:b']);
    const afterFirst = await snapshot(j);
    expect(await upgradeTriggers(j)).toEqual({ dryRun: false, migrated: [] });
    expect(await snapshot(j)).toEqual(afterFirst);
  });

  it('dryRun reports the same triggers and writes nothing', async () => {
    const j = new InMemoryJournal();
    await legacy(j);
    const before = await snapshot(j);
    expect(await upgradeTriggers(j, { dryRun: true })).toEqual({ dryRun: true, migrated: ['a'] });
    expect(await snapshot(j)).toEqual(before);
  });

  it('after it: scheduling without a misfire is a no-op, and 5 missed occurrences fire the latest, for its own slot', async () => {
    const j = new InMemoryJournal();
    await legacy(j);
    await upgradeTriggers(j);
    const before = await snapshot(j);
    await scheduleWorkflow(j, { id: 'a', name: 'wf', every: 1000 }, 0);
    expect(await snapshot(j)).toEqual(before);
    const { slots, runner } = recorder();
    await drain(j, runner, 5500);
    expect(slots).toEqual([5000]);
  });

  it('a trigger with no state yet (its definition only) is migrated too', async () => {
    const j = new InMemoryJournal();
    await legacy(j);
    await j.deletePrefix('sched:state:a');
    expect((await upgradeTriggers(j)).migrated).toEqual(['a']);
    expect(await j.get('sched:def:a')).not.toHaveProperty('misfire');
    expect(await j.get('sched:state:a')).toBeUndefined();
  });
});

describe('schedulerUpgrade: the step a storage registers', () => {
  it('is named scheduler/misfire-default and waits for every older process to be gone', () => {
    const steps = [schedulerUpgrade(new InMemoryStorage())].flat();
    expect(steps.map((s) => s.name)).toEqual(['scheduler/misfire-default']);
    expect(steps[0]!.afterOlderGone).toBe(true);
    expect(steps[0]!.description).toMatch(/misfire/);
  });

  it('pending() / plan() / run() are upgradeTriggers: a second run finds nothing, plan writes nothing', async () => {
    const storage = new InMemoryStorage();
    const step = [schedulerUpgrade(storage)].flat()[0]!;
    expect(await step.pending()).toBe(false);
    expect(await step.plan()).toEqual({ triggers: [] });
    const { toJournal } = await import('@gnldev/durable');
    const j = toJournal(storage.runs) as unknown as InMemoryJournal;
    await legacy(j, 'a');
    await legacy(j, 'b');
    const before = await snapshot(j);
    expect(await step.pending()).toBe(true);
    expect(await step.plan()).toEqual({ triggers: ['a', 'b'] });
    expect(await snapshot(j)).toEqual(before);
    expect(await step.run()).toEqual({ triggers: ['a', 'b'] });
    expect(await step.pending()).toBe(false);
    expect(await step.run()).toEqual({ triggers: [] });
  });
});
