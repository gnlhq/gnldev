// A trigger whose fire's run was erased is answered as erased — when it is scheduled, and at the fire.
//
// The scheduler sibling of e2e F1 (raporlar/2026-10-16-e2e): a trigger's fire runs as
// `sched:<id>:<fireCount>`, born at the fire. After `eraseSubject('ayse')` took her trigger and fenced
// its fires' runs, scheduling the same id again started its counter at 0 — a fenced run id — so
// `scheduleWorkflow` returned the id, and every fire was refused at the run's birth: five attempts, then
// `failed` with "run … was deleted while it was running", about a run that never ran again.
import { describe, it, expect, afterAll } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { InMemoryStorage, eraseSubject, purgeResource, claimRunOwner, toJournal, type Storage } from '@gnldev/durable';
import { SqliteStorage } from '@gnldev/durable/sqlite';
import { scheduleWorkflow, pollScheduler, triggerEraser, listTriggers, type WorkflowRunner } from '../src/index.js';

const ends: Array<() => unknown> = [];
afterAll(async () => { for (const end of ends.reverse()) await end(); });

const BACKENDS: Array<[string, () => Storage]> = [
  ['in-memory', () => new InMemoryStorage()],
  ['Sqlite', () => {
    const dir = mkdtempSync(join(tmpdir(), 'gnl-erased-trigger-'));
    const storage = new SqliteStorage(join(dir, 's.db')) as unknown as Storage;
    ends.push(() => { (storage as any).close?.(); rmSync(dir, { recursive: true, force: true }); });
    return storage;
  }],
];

/** A runner that births each fire's run the way the engine does, then runs `body`. */
function runner(journal: any, body: (runId: string) => Promise<void> = async () => undefined) {
  const fired: string[] = [];
  const r: WorkflowRunner = {
    runWorkflow: async (_name, _input, o: any) => {
      await claimRunOwner(journal, o.runId, o.caller);
      fired.push(o.runId);
      await body(o.runId);
      return { output: 'ok' };
    },
  } as WorkflowRunner;
  return { r, fired };
}

describe.each(BACKENDS)('a trigger under an erased run id — %s', (_name, make) => {
  it('scheduling again the id of a trigger the erasure took is refused as erased, and writes nothing', async () => {
    const s = make();
    const j = toJournal(s.runs) as any;
    const { r, fired } = runner(j);
    const t0 = 1_800_000_000_000;
    await scheduleWorkflow(j, { id: 'digest', name: 'wf', at: t0, resourceId: 'ayse' }, t0);
    await pollScheduler(j, r, t0 + 1);
    expect(fired).toHaveLength(1);
    await eraseSubject(s, 'ayse', { erasers: [triggerEraser(j)] } as any);
    await expect(scheduleWorkflow(j, { id: 'digest', name: 'wf', at: t0 + 10, resourceId: 'ayse' }, t0 + 5)).rejects.toMatchObject({ name: 'RunErasedError' });
    expect(await listTriggers(j)).toEqual([]);
  });

  it('control: after the erasure a new trigger id for the same person fires', async () => {
    const s = make();
    const j = toJournal(s.runs) as any;
    const { r, fired } = runner(j);
    const t0 = 1_800_000_000_000;
    await scheduleWorkflow(j, { id: 'digest', name: 'wf', at: t0, resourceId: 'ayse' }, t0);
    await pollScheduler(j, r, t0 + 1);
    await eraseSubject(s, 'ayse', { erasers: [triggerEraser(j)] } as any);
    await scheduleWorkflow(j, { id: 'digest-2', name: 'wf', at: t0 + 10, resourceId: 'ayse' }, t0 + 5);
    expect((await pollScheduler(j, r, t0 + 11)).fired).toBe(1);
    expect(fired).toHaveLength(2);
  });

  it('a fire whose run is deleted before its retry fails the trigger as erased, with no further attempt', async () => {
    const s = make();
    const j = toJournal(s.runs) as any;
    let calls = 0;
    const { r } = runner(j, async () => { calls++; throw new Error('transient'); });
    const t0 = 1_800_000_000_000;
    await scheduleWorkflow(j, { id: 'export', name: 'wf', at: t0, resourceId: 'ayse' }, t0);
    expect((await pollScheduler(j, r, t0 + 1)).rescheduled).toBe(1);
    await purgeResource(j, 'ayse');
    const out = await pollScheduler(j, r, t0 + 10_000_000);
    expect(calls).toBe(1);
    expect(out.failed).toBe(1);
    const [t] = await listTriggers(j);
    expect(t.status).toBe('failed');
    expect(t.attempts).toBe(2);
    expect(t.lastError).toMatch(/deleted/);
    expect(t.lastError).not.toMatch(/while it was running/);
  });
});
