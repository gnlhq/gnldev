// A trigger is two records, `sched:def:<id>` and `sched:state:<id>`. Invariant: after a crash at any
// point of a registration (or of `moveTrigger`), running the SAME call again converges to a trigger the
// poller fires — and never fires a run id twice.
//
// Before: a replace / repair wrote the two halves as two puts and the same-spec check read only the
// definition. A crash between the puts left a new definition next to the old state (`done` or
// `failed`), and the identical call on the next boot found "the same spec" and did nothing: the
// trigger never fired again (4/4 scenarios, in-memory and SQLite).
//
// Now: `writeTrigger` is the one writer (atomic `applyBatch` where the journal has it), and a journal
// without it gets a state that names its definition (`of`), which the same-spec path checks.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { InMemoryJournal, toJournal, type Journal } from '@gnldev/durable';
import { SqliteStorage } from '@gnldev/durable/sqlite';
import { scheduleWorkflow, pollScheduler, listTriggers, moveTrigger, type WorkflowRunner } from '../src/index.js';

let warn: ReturnType<typeof vi.spyOn>;
beforeEach(() => { warn = vi.spyOn(console, 'warn').mockImplementation(() => {}); });
afterEach(() => { warn.mockRestore(); });

/** A journal whose next put to a key starting with `crashBefore` throws — the process "stops" there. */
function crashing(base: Journal, batch: boolean) {
  const ctl = { crashBefore: '' };
  const j = Object.create(base) as Journal;
  j.put = async (k, v) => {
    if (ctl.crashBefore !== '' && k.startsWith(ctl.crashBefore)) {
      ctl.crashBefore = '';
      throw new Error(`crash before ${k}`);
    }
    return base.put(k, v);
  };
  for (const m of ['get', 'putIfAbsent', 'putIfMatch', 'listKeys', 'deletePrefix', 'incrBy', 'getCounters', 'getMany', 'now'] as const) {
    const f = (base as any)[m];
    if (typeof f === 'function') (j as any)[m] = f.bind(base);
  }
  (j as any).applyBatch = batch && base.applyBatch ? base.applyBatch.bind(base) : undefined;
  return { j, ctl };
}

function runner(): WorkflowRunner & { runIds: string[] } {
  const runIds: string[] = [];
  return { runIds, async runWorkflow(_n, _i, o) { runIds.push(o?.runId ?? '?'); return { runId: o?.runId ?? '?' }; } };
}

const T0 = Date.UTC(2026, 0, 1);
const stores = [
  ['in-memory, applyBatch', () => new InMemoryJournal() as Journal, true],
  ['sqlite, applyBatch', () => toJournal(new SqliteStorage(':memory:').runs), true],
  ['in-memory, no applyBatch', () => new InMemoryJournal() as Journal, false],
  ['sqlite, no applyBatch', () => toJournal(new SqliteStorage(':memory:').runs), false],
] as const;

async function tryCall(f: () => Promise<unknown>): Promise<string> {
  try { await f(); return ''; } catch (e) { return (e as Error).message; }
}

describe.each(stores)('a crash between a trigger\'s two writes — %s', (_label, mk, batch) => {
  it('a fired one-shot replaced by every:1000 — the identical call after the crash leaves a trigger that fires', async () => {
    const { j, ctl } = crashing(mk(), batch);
    const r = runner();
    await scheduleWorkflow(j, { id: 'job', name: 'w', at: T0 + 1000 }, T0);
    await pollScheduler(j, r, T0 + 2000);
    expect(r.runIds).toEqual(['sched:job:0']);
    ctl.crashBefore = 'sched:state:';
    const crashed = await tryCall(() => scheduleWorkflow(j, { id: 'job', name: 'w', every: 1000, ifExists: 'replace' }, T0 + 3000));
    // Without applyBatch the window is real and was hit; with it there is no window to hit.
    expect(crashed).toMatch(batch ? /^$/ : /crash before sched:state:/);
    // A poll between the crash and the reboot does not fire the old one-shot again.
    await pollScheduler(j, r, T0 + 3500);
    expect(r.runIds).toEqual(['sched:job:0']);
    await scheduleWorkflow(j, { id: 'job', name: 'w', every: 1000, ifExists: 'replace' }, T0 + 4000);
    for (let k = 1; k <= 3; k++) await pollScheduler(j, r, T0 + 4000 + k * 1000);
    expect(r.runIds.length).toBeGreaterThan(1);
    expect(new Set(r.runIds).size, 'a run id fired twice').toBe(r.runIds.length);
    expect((await listTriggers(j))[0]).toMatchObject({ id: 'job', kind: 'every', status: 'pending' });
  });

  it("0.9's every:0 trigger, failed by the poller → the corrected call crashes → the identical call fires it", async () => {
    const base = mk();
    const { j, ctl } = crashing(base, batch);
    const r = runner();
    await scheduleWorkflow(j, { id: 'hb', name: 'w', every: 1000 }, T0);
    const def = await base.get<Record<string, unknown>>('sched:def:hb');
    await base.put('sched:def:hb', { ...def, value: 0 }); // the shape 0.9 accepted
    await pollScheduler(j, r, T0 + 5000);
    expect((await listTriggers(j))[0]!.status).toBe('failed');
    ctl.crashBefore = 'sched:state:hb';
    await tryCall(() => scheduleWorkflow(j, { id: 'hb', name: 'w', every: 1000 }, T0 + 6000));
    await scheduleWorkflow(j, { id: 'hb', name: 'w', every: 1000 }, T0 + 7000);
    for (let k = 1; k <= 3; k++) await pollScheduler(j, r, T0 + 7000 + k * 1500);
    expect(r.runIds.length).toBeGreaterThan(0);
    expect((await listTriggers(j))[0]!.status).toBe('pending');
  });

  // ── siblings ──────────────────────────────────────────────────────────────────────────────────
  it('moveTrigger stopped between the owned trigger\'s two writes — calling it again finishes the move; one trigger fires, the count carries', async () => {
    const { j, ctl } = crashing(mk(), batch);
    const r = runner();
    await scheduleWorkflow(j, { id: 'nightly', name: 'w', every: 1000 }, T0);
    await pollScheduler(j, r, T0 + 1000);
    await pollScheduler(j, r, T0 + 2000); // fireCount 2
    ctl.crashBefore = 'sched:state:';
    await tryCall(() => moveTrigger(j, 'nightly', { orgId: 'acme' }));
    const toId = await moveTrigger(j, 'nightly', { orgId: 'acme' });
    const listed = await listTriggers(j);
    const moved = listed.find((t) => t.id === toId)!;
    expect(moved).toMatchObject({ status: 'pending', fireCount: 2, orgId: 'acme' });
    expect(listed.find((t) => t.id === 'nightly')).toMatchObject({ status: 'done', movedTo: toId });
    const before = r.runIds.length;
    await pollScheduler(j, r, T0 + 3000, { runnerForOrg: () => r });
    expect(r.runIds.slice(before)).toEqual([`sched:${toId}:2`]); // only the owned one fired
  });

  it("'keep' with a different spec and a lost state — the repair takes the STORED schedule, not the one it was told to ignore", async () => {
    const base = mk();
    const { j } = crashing(base, batch);
    await scheduleWorkflow(j, { id: 'k', name: 'w', every: 60_000 }, T0);
    await base.deletePrefix!('sched:state:k');
    await scheduleWorkflow(j, { id: 'k', name: 'w', every: 5_000, ifExists: 'keep' }, T0 + 1000);
    expect((await listTriggers(j))[0]).toMatchObject({ value: 60_000, nextRunAt: T0 + 1000 + 60_000 });
  });

  it('a state written before the fingerprint (no `of`) is trusted: a done one-shot registered again stays done, nothing fires, nothing warns', async () => {
    const base = mk();
    const { j } = crashing(base, batch);
    const r = runner();
    await scheduleWorkflow(j, { id: 'once', name: 'w', at: T0 + 1000 }, T0);
    await pollScheduler(j, r, T0 + 2000);
    const { of: _of, ...legacy } = (await base.get<Record<string, unknown>>('sched:state:once'))!;
    await base.put('sched:state:once', legacy);
    warn.mockClear();
    await scheduleWorkflow(j, { id: 'once', name: 'w', at: T0 + 1000 }, T0 + 3000);
    await pollScheduler(j, r, T0 + 4000);
    expect(r.runIds).toEqual(['sched:once:0']);
    expect(await base.get('sched:state:once')).toEqual(legacy);
    expect(warn).not.toHaveBeenCalled();
  });

  it('once the poller has fired a trigger, the identical registration is a no-op (the poller stamps the state it writes)', async () => {
    const base = mk();
    const { j } = crashing(base, batch);
    const r = runner();
    await scheduleWorkflow(j, { id: 'p', name: 'w', every: 1000 }, T0);
    const { of: _of, ...legacy } = (await base.get<Record<string, unknown>>('sched:state:p'))!;
    await base.put('sched:state:p', legacy); // a pre-0.10 state
    await pollScheduler(j, r, T0 + 1000);
    const afterFire = await base.get('sched:state:p');
    expect(afterFire).toMatchObject({ fireCount: 1, of: expect.any(String) });
    warn.mockClear();
    await scheduleWorkflow(j, { id: 'p', name: 'w', every: 1000 }, T0 + 1500);
    expect(await base.get('sched:state:p')).toEqual(afterFire);
    expect(warn).not.toHaveBeenCalled();
  });
});
