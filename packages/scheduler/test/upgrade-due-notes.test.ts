// A poller that reads a trigger 0.16 stored as 'skip' leaves a note for `scheduler/misfire-default`
// (@gnldev/durable `markUpgradeDue`), so a `storage.upgrade()` on a store where `schedulerUpgrade` is not
// registered says the step is missing instead of finding nothing to do; `upgradeTriggers` — the step —
// clears it as its last act. (The queue's notes: packages/queue/test/upgrade-due-notes.test.ts.)
import { describe, it, expect } from 'vitest';
import { registerUpgradeSteps, toJournal, InMemoryStorage, argsHash, type Storage } from '@gnldev/durable';
import { scheduleWorkflow, pollScheduler, schedulerUpgrade, upgradeTriggers } from '../src/index.js';

const notes = async (s: Storage) => (await toJournal(s.runs).listKeys('__upgrade_due__:')).sort();
const rowOf = (r: { steps: Array<{ name: string; detail?: Record<string, unknown> }> }, name: string) => r.steps.find((x) => x.name === name);

describe("scheduler: a poller that reads a 0.16 'skip' trigger notes scheduler/misfire-default", () => {
  async function legacy(s: Storage, id = 'a') {
    const j = toJournal(s.runs);
    await scheduleWorkflow(j, { id, name: 'wf', every: 1000 }, 0);
    const def = { ...(await j.get<Record<string, unknown>>(`sched:def:${id}`))!, misfire: 'skip' };
    const state = { ...(await j.get<Record<string, unknown>>(`sched:state:${id}`))!, of: argsHash(def) };
    await j.put(`sched:def:${id}`, def);
    await j.put(`sched:state:${id}`, state);
  }
  const runner = { async runWorkflow(_n: string, _i: unknown, o?: { runId?: string }) { return { runId: o!.runId! }; } };

  it('noted on the poll, reported by an upgrade() with nothing registered, cleared by the step', async () => {
    const s = new InMemoryStorage();
    await legacy(s);
    expect(await notes(s)).toEqual([]);
    await pollScheduler(toJournal(s.runs), runner, 5000);
    await new Promise((r) => setTimeout(r, 10)); // the note is written beside the poll, never in its way
    expect(await notes(s)).toEqual(['__upgrade_due__:scheduler/misfire-default']);
    expect(rowOf(await s.upgrade!({ dryRun: true }), 'scheduler/misfire-default')?.detail).toMatchObject({ notRegistered: true, register: 'registerUpgradeSteps(storage, [schedulerUpgrade])' });
    registerUpgradeSteps(s, [schedulerUpgrade]);
    await s.upgrade!({ only: ['scheduler/misfire-default'] });
    expect(await notes(s)).toEqual([]);
  });

  it('upgradeTriggers called on its own clears it too; a dry run does not', async () => {
    const s = new InMemoryStorage();
    await legacy(s);
    await pollScheduler(toJournal(s.runs), runner, 5000);
    await new Promise((r) => setTimeout(r, 10));
    await upgradeTriggers(toJournal(s.runs), { dryRun: true });
    expect(await notes(s)).toHaveLength(1);
    await upgradeTriggers(toJournal(s.runs));
    expect(await notes(s)).toEqual([]);
  });

  it('a trigger this version stored gets no note', async () => {
    const s = new InMemoryStorage();
    await scheduleWorkflow(toJournal(s.runs), { id: 'b', name: 'wf', every: 1000 }, 0);
    await pollScheduler(toJournal(s.runs), runner, 5000);
    await new Promise((r) => setTimeout(r, 10));
    expect(await notes(s)).toEqual([]);
  });
});
