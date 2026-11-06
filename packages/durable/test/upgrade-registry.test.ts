// A package adds its upgrade steps to a store with `registerUpgradeSteps(storage, [...])`, and
// `storage.upgrade()` — dry run, `only`, the stop on the first failure, the wait for the earlier version's
// processes — treats them as the store's own. Two fake packages stand in for the real ones: `fakeA` and
// `fakeB`. Run on every store with a real backend this machine has (Postgres with GNL_PG_URL, in its own
// schema).
import { describe, it, expect, afterEach, afterAll } from 'vitest';
import pg from 'pg';
import {
  InMemoryStorage, toJournal, registerUpgradeSteps, markUpgradeDue, clearUpgradeDue, UpgradeFailedError,
  type Storage, type UpgradeStep, type UpgradeStepFactory,
} from '../src/index.js';
import { SqliteStorage } from '../src/sqlite-storage.js';
import { PostgresStorage } from '../src/postgres-storage.js';

const PG_URL = process.env.GNL_PG_URL;
const SCHEMA = `upg_reg_${process.pid}`;

/** A package step that counts what is asked of it and keeps its own "done" flag, as a real step keeps its data. */
interface Fake { step: UpgradeStep; state: { done: boolean; pendings: number; plans: number; runs: number; failWith?: string } }
function fake(name: string, o: { requires?: string[]; afterOlderGone?: true; storage?: () => Storage; due?: boolean } = {}): Fake {
  const state: Fake['state'] = { done: false, pendings: 0, plans: 0, runs: 0 };
  const step: UpgradeStep = {
    name,
    description: `does ${name}`,
    ...(o.requires ? { requires: o.requires } : {}),
    ...(o.afterOlderGone ? { afterOlderGone: true as const } : {}),
    pending: async () => { state.pendings++; return !state.done; },
    plan: async () => { state.plans++; return { would: name }; },
    run: async () => {
      state.runs++;
      if (state.failWith) throw new Error(state.failWith);
      state.done = true;
      if (o.due && o.storage) await clearUpgradeDue(o.storage(), name);
      return { did: name };
    },
  };
  return { step, state };
}
const factoryOf = (...fs: Fake[]): UpgradeStepFactory => () => fs.map((f) => f.step);

/** Threads as an earlier version left them: a run with a thread and no owner record, so `thread-records` is pending. */
async function oldThread(s: Storage) {
  const j = toJournal(s.runs);
  await j.put('r1:input', { _v: 1, threadId: 't1', resourceId: 'ayse' });
  await j.put('r1:model:0', { text: 'x' });
}

type Make = { make: () => Promise<Storage>; real: boolean };
const stores: Array<[string, Make]> = [
  ['memory', { make: async () => new InMemoryStorage(), real: false }],
  ['sqlite', { make: async () => new SqliteStorage(), real: false }],
];
if (PG_URL) {
  // One schema per test, all named upg_reg_*: the suite touches nothing else in the database. A store's
  // close() ends its pool, so each test gets its own.
  const made: string[] = [];
  const admin = async <T>(f: (c: pg.Client) => Promise<T>) => {
    const c = new pg.Client({ connectionString: PG_URL });
    await c.connect();
    try { return await f(c); } finally { await c.end(); }
  };
  afterAll(async () => { await admin(async (c) => { for (const sc of made) await c.query(`DROP SCHEMA IF EXISTS ${sc} CASCADE`); }); });
  stores.push(['postgres', {
    real: true,
    make: async () => {
      const sc = `${SCHEMA}_${made.length}`;
      made.push(sc);
      await admin((c) => c.query(`DROP SCHEMA IF EXISTS ${sc} CASCADE; CREATE SCHEMA ${sc}`));
      const s = new PostgresStorage({ pool: new pg.Pool({ connectionString: PG_URL, options: `-c search_path=${sc}` }) as never });
      await s.init!();
      return s;
    },
  }]);
}

const open: Storage[] = [];
afterEach(async () => { for (const s of open.splice(0)) await s.close?.().catch(() => {}); });
const made = async (m: Make) => { const s = await m.make(); open.push(s); return s; };

for (const [name, m] of stores) {
  describe(`registered upgrade steps — ${name}`, () => {
    it('R1 a registered step shows in a dry run after the store steps, in registration order, and is not run', async () => {
      const s = await made(m);
      const a = fake('fakeA/step1'); const b = fake('fakeB/step1');
      registerUpgradeSteps(s, [factoryOf(a), factoryOf(b)]);
      const dry = await s.upgrade!({ dryRun: true });
      const names = dry.steps.map((x) => x.name);
      expect(names.slice(-2)).toEqual(['fakeA/step1', 'fakeB/step1']);
      expect(names.indexOf('thread-records')).toBeLessThan(names.indexOf('fakeA/step1'));
      expect(dry.steps.find((x) => x.name === 'fakeA/step1')).toMatchObject({ pending: true, ran: false, detail: { would: 'fakeA/step1' } });
      expect(a.state.runs + b.state.runs).toBe(0);
    });

    it('R2 only runs one registered step; an unknown name is refused and the message lists the registered ones', async () => {
      const s = await made(m);
      const a = fake('fakeA/step1'); const b = fake('fakeB/step1');
      registerUpgradeSteps(s, [factoryOf(a, b)]);
      const r = await s.upgrade!({ only: ['fakeB/step1'] });
      expect(r.steps.filter((x) => x.ran).map((x) => x.name)).toEqual(['fakeB/step1']);
      expect(a.state.runs).toBe(0);
      await expect(s.upgrade!({ only: ['fakeC/step1'] })).rejects.toThrow(/'fakeC\/step1' is not a step of this store\..*fakeA\/step1, fakeB\/step1/);
    });

    it('R3 a registered step that needs a pending store step is refused with the command that runs', async () => {
      const s = await made(m);
      await oldThread(s);
      const a = fake('fakeA/step1', { requires: ['thread-records'] });
      registerUpgradeSteps(s, [factoryOf(a)]);
      await expect(s.upgrade!({ only: ['fakeA/step1'] })).rejects.toThrow(/'fakeA\/step1' needs 'thread-records' first.*only: \['thread-records', 'fakeA\/step1'\]/);
      expect(a.state.runs).toBe(0);
      const r = await s.upgrade!({ only: ['thread-records', 'fakeA/step1'] });
      expect(r.steps.filter((x) => x.ran).map((x) => x.name)).toEqual(['thread-records', 'fakeA/step1']);
    });

    it('R4 the first failure stops the run; the report survives in the error; running again finishes the rest', async () => {
      const s = await made(m);
      const a = fake('fakeA/step1'); const b = fake('fakeB/step1'); const c = fake('fakeC/step1');
      b.state.failWith = 'boom';
      registerUpgradeSteps(s, [factoryOf(a), factoryOf(b), factoryOf(c)]);
      const err = await s.upgrade!().then(() => undefined, (e: unknown) => e);
      expect(err).toBeInstanceOf(UpgradeFailedError);
      const e = err as UpgradeFailedError;
      expect(e.step).toBe('fakeB/step1');
      expect(e.message).toMatch(/step 'fakeB\/step1' failed: boom/);
      const row = (n: string) => e.report.steps.find((x) => x.name === n)!;
      expect(row('fakeA/step1')).toMatchObject({ ran: true });
      expect(row('fakeB/step1')).toMatchObject({ ran: false, failed: { message: 'boom' } });
      expect(row('fakeC/step1')).toMatchObject({ ran: false, notAttempted: true });
      expect(c.state.runs).toBe(0);
      b.state.failWith = undefined;
      const again = await s.upgrade!();
      expect(again.steps.filter((x) => x.ran).map((x) => x.name)).toEqual(['fakeB/step1', 'fakeC/step1']);
      expect(again.steps.find((x) => x.name === 'fakeA/step1')).toMatchObject({ pending: false, ran: false });
      expect(a.state.runs).toBe(1);
    });

    it('R5 a dry run asks pending and plan only, and writes nothing', async () => {
      const s = await made(m);
      await oldThread(s);
      const a = fake('fakeA/step1');
      registerUpgradeSteps(s, [factoryOf(a)]);
      const j = toJournal(s.runs);
      const before = (await j.listKeys('')).sort();
      await s.upgrade!({ dryRun: true });
      expect(a.state).toMatchObject({ runs: 0, done: false });
      expect(a.state.plans).toBe(1);
      expect((await j.listKeys('')).sort()).toEqual(before);
    });

    it('R6 run twice: the second finds nothing pending and runs nothing', async () => {
      const s = await made(m);
      const a = fake('fakeA/step1'); const b = fake('fakeB/step1');
      registerUpgradeSteps(s, [factoryOf(a, b)]);
      await s.upgrade!();
      const second = await s.upgrade!();
      expect(second.steps.some((x) => x.ran || x.pending)).toBe(false);
      expect([a.state.runs, b.state.runs]).toEqual([1, 1]);
    });

    it('R7 an afterOlderGone step is asked and reported as waiting, never run by a plain upgrade; only runs it', async () => {
      const s = await made(m);
      const a = fake('fakeA/step1'); const clean = fake('fakeA/cleanup', { requires: ['fakeA/step1'], afterOlderGone: true });
      registerUpgradeSteps(s, [factoryOf(a, clean)]);
      const r = await s.upgrade!();
      expect(r.steps.find((x) => x.name === 'fakeA/step1')).toMatchObject({ ran: true });
      expect(r.steps.find((x) => x.name === 'fakeA/cleanup')).toMatchObject({ pending: true, ran: false, detail: { waits: expect.any(String) } });
      expect(clean.state.runs).toBe(0);
      const again = await s.upgrade!();
      expect(again.steps.find((x) => x.name === 'fakeA/cleanup')).toMatchObject({ pending: true, ran: false });
      const named = await s.upgrade!({ only: ['fakeA/cleanup'] });
      expect(named.steps.find((x) => x.name === 'fakeA/cleanup')).toMatchObject({ ran: true });
      const last = await s.upgrade!();
      expect(last.steps.find((x) => x.name === 'fakeA/cleanup')).toMatchObject({ pending: false, ran: false });
    });

    it('R7b a dry run also shows what the waiting step would do', async () => {
      const s = await made(m);
      const clean = fake('fakeA/cleanup', { afterOlderGone: true });
      registerUpgradeSteps(s, [factoryOf(clean)]);
      const dry = await s.upgrade!({ dryRun: true });
      expect(dry.steps.find((x) => x.name === 'fakeA/cleanup')?.detail).toMatchObject({ waits: expect.any(String), would: 'fakeA/cleanup' });
    });

    it('R9 a store that was not registered on does not see the steps', async () => {
      const s = await made(m); const other = await made(m);
      registerUpgradeSteps(s, [factoryOf(fake('fakeA/step1'))]);
      expect((await other.upgrade!({ dryRun: true })).steps.some((x) => x.name.includes('/'))).toBe(false);
    });

    it('R11 a debt no registered step answers: dry run reports the line to add; a real run fails with it', async () => {
      const s = await made(m);
      const register = 'registerUpgradeSteps(storage, [fakeAUpgrade])';
      await markUpgradeDue(s, 'fakeA/step1', { by: '@gnldev/fakeA', register, dataVersion: 1, packageVersion: 2 });
      const dry = await s.upgrade!({ dryRun: true });
      expect(dry.steps.find((x) => x.name === 'fakeA/step1')).toMatchObject({ pending: true, ran: false, detail: { notRegistered: true, register, dataVersion: 1, packageVersion: 2 } });
      const err = await s.upgrade!().then(() => undefined, (e: unknown) => e);
      expect(err).toBeInstanceOf(UpgradeFailedError);
      expect((err as Error).message).toContain(register);
      await expect(s.upgrade!({ only: ['fakeA/step1'] })).rejects.toThrow(register);
      // Registered, the debt is the step's: it runs, clears the note, and the next upgrade is quiet.
      const a = fake('fakeA/step1', { due: true, storage: () => s });
      registerUpgradeSteps(s, [factoryOf(a)]);
      const ok = await s.upgrade!();
      expect(ok.steps.find((x) => x.name === 'fakeA/step1')).toMatchObject({ ran: true });
      expect((await s.upgrade!()).steps.some((x) => x.detail?.notRegistered)).toBe(false);
    });

    it('a call naming steps is about those: another package\'s unanswered debt does not fail it', async () => {
      const s = await made(m);
      await markUpgradeDue(s, 'fakeB/step1', { by: 'fakeB', register: 'registerUpgradeSteps(storage, [fakeBUpgrade])' });
      const a = fake('fakeA/step1');
      registerUpgradeSteps(s, [factoryOf(a)]);
      const r = await s.upgrade!({ only: ['fakeA/step1'] });
      expect(r.steps.find((x) => x.name === 'fakeA/step1')).toMatchObject({ ran: true });
      expect(r.steps.some((x) => x.detail?.notRegistered)).toBe(false);
    });

    it('a debt marked twice is one note; a registered step with a debt standing is not "not registered"', async () => {
      const s = await made(m);
      await markUpgradeDue(s, 'fakeA/step1', { by: 'fakeA', register: 'first' });
      await markUpgradeDue(s, 'fakeA/step1', { by: 'fakeA', register: 'second' });
      registerUpgradeSteps(s, [factoryOf(fake('fakeA/step1'))]);
      const dry = await s.upgrade!({ dryRun: true });
      expect(dry.steps.filter((x) => x.name === 'fakeA/step1')).toHaveLength(1);
      expect(dry.steps[dry.steps.length - 1]!.detail?.notRegistered).toBeUndefined();
    });
  });
}

describe('R8 registration is checked where it is made', () => {
  const none = () => new InMemoryStorage();
  const attempt = (s: Storage, ...fs: UpgradeStep[]) => () => registerUpgradeSteps(s, [() => fs]);
  const step = (name: string, extra: Partial<UpgradeStep> = {}): UpgradeStep => ({ name, description: name, pending: async () => false, plan: async () => ({}), run: async () => ({}), ...extra });

  it('refuses a name that is not <package>/<step>, a taken name, a forward requires, and a step with no plan; registers nothing', async () => {
    const s = none();
    expect(attempt(s, step('lanes'))).toThrow(TypeError);
    expect(attempt(s, step('queue/lanes/extra'))).toThrow(/is not named '<package>\/<step>'/);
    expect(attempt(s, step('fakeA/b', { requires: ['fakeA/a'] }), step('fakeA/a'))).toThrow(/requires 'fakeA\/a', which is not a step of this store or one registered before it/);
    expect(attempt(s, { ...step('fakeA/a'), plan: undefined })).toThrow(/has no plan\(\)/);
    expect(attempt(s, step('fakeA/a'), step('fakeA/a'))).toThrow(/already registered/);
    expect(attempt(s, step('fakeA/normal', { requires: ['fakeA/waits'] }))).toThrow(/is not a step/);
    expect((await s.upgrade!({ dryRun: true })).steps.some((x) => x.name.includes('/'))).toBe(false);
    registerUpgradeSteps(s, [() => step('fakeA/a')]);
    expect(attempt(s, step('fakeA/a'))).toThrow(/already registered/);
  });

  it('a step that does not wait may not require one that does', () => {
    const s = none();
    const waits = step('fakeA/waits', { afterOlderGone: true });
    expect(attempt(s, waits, step('fakeA/normal', { requires: ['fakeA/waits'] }))).toThrow(/waits for the earlier version's processes/);
    expect(attempt(none(), waits, step('fakeA/also', { requires: ['fakeA/waits'], afterOlderGone: true }))).not.toThrow();
  });

  it('a step may require a store step; the same factory twice registers once', async () => {
    const s = none();
    const f: UpgradeStepFactory = () => step('fakeA/a', { requires: ['thread-records'] });
    registerUpgradeSteps(s, [f]);
    registerUpgradeSteps(s, [f, f]);
    expect((await s.upgrade!({ dryRun: true })).steps.filter((x) => x.name === 'fakeA/a')).toHaveLength(1);
  });

  it('a store with no upgrade() is refused', () => {
    expect(() => registerUpgradeSteps({ name: 'custom' } as never, [() => step('fakeA/a')])).toThrow(/has no upgrade\(\)/);
  });
});
