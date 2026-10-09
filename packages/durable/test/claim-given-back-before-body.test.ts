// A storage error after a tool's claim and before its body: the claim is given back.
//
// A durable tool claims its record ('running') and then does more storage work before it calls the
// tool: the duplicate marker, the cross-run owner, a spent approval. If one of those reads or writes
// failed (a serialization failure under SERIALIZABLE, a dropped connection), the call threw — and the
// 'running' claim stayed. The tool never ran, yet every later attempt on that record was refused as
// "being executed by another executor" until the claim expired, and after that it counted as a crash
// that "MAY have already run", so a side effect needed recover(), idempotent: true or a human.
// Measured on every store: executions 0, record 'running', the retry threw RunBusyError.
//
// The body had provably not started, so nothing can have happened. The claim is now given back: the
// record returns to what it was before this call claimed it (no record reads as none; a failed or
// crashed earlier attempt stays failed or crashed, with its counter), and a retry runs the tool once.
// An error AFTER the body started is the opposite case — the effect may have happened — and is left
// exactly as it was: 'running', never re-run silently. Postgres runs when GNL_PG_URL is set.
import { describe, it, expect, vi, beforeAll, afterAll } from 'vitest';
import { newDb } from 'pg-mem';
import { durableTool } from '../src/durable-tool.js';
import { InMemoryStorage, RunBusyError, SideEffectRetryBlockedError, type Storage } from '../src/index.js';
import { SqliteStorage } from '../src/sqlite-storage.js';
import { PostgresStorage } from '../src/postgres-storage.js';
import type { DurableCtx, Journal } from '../src/journal.js';

beforeAll(() => { vi.spyOn(console, 'warn').mockImplementation(() => {}); });
const ends: Array<() => Promise<unknown>> = [];
afterAll(async () => { for (const e of ends.reverse()) await e(); });

const PG_URL = process.env.GNL_PG_URL;
const STORES: Array<[string, () => Promise<Storage>]> = [
  ['in-memory', async () => new InMemoryStorage()],
  ['sqlite', async () => new SqliteStorage(':memory:')],
  ['postgres (pg-mem)', async () => { const { Pool } = newDb().adapters.createPg(); return new PostgresStorage({ pool: new Pool() }); }],
];
if (PG_URL) {
  STORES.push(['postgres (real)', async () => {
    const pg = (await import('pg')).default;
    const admin = new pg.Client({ connectionString: PG_URL });
    await admin.connect();
    const db = `claim_back_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`;
    await admin.query(`CREATE DATABASE ${db}`);
    const url = new URL(PG_URL); url.pathname = `/${db}`;
    const s = new PostgresStorage({ connectionString: url.toString() });
    ends.push(async () => { await s.close(); await admin.query(`DROP DATABASE IF EXISTS ${db}`); await admin.end(); });
    return s;
  }]);
}

const KEY = 'call-1';
const serializationFailure = () => Object.assign(new Error('could not serialize access due to read/write dependencies among transactions'), { code: '40001' });

/**
 * The run journal with ONE injected failure. `armWhen` sees every write and says when the trap is set
 * (a claim landed); `failOn` sees every call after that and picks the one that throws, once.
 */
function faulty(journal: Journal, opts: {
  armWhen: (op: string, key: string, value: unknown, result: unknown) => boolean;
  failOn: (op: string, key: string, value: unknown) => boolean;
}): { journal: Journal; injected: () => number } {
  let armed = false;
  let injected = 0;
  const wrapped = new Proxy(journal as any, {
    get(target, prop) {
      const v = target[prop];
      if (typeof v !== 'function') return v;
      if (prop !== 'get' && prop !== 'put' && prop !== 'putIfAbsent' && prop !== 'putIfMatch') return v.bind(target);
      return async (key: string, ...rest: unknown[]) => {
        const value = prop === 'putIfMatch' ? rest[1] : rest[0];
        if (armed && injected === 0 && opts.failOn(prop, key, value)) { injected++; throw serializationFailure(); }
        const result = await v.call(target, key, ...rest);
        if (!armed && opts.armWhen(prop, key, value, result)) armed = true;
        return result;
      };
    },
  });
  return { journal: wrapped as Journal, injected: () => injected };
}

/** The tool's own record has just been claimed 'running' (fresh claim or takeover). */
const claimedTool = (op: string, key: string, value: unknown, result: unknown) =>
  (op === 'putIfAbsent' || op === 'putIfMatch') && result === true &&
  (key.includes(':tool:') || key.startsWith('xrun:args-')) &&
  (value as { status?: string } | undefined)?.status === 'running';

function charge() {
  let executions = 0;
  const tool = { sideEffect: true, execute: async (args: { amount: number }) => { executions++; return { chargeId: `ch_${executions}`, amount: args.amount }; } };
  return { tool, executions: () => executions };
}

const statusOf = async (journal: Journal, key: string) => ((await journal.get(key)) as { status?: string } | undefined)?.status;

describe.each(STORES)('a storage error between the claim and the body — %s', (_name, make) => {
  it('the duplicate-marker read fails after the claim: the error surfaces, the claim is given back, a retry runs it once', async () => {
    const storage = await make();
    const runId = 'r-dup';
    const f = faulty(storage.runs, { armWhen: claimedTool, failOn: (op, key) => op === 'get' && key.includes('dup-charge-') });
    const { tool, executions } = charge();
    const call = (journal: Journal) => durableTool(tool as any, { journal, runId } as DurableCtx, 'charge').execute!({ amount: 20 }, { toolCallId: KEY } as any);

    await expect(call(f.journal)).rejects.toThrow(/could not serialize access/);
    expect(f.injected()).toBe(1);
    expect(executions()).toBe(0);
    expect(await statusOf(storage.runs, `${runId}:tool:${KEY}`)).not.toBe('running');

    expect(await call(storage.runs)).toEqual({ chargeId: 'ch_1', amount: 20 });
    expect(executions()).toBe(1);
    expect(await statusOf(storage.runs, `${runId}:tool:${KEY}`)).toBe('succeeded');
    // And it stays exactly-once: the same call again replays.
    expect(await call(storage.runs)).toEqual({ chargeId: 'ch_1', amount: 20 });
    expect(executions()).toBe(1);
  });

  it('a cross-run claim whose owner write fails: after the claim would have expired, the retry runs it once (not "may have run")', async () => {
    const storage = await make();
    const f = faulty(storage.runs, { armWhen: claimedTool, failOn: (op, key) => op === 'putIfAbsent' && key.includes('owner') });
    const { tool, executions } = charge();
    Object.assign(tool, { idempotencyWindow: 'cross-run', claimTtlMs: 30 });
    const call = (journal: Journal, runId: string, toolCallId: string) =>
      durableTool(tool as any, { journal, runId } as DurableCtx, 'charge').execute!({ amount: 7 }, { toolCallId } as any);

    await expect(call(f.journal, 'r-x1', 'c1')).rejects.toThrow(/could not serialize access/);
    expect(f.injected()).toBe(1);
    expect(executions()).toBe(0);
    await new Promise((r) => setTimeout(r, 60)); // past claimTtlMs: a claim left behind would now read as a crash

    expect(await call(storage.runs, 'r-x2', 'c2')).toEqual({ chargeId: 'ch_1', amount: 7 });
    expect(executions()).toBe(1);
    expect(await call(storage.runs, 'r-x3', 'c3')).toEqual({ chargeId: 'ch_1', amount: 7 });
    expect(executions()).toBe(1);
  });

  it('an approved retry of a FAILED side effect: the failure is put back as it was, so the gate still holds without the approval', async () => {
    const storage = await make();
    const runId = 'r-failed';
    const toolKey = `${runId}:tool:${KEY}`;
    await storage.runs.put(toolKey, { status: 'failed', error: 'timeout', attempts: 1, sideEffect: true, toolName: 'charge', _v: 2 });
    const before = await storage.runs.get(toolKey);
    const f = faulty(storage.runs, { armWhen: claimedTool, failOn: (op, key) => op === 'put' && key.includes(':approval:') });
    const { tool, executions } = charge();
    const call = (journal: Journal, approvals?: Record<string, boolean>) =>
      durableTool(tool as any, { journal, runId, approvals, limits: { approvalScope: 'attempt' } } as unknown as DurableCtx, 'charge')
        .execute!({ amount: 5 }, { toolCallId: KEY } as any);

    await expect(call(f.journal, { [KEY]: true })).rejects.toThrow(/could not serialize access/);
    expect(f.injected()).toBe(1);
    expect(executions()).toBe(0);
    expect(await storage.runs.get(toolKey)).toEqual(before);
    // Without the approval the earlier failure still blocks a silent re-run…
    await expect(call(storage.runs)).rejects.toBeInstanceOf(SideEffectRetryBlockedError);
    expect(executions()).toBe(0);
    // …and with it the call runs once.
    expect(await call(storage.runs, { [KEY]: true })).toEqual({ chargeId: 'ch_1', amount: 5 });
    expect(executions()).toBe(1);
  });

  it('lookup() says the effect exists and its terminal write fails: the body is NOT run, and a retry still answers from lookup', async () => {
    const storage = await make();
    const runId = 'r-lookup';
    const toolKey = `${runId}:tool:${KEY}`;
    const f = faulty(storage.runs, {
      armWhen: claimedTool,
      failOn: (op, key, value) => (op === 'put' || op === 'putIfMatch') && key === toolKey && (value as { status?: string } | undefined)?.status === 'succeeded',
    });
    const { tool, executions } = charge();
    let lookups = 0;
    Object.assign(tool, { lookup: async () => { lookups++; return { exists: true, output: { chargeId: 'ch_existing', amount: 3 } }; } });
    const call = (journal: Journal) => durableTool(tool as any, { journal, runId } as DurableCtx, 'charge').execute!({ amount: 3 }, { toolCallId: KEY } as any);

    await expect(call(f.journal)).rejects.toThrow(/could not serialize access/);
    expect(f.injected()).toBe(1);
    expect(executions()).toBe(0);                 // the effect exists downstream: firing it again is a second charge
    expect(await call(storage.runs)).toEqual({ chargeId: 'ch_existing', amount: 3 });
    expect(executions()).toBe(0);
    expect(lookups).toBe(2);
  });

  it('a concurrent duplicate BLOCKED by the guard leaves no running claim: replayed, it answers the same block, and runs nothing', async () => {
    const storage = await make();
    const runId = 'r-dupblock';
    let executions = 0;
    let release!: () => void;
    const gate = new Promise<void>((r) => { release = r; });
    let entered!: () => void;
    const inBody = new Promise<void>((r) => { entered = r; });
    const tool = { sideEffect: true, execute: async (a: { amount: number }) => { executions++; entered(); await gate; return { chargeId: `ch_${executions}`, amount: a.amount }; } };
    const ctx = { journal: storage.runs, runId, limits: { sideEffectDuplicates: 'block' } } as unknown as DurableCtx;
    const call = (toolCallId: string) => durableTool(tool as any, ctx, 'charge').execute!({ amount: 4 }, { toolCallId } as any);
    const first = call('c-first');
    await inBody;                                                   // the first holds the duplicate marker, in its body
    const blocked = await call('c-twin');
    expect((blocked as { __gnl_limit_exceeded?: { kind: string } }).__gnl_limit_exceeded?.kind).toBe('duplicateSideEffect');
    release();
    await first;
    expect(executions).toBe(1);
    expect(await statusOf(storage.runs, `${runId}:tool:c-twin`)).not.toBe('running');
    const again = await call('c-twin');                             // a resume replays the twin's call
    expect((again as { __gnl_limit_exceeded?: unknown }).__gnl_limit_exceeded).toBeDefined();
    expect(executions).toBe(1);
  });

  it('an error AFTER the body started is unchanged: the claim stays, nothing is re-run', async () => {
    const storage = await make();
    const runId = 'r-after';
    const toolKey = `${runId}:tool:${KEY}`;
    const f = faulty(storage.runs, {
      armWhen: claimedTool,
      failOn: (op, key, value) => op === 'put' && key === toolKey && (value as { status?: string } | undefined)?.status === 'succeeded',
    });
    const { tool, executions } = charge();
    const call = (journal: Journal) => durableTool(tool as any, { journal, runId } as DurableCtx, 'charge').execute!({ amount: 9 }, { toolCallId: KEY } as any);

    await expect(call(f.journal)).rejects.toThrow(/could not serialize access/);
    expect(f.injected()).toBe(1);
    expect(executions()).toBe(1);
    expect(await statusOf(storage.runs, toolKey)).toBe('running');
    await expect(call(storage.runs)).rejects.toBeInstanceOf(RunBusyError);
    expect(executions()).toBe(1);
  });
}, 60_000);
