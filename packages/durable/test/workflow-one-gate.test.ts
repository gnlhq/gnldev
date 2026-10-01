// S-c5 (review panel, round 2): one nested workflow with `waitForResume('approve')`, used as
// `asStep('a')` and `asStep('b')`. A waitId is one key per run (`<runId>:wf:_resume:approve` — not
// scoped by asStep, so an operator can resume without knowing the nesting), so ONE resume opened both
// gates. @gnldev/workflow now refuses that workflow where it is built; this runs the scenario and its
// way through on the real journals, in memory and on SQLite.
import { describe, it, expect } from 'vitest';
import { workflow, asStep, waitForResume } from '@gnldev/workflow';
import { InMemoryJournal } from '../src/index.js';
import { SqliteStorage } from '../src/sqlite-storage.js';

const journals = {
  'in-memory': () => new InMemoryJournal(),
  sqlite: () => new SqliteStorage(':memory:').runs,
};

describe.each(Object.entries(journals))('one resume opens one gate (%s)', (_name, make) => {
  it('the panel scenario is refused at build, naming a waitId of its own as the way through', () => {
    const gate = workflow<number>().then(waitForResume('approve'));
    expect(() => workflow<number>().then(asStep('a', gate)).then(asStep('b', gate))).toThrow(
      /'_resume:approve'.*one resume would open both gates.*waitForResume\('approve-2'\)/s,
    );
  });

  it('the way through: each gate with its own waitId waits for its own resume', async () => {
    const journal = make() as any;
    const gate = (waitId: string) => workflow<number>().then(waitForResume(waitId));
    const wf = workflow<number>().then(asStep('a', gate('approve'))).then(asStep('b', gate('approve-2')));
    expect(await wf.runResumable(1, { runId: 'w5', journal })).toMatchObject({ status: 'suspended', waitId: 'approve' });
    const afterOne = await wf.runResumable(1, { runId: 'w5', journal }, { resume: { approve: 'yes-for-a' } });
    expect(afterOne).toMatchObject({ status: 'suspended', waitId: 'approve-2' });
    expect(await wf.runResumable(1, { runId: 'w5', journal }, { resume: { 'approve-2': 'yes-for-b' } })).toEqual({ status: 'completed', output: 'yes-for-b' });
  });
});
