// Upgrade from 0.9.0, @gnldev/workflow: runs 0.9.0 suspended after steps that returned nothing (one
// plain, one `sideEffect`) and after a nested workflow (`asStep`), resumed by the current code.
import { describe, expect, it } from 'vitest';
import { decodeStepRecord, toJournal } from '@gnldev/durable';
import * as w from '@gnldev/workflow';
import * as S from '../../generate/shapes.mjs';
import { itMigrates, notes090, openFixture } from '../support.js';

const R = S.WORKFLOW_RUNS;

describe('upgrade from 0.9.0 — workflow', () => {
  itMigrates('workflow.db');

  it('the fixture is what it claims: both runs suspended, every step before the wait ran once', () => {
    expect(notes090.workflow.results).toEqual(['suspended', 'suspended']);
    expect(notes090.workflow.callsOn090).toEqual(['notify', 'notifySE', 'pay:check', 'pay:charge']);
  });

  it('0.9.0 runs are listed and read as suspended, waiting where they stopped', async () => {
    const { storage } = openFixture('workflow.db');
    const j = toJournal(storage.runs);
    expect(await w.getWorkflowRunStatus(j, R.void)).toMatchObject({ status: 'suspended', waitId: 'approve' });
    expect(await w.getWorkflowRunStatus(j, R.nested)).toMatchObject({ status: 'suspended', waitId: 'ship' });
    const listed = (await w.listWorkflowRuns(j)).map((r: { runId: string }) => r.runId);
    expect(listed).toEqual(expect.arrayContaining([R.void, R.nested]));
  });

  it('a 0.9.0 step record reads back unchanged through decodeStepRecord', async () => {
    const { storage } = openFixture('workflow.db');
    const j = toJournal(storage.runs);
    expect(decodeStepRecord(await j.get(`${R.nested}:wf:pay:check`))).toEqual({ amount: 20 });
  });

  it('resuming the 0.9.0 void-step run: the sideEffect void step does not run again; the plain one re-runs once (documented)', async () => {
    const { storage } = openFixture('workflow.db');
    const j = toJournal(storage.runs);
    const calls: string[] = [];
    const r = await S.voidWorkflow(w, calls).runResumable(1, { runId: R.void, journal: j }, { resume: { approve: 'yes' } });
    expect(r).toEqual({ status: 'completed', output: { approved: 'yes' } });
    // CHANGELOG [Unreleased]: "a plain void step re-runs once, as on 0.9.0, and is then rewritten in the new shape".
    expect(calls).toEqual(['notify', 'final']);
    expect(w.isVoidStepRecord(await j.get(`${R.void}:wf:notify`))).toBe(true);
  });

  it('after that resume, running the run again runs nothing', async () => {
    const { storage } = openFixture('workflow.db');
    const j = toJournal(storage.runs);
    await S.voidWorkflow(w, []).runResumable(1, { runId: R.void, journal: j }, { resume: { approve: 'yes' } });
    const calls: string[] = [];
    const again = await S.voidWorkflow(w, calls).runResumable(1, { runId: R.void, journal: j }, { resume: { approve: 'yes' } });
    expect(again).toEqual({ status: 'completed', output: { approved: 'yes' } });
    expect(calls).toEqual([]);
  });

  it('resuming the 0.9.0 nested run runs only what comes after the wait', async () => {
    const { storage } = openFixture('workflow.db');
    const j = toJournal(storage.runs);
    const calls: string[] = [];
    const r = await S.nestedWorkflow(w, calls).runResumable(2, { runId: R.nested, journal: j }, { resume: { ship: 'today' } });
    expect(r).toEqual({ status: 'completed', output: { shipped: 'today' } });
    expect(calls).toEqual(['final']);
  });

  it('a 0.9.0 run resumed from a restarted process (a second open of the file) runs nothing twice', async () => {
    const f = openFixture('workflow.db');
    const calls: string[] = [];
    await S.nestedWorkflow(w, calls).runResumable(2, { runId: R.nested, journal: toJournal(f.storage.runs) }, { resume: { ship: 'today' } });
    await S.nestedWorkflow(w, calls).runResumable(2, { runId: R.nested, journal: toJournal(f.reopen().runs) }, { resume: { ship: 'today' } });
    expect(calls).toEqual(['final']);
  });
});
