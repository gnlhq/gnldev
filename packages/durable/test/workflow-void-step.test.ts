// @gnldev/workflow on the real journals: a step that completed with `undefined` is replayed, not
// re-run, and the run's step list reports `undefined` rather than the record that stands for it.
// The engine-level suite (packages/workflow/test/void-output-replay.test.ts) uses a Map journal; this
// one checks the same invariant through superjson (InMemoryStorage) and SQLite, where a stored
// `undefined` reads back exactly like a missing key — which is how the bug looked in production.
import { describe, it, expect } from 'vitest';
import { workflow, step } from '@gnldev/workflow';
import { InMemoryStorage } from '../src/in-memory-storage.js';
import { SqliteStorage } from '../src/sqlite-storage.js';
import { toJournal } from '../src/storage.js';
import { createGnl } from '../src/registry.js';

const journals: Array<[string, () => any]> = [
  ['in-memory', () => toJournal(new InMemoryStorage().runs)],
  ['sqlite', () => new SqliteStorage(':memory:').runs],
];

describe.each(journals)('void step on the real journal — %s', (_n, mk) => {
  it('CONTROL: a step returning null runs once across a resume', async () => {
    const journal = mk();
    let sends = 0; let crash = true;
    const wf = workflow<number>()
      .then(step('sendEmail', async () => { sends++; return null; }))
      .then(step('after', async () => { if (crash) throw new Error('crash'); return 'ok'; }));
    await expect(wf.run(1, { runId: 'r-null', journal })).rejects.toThrow('crash');
    crash = false;
    expect(await wf.run(1, { runId: 'r-null', journal })).toBe('ok');
    expect(sends).toBe(1);
  });

  it('a step returning undefined runs once across a resume', async () => {
    const journal = mk();
    let sends = 0; let crash = true;
    const wf = workflow<number>()
      .then(step('sendEmail', async () => { sends++; }))
      .then(step('after', async () => { if (crash) throw new Error('crash'); return 'ok'; }));
    await expect(wf.run(1, { runId: 'r-void', journal })).rejects.toThrow('crash');
    crash = false;
    expect(await wf.run(1, { runId: 'r-void', journal })).toBe('ok');
    expect(sends).toBe(1);
  });

  it('sideEffect:true + recover: resume neither re-runs the void step nor blocks on its claim', async () => {
    const journal = mk();
    let sends = 0; let crash = true;
    const wf = workflow<number>()
      .then(step('sendEmail', async () => { sends++; }, { sideEffect: true, recover: async () => ({ done: false }) }))
      .then(step('after', async () => { if (crash) throw new Error('crash'); return 'ok'; }));
    await expect(wf.run(1, { runId: 'r-se', journal })).rejects.toThrow('crash');
    crash = false;
    expect(await wf.run(1, { runId: 'r-se', journal })).toBe('ok');
    expect(sends).toBe(1);
  });

  it('a 0.9.0 journal (claim + raw undefined output) replays the side-effect step instead of blocking', async () => {
    const journal = mk();
    await journal.put('old:wf:sendEmail:_claim', { startedAt: Date.now() });
    await journal.put('old:wf:sendEmail', undefined);
    let sends = 0;
    const wf = workflow<number>()
      .then(step('sendEmail', async () => { sends++; }, { sideEffect: true, recover: async () => ({ done: false }) }))
      .then(step('after', async () => 'ok'));
    // A run written before owners were recorded is staff's (runOwnerOf): the operator resumes it as staff.
    expect(await wf.run(1, { runId: 'old', journal, identity: { kind: 'staff', runId: 'old' } })).toBe('ok');
    expect(sends).toBe(0);
  });
});

describe('the registry reports a void step as undefined', () => {
  it('runWorkflow().steps shows output: undefined, not the stored brand', async () => {
    const wf = workflow<number>().then(step('notify', async () => undefined)).then(step('after', async () => 'ok'));
    const gnl = createGnl({ journal: toJournal(new InMemoryStorage().runs), workflows: { w: wf as any } });
    const r = await gnl.runWorkflow('w', 1, { runId: 'reg-1' });
    expect(r.steps.map((s) => [s.id, s.output])).toEqual([['notify', undefined], ['after', 'ok']]);
  });
});
