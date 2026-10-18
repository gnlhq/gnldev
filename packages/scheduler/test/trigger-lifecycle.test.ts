// A trigger's lifecycle after it is scheduled: remove it (`unscheduleWorkflow`), stop it for a while
// (`pauseTrigger` / `resumeTrigger`). Before these existed the only way to stop a trigger was to delete
// journal keys by hand — and a definition left without its state is "repaired" (re-created) by the
// next boot's scheduleWorkflow, so a hand-deleted trigger came back.
//
// One owner decides whether a trigger fires: its state's `status` (`'pending'` and due). Remove and pause
// are state transitions written by the one trigger writer (`writeTrigger`, CAS against the state read),
// so they race with a fire the same way two pollers do: one write wins, none is lost.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { InMemoryJournal, toJournal, type Journal } from '@gnldev/durable';
import { SqliteStorage } from '@gnldev/durable/sqlite';
import {
  scheduleWorkflow, pollScheduler, listTriggers, unscheduleWorkflow, pauseTrigger, resumeTrigger,
  type WorkflowRunner,
} from '../src/index.js';

let warn: ReturnType<typeof vi.spyOn>;
beforeEach(() => { warn = vi.spyOn(console, 'warn').mockImplementation(() => {}); });
afterEach(() => { warn.mockRestore(); });

/** A durable-like runner: a run id that already completed returns its recorded answer without executing. */
function runner(): WorkflowRunner & { executed: string[]; calls: string[] } {
  const executed: string[] = [];
  const calls: string[] = [];
  return {
    executed, calls,
    async runWorkflow(_n, _i, o) {
      const id = o?.runId ?? '?';
      calls.push(id);
      if (!executed.includes(id)) executed.push(id);
      return { runId: id };
    },
  };
}

/** A runner whose run blocks until `open()` — a fire in flight, holding its fire lock. */
function gated(): WorkflowRunner & { executed: string[]; open: () => void; started: Promise<void> } {
  let open!: () => void;
  let started!: () => void;
  const gate = new Promise<void>((r) => { open = r; });
  const startedP = new Promise<void>((r) => { started = r; });
  const executed: string[] = [];
  return {
    executed, open: () => open(), started: startedP,
    async runWorkflow(_n, _i, o) {
      executed.push(o?.runId ?? '?');
      started();
      await gate;
      return { runId: o?.runId ?? '?' };
    },
  };
}

const T0 = Date.UTC(2026, 0, 1);
const MIN = 60_000;
const stores = [
  ['in-memory', () => new InMemoryJournal() as Journal],
  ['sqlite', () => toJournal(new SqliteStorage(':memory:').runs)],
] as const;

describe.each(stores)('unscheduleWorkflow — %s', (_l, mk) => {
  it('a removed trigger never fires again and is gone from listTriggers', async () => {
    const j = mk();
    const r = runner();
    await scheduleWorkflow(j, { id: 'tick', name: 'wf', every: MIN }, T0);
    await pollScheduler(j, r, T0 + MIN);
    expect(r.executed).toEqual(['sched:tick:0']);

    expect(await unscheduleWorkflow(j, { id: 'tick' })).toBe(true);
    for (let i = 2; i < 6; i++) await pollScheduler(j, r, T0 + i * MIN);
    expect(r.executed).toEqual(['sched:tick:0']);
    expect(await listTriggers(j)).toEqual([]);
    // Removing it again, or something that never existed, says so instead of pretending.
    expect(await unscheduleWorkflow(j, { id: 'tick' })).toBe(false);
    expect(await unscheduleWorkflow(j, { id: 'never-was' })).toBe(false);
  });

  it('removed while a fire is in flight: the run finishes, its late result does not bring the trigger back', async () => {
    const j = mk();
    const g = gated();
    await scheduleWorkflow(j, { id: 'long', name: 'wf', every: MIN }, T0);
    const poll = pollScheduler(j, g, T0 + MIN, { lockTtlMs: 10 * MIN });
    await g.started;
    expect(await unscheduleWorkflow(j, { id: 'long' })).toBe(true);
    g.open();
    expect(await poll).toMatchObject({ fired: 0 });
    for (let i = 2; i < 5; i++) await pollScheduler(j, g, T0 + i * MIN);
    expect(g.executed).toEqual(['sched:long:0']);
    expect(await listTriggers(j)).toEqual([]);
  });

  it('scheduling the id again after removal is a new trigger, and its first run id is one no run used', async () => {
    const j = mk();
    const r = runner();
    await scheduleWorkflow(j, { id: 'job', name: 'wf', every: MIN }, T0);
    await pollScheduler(j, r, T0 + MIN);
    await pollScheduler(j, r, T0 + 2 * MIN);
    await unscheduleWorkflow(j, { id: 'job' });
    // A DIFFERENT spec: a removed trigger is absent, so the default ifExists ('refuse') has nothing to refuse.
    await scheduleWorkflow(j, { id: 'job', name: 'wf', every: 5 * MIN }, T0 + 3 * MIN);
    await pollScheduler(j, r, T0 + 8 * MIN);
    expect(r.calls).toEqual(['sched:job:0', 'sched:job:1', 'sched:job:2']);
    expect((await listTriggers(j)).map((t) => [t.id, t.status, t.value])).toEqual([['job', 'pending', 5 * MIN]]);
  });

  it('an owned trigger is named by its owner: removing ayse\'s leaves bora\'s', async () => {
    const j = mk();
    const r = runner();
    const a = await scheduleWorkflow(j, { id: 'digest', name: 'wf', every: MIN, resourceId: 'ayse', orgId: 'acme' }, T0);
    const b = await scheduleWorkflow(j, { id: 'digest', name: 'wf', every: MIN, resourceId: 'bora', orgId: 'acme' }, T0);
    expect(await unscheduleWorkflow(j, { id: 'digest', resourceId: 'ayse', orgId: 'acme' })).toBe(true);
    expect((await listTriggers(j)).map((t) => t.id)).toEqual([b]);
    expect(a).not.toBe(b);
    // The system id `digest` is a different trigger, and there is none.
    expect(await unscheduleWorkflow(j, { id: 'digest' })).toBe(false);
    void r;
  });
});

describe.each(stores)('pauseTrigger / resumeTrigger — %s', (_l, mk) => {
  it('a paused trigger does not fire, and the boot-time scheduleWorkflow does not unpause it', async () => {
    const j = mk();
    const r = runner();
    const spec = { id: 'p', name: 'wf', every: MIN };
    await scheduleWorkflow(j, spec, T0);
    expect(await pauseTrigger(j, { id: 'p' })).toBe(true);
    expect(await pauseTrigger(j, { id: 'p' })).toBe(true); // idempotent
    await scheduleWorkflow(j, spec, T0 + MIN); // a restart re-registers the same spec
    for (let i = 1; i < 5; i++) await pollScheduler(j, r, T0 + i * MIN);
    expect(r.calls).toEqual([]);
    expect((await listTriggers(j))[0]).toMatchObject({ id: 'p', status: 'paused' });
  });

  it('resume does not run the occurrences that fell inside the pause — not even with misfire: catchup', async () => {
    const j = mk();
    const r = runner();
    await scheduleWorkflow(j, { id: 'c', name: 'wf', every: MIN, misfire: 'catchup' }, T0);
    await pollScheduler(j, r, T0 + MIN); // fires slot T0+1m
    await pauseTrigger(j, { id: 'c' });
    // 10 slots pass while paused.
    expect(await resumeTrigger(j, { id: 'c' }, T0 + 11 * MIN + 30_000)).toBe(true);
    const [t] = await listTriggers(j);
    expect(t).toMatchObject({ status: 'pending', nextRunAt: T0 + 12 * MIN, fireCount: 1 }); // on the grid, after now
    for (let i = 0; i < 5; i++) await pollScheduler(j, r, T0 + 12 * MIN);
    expect(r.calls).toEqual(['sched:c:0', 'sched:c:1']);
  });

  it('paused while a fire is in flight: that fire is recorded once, and resume does not run it again', async () => {
    const j = mk();
    const g = gated();
    await scheduleWorkflow(j, { id: 'f', name: 'wf', every: MIN }, T0);
    const poll = pollScheduler(j, g, T0 + MIN, { lockTtlMs: 10 * MIN });
    await g.started;
    expect(await pauseTrigger(j, { id: 'f' })).toBe(true);
    g.open();
    expect(await poll).toMatchObject({ fired: 1 });
    // The outcome landed under the pause: counter advanced, still paused.
    expect((await listTriggers(j))[0]).toMatchObject({ status: 'paused', fireCount: 1 });
    await resumeTrigger(j, { id: 'f' }, T0 + 5 * MIN);
    await pollScheduler(j, g, T0 + 6 * MIN);
    expect(g.executed).toEqual(['sched:f:0', 'sched:f:1']);
  });

  it('a one-shot paused past its time runs once on resume (skipping it would delete it)', async () => {
    const j = mk();
    const r = runner();
    await scheduleWorkflow(j, { id: 'once', name: 'wf', at: T0 + MIN }, T0);
    await pauseTrigger(j, { id: 'once' });
    await pollScheduler(j, r, T0 + 2 * MIN);
    await resumeTrigger(j, { id: 'once' }, T0 + 3 * MIN);
    await pollScheduler(j, r, T0 + 3 * MIN);
    await pollScheduler(j, r, T0 + 4 * MIN);
    expect(r.calls).toEqual(['sched:once:0']);
    expect((await listTriggers(j))[0]).toMatchObject({ status: 'done' });
  });

  it('nothing to pause or resume says false: unknown, removed, done', async () => {
    const j = mk();
    const r = runner();
    expect(await pauseTrigger(j, { id: 'x' })).toBe(false);
    expect(await resumeTrigger(j, { id: 'x' })).toBe(false);
    await scheduleWorkflow(j, { id: 'gone', name: 'wf', every: MIN }, T0);
    await unscheduleWorkflow(j, { id: 'gone' });
    expect(await pauseTrigger(j, { id: 'gone' })).toBe(false);
    await scheduleWorkflow(j, { id: 'one', name: 'wf', at: T0 }, T0);
    await pollScheduler(j, r, T0);
    expect(await pauseTrigger(j, { id: 'one' })).toBe(false);
    expect(await resumeTrigger(j, { id: 'one' })).toBe(false);
  });

  it('removing a paused trigger removes it; re-registering it starts unpaused', async () => {
    const j = mk();
    await scheduleWorkflow(j, { id: 'pr', name: 'wf', every: MIN }, T0);
    await pauseTrigger(j, { id: 'pr' });
    expect(await unscheduleWorkflow(j, { id: 'pr' })).toBe(true);
    await scheduleWorkflow(j, { id: 'pr', name: 'wf', every: MIN }, T0);
    expect((await listTriggers(j))[0]).toMatchObject({ status: 'pending' });
  });
});

describe('a crash during pause / remove', () => {
  /** A journal whose next state write throws — the process stops before the transition lands. */
  function crashing() {
    const base = new InMemoryJournal() as Journal;
    const ctl = { armed: false };
    const j = Object.create(base) as Journal;
    const boom = () => { ctl.armed = false; throw new Error('crash'); };
    j.put = async (k, v) => { if (ctl.armed && k.startsWith('sched:state:')) boom(); return base.put(k, v); };
    j.putIfMatch = async (k, e, v) => { if (ctl.armed && k.startsWith('sched:state:')) boom(); return base.putIfMatch!(k, e, v); };
    for (const m of ['get', 'putIfAbsent', 'listKeys', 'deletePrefix', 'applyBatch', 'incrBy', 'getCounters', 'now'] as const) (j as any)[m] = (base as any)[m].bind(base);
    return { j, ctl };
  }

  it('the trigger is unchanged after the crash, and the same call again completes it', async () => {
    const { j, ctl } = crashing();
    const r = runner();
    await scheduleWorkflow(j, { id: 'k', name: 'wf', every: MIN }, T0);
    ctl.armed = true;
    await expect(pauseTrigger(j, { id: 'k' })).rejects.toThrow('crash');
    expect((await listTriggers(j))[0]).toMatchObject({ status: 'pending' });
    expect(await pauseTrigger(j, { id: 'k' })).toBe(true);
    ctl.armed = true;
    await expect(unscheduleWorkflow(j, { id: 'k' })).rejects.toThrow('crash');
    expect((await listTriggers(j))[0]).toMatchObject({ status: 'paused' });
    expect(await unscheduleWorkflow(j, { id: 'k' })).toBe(true);
    await pollScheduler(j, r, T0 + 5 * MIN);
    expect(r.calls).toEqual([]);
  });
});
