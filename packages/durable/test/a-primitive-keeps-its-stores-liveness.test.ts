// A primitive handed a store keeps that store's process liveness.
//
// A claim names the process that holds it (`proc`, the store's liveness), and a reader judges it by that
// process — alive, however long it has been frozen — not by its age (process-liveness.ts). Since a run
// is born at a primitive's first write, `durableTool` (and `durableModel`, the processors) wrap the
// ctx's journal in a forwarding view (`bornOnFirstWrite`, run-identity.ts). The liveness is looked up by
// the journal's store, and the view hid it: the claim was written without `proc`, judged by its age, and
// a holder that stalled past its TTL was taken over while its effect was still in its hands. Measured
// before the fix: 2 executions on Sqlite and Postgres; 1 on the commit before the view existed.
//
// Here the holder stalls (the event loop blocked) three claim TTLs inside its body, and a twin in the
// same process meets its claim. Postgres runs when GNL_PG_URL is set.
import { describe, it, expect, vi, beforeAll, afterAll, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { durableTool } from '../src/durable-tool.js';
import { RunBusyError, type Storage } from '../src/index.js';
import { SqliteStorage } from '../src/sqlite-storage.js';
import { PostgresStorage } from '../src/postgres-storage.js';
import { storeLiveness, unbindLiveness } from '../src/process-liveness.js';
import type { DurableCtx } from '../src/journal.js';

beforeAll(() => { vi.spyOn(console, 'warn').mockImplementation(() => {}); });
const ends: Array<() => Promise<unknown> | unknown> = [];
afterAll(async () => { for (const e of ends.reverse()) await e(); });

const PG_URL = process.env.GNL_PG_URL;
const STORES: Array<[string, () => Promise<Storage>]> = [
  ['sqlite (file)', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'gnl-liveness-'));
    const s = new SqliteStorage(join(dir, 'runs.db'));
    ends.push(() => rmSync(dir, { recursive: true, force: true }), () => s.close());
    return s;
  }],
];
if (PG_URL) STORES.push(['postgres (real)', async () => { const s = new PostgresStorage({ connectionString: PG_URL }); ends.push(() => s.close()); return s; }]);

const TTL = 150;
const unique = () => `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
const gate = () => { let open!: () => void; const p = new Promise<void>((r) => { open = r; }); return { p, open }; };
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const settled = <T>(p: Promise<T>) => p.then((v) => v, (e) => e);
/** A process stall: nothing in this process runs — the claim's renewal neither. */
const stall = (ms: number) => { const end = Date.now() + ms; while (Date.now() < end) { /* blocked */ } };

function longCharge(extra: Record<string, unknown>) {
  let executions = 0;
  let landed = false;
  const inBody = gate();
  const finish = gate();
  const tool = {
    sideEffect: true, claimTtlMs: TTL, ...extra,
    recover: async () => (landed ? { done: true as const, output: { chargeId: 'ch_1' } } : { done: false as const }),
    execute: async () => { executions++; inBody.open(); await finish.p; landed = true; return { chargeId: `ch_${executions}` }; },
  };
  return { tool, executions: () => executions, inBody: inBody.p, finish: finish.open };
}

describe.each(STORES)('a primitive keeps its store\'s liveness — %s', (_name, make) => {
  let storage: Storage;
  afterEach(() => unbindLiveness(storage.runs));

  it('a resume meets a claim whose holder stalled past its TTL: busy, the call is not run again', async () => {
    storage = await make();
    await storeLiveness(storage.runs, { own: () => storage.processLiveness?.() });
    const runId = `r-live-${unique()}`;
    const { tool, executions, inBody, finish } = longCharge({});
    const call = () => durableTool(tool as any, { journal: storage.runs, runId } as unknown as DurableCtx, 'charge').execute!({ amount: 1 }, { toolCallId: 'c1' } as any);
    const a = call();
    await inBody;
    expect((await storage.runs.get<{ proc?: string }>(`${runId}:tool:c1`))?.proc).toBeTypeOf('string');
    stall(TTL * 3);
    const b = await settled(call());
    expect(b).toBeInstanceOf(RunBusyError);
    expect(executions()).toBe(1);
    finish();
    expect(await a).toEqual({ chargeId: 'ch_1' });
    expect(executions()).toBe(1);
  });

  it("'args' mode: a same-arguments call meets a claim whose holder stalled past its TTL: it waits, the call runs once", async () => {
    storage = await make();
    await storeLiveness(storage.runs, { own: () => storage.processLiveness?.() });
    const runId = `r-live-args-${unique()}`;
    const { tool, executions, inBody, finish } = longCharge({ idempotency: 'args' });
    const call = (toolCallId: string) => durableTool(tool as any, { journal: storage.runs, runId } as unknown as DurableCtx, 'charge').execute!({ amount: 2 }, { toolCallId } as any);
    const a = call('c1');
    await inBody;
    stall(TTL * 3);
    const b = settled(call('c2'));
    await sleep(TTL);
    expect(executions()).toBe(1);
    finish();
    expect(await a).toEqual({ chargeId: 'ch_1' });
    expect(await b).toEqual({ chargeId: 'ch_1' });
    expect(executions()).toBe(1);
  });
}, 60_000);
