// Whether a trigger can fire is a property of its spec, not of the moment it is looked at.
//
// INVARIANT: a spec accepted once is accepted at every other time, and a stored trigger fires at its
// due time; a spec refused once is refused at every time. And a re-registration either takes effect or
// says why not — it never leaves a trigger that silently does nothing.
//
// Measured on the first cut of the "validate before writing" fix (review panel, round 2): validity was
// "does `nextCronTime(expr, now)` find a match within 366 days". `0 0 29 2 *` (every leap day)
// registered on 2026-01-01 was refused — the next 29 February is 790 days away. Registered on
// 2027-03-01 it was accepted, and at 2028-02-29 00:00:30 the poller re-ran the same check with the new
// `now`, found no match within a year of it (the one after is 2032), marked the trigger `failed` and
// never fired it. And a trigger stored by 0.9 as `{ at }`, re-registered as `{ every }` (review-B S3),
// was answered "already scheduled" and never fired again.
import { describe, it, expect, vi, afterEach } from 'vitest';
import { InMemoryStorage, toJournal } from '@gnldev/durable';
import { scheduleWorkflow, pollScheduler, listTriggers, nextCronTime } from '../src/index.js';

afterEach(() => vi.restoreAllMocks());

function runner() {
  const fired: string[] = [];
  return {
    fired,
    runWorkflow: async (name: string, _i: unknown, o?: { runId?: string }) => { fired.push(`${name}@${o?.runId}`); return { runId: o?.runId ?? 'x' }; },
  };
}
const journal = () => toJournal(new InMemoryStorage().runs);
const at = (y: number, mo: number, d: number, h = 0, mi = 0) => Date.UTC(y, mo - 1, d, h, mi);

describe('a cron that fires less often than once a year', () => {
  it('every leap day (0 0 29 2 *), registered on 2026-01-01: accepted, first fire 2028-02-29', async () => {
    const j = journal();
    await scheduleWorkflow(j, { id: 'leap', name: 'leapWf', cron: '0 0 29 2 *' }, at(2026, 1, 1));
    expect((await listTriggers(j))[0]).toMatchObject({ id: 'leap', status: 'pending', nextRunAt: at(2028, 2, 29) });
  });

  it('registered 2027-03-01 and due 2028-02-29: it fires once, the poll does not throw, and the next one is 2032-02-29', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const j = journal();
    await scheduleWorkflow(j, { id: 'a-leap', name: 'leapWf', cron: '0 0 29 2 *' }, at(2027, 3, 1));
    await scheduleWorkflow(j, { id: 'b-daily', name: 'dailyWf', cron: '0 0 * * *' }, at(2027, 3, 1));
    const r = runner();
    const due = at(2028, 2, 29) + 30_000;
    await pollScheduler(j, r, due);
    await pollScheduler(j, r, due + 1000);
    expect(r.fired.filter((f) => f.startsWith('leapWf'))).toEqual(['leapWf@sched:a-leap:0']);
    expect(r.fired.some((f) => f.startsWith('dailyWf'))).toBe(true);
    const leap = (await listTriggers(j)).find((t) => t.id === 'a-leap')!;
    expect({ status: leap.status, nextRunAt: leap.nextRunAt, lastError: leap.lastError }).toEqual({ status: 'pending', nextRunAt: at(2032, 2, 29), lastError: undefined });
  });

  it('SIBLING — across a century that is not a leap year: from 2096-03-01 the next leap day is 2104-02-29', () => {
    expect(nextCronTime('0 0 29 2 *', at(2096, 3, 1))).toBe(at(2104, 2, 29));
  });

  it('SIBLING — day 29 of February OR a Monday (both fields restricted, POSIX OR): the next Monday, not the next leap day', () => {
    // 2026-01-01 is a Thursday; the next Monday in February is 2026-02-02.
    expect(nextCronTime('0 0 29 2 1', at(2026, 1, 1))).toBe(at(2026, 2, 2));
  });

  it('SIBLING — day 31 (only some months have one) fires in the next month that does', () => {
    expect(nextCronTime('0 12 31 * *', at(2026, 4, 1))).toBe(at(2026, 5, 31, 12));
  });

  it.each([
    ['0 0 30 2 *', 'February never has a 30th'],
    ['0 0 31 4,6,9,11 *', 'none of these months has a 31st'],
    ['0 0 31 2 *', 'February never has a 31st'],
  ])('a cron that can NEVER fire (%s: %s) is refused whatever the date, and writes nothing', async (cron) => {
    for (const now of [at(2026, 1, 1), at(2027, 3, 1), at(2096, 3, 1)]) {
      const j = journal();
      await expect(scheduleWorkflow(j, { id: 'never', name: 'w', cron }, now)).rejects.toThrow(/trigger 'never'.*cron.*can never fire/s);
      expect(await j.listKeys!('sched:')).toEqual([]);
    }
  });

  it('SIBLING — the answer does not depend on when the question is asked: each accepted cron is accepted at eight dates across a leap cycle', async () => {
    const crons = ['0 0 29 2 *', '0 0 31 * *', '*/15 * * * *', '0 9 * * 1-5', '0 0 1 1 *', '59 23 31 12 *'];
    const dates = [at(2026, 1, 1), at(2026, 12, 31, 23, 59), at(2027, 3, 1), at(2028, 2, 28, 23, 59), at(2028, 2, 29, 0, 1), at(2028, 3, 1), at(2099, 3, 1), at(2100, 2, 28)];
    for (const cron of crons) {
      for (const now of dates) {
        const j = journal();
        await expect(scheduleWorkflow(j, { id: 'x', name: 'w', cron }, now), `${cron} @ ${new Date(now).toISOString()}`).resolves.toBe('x');
        const t = (await listTriggers(j))[0]!;
        expect(t.nextRunAt).toBeGreaterThan(now);
      }
    }
  });
});

describe('re-registering an id with a different spec', () => {
  it('0.9 stored `{ at }`, this call passes `{ every }`: refused with the way through, not "already scheduled"', async () => {
    const j = journal();
    const T0 = at(2026, 1, 1);
    await scheduleWorkflow(j, { id: 'two', name: 'wtwo', at: T0 + 500 }, T0);
    await pollScheduler(j, runner(), T0 + 600); // the one-shot fired and is done
    await expect(scheduleWorkflow(j, { id: 'two', name: 'wtwo', every: 1000 }, T0 + 4000))
      .rejects.toThrow(/trigger 'two'.*already scheduled.*at.*every.*ifExists: 'replace'.*new id/s);
  });

  it('with `ifExists: \'replace\'` the new spec takes effect: it fires on its schedule, under a run id never used before', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const j = journal();
    const T0 = at(2026, 1, 1);
    await scheduleWorkflow(j, { id: 'two', name: 'wtwo', at: T0 + 500 }, T0);
    const r = runner();
    await pollScheduler(j, r, T0 + 600);
    await scheduleWorkflow(j, { id: 'two', name: 'wtwo', every: 1000, ifExists: 'replace' }, T0 + 4000);
    await pollScheduler(j, r, T0 + 5000);
    await pollScheduler(j, r, T0 + 6000);
    expect(r.fired).toEqual(['wtwo@sched:two:0', 'wtwo@sched:two:1', 'wtwo@sched:two:2']);
  });

  it('with `ifExists: \'keep\'` the stored trigger stays as it was (what 0.9 did for every re-registration)', async () => {
    const j = journal();
    const T0 = at(2026, 1, 1);
    await scheduleWorkflow(j, { id: 'k', name: 'w', cron: '0 3 * * *' }, T0);
    await scheduleWorkflow(j, { id: 'k', name: 'w', cron: '0 4 * * *', ifExists: 'keep' }, T0);
    expect((await listTriggers(j))[0]).toMatchObject({ value: '0 3 * * *', nextRunAt: at(2026, 1, 1, 3) });
  });

  it('SIBLING — the same spec again is still a no-op (the idempotency every boot relies on), with or without an ifExists', async () => {
    const j = journal();
    const T0 = at(2026, 1, 1);
    const spec = { id: 'same', name: 'w', cron: '0 3 * * *', input: { a: 1, when: new Date(0) } };
    await scheduleWorkflow(j, spec, T0);
    const before = await listTriggers(j);
    await scheduleWorkflow(j, spec, T0 + 3600_000);
    await scheduleWorkflow(j, { ...spec, ifExists: 'replace' }, T0 + 7200_000);
    expect(await listTriggers(j)).toEqual(before);
  });

  it.each([
    ['a cron changed', { cron: '0 3 * * *' }, { cron: '0 4 * * *' }],
    ['a one-shot moved', { at: at(2026, 1, 2) }, { at: at(2026, 1, 3) }],
    ['an input changed', { every: 1000, input: { n: 1 } }, { every: 1000, input: { n: 2 } }],
    ['maxAttempts changed', { every: 1000 }, { every: 1000, maxAttempts: 2 }],
  ])('SIBLING — %s: refused by default, applied with ifExists: \'replace\'', async (_what, a, b) => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const j = journal();
    const T0 = at(2026, 1, 1);
    await scheduleWorkflow(j, { id: 'c', name: 'w', ...a }, T0);
    await expect(scheduleWorkflow(j, { id: 'c', name: 'w', ...b }, T0)).rejects.toThrow(/already scheduled/);
    await scheduleWorkflow(j, { id: 'c', name: 'w', ...b, ifExists: 'replace' }, T0);
    const t = (await listTriggers(j))[0]!;
    const kind = Object.keys(b).find((k) => k === 'at' || k === 'every' || k === 'cron') as 'at' | 'every' | 'cron';
    expect(t.value).toEqual((b as Record<string, unknown>)[kind]);
    expect(t.maxAttempts).toBe((b as { maxAttempts?: number }).maxAttempts ?? 5);
  });

  it('SIBLING — the refusal names what differs, never the stored trigger\'s values (an ownerless id can be a guess by someone else)', async () => {
    const j = journal();
    await scheduleWorkflow(j, { id: 'shared', name: 'w', cron: '0 3 * * *', input: { token: 'owner-secret-7f3a' } }, 0);
    const err = await scheduleWorkflow(j, { id: 'shared', name: 'w', cron: '0 5 * * *', input: { probe: 1 } }, 0).catch((e: Error) => e.message);
    expect(err).toMatch(/already scheduled.*differs in the cron value, input/);
    expect(err).not.toMatch(/owner-secret|0 3 \* \* \*/);
  });

  it('SIBLING — an unknown ifExists is refused before anything is written', async () => {
    const j = journal();
    await expect(scheduleWorkflow(j, { id: 'u', name: 'w', every: 1000, ifExists: 'overwrite' as never }, 0)).rejects.toThrow(/ifExists/);
    expect(await j.listKeys!('sched:')).toEqual([]);
  });
});
