// What a trigger does with the occurrences it missed (the machine slept, every process was down) —
// one option, four values, one reading (`slotToFire`). Each fire says which occurrence it is for.
import { describe, it, expect, vi, afterEach } from 'vitest';
import { InMemoryJournal } from '@gnldev/durable';
import { scheduleWorkflow, pollScheduler, listTriggers, type WorkflowRunner, type ScheduleSpec } from '../src/index.js';

const MIN = 60_000;
const DAY = 1440 * MIN;
const T0 = Date.UTC(2026, 10, 2, 12, 0, 0);
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

/** Polls at one instant until nothing fires any more — what a scheduler does on its next ticks. */
async function drain(j: InMemoryJournal, runner: WorkflowRunner, now: number): Promise<number> {
  let fired = 0;
  for (let p = 0; p < 5000; p++) {
    const r = await pollScheduler(j, runner, now);
    if (!r.fired && !r.rescheduled) break;
    fired += r.fired;
  }
  return fired;
}

// "The server missed 5 occurrences": scheduled at `start`, polled again 5.5 periods later.
const KINDS = {
  every: { spec: { every: 1000 } as Partial<ScheduleSpec>, start: 0, slots: [1000, 2000, 3000, 4000, 5000], now: 5500, next: 6000 },
  cron: { spec: { cron: '* * * * *' } as Partial<ScheduleSpec>, start: T0, slots: [1, 2, 3, 4, 5].map((n) => T0 + n * MIN), now: T0 + 5 * MIN + 30_000, next: T0 + 6 * MIN },
};
const EXPECT: Record<string, (s: number[]) => { fired: number[]; }> = {
  latest: (s) => ({ fired: [s[4]!] }),
  earliest: (s) => ({ fired: [s[0]!] }),
  none: () => ({ fired: [] }),
  catchup: (s) => ({ fired: s }),
};

describe('misfire: 5 occurrences missed', () => {
  for (const [kind, k] of Object.entries(KINDS)) {
    for (const misfire of ['latest', 'earliest', 'none', 'catchup'] as const) {
      it(`${kind} / ${misfire}: fires ${EXPECT[misfire]!(k.slots).fired.length} time(s), each for its own occurrence, and the calendar goes on`, async () => {
        const j = new InMemoryJournal();
        const { slots, runner } = recorder();
        await scheduleWorkflow(j, { id: 't', name: 'wf', misfire, ...k.spec } as ScheduleSpec, k.start);
        await drain(j, runner, k.now);
        expect(slots).toEqual(EXPECT[misfire]!(k.slots).fired);
        expect((await listTriggers(j))[0]!.nextRunAt).toBe(k.next);
      });
    }

    it(`${kind} / no misfire given: 'latest' — the last missed occurrence fires once`, async () => {
      const j = new InMemoryJournal();
      const { slots, runner } = recorder();
      await scheduleWorkflow(j, { id: 't', name: 'wf', ...k.spec } as ScheduleSpec, k.start);
      await drain(j, runner, k.now);
      expect(slots).toEqual([k.slots[4]]);
      expect((await listTriggers(j))[0]!.misfire).toBe('latest');
    });
  }

  it("'none' still fires an occurrence that is simply due (polled within its own period)", async () => {
    const j = new InMemoryJournal();
    const { slots, runner } = recorder();
    await scheduleWorkflow(j, { id: 't', name: 'wf', every: 1000, misfire: 'none' }, 0);
    await drain(j, runner, 1200);
    expect(slots).toEqual([1000]);
    expect((await listTriggers(j))[0]!.nextRunAt).toBe(2000);
  });

  it("'earliest' keeps the schedule on its grid: the occurrence after the missed ones, not 'now plus a period'", async () => {
    const j = new InMemoryJournal();
    const { runner } = recorder();
    await scheduleWorkflow(j, { id: 't', name: 'wf', every: 1500, misfire: 'earliest' }, 0);
    await drain(j, runner, 7000); // slots 1500 3000 4500 6000 missed; next on the grid is 7500
    expect((await listTriggers(j))[0]!.nextRunAt).toBe(7500);
  });
});

describe("the old name 'skip' is gone", () => {
  it('is refused like any unknown misfire value, before anything is written', async () => {
    const j = new InMemoryJournal();
    await expect(scheduleWorkflow(j, { id: 'x', name: 'w', every: 1000, misfire: 'skip' } as never, 0)).rejects.toThrow(/misfire must be 'latest', 'earliest', 'none' or 'catchup', got "skip"/);
    expect(await j.listKeys('sched:')).toEqual([]);
  });
});

describe('maxCatchup', () => {
  for (const [kind, spec] of Object.entries({ every: { every: MIN }, cron: { cron: '* * * * *' } })) {
    it(`${kind}: not given — a day asleep on a minute trigger fires every missed occurrence (1440)`, async () => {
      const j = new InMemoryJournal();
      const { slots, runner } = recorder();
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
      await scheduleWorkflow(j, { id: 't', name: 'wf', misfire: 'catchup', ...spec } as ScheduleSpec, T0 - DAY);
      const fired = await drain(j, runner, T0);
      expect(fired).toBe(1440);
      expect(slots[0]).toBe(T0 - DAY + MIN);
      expect(slots.at(-1)).toBe(T0);
      expect(warn).not.toHaveBeenCalled();
    }, 60_000);

    it(`${kind}: maxCatchup 10 — 10 fires (the latest ones) and exactly one warning with the count and the oldest dropped time`, async () => {
      const j = new InMemoryJournal();
      const { slots, runner } = recorder();
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
      await scheduleWorkflow(j, { id: 't', name: 'wf', misfire: 'catchup', maxCatchup: 10, ...spec } as ScheduleSpec, T0 - DAY);
      const fired = await drain(j, runner, T0);
      expect(fired).toBe(10);
      expect(slots).toEqual(Array.from({ length: 10 }, (_, i) => T0 - 9 * MIN + i * MIN));
      const warned = warn.mock.calls.map((c) => String(c[0])).filter((m) => m.includes('maxCatchup'));
      expect(warned).toHaveLength(1);
      expect(warned[0]).toContain("trigger t");
      expect(warned[0]).toContain('1430'); // 1440 missed, 10 kept
      expect(warned[0]).toContain(new Date(T0 - DAY + MIN).toISOString()); // the oldest dropped
    }, 60_000);
  }

  it('no warning when nothing was dropped by the limit', async () => {
    const j = new InMemoryJournal();
    const { runner } = recorder();
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    await scheduleWorkflow(j, { id: 't', name: 'wf', every: MIN, misfire: 'catchup', maxCatchup: 10 }, T0 - 5 * MIN);
    expect(await drain(j, runner, T0)).toBe(5);
    expect(warn.mock.calls.filter((c) => String(c[0]).includes('maxCatchup'))).toHaveLength(0);
  });
});

describe('concurrency', () => {
  async function burst(n: number, opts: { concurrency?: number }) {
    const j = new InMemoryJournal();
    let inFlight = 0, max = 0;
    const runner: WorkflowRunner = {
      async runWorkflow(_n, _i, o) {
        max = Math.max(max, ++inFlight);
        await new Promise((r) => setTimeout(r, 30));
        inFlight--;
        return { runId: o!.runId! };
      },
    };
    for (let i = 0; i < n; i++) await scheduleWorkflow(j, { id: `t${i}`, name: 'wf', at: 1000 }, 0);
    const r = await pollScheduler(j, runner, 1000, opts);
    return { max, fired: r.fired };
  }
  it('not given: no limit — a burst of 200 due triggers runs at once', async () => {
    const r = await burst(200, {});
    expect(r.fired).toBe(200);
    expect(r.max).toBeGreaterThanOrEqual(200);
  });
  it('concurrency: 10 — never more than 10 at once, and the rest still fire on later polls', async () => {
    const r = await burst(200, { concurrency: 10 });
    expect(r.max).toBeLessThanOrEqual(10);
    expect(r.fired).toBe(10);
  });
});
