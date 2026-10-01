// Upgrade from 0.9.0, @gnldev/scheduler: triggers 0.9.0 stored — one valid, three that cannot fire
// (`every: 0`, `maxAttempts: 0`, and a cron 0.9.0 refused AFTER writing its definition), one with two
// of `at | every`, and a leap-day cron 0.9.0 refused in a non-leap year (again after writing it).
import { describe, expect, it } from 'vitest';
import { toJournal } from '@gnldev/durable';
import { listTriggers, pollScheduler, scheduleWorkflow } from '@gnldev/scheduler';
import * as S from '../../generate/shapes.mjs';
import { itMigrates, notes090, openFixture } from '../support.js';

const T = S.SCHED_T0;
const spec = (id: string) => S.SCHEDULES.find((s) => s.id === id)!;
/** Run ids 0.9.0 already fired: a fire after the upgrade must never reuse one (it would replay, not run). */
const runIdsOn090 = new Set((notes090.scheduler.firedOn090 as string[]).map((f) => f.split('@')[1]));

function setup() {
  const f = openFixture('scheduler.db');
  const j = toJournal(f.storage.runs);
  const fired: string[] = [];
  const runner = { runWorkflow: async (name: string, _in: unknown, o?: { runId?: string }) => { fired.push(`${name}@${o?.runId}`); return { runId: o?.runId ?? 'x' }; } };
  const poll = (at: number) => pollScheduler(j, runner as any, at);
  return { j, fired, poll };
}
const quiet = <T>(f: () => Promise<T>) => {
  const warn = console.warn;
  console.warn = () => undefined;
  return f().finally(() => { console.warn = warn; });
};

describe('upgrade from 0.9.0 — scheduler', () => {
  itMigrates('scheduler.db');

  it('the fixture is what it claims: 0.9.0 wrote the definitions of the two specs it then refused', () => {
    expect(notes090.scheduler.registered.bad).toMatch(/^threw/);
    expect(notes090.scheduler.registered.leap).toMatch(/^threw: cron: no match within 1 year/);
    expect(notes090.scheduler.keys).toEqual(expect.arrayContaining(['sched:def:bad', 'sched:def:leap']));
    expect(notes090.scheduler.firedOn090).toEqual(expect.arrayContaining(['w-ok@sched:ok:0', 'w-zero@sched:zero:0']));
  });

  it('the first polls after the upgrade fire the valid trigger under new run ids, and nothing that cannot fire', async () => {
    const { fired, poll } = setup();
    await quiet(async () => { await poll(T + 2600); await poll(T + 3700); });
    expect(fired.filter((f) => f.startsWith('w-ok@'))).toHaveLength(2);
    expect(fired.filter((f) => !f.startsWith('w-ok@'))).toEqual([]);
    for (const f of fired) expect(runIdsOn090.has(f.split('@')[1])).toBe(false);
  });

  it('a stored trigger that cannot fire is marked failed with the reason, naming the way through', async () => {
    const { j, poll } = setup();
    await quiet(() => poll(T + 2600));
    const t = new Map((await listTriggers(j)).map((x) => [x.id, x]));
    for (const id of ['zero', 'ma0']) {
      expect(t.get(id)?.status).toBe('failed');
      expect(t.get(id)?.lastError).toMatch(/cannot fire.*Call scheduleWorkflow again with a valid spec/);
    }
    expect(t.get('ok')?.status).toBe('pending');
  });

  it('re-registering the 0.9.0 specs on boot: the valid one is a no-op, each spec that cannot fire is refused and writes nothing', async () => {
    const { j } = setup();
    expect(await scheduleWorkflow(j, spec('ok'), T + 4000)).toBe('ok');
    for (const id of ['bad', 'zero', 'ma0', 'two']) {
      const before = await j.get(`sched:def:${id}`);
      await expect(scheduleWorkflow(j, spec(id), T + 4000)).rejects.toThrow(new RegExp(`trigger '${id}'`));
      expect(await j.get(`sched:def:${id}`)).toEqual(before);
    }
  });

  it('a corrected spec replaces a stored one that cannot fire, and its fires never reuse a 0.9.0 run id', async () => {
    const { j, fired, poll } = setup();
    await quiet(async () => {
      await scheduleWorkflow(j, { id: 'bad', cron: '0 3 * * *', name: 'w-bad' }, T + 4000);
      await scheduleWorkflow(j, { id: 'zero', every: 1000, name: 'w-zero' }, T + 4000);
      await scheduleWorkflow(j, { id: 'ma0', every: 1000, maxAttempts: 1, name: 'w-ma0' }, T + 4000);
      await poll(T + 6000);
      await poll(Date.UTC(2026, 0, 1, 3, 0, 30));
    });
    for (const name of ['w-bad', 'w-zero', 'w-ma0']) expect(fired.some((f) => f.startsWith(`${name}@`))).toBe(true);
    for (const f of fired) expect(runIdsOn090.has(f.split('@')[1]), f).toBe(false);
  });

  it("the 0.9.0 {at, every} trigger: `ifExists: 'replace'` applies one field, and its first fire does not reuse the run id 0.9.0 fired", async () => {
    const { j, fired, poll } = setup();
    await quiet(async () => {
      await scheduleWorkflow(j, { id: 'two', every: 1000, name: 'w-two', ifExists: 'replace' }, T + 4000);
      await poll(T + 6000);
    });
    const two = fired.filter((f) => f.startsWith('w-two@'));
    expect(two.length).toBeGreaterThan(0);
    for (const f of two) expect(runIdsOn090.has(f.split('@')[1]), `${f} was already fired by 0.9.0`).toBe(false);
  });

  it('the leap-day cron 0.9.0 refused in 2026: registered again, it fires on 2028-02-29 and not before, then 2032-02-29', async () => {
    const { j, fired, poll } = setup();
    await quiet(async () => {
      await scheduleWorkflow(j, spec('leap'), T + 5);
      for (const at of [T + 10, Date.UTC(2027, 1, 28, 23, 59), Date.UTC(2028, 1, 28, 23, 59)]) await poll(at);
    });
    expect(fired.filter((f) => f.startsWith('w-leap@'))).toEqual([]);
    await quiet(() => poll(Date.UTC(2028, 1, 29, 0, 0, 30)));
    expect(fired.filter((f) => f.startsWith('w-leap@'))).toHaveLength(1);
    const leap = (await listTriggers(j)).find((t) => t.id === 'leap');
    expect(leap?.status).toBe('pending');
    expect(leap?.nextRunAt).toBe(Date.UTC(2032, 1, 29));
  });
});
