// A live process whose liveness session is cut keeps the call its body is running.
//
// A session ends under a live process too: a terminated backend, a database restart, a failover, a
// pooler closing it. Measured on Postgres (2026-10-18, raporlar/2026-10-18-session-cut): cutting only the
// holder's liveness session while its body ran, another process resumed the call two seconds later, read
// the holder as dead and ran the body beside it — 2 effects in 5 of 5 rounds (1 with no cut). The holder
// came back under a new id, and its old one read dead at once.
//
// The rule (process-liveness.ts `judgeAlive`): a live process takes its lock back under the SAME id, and
// a holder reads as dead only when its lock has been gone at two looks spanning `reconnectGraceMs`. A
// process that really is gone is still taken over — that much later.
//
// Postgres: runs when GNL_PG_URL is set (two stores in one OS process are two processes to the database:
// each has its own session and lock, and a hold is live only in the store that took it).
import { describe, it, expect, afterAll, vi, beforeAll } from 'vitest';
import pg from 'pg';
import { durableTool } from '../src/durable-tool.js';
import { RunBusyError } from '../src/index.js';
import { PostgresStorage } from '../src/postgres-storage.js';
import { procLockKey } from '../src/process-liveness.js';
import { runKeys } from '../src/journal.js';
import type { DurableCtx, Journal } from '../src/journal.js';

const PG_URL = process.env.GNL_PG_URL;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const gate = () => { let open!: () => void; const p = new Promise<void>((r) => { open = r; }); return { p, open }; };
const settled = <T>(p: Promise<T>) => p.then((v) => v, (e) => e);
const ends: Array<() => Promise<unknown>> = [];
beforeAll(() => { vi.spyOn(console, 'warn').mockImplementation(() => undefined); });
afterAll(async () => { for (const e of ends.reverse()) await e().catch(() => undefined); });

const ctxOf = (journal: Journal, runId: string) => ({ journal, runId }) as unknown as DurableCtx;
const charge = (tool: object, journal: Journal, runId: string) =>
  durableTool(tool as any, ctxOf(journal, runId), 'charge').execute!({ amount: 1 }, { toolCallId: 'c1' } as any);

describe.skipIf(!PG_URL)('a live process whose liveness session is cut', () => {
  let admin: pg.Client;
  let url: string;
  beforeAll(async () => {
    admin = new pg.Client({ connectionString: PG_URL });
    await admin.connect();
    ends.push(() => admin.end());
    const db = `sesscutfix_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`;
    await admin.query(`CREATE DATABASE ${db}`);
    ends.push(() => admin.query(`DROP DATABASE IF EXISTS ${db} WITH (FORCE)`));
    const u = new URL(PG_URL!); u.pathname = `/${db}`; url = u.toString();
  });
  const store = () => { const s = new PostgresStorage({ connectionString: url }); ends.push(() => s.close()); return s; };
  const lockPid = async (id: string): Promise<number | undefined> =>
    (await admin.query(`SELECT pid FROM pg_locks WHERE locktype = 'advisory' AND ((classid::bigint << 32) | objid::bigint) = $1::bigint AND granted`, [procLockKey(id)])).rows[0]?.pid;

  it('keeps the call its body is running: the other process is told busy, the body runs once', async () => {
    const A = store();
    const B = store();
    const runId = `r-cut-${Date.now().toString(36)}`;
    let effects = 0;
    const inBody = gate();
    const finish = gate();
    const tool = {
      sideEffect: true,
      recover: async () => ({ done: false as const }),
      execute: async () => {
        const me = ++effects;
        if (me === 1) { inBody.open(); await finish.p; }
        return { chargeId: `ch_${me}` };
      },
    };
    const a = settled(charge(tool, A.runs, runId));
    await inBody.p;
    const liv = await A.processLiveness();
    const id = liv.id;
    const pid = await lockPid(id);
    expect(pid, "A's lock is held").toBeDefined();
    await admin.query('SELECT pg_terminate_backend($1)', [pid]);
    await sleep(2_000);
    const b = await settled(charge(tool, B.runs, runId));
    expect(b).toBeInstanceOf(RunBusyError);
    expect(effects, 'the body ran once').toBe(1);
    expect(liv.id, 'the process came back under the same id').toBe(id);
    expect(await lockPid(id), 'its lock is held again').toBeDefined();
    finish.open();
    expect(await a).toEqual({ chargeId: 'ch_1' });
    expect(await A.runs.get(runKeys.tool(runId, 'c1'))).toMatchObject({ status: 'succeeded', output: { chargeId: 'ch_1' } });
  }, 60_000);

  it('sibling: a process that is really gone is still taken over — once its lock has been gone for the grace', async () => {
    const C = store();
    const B = store();
    const runId = `r-gone-${Date.now().toString(36)}`;
    let effects = 0;
    const inBody = gate();
    const tool = {
      sideEffect: true,
      recover: async () => ({ done: false as const }),
      execute: async () => {
        const me = ++effects;
        if (me === 1) { inBody.open(); await new Promise(() => undefined); }
        return { chargeId: `ch_${me}` };
      },
    };
    void settled(charge(tool, C.runs, runId));
    await inBody.p;
    const liv = await C.processLiveness();
    const grace = liv.reconnectGraceMs ?? 0;
    // Gone for good: its session closed and never back (what a crash looks like to the database).
    await liv.close();
    const t0 = performance.now();
    expect(await charge(tool, B.runs, runId)).toEqual({ chargeId: 'ch_2' });
    const took = performance.now() - t0;
    expect(took, 'taken over only after the grace').toBeGreaterThanOrEqual(grace - 50);
    expect(took, 'and not much later').toBeLessThan(grace + 3_000);
  }, 60_000);
});
