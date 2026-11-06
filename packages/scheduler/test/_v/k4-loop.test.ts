// MOD3 k4 — the scheduler loop: one trigger's fire must not hold up another's decision; a trigger's
// work per poll is bounded; every fire knows which occurrence it is for. Same file in every candidate.
// Candidate-neutral: the slot is read from `opts.scheduledFor` (candidate B) or `scheduledForOf`
// (candidate C) — whichever the candidate offers; A offers neither.
import { describe, it, expect, afterEach } from 'vitest';
import { InMemoryJournal, createGnl, drainProcess, endDrain } from '@gnldev/durable';
import { workflow, step, waitForResume } from '@gnldev/workflow';
import * as sched from '../../src/index.js';
import { scheduleWorkflow, createScheduler, pollScheduler, listTriggers, type WorkflowRunner } from '../../src/index.js';

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const MIN = 60_000;
const DAY = 24 * 60 * MIN;
afterEach(() => endDrain());

/** The occurrence a fire is for, by whatever means the candidate offers (undefined if none). */
async function slotOf(journal: { get: (k: string) => Promise<unknown> }, runId: string, opts: unknown): Promise<number | undefined> {
  const viaOpts = (opts as { scheduledFor?: number } | undefined)?.scheduledFor;
  if (viaOpts !== undefined) return viaOpts;
  const reader = (sched as Record<string, unknown>).scheduledForOf as undefined | ((c: { journal: unknown; runId: string }) => Promise<number | undefined>);
  return reader ? reader({ journal, runId }) : undefined;
}

/** Real-time loop: fires per trigger name within `windowMs`. */
async function runLoop(setup: (j: InMemoryJournal, t0: number) => Promise<void>, durations: Record<string, number | 'hang'>, windowMs: number, opts: Record<string, unknown> = {}) {
  const j = new InMemoryJournal();
  const t0 = Date.now();
  const fires: Record<string, number[]> = {};
  let release!: () => void;
  const hung = new Promise<void>((r) => (release = r));
  const runner: WorkflowRunner = {
    async runWorkflow(name, _input, o) {
      (fires[name] ??= []).push(Date.now() - t0);
      const d = durations[name] ?? 0;
      if (d === 'hang') await hung;
      else if (d > 0) await sleep(d);
      return { runId: o!.runId! };
    },
  };
  await setup(j, t0);
  const s = createScheduler(j, runner, { pollMs: 20, ...opts } as never);
  s.start();
  await sleep(windowMs);
  s.stop();
  release();
  const inWindow: Record<string, number> = {};
  for (const [k, v] of Object.entries(fires)) inWindow[k] = v.filter((t) => t <= windowMs).length;
  return { inWindow, fires, j };
}

describe('k4 R1 (A3) — a long fire does not starve another trigger', () => {
  it('short every 200 ms beside a long (1 s, always busy) trigger fires about as often as alone', async () => {
    const setup = (withLong: boolean) => async (j: InMemoryJournal, t0: number) => {
      if (withLong) await scheduleWorkflow(j, { id: 'a-long', name: 'long', every: 1000 }, t0 - 800);
      await scheduleWorkflow(j, { id: 'short', name: 'short', every: 200 }, t0);
    };
    const alone = await runLoop(setup(false), { short: 0 }, 2500);
    const mixed = await runLoop(setup(true), { long: 1000, short: 0 }, 2500);
    console.log(`[k4 R1] short alone=${alone.inWindow.short} mixed=${mixed.inWindow.short} long=${mixed.inWindow.long}`);
    expect(mixed.inWindow.short).toBeGreaterThanOrEqual((alone.inWindow.short ?? 0) - 1);
  }, 20_000);
});

describe('k4 R2 (A5) — catch-up is bounded and every fire carries its slot', () => {
  const T = Date.UTC(2026, 10, 2, 12, 0, 0);
  for (const kind of ['cron', 'every'] as const) {
    it(`${kind} 1/min, catchup, maxCatchup 10, after a day asleep: at most 10 fires, the latest slots, each knows its slot`, async () => {
      const j = new InMemoryJournal();
      const slots: Array<number | undefined> = [];
      const runner: WorkflowRunner = { async runWorkflow(_n, _i, o) { slots.push(await slotOf(j, o!.runId!, o)); return { runId: o!.runId! }; } };
      await scheduleWorkflow(j, { id: 't', name: 'wf', misfire: 'catchup', maxCatchup: 10, ...(kind === 'cron' ? { cron: '* * * * *' } : { every: MIN }) }, T - DAY);
      let fired = 0;
      for (let p = 0; p < 2000; p++) { const r = await pollScheduler(j, runner, T + p * 1000); if (!r.fired) break; fired += r.fired; }
      console.log(`[k4 R2] ${kind} catchup: fired=${fired} first slot=${slots[0] && new Date(slots[0]).toISOString()} last=${slots.at(-1) && new Date(slots.at(-1)!).toISOString()}`);
      expect(fired).toBeLessThanOrEqual(10);
      expect(slots.every((s) => typeof s === 'number')).toBe(true);
      expect(slots.at(-1)).toBe(T); // the latest due occurrence is the last one fired
      expect(new Set(slots).size).toBe(slots.length);
    }, 60_000);
    it(`${kind} 1/min, latest after a day asleep: one fire, for the LATEST missed slot`, async () => {
      const j = new InMemoryJournal();
      const slots: Array<number | undefined> = [];
      const runner: WorkflowRunner = { async runWorkflow(_n, _i, o) { slots.push(await slotOf(j, o!.runId!, o)); return { runId: o!.runId! }; } };
      await scheduleWorkflow(j, { id: 't', name: 'wf', ...(kind === 'cron' ? { cron: '* * * * *' } : { every: MIN }) }, T - DAY);
      let fired = 0;
      for (let p = 0; p < 50; p++) { const r = await pollScheduler(j, runner, T + 30_000 + p * 1000); if (!r.fired) break; fired += r.fired; }
      expect(fired).toBe(1);
      expect(slots).toEqual([T]);
      expect((await listTriggers(j))[0]!.nextRunAt).toBe(T + MIN);
    });
  }
});

describe('k4 siblings', () => {
  it('S1 hang: one of three triggers hangs forever — the other two keep their schedule', async () => {
    const setup = (withHang: boolean) => async (j: InMemoryJournal, t0: number) => {
      if (withHang) await scheduleWorkflow(j, { id: 'b-hang', name: 'hang', every: 200 }, t0 - 150);
      await scheduleWorkflow(j, { id: 'a-x', name: 'x', every: 200 }, t0);
      await scheduleWorkflow(j, { id: 'c-y', name: 'y', every: 300 }, t0);
    };
    const alone = await runLoop(setup(false), {}, 2000);
    const mixed = await runLoop(setup(true), { hang: 'hang' }, 2000);
    console.log(`[k4 S1] alone x=${alone.inWindow.x} y=${alone.inWindow.y} | with hang x=${mixed.inWindow.x} y=${mixed.inWindow.y} hang=${mixed.inWindow.hang}`);
    expect(mixed.inWindow.hang).toBe(1);
    expect(mixed.inWindow.x).toBeGreaterThanOrEqual((alone.inWindow.x ?? 0) - 1);
    expect(mixed.inWindow.y).toBeGreaterThanOrEqual((alone.inWindow.y ?? 0) - 1);
  }, 20_000);

  it('S2 drain during a long fire: the drain waits for the fire, and nothing new fires once it began', async () => {
    const j = new InMemoryJournal();
    const t0 = Date.now();
    const log: string[] = [];
    let drainBegan = Infinity;
    const runner: WorkflowRunner = {
      async runWorkflow(name, _i, o) {
        log.push(`start ${name} @${Date.now() - t0}`);
        if (Date.now() >= drainBegan) log.push(`LATE ${name}`);
        if (name === 'long') await sleep(700);
        log.push(`end ${name} @${Date.now() - t0}`);
        return { runId: o!.runId! };
      },
    };
    await scheduleWorkflow(j, { id: 'long', name: 'long', at: t0 }, t0);
    await scheduleWorkflow(j, { id: 'tick', name: 'tick', every: 50 }, t0);
    const s = createScheduler(j, runner, { pollMs: 10 });
    s.start();
    while (!log.some((l) => l.startsWith('start long'))) await sleep(5);
    drainBegan = Date.now();
    const r = await drainProcess({ deadlineMs: 5000 });
    const drainedAt = Date.now() - t0;
    s.stop();
    const longEnd = Number(log.find((l) => l.startsWith('end long'))?.split('@')[1]);
    console.log(`[k4 S2] drained=${r.drained} at ${drainedAt}, long ended at ${longEnd}, late=${log.filter((l) => l.startsWith('LATE')).length}`);
    expect(r.drained).toBe(true);
    expect(longEnd).toBeLessThanOrEqual(drainedAt);
    expect(log.filter((l) => l.startsWith('LATE'))).toEqual([]);
  }, 20_000);

  it('S4 catch-up with a long job beside a short trigger: catch-up is bounded, short is not held up', async () => {
    const setup = (withCatchup: boolean) => async (j: InMemoryJournal, t0: number) => {
      if (withCatchup) await scheduleWorkflow(j, { id: 'a-cu', name: 'cu', every: MIN, misfire: 'catchup', maxCatchup: 10 }, t0 - DAY);
      await scheduleWorkflow(j, { id: 'short', name: 'short', every: 200 }, t0);
    };
    const alone = await runLoop(setup(false), {}, 3000);
    const mixed = await runLoop(setup(true), { cu: 400 }, 3000);
    console.log(`[k4 S4] short alone=${alone.inWindow.short} with catchup=${mixed.inWindow.short} catchup fires=${mixed.inWindow.cu}`);
    expect(mixed.inWindow.cu).toBeLessThanOrEqual(10);
    expect(mixed.inWindow.short).toBeGreaterThanOrEqual((alone.inWindow.short ?? 0) - 1);
  }, 20_000);

  it('S7 overlap: a fire longer than its period never overlaps itself, and each fire is for a later slot on the grid', async () => {
    const j = new InMemoryJournal();
    const t0 = Date.now();
    let inFlight = 0, maxInFlight = 0;
    const slots: Array<number | undefined> = [];
    const runner: WorkflowRunner = {
      async runWorkflow(_n, _i, o) {
        inFlight++; maxInFlight = Math.max(maxInFlight, inFlight);
        slots.push(await slotOf(j, o!.runId!, o));
        await sleep(350);
        inFlight--;
        return { runId: o!.runId! };
      },
    };
    await scheduleWorkflow(j, { id: 'ov', name: 'ov', every: 100 }, t0);
    const s = createScheduler(j, runner, { pollMs: 10 });
    s.start();
    await sleep(2000);
    s.stop();
    await sleep(400);
    console.log(`[k4 S7] fires=${slots.length} maxInFlight=${maxInFlight} slots(rel)=${JSON.stringify(slots.map((x) => (x === undefined ? null : x - t0)))}`);
    expect(maxInFlight).toBe(1);
    expect(slots.every((x) => x !== undefined && (x - t0) % 100 === 0)).toBe(true);
    for (let i = 1; i < slots.length; i++) expect(slots[i]!).toBeGreaterThan(slots[i - 1]!);
  }, 20_000);

  it('S8 a retry keeps its occurrence: the fire after a failure is for the ORIGINAL slot, and the grid does not drift', async () => {
    const j = new InMemoryJournal();
    const slots: Array<number | undefined> = [];
    let calls = 0;
    const runner: WorkflowRunner = {
      async runWorkflow(_n, _i, o) {
        slots.push(await slotOf(j, o!.runId!, o));
        if (calls++ === 0) throw new Error('transient');
        return { runId: o!.runId! };
      },
    };
    await scheduleWorkflow(j, { id: 'r', name: 'wf', every: 1500 }, 0); // grid 1500, 3000, 4500…
    await pollScheduler(j, runner, 1500); // fails → retry at 2500 (backoff 1 s)
    await pollScheduler(j, runner, 2500); // succeeds
    const next = (await listTriggers(j))[0]!.nextRunAt;
    console.log(`[k4 S8] slots=${JSON.stringify(slots)} next=${next}`);
    expect(slots).toEqual([1500, 1500]);
    expect(next).toBe(3000);
  });

  it('S9 the run itself reads its slot after a resume nobody scheduled (createGnl + waitForResume)', async () => {
    const j = new InMemoryJournal();
    const seen: Record<string, number | undefined> = {};
    const read = async (ctx: { journal: unknown; runId: string; scheduledFor?: number }) =>
      ctx.scheduledFor ?? (await slotOf(ctx.journal as never, ctx.runId, undefined));
    const wf = workflow<Record<string, never>>()
      .then(step('before', async (_i, ctx) => { seen.before = await read(ctx as never); return {}; }))
      .then(waitForResume('go'))
      .then(step('after', async (_i, ctx) => { seen.after = await read(ctx as never); return {}; }));
    const gnl = createGnl({ journal: j, workflows: { nightly: wf } });
    await scheduleWorkflow(j, { id: 'n', name: 'nightly', input: {}, at: 5000 }, 0);
    await pollScheduler(j, gnl as never, 5000);
    // A resume from outside the scheduler (an approval UI, the waker): it does not know the slot.
    await gnl.runWorkflow('nightly', {}, { runId: 'sched:n:0', resume: { go: true } });
    console.log(`[k4 S9] before=${seen.before} after=${seen.after}`);
    expect(seen.before).toBe(5000);
    expect(seen.after).toBe(5000);
  });
});
