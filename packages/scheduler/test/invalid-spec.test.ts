// A trigger definition in the journal is always one the poller can fire.
//
// Measured on 0.9.0 (in-memory and SQLite):
//  · `scheduleWorkflow({ cron: '0 25 * * *' })` threw — AFTER writing `sched:def:<id>`. The orphan
//    definition stayed. Re-registering the same id with a FIXED cron then went down the orphan-repair
//    branch, which keeps the stored definition and only writes a state: every poll fired the workflow
//    with the same runId, threw in computeNext on the broken cron, and the triggers sorted after it
//    never fired at all.
//  · `every: 0` (and a negative or NaN period) was accepted and fired on every poll.
// The fix is in the owning layer: the whole spec is validated before anything is written; a stored
// definition that is not valid (written by 0.9.0) is replaced by the next valid registration of that id;
// and the poller does not fire an invalid stored definition — it fails that one trigger, loudly, and
// keeps going.
import { describe, it, expect, vi, afterEach } from 'vitest';
import { InMemoryStorage, toJournal } from '@gnldev/durable';
import { SqliteStorage } from '@gnldev/durable/sqlite';
import { scheduleWorkflow, pollScheduler, listTriggers } from '../src/index.js';

afterEach(() => vi.restoreAllMocks());

const journals: Array<[string, () => any]> = [
  ['in-memory', () => toJournal(new InMemoryStorage().runs)],
  ['sqlite', () => toJournal(new SqliteStorage(':memory:').runs)],
];

function runner() {
  const fired: string[] = [];
  const runIds: string[] = [];
  return {
    fired,
    runIds,
    runWorkflow: async (name: string, _i: unknown, o?: { runId?: string }) => {
      fired.push(name);
      runIds.push(o?.runId ?? 'x');
      return { runId: o?.runId ?? 'x' };
    },
  };
}

const T0 = Date.UTC(2026, 0, 1, 0, 0, 0);
const HOUR = 3600_000;

describe.each(journals)('invalid trigger specs — %s', (_n, mk) => {
  it('CONTROL: two healthy triggers both fire', async () => {
    const j = mk(); const r = runner();
    await scheduleWorkflow(j, { id: 'a-ok', every: 1000, name: 'wa' }, T0);
    await scheduleWorkflow(j, { id: 'z-ok', every: 1000, name: 'wz' }, T0);
    await pollScheduler(j, r, T0 + 1500);
    expect(r.fired.sort()).toEqual(['wa', 'wz']);
  });

  it('an invalid cron is refused and leaves nothing in the journal', async () => {
    const j = mk();
    await expect(scheduleWorkflow(j, { id: 'a-bad', cron: '0 25 * * *', name: 'wbad' }, T0)).rejects.toThrow(/trigger 'a-bad'.*cron/s);
    expect(await j.listKeys('sched:')).toEqual([]);
  });

  it('after a refused registration, polling does not throw and the healthy trigger fires', async () => {
    const j = mk(); const r = runner();
    await expect(scheduleWorkflow(j, { id: 'a-bad', cron: '0 25 * * *', name: 'wbad' }, T0)).rejects.toThrow();
    await scheduleWorkflow(j, { id: 'z-ok', every: 1000, name: 'wz' }, T0);
    await pollScheduler(j, r, T0 + 1500);
    expect(r.fired).toEqual(['wz']);
    expect((await listTriggers(j)).map((t) => t.id)).toEqual(['z-ok']);
  });

  it('re-registering the same id with a FIXED spec gives a working trigger and does not break polling', async () => {
    const j = mk(); const r = runner();
    await expect(scheduleWorkflow(j, { id: 'a-bad', cron: '0 25 * * *', name: 'wbad' }, T0)).rejects.toThrow();
    await scheduleWorkflow(j, { id: 'a-bad', cron: '0 3 * * *', name: 'wbad' }, T0); // the fix
    await scheduleWorkflow(j, { id: 'z-ok', every: 1000, name: 'wz' }, T0);
    const errs: string[] = [];
    for (const dt of [4 * HOUR, 4 * HOUR + 1000, 4 * HOUR + 2000]) {
      try { await pollScheduler(j, r, T0 + dt); } catch (e) { errs.push((e as Error).message); }
    }
    expect({ errs, okFired: r.fired.includes('wz'), badFired: r.fired.filter((x) => x === 'wbad').length })
      .toEqual({ errs: [], okFired: true, badFired: 1 });
  });

  it.each([
    ['every: 0', { every: 0 }, /every/],
    ['every: -5', { every: -5 }, /every/],
    ['every: NaN', { every: Number.NaN }, /every/],
    ['every: Infinity', { every: Number.POSITIVE_INFINITY }, /every/],
    ['at: NaN', { at: Number.NaN }, /at/],
    ['cron with 4 fields', { cron: '0 3 * *' }, /cron/],
    ['cron that never matches (31 February)', { cron: '0 0 31 2 *' }, /cron/],
    ['none of at/every/cron', {}, /one of at \| every \| cron/],
    ['two of at/every/cron', { every: 1000, cron: '0 3 * * *' }, /only one of at \| every \| cron/],
    ['maxAttempts: 0', { every: 1000, maxAttempts: 0 }, /maxAttempts/],
    ['misfire typo', { every: 1000, misfire: 'catch-up' }, /misfire/],
    ['empty workflow name', { every: 1000, name: '' }, /name/],
  ])('%s is refused before anything is written', async (_label, bad, msg) => {
    const j = mk();
    await expect(scheduleWorkflow(j, { id: 'x', name: 'w', ...(bad as object) } as any, T0)).rejects.toThrow(msg);
    expect(await j.listKeys('sched:')).toEqual([]);
  });

  it('every: 1 (the smallest positive period) is legal and fires on the grid, not on every poll', async () => {
    const j = mk(); const r = runner();
    await scheduleWorkflow(j, { id: 'fast', every: 1, name: 'wf' }, T0);
    await pollScheduler(j, r, T0 + 1);
    await pollScheduler(j, r, T0 + 1); // same instant: nothing new is due
    expect(r.fired).toEqual(['wf']);
  });

  it('a past `at` is legal (fires on the next poll)', async () => {
    const j = mk(); const r = runner();
    await scheduleWorkflow(j, { id: 'late', at: T0 - HOUR, name: 'wl' }, T0);
    await pollScheduler(j, r, T0);
    expect(r.fired).toEqual(['wl']);
  });
});

describe.each(journals)('journals written by 0.9.0 — %s', (_n, mk) => {
  /** What 0.9.0 left after `scheduleWorkflow({ id, cron: '0 25 * * *' })` threw: a definition, no state. */
  const orphanBrokenCron = async (j: any, id: string) => {
    await j.put(`sched:def:${id}`, { name: 'wbad', input: undefined, kind: 'cron', value: '0 25 * * *', maxAttempts: 5, misfire: 'skip' });
  };

  it('a corrected re-registration replaces a broken orphan definition (the fix wins)', async () => {
    const j = mk(); const r = runner();
    await orphanBrokenCron(j, 'a-bad');
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    await scheduleWorkflow(j, { id: 'a-bad', cron: '0 3 * * *', name: 'wbad' }, T0);
    await scheduleWorkflow(j, { id: 'z-ok', every: 1000, name: 'wz' }, T0);
    const errs: string[] = [];
    for (const dt of [4 * HOUR, 4 * HOUR + 1000, 4 * HOUR + 2000]) {
      try { await pollScheduler(j, r, T0 + dt); } catch (e) { errs.push((e as Error).message); }
    }
    expect({ errs, badFired: r.fired.filter((x) => x === 'wbad').length, okFired: r.fired.includes('wz') })
      .toEqual({ errs: [], badFired: 1, okFired: true });
    expect((await listTriggers(j)).find((t) => t.id === 'a-bad')).toMatchObject({ kind: 'cron', value: '0 3 * * *' });
    expect(warn.mock.calls.some(([m]) => /replaced/.test(String(m)))).toBe(true);
  });

  it('an `every: 0` trigger (def + state) stops firing on every poll: the poller fails it and the others still fire', async () => {
    const j = mk(); const r = runner();
    await j.put('sched:def:zero', { name: 'w0', input: undefined, kind: 'every', value: 0, maxAttempts: 5, misfire: 'skip' });
    await j.put('sched:state:zero', { nextRunAt: T0, attempts: 0, fireCount: 0, status: 'pending' });
    await scheduleWorkflow(j, { id: 'z-ok', every: 1000, name: 'wz' }, T0);
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    for (let i = 1; i <= 5; i++) await pollScheduler(j, r, T0 + i * 1000);
    expect(r.fired.filter((x) => x === 'w0')).toEqual([]);
    expect(r.fired.filter((x) => x === 'wz').length).toBe(5);
    const zero = (await listTriggers(j)).find((t) => t.id === 'zero')!;
    expect(zero.status).toBe('failed');
    expect(zero.lastError).toMatch(/every.*scheduleWorkflow/s);
  });

  it('re-registering the `every: 0` trigger with a valid period revives it, keeping its fire counter', async () => {
    const j = mk(); const r = runner();
    await j.put('sched:def:zero', { name: 'w0', input: undefined, kind: 'every', value: 0, maxAttempts: 5, misfire: 'skip' });
    await j.put('sched:state:zero', { nextRunAt: T0, attempts: 0, fireCount: 7, status: 'pending' });
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    await scheduleWorkflow(j, { id: 'zero', every: 60_000, name: 'w0' }, T0);
    await pollScheduler(j, r, T0 + 60_000);
    await pollScheduler(j, r, T0 + 60_001);
    expect(r.runIds).toEqual(['sched:zero:7']); // not :0 — that run id may already have completed
  });

  it('a VALID stored trigger is still not redefined by a re-registration (unchanged behaviour)', async () => {
    const j = mk();
    await scheduleWorkflow(j, { id: 't', every: 1000, name: 'w' }, T0);
    await scheduleWorkflow(j, { id: 't', every: 5000, name: 'w' }, T0);
    expect((await listTriggers(j))[0]).toMatchObject({ value: 1000 });
  });
});
