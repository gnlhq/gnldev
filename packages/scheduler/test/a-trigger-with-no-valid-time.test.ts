// A stored trigger the poller cannot fire is answered on the first poll that sees it, whatever its time
// says — "can it fire" is asked before "is it time".
//
// - An invalid DEFINITION (only 0.9.0 could store one) is failed with the reason. 0.9.0 wrote
//   `nextRunAt: NaN` for `every: 0`, and `now >= NaN` is false, which once left such a trigger pending
//   forever (caught by the 0.9.0 upgrade suite; pinned here so the main run does too).
// - A VALID definition whose stored next time is not a number (a foreign writer, a hand edit) is never
//   fired from that state: a fire computes the next slot from the stored time, so an `every` fired on
//   every poll and an `at` fired before its time (measured, 15 of 15). By default it is failed, visible
//   in listTriggers/Studio with the way out — registering the same spec, which a restart does — and
//   `onInvalidTime: 'repair'` sets the time from the definition instead.
import { describe, it, expect } from 'vitest';
import { InMemoryJournal } from '@gnldev/durable';
import { createScheduler, listTriggers, pollScheduler, scheduleWorkflow } from '../src/index.js';

const quiet = async <T>(f: () => Promise<T>): Promise<T> => {
  const warn = console.warn; console.warn = () => undefined;
  try { return await f(); } finally { console.warn = warn; }
};
const recorder = () => {
  const fired: string[] = [];
  return { fired, runner: { runWorkflow: async (n: string) => { fired.push(n); return { runId: 'x' }; } } as any };
};

describe('a trigger with an invalid definition', () => {
  for (const nextRunAt of [NaN, Infinity]) {
    it(`nextRunAt ${nextRunAt} on an every:0 definition → failed with the reason, nothing fired`, async () => {
      const j = new InMemoryJournal();
      await j.put('sched:def:zero', { name: 'w', kind: 'every', value: 0, input: {}, maxAttempts: 3 });
      await j.put('sched:state:zero', { nextRunAt, attempts: 0, fireCount: 1, status: 'pending' });
      const { fired, runner } = recorder();
      await quiet(() => pollScheduler(j as any, runner, 1_000_000));
      const t = (await listTriggers(j as any)).find((x) => x.id === 'zero');
      expect(fired).toEqual([]);
      expect(t?.status).toBe('failed');
      expect(t?.lastError).toMatch(/cannot fire/);
    });
  }

  it('is failed on the first poll even when its time is far away (maxAttempts: 0, an unknown misfire)', async () => {
    for (const bad of [{ maxAttempts: 0 }, { misfire: 'sometimes' }]) {
      const j = new InMemoryJournal();
      await j.put('sched:def:t', { name: 'w', kind: 'every', value: 60_000, input: {}, maxAttempts: 3, ...bad });
      await j.put('sched:state:t', { nextRunAt: 9_000_000_000, attempts: 0, fireCount: 0, status: 'pending' });
      const { fired, runner } = recorder();
      await quiet(() => pollScheduler(j as any, runner, 1_000_000));
      const t = (await listTriggers(j as any)).find((x) => x.id === 't');
      expect(fired, JSON.stringify(bad)).toEqual([]);
      expect(t?.status, JSON.stringify(bad)).toBe('failed');
    }
  });
});

describe('a valid trigger whose stored next time is not a number', () => {
  const KINDS = [['every', { every: 60_000 }, 1_063_000], ['cron', { cron: '*/5 * * * *' }, 1_200_000], ['at', { at: 5_000_000 }, 5_000_000]] as const;
  const BAD = [NaN, null, Infinity, undefined, 'abc'];

  async function broken(spec: object, bad: unknown) {
    const j = new InMemoryJournal();
    await scheduleWorkflow(j as any, { id: 't', name: 'broken', ...spec } as any, 900_000);
    await scheduleWorkflow(j as any, { id: 'n', name: 'neighbour', every: 1_000 }, 999_000);
    const st: any = await j.get('sched:state:t');
    await j.put('sched:state:t', { ...st, nextRunAt: bad });
    return j;
  }

  for (const [kind, spec, dueAfter] of KINDS) {
    for (const bad of BAD) {
      it(`${kind}, nextRunAt ${String(bad)}: not fired, failed and visible; the neighbour fires; the same spec registered again repairs it`, async () => {
        const j = await broken(spec, bad);
        const { fired, runner } = recorder();
        for (const now of [1_000_000, 1_001_000, 1_002_000]) await quiet(() => pollScheduler(j as any, runner, now));
        expect(fired.filter((n) => n === 'broken')).toEqual([]);
        expect(fired.filter((n) => n === 'neighbour')).toHaveLength(3);
        const t = (await listTriggers(j as any)).find((x) => x.id === 't');
        expect(t?.status).toBe('failed');
        expect(t?.lastError).toMatch(/stored next time is not a number.*scheduleWorkflow again/s);

        await quiet(() => scheduleWorkflow(j as any, { id: 't', name: 'broken', ...spec } as any, 1_003_000));
        const after = (await listTriggers(j as any)).find((x) => x.id === 't');
        expect(after?.status).toBe('pending');
        expect(after?.nextRunAt).toBe(dueAfter);
        fired.length = 0;
        await quiet(() => pollScheduler(j as any, runner, dueAfter));
        expect(fired).toContain('broken');
      });
    }

    it(`${kind}, onInvalidTime: 'repair': its time comes from the definition, nothing fired before it`, async () => {
      const j = await broken(spec, NaN);
      const { fired, runner } = recorder();
      for (const now of [1_000_000, 1_001_000, 1_002_000]) await quiet(() => pollScheduler(j as any, runner, now, { onInvalidTime: 'repair' }));
      expect(fired.filter((n) => n === 'broken')).toEqual([]);
      const t = (await listTriggers(j as any)).find((x) => x.id === 't');
      expect(t?.status).toBe('pending');
      expect(t?.nextRunAt).toBe(kind === 'every' ? 1_060_000 : kind === 'at' ? 5_000_000 : 1_200_000);
    });
  }

  it('an onInvalidTime that is neither fail nor repair is refused when the scheduler is built, naming the values', async () => {
    const j = new InMemoryJournal();
    const { runner } = recorder();
    expect(() => createScheduler(j as any, runner, { onInvalidTime: 'repiar' as any })).toThrow(/onInvalidTime must be 'fail' or 'repair', got "repiar"/);
    await expect(pollScheduler(j as any, runner, 1, { onInvalidTime: 'heal' as any })).rejects.toThrow(/onInvalidTime/);
  });
});
