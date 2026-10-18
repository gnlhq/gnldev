// A process that stalls while it holds a claim keeps it.
//
// A claim names the attempt that holds it, and is judged LIVE while that attempt is: by this process when
// it is this process's own (an in-process registry of the attempts it holds), and by the holder's process
// liveness when it is another's (a Postgres session lock, a Sqlite file lock) — never by its age while
// either can answer. Its age decided alone, before: a holder whose event loop stalled past the claim's TTL
// (a GC pause, a synchronous burst) could not renew it, and a twin of the call — in the same process, or
// in another on the same store — judged it crashed and ran the effect beside it (audit 2026-10-16: 2
// executions; CI red on a-live-attempt-keeps-its-claim). A direct `durableTool` / `durableModel` / a tool
// in a queue handler or a workflow step had no liveness bound: only `createGnl`'s executor and
// `createWorker` bound one.
//
// Here no liveness is bound by the test. Postgres runs when GNL_PG_URL is set; MySQL / MariaDB when
// GNL_MYSQL_URL / GNL_MARIADB_URL are.
import { describe, it, expect, vi, beforeAll, afterAll, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { durableTool } from '../src/durable-tool.js';
import { withDurableModel } from '../src/durable-model.js';
import { InMemoryStorage, RunBusyError, type Storage } from '../src/index.js';
import { SqliteStorage } from '../src/sqlite-storage.js';
import { PostgresStorage } from '../src/postgres-storage.js';
import { unbindLiveness, installProcessLiveness } from '../src/process-liveness.js';
import type { DurableCtx } from '../src/journal.js';
import { createMockModel, finalTextResult } from './mock.js';
import { mysqlStores } from './real-backends.js';

beforeAll(() => { vi.spyOn(console, 'warn').mockImplementation(() => {}); });
const ends: Array<() => Promise<unknown> | unknown> = [];
afterAll(async () => { for (const e of ends.reverse()) await e(); });

const PG_URL = process.env.GNL_PG_URL;
const STORES: Array<[string, () => Promise<Storage>]> = [
  ['in-memory', async () => new InMemoryStorage()],
  ['sqlite :memory:', async () => { const s = new SqliteStorage(':memory:'); ends.push(() => s.close()); return s; }],
  ['sqlite (file)', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'gnl-stall-'));
    const s = new SqliteStorage(join(dir, 'runs.db'));
    ends.push(() => rmSync(dir, { recursive: true, force: true }), () => s.close());
    return s;
  }],
];
if (PG_URL) STORES.push(['postgres (real)', async () => { const s = new PostgresStorage({ connectionString: PG_URL }); ends.push(() => s.close()); return s; }]);
for (const [name, make] of mysqlStores(' (real)')) STORES.push([name.toLowerCase(), async () => { const s = await make(); ends.push(() => s.close()); return s; }]);

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

afterEach(() => installProcessLiveness(undefined));

describe.each(STORES)('a stalled holder keeps its claim, no liveness bound by the host — %s', (_name, make) => {
  let storage: Storage;
  afterEach(() => { if (storage) unbindLiveness(storage.runs); });

  it('a resume meets the claim of a holder stalled past its TTL: busy, the call is not run again', async () => {
    storage = await make();
    const runId = `r-stall-${unique()}`;
    const { tool, executions, inBody, finish } = longCharge({});
    const call = () => durableTool(tool as any, { journal: storage.runs, runId } as unknown as DurableCtx, 'charge').execute!({ amount: 1 }, { toolCallId: 'c1' } as any);
    const a = call();
    await inBody;
    stall(TTL * 3);
    const b = settled(call());
    await Promise.race([b, sleep(TTL * 2)]);
    expect(executions()).toBe(1);
    finish();
    expect(await b).toBeInstanceOf(RunBusyError);
    expect(await a).toEqual({ chargeId: 'ch_1' });
    expect(executions()).toBe(1);
  });

  it("'args' mode: a same-arguments call meets the claim of a holder stalled past its TTL: it waits, the call runs once", async () => {
    storage = await make();
    const runId = `r-stall-args-${unique()}`;
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

describe('a stalled holder keeps its claim — durableModel (exclusiveStep)', () => {
  it('a twin of a model step whose holder stalled past the step TTL is busy: the model is called once', async () => {
    const storage = new InMemoryStorage();
    const runId = `r-stall-model-${unique()}`;
    let calls = 0;
    const inCall = gate();
    const finish = gate();
    const model = createMockModel(async () => { calls++; inCall.open(); await finish.p; return finalTextResult('ok'); });
    const wrapped = (): any => withDurableModel(model, { journal: storage.runs, runId } as unknown as DurableCtx, { exclusiveStep: { ttlMs: TTL } });
    const params: any = { prompt: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }] };
    const a = wrapped().doGenerate(params);
    await inCall.p;
    stall(TTL * 3);
    const b = settled(wrapped().doGenerate(params));
    await Promise.race([b, sleep(TTL * 2)]);
    expect(calls).toBe(1);
    finish.open();
    expect(await b).toBeInstanceOf(RunBusyError);
    await a;
    expect(calls).toBe(1);
  });
}, 60_000);
