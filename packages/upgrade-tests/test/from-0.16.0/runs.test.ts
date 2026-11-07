// Upgrade from 0.16.0, outside the queue: the store 0.16.0 left (fixtures/0.16.0/runs.db and
// postgres-runs.sql, written by generate/0.16.0-runs.mjs with the published 0.16.0 and a fixed clock; the
// scenario is generate/crash-runs.mjs), opened by the current code. The store holds
//
//   r-done          a completed run, its tool's result, its thread's messages;
//   r-mid-recover   a run stopped in its second step: `note` finished, `charge` started and wrote no result
//                   (the process died inside it); `charge` has a recover() hook;
//   r-mid-human     the same with `wire`, which has none;
//   r-pending       a run waiting for an approval.
//
// What has to hold, on Sqlite and on a real Postgres:
//
//   R1 opening it, `storage.upgrade({ dryRun })`, `pendingWork`, listing and reading change no record;
//   R2 the completed run reads as it did, its thread's messages are there, and asking for the run again
//      returns its answer and runs no tool;
//   R3 `pendingWork` names the two calls in doubt (with the key they carried and the arguments the model
//      gave) and the one run awaiting an approval;
//   R4 a run stopped in a tool is continued by the crash ladder, never blindly: `note`, which finished,
//      does not run again; `charge` is first asked (`recover()`, with its key) — if the provider says it
//      happened, the run continues from that answer and the body does not run; if it says it did not, the
//      body runs once, and a second continuation runs nothing;
//   R5 a tool with no recover() is not run again either: the continuation is refused (the same refusal
//      each time) and the call stays in doubt until a person decides — declares it done (the record
//      `gnl pending` writes), or says it did not happen (`approvals`), and then the body runs once;
//   R6 the run awaiting an approval stays suspended without one, runs its tool once with it, and not again
//      when it is approved twice;
//   R7 after all of it, no record 0.16.0 wrote is gone;
//   R8 a process that merely starts on the store (its sweeper on) takes the dead process's runs over by
//      itself, and does R4 and R5 without being asked: the run with a recover() hook finishes, the one
//      without stays a person's, the one awaiting an approval stays suspended.
//
// Postgres runs with GNL_INTEGRATION=1 against GNL_PG_URL (a URL that may CREATE DATABASE), as the other
// real-backend tests here; its databases are named GNL_TEST_DB_PREFIX (default `gnl_upgrade_`) + a suffix.
import { copyFileSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import * as durable from '@gnldev/durable';
import { SqliteStorage } from '@gnldev/durable/sqlite';
import { PostgresStorage } from '@gnldev/durable/postgres';
import { z } from 'zod';
import { RUNS, THREAD, gnlOf } from '../../generate/crash-runs.mjs';

const FIXTURES = fileURLToPath(new URL('../../fixtures/0.16.0/', import.meta.url));
const m = { durable, z };
const require = createRequire(import.meta.url);
const written = JSON.parse(readFileSync(join(FIXTURES, 'notes-runs-sqlite.json'), 'utf8')).notes.written;

const RUN_PG = process.env.GNL_INTEGRATION === '1' && !!process.env.GNL_PG_URL;
const PG_URL = process.env.GNL_PG_URL ?? '';
const DB_PREFIX = process.env.GNL_TEST_DB_PREFIX ?? 'gnl_upgrade_';
const ALL = Object.values(RUNS);

const cleanups: Array<() => Promise<void> | void> = [];
afterEach(async () => {
  while (cleanups.length) await cleanups.pop()!();
});

interface Backend {
  name: string;
  /** The 0.16.0 store, loaded fresh from the fixture: a new storage object on it each call. */
  old(): Promise<{ open(): durable.Storage }>;
}

const sqlite: Backend = {
  name: 'Sqlite',
  async old() {
    const dir = mkdtempSync(join(tmpdir(), 'gnl-upgrade-0160-'));
    const file = join(dir, 'runs.db');
    copyFileSync(join(FIXTURES, 'runs.db'), file);
    const opened: durable.Storage[] = [];
    cleanups.push(async () => { for (const s of opened) await s.close?.(); rmSync(dir, { recursive: true, force: true }); });
    return { open() { const s = new SqliteStorage(file); opened.push(s); return s; } };
  },
};

const postgres: Backend = {
  name: 'Postgres',
  async old() {
    const pg = require('pg');
    const admin = new pg.Client({ connectionString: PG_URL });
    await admin.connect();
    const db = `${DB_PREFIX}${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 7)}`;
    await admin.query(`CREATE DATABASE ${db}`);
    const u = new URL(PG_URL);
    u.pathname = `/${db}`;
    const client = new pg.Client({ connectionString: u.toString() });
    await client.connect();
    await client.query(readFileSync(join(FIXTURES, 'postgres-runs.sql'), 'utf8'));
    await client.end();
    const opened: durable.Storage[] = [];
    cleanups.push(async () => {
      for (const s of opened) await s.close?.();
      await admin.query(`DROP DATABASE IF EXISTS ${db} WITH (FORCE)`);
      await admin.end();
    });
    return { open() { const s = new PostgresStorage({ connectionString: u.toString() }); opened.push(s); return s; } };
  },
};

/** The current code over the store, with a fresh gateway and effect log: what a restarted process has. */
function process_(storage: durable.Storage, gateway = new Map<string, unknown>(), sweep = false) {
  const env = { effects: [] as string[], gateway };
  const { g, memory, run } = gnlOf(m, storage, env, { sweep }) as { g: any; memory: any; run: (agent: string, runId: string, who: string, threadId?: string, extra?: object) => Promise<string> };
  return { env, g, memory, run, journal: durable.toJournal(storage.runs) };
}
const bodies = (effects: string[]) => effects.filter((e) => !e.startsWith('recover:'));
const inDoubt = async (j: durable.Journal, runId: string) => (await durable.pendingWork(j)).inDoubt.filter((c) => c.runId === runId);
/** Every key and value of the four runs, as stored. */
async function records(j: durable.Journal): Promise<Record<string, unknown>> {
  const out: Record<string, unknown> = {};
  for (const id of ALL) for (const k of await j.listKeys(`${id}:`)) out[k] = await j.get(k);
  return out;
}

for (const b of [sqlite, ...(RUN_PG ? [postgres] : [])]) {
  describe(`upgrade from 0.16.0 — runs, ${b.name}`, () => {
    it('R1: opening it, a dry-run upgrade, pendingWork, listing and reading change no record', async () => {
      const old = await b.old();
      const s = old.open();
      const p = process_(s);
      const before = await records(p.journal);
      expect(Object.keys(before).length).toBeGreaterThan(40);
      const dry = await s.upgrade!({ dryRun: true });
      expect(dry.steps.filter((x) => x.pending).map((x) => x.name)).toEqual([]);
      await durable.pendingWork(p.journal);
      const listed = (await s.runs.listRuns({ limit: 50 })).items;
      expect(listed.map((r) => r.runId).sort()).toEqual([...ALL].sort());
      await p.memory.getMessages(THREAD.done);
      expect(await records(p.journal)).toEqual(before);
      // A second open (a restart, another process) finds the same.
      expect(await records(process_(old.open()).journal)).toEqual(before);
    });

    it('R2: the completed run reads as it did, its thread is there, and asking for it again runs no tool', async () => {
      const s = (await b.old()).open();
      const p = process_(s);
      const listed = Object.fromEntries((await s.runs.listRuns({ limit: 50 })).items.map((r) => [r.runId, r]));
      expect(listed[RUNS.done]).toMatchObject({ status: 'completed', agent: 'noter', resourceId: 'alice', threadId: THREAD.done, toolCalls: 1, modelSteps: 2 });
      expect(listed[RUNS.midRecover]).toMatchObject({ status: 'running', agent: 'twostep', resourceId: 'alice' });
      expect(listed[RUNS.midHuman]).toMatchObject({ status: 'running', agent: 'twohuman', resourceId: 'bob' });
      expect(listed[RUNS.pending]).toMatchObject({ status: 'suspended', agent: 'payer', resourceId: 'alice', threadId: THREAD.pending });
      expect((await p.memory.getMessages(THREAD.done)).length).toBe(written.threadMessages);
      expect(await p.run('noter', RUNS.done, 'alice', THREAD.done)).toBe(written[RUNS.done]);
      expect(await p.run('noter', RUNS.done, 'alice', THREAD.done)).toBe(written[RUNS.done]);
      expect(p.env.effects).toEqual([]);
      expect((await p.memory.getMessages(THREAD.done)).length).toBe(written.threadMessages);
    });

    it('R3: pendingWork names the two calls in doubt, with their key and arguments, and the run awaiting an approval', async () => {
      const s = (await b.old()).open();
      const work = await durable.pendingWork(process_(s).journal);
      expect(work.blocking).toBe(true);
      expect(work.inDoubt.map((c) => ({ runId: c.runId, toolName: c.toolName, status: c.status, idempotencyKey: c.idempotencyKey, input: c.input })).sort((a, c) => a.runId.localeCompare(c.runId))).toEqual([
        { runId: RUNS.midHuman, toolName: 'wire', status: 'running', idempotencyKey: `${RUNS.midHuman}:call_wire`, input: { to: 'acme' } },
        { runId: RUNS.midRecover, toolName: 'charge', status: 'running', idempotencyKey: `${RUNS.midRecover}:call_charge`, input: { amt: 9 } },
      ]);
      expect(work.awaitingApproval.map((a) => a.runId)).toEqual([RUNS.pending]);
    });

    it('R4: a run stopped in a tool with a recover() hook — the provider says it happened: the run continues from that, nothing runs again', async () => {
      const s = (await b.old()).open();
      const gateway = new Map<string, unknown>([[`${RUNS.midRecover}:call_charge`, { charged: 'by the provider, before the crash' }]]);
      const p = process_(s, gateway);
      expect(await p.run('twostep', RUNS.midRecover, 'alice', 't-alice-2')).toBe('ok:ok');
      expect(p.env.effects).toEqual([`recover:${RUNS.midRecover}:call_charge`]);
      expect(await inDoubt(p.journal, RUNS.midRecover)).toEqual([]);
      expect((await s.runs.listRuns({ limit: 50 })).items.find((r) => r.runId === RUNS.midRecover)).toMatchObject({ status: 'completed' });
      // Asked again: the answer, no tool, no new question to the provider.
      expect(await p.run('twostep', RUNS.midRecover, 'alice', 't-alice-2')).toBe('ok:ok');
      expect(p.env.effects).toEqual([`recover:${RUNS.midRecover}:call_charge`]);
    });

    it('R4: ... the provider says it did not: the body runs once, `note` (finished) not at all, and a second continuation runs nothing', async () => {
      const s = (await b.old()).open();
      const p = process_(s);
      expect(await p.run('twostep', RUNS.midRecover, 'alice', 't-alice-2')).toBe('ok:ok');
      expect(bodies(p.env.effects)).toEqual(['charge:{"amt":9}']);
      expect(p.env.effects[0]).toBe(`recover:${RUNS.midRecover}:call_charge`);
      expect(await p.run('twostep', RUNS.midRecover, 'alice', 't-alice-2')).toBe('ok:ok');
      expect(p.env.effects).toHaveLength(2);
      // The other process, then: the same store, nothing to run for this run.
      const other = process_((await b.old()).open());
      expect(other.env.effects).toEqual([]);
      expect(await inDoubt(p.journal, RUNS.midRecover)).toEqual([]);
    });

    it('R5: a tool with no recover() is not run again: refused each time, and in doubt until a person decides', async () => {
      const s = (await b.old()).open();
      const p = process_(s);
      expect(await p.run('twohuman', RUNS.midHuman, 'bob', 't-bob-1')).toBe('error:SideEffectRetryBlockedError');
      expect(await p.run('twohuman', RUNS.midHuman, 'bob', 't-bob-1')).toBe('error:SideEffectRetryBlockedError');
      expect(p.env.effects).toEqual([]);
      const [call] = await inDoubt(p.journal, RUNS.midHuman);
      expect(call).toMatchObject({ toolName: 'wire', idempotencyKey: `${RUNS.midHuman}:call_wire` });
      // What `gnl pending` writes when the person says it happened: the call's result, with who said so.
      expect(await durable.declareInDoubtDone(p.journal, call!, { by: 'ops', note: 'seen in the bank' })).toBe(true);
      expect(await p.journal.get<any>(`${RUNS.midHuman}:tool:call_wire`)).toMatchObject({ status: 'succeeded', declaredBy: { by: 'ops', note: 'seen in the bank' } });
      expect(await inDoubt(p.journal, RUNS.midHuman)).toEqual([]);
      expect(p.env.effects).toEqual([]);
    });

    it('R5: ... and when the person says it did not happen (`approvals`), the body runs once and the run finishes', async () => {
      const s = (await b.old()).open();
      const p = process_(s);
      expect(await p.run('twohuman', RUNS.midHuman, 'bob', 't-bob-1')).toBe('error:SideEffectRetryBlockedError');
      expect(await p.run('twohuman', RUNS.midHuman, 'bob', 't-bob-1', { approvals: { call_wire: true } })).toBe('ok:ok');
      expect(p.env.effects).toEqual(['wire:{"to":"acme"}']);
      expect(await p.run('twohuman', RUNS.midHuman, 'bob', 't-bob-1', { approvals: { call_wire: true } })).toBe('ok:ok');
      expect(p.env.effects).toEqual(['wire:{"to":"acme"}']);
      expect(await inDoubt(p.journal, RUNS.midHuman)).toEqual([]);
    });

    it('R6: the run awaiting an approval stays suspended without one, runs its tool once with it, and not again when approved twice', async () => {
      const s = (await b.old()).open();
      const p = process_(s);
      expect(await p.run('payer', RUNS.pending, 'alice', THREAD.pending)).toBe('suspended');
      expect(p.env.effects).toEqual([]);
      expect(await p.run('payer', RUNS.pending, 'alice', THREAD.pending, { approvals: { call_pay: true } })).toBe('ok:ok');
      expect(await p.run('payer', RUNS.pending, 'alice', THREAD.pending, { approvals: { call_pay: true } })).toBe('ok:ok');
      expect(p.env.effects).toEqual(['pay:{"amt":5}']);
      expect(await p.run('payer', RUNS.pending, 'mallory', THREAD.pending)).toMatch(/^error:/);
      expect(p.env.effects).toEqual(['pay:{"amt":5}']);
    });

    it('R7: after every continuation, every record 0.16.0 wrote is still there, and a finished run is no longer running', async () => {
      const old = await b.old();
      const s = old.open();
      const p = process_(s, new Map([[`${RUNS.midRecover}:call_charge`, { charged: true }]]));
      const before = await records(p.journal);
      await p.run('noter', RUNS.done, 'alice', THREAD.done);
      await p.run('twostep', RUNS.midRecover, 'alice', 't-alice-2');
      await p.run('twohuman', RUNS.midHuman, 'bob', 't-bob-1');
      await p.run('payer', RUNS.pending, 'alice', THREAD.pending, { approvals: { call_pay: true } });
      const after = await records(p.journal);
      expect(Object.keys(before).filter((k) => !(k in after))).toEqual([]);
      // What 0.16.0 recorded as a result stays that result.
      for (const k of Object.keys(before).filter((k) => /:(model|tool):/.test(k) && (before[k] as any)?.status === 'succeeded')) expect(after[k]).toEqual(before[k]);
      expect(await records(process_(old.open()).journal)).toEqual(after);
    });

    it('R8: a process that starts on it takes over the runs of the one that died by itself: recover() answered, no body run, nobody guessed for', async () => {
      const s = (await b.old()).open();
      const p = process_(s, new Map([[`${RUNS.midRecover}:call_charge`, { charged: 'before the crash' }]]), true);
      const status = async () => Object.fromEntries((await s.runs.listRuns({ limit: 50 })).items.map((r) => [r.runId, r.status]));
      const until = Date.now() + 20_000;
      while ((await status())[RUNS.midRecover] !== 'completed' && Date.now() < until) await new Promise((r) => setTimeout(r, 200));
      await new Promise((r) => setTimeout(r, 2_500)); // a second sweep finds nothing more to do
      expect(await status()).toEqual({ [RUNS.done]: 'completed', [RUNS.midRecover]: 'completed', [RUNS.midHuman]: 'running', [RUNS.pending]: 'suspended' });
      expect(p.env.effects).toEqual([`recover:${RUNS.midRecover}:call_charge`]);
      const work = await durable.pendingWork(p.journal);
      expect(work.inDoubt.map((c) => c.runId)).toEqual([RUNS.midHuman]);
      expect(work.awaitingApproval.map((a) => a.runId)).toEqual([RUNS.pending]);
    });
  });
}
