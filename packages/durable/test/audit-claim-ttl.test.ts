// Audit probe (2026-10-16): does a side effect run twice when the process holding its claim stalls
// past the claim's TTL? CI red on main dd3dbe9f: a-live-attempt-keeps-its-claim 'args' mode, 2 executions.
//
// A stall is a synchronous block of the event loop while the first attempt is in its body: its claim
// renewal (attempt.ts hold(), every TTL/3) cannot fire, the stamp ages past its TTL, and a same-arguments
// twin in the same process judges it.
//
// Each case is run without a process liveness (what a direct durableTool / runDurable call has, and what
// the CI test has) and, for the stores that bring one, with the store's own liveness bound (what
// createGnl's executor and createWorker do). Postgres runs when GNL_PG_URL is set.
//
// A measurement, not a gate: the rows without a liveness run twice by design of the age fallback
// (see the audit report). Runs only with AUDIT_PROBE=1.
import { describe, it, expect, vi, beforeAll, afterAll, afterEach } from 'vitest';
import { durableTool } from '../src/durable-tool.js';
import { InMemoryStorage, type Storage } from '../src/index.js';
import { SqliteStorage } from '../src/sqlite-storage.js';
import { PostgresStorage } from '../src/postgres-storage.js';
import { storeLiveness, unbindLiveness, livenessFor, procStampFor } from '../src/process-liveness.js';
import type { DurableCtx } from '../src/journal.js';

beforeAll(() => { vi.spyOn(console, 'warn').mockImplementation(() => {}); });
const ends: Array<() => Promise<unknown>> = [];
afterAll(async () => { for (const e of ends.reverse()) await e(); });

const PG_URL = process.env.GNL_PG_URL;
const DEFAULT_TTL = process.env.AUDIT_DEFAULT_TTL === '1';
type Make = () => Promise<Storage>;
const STORES: Array<[string, Make, boolean]> = [
  ['in-memory', async () => new InMemoryStorage(), false],
  ['sqlite', async () => new SqliteStorage(':memory:'), false],
];
if (PG_URL) STORES.push(['postgres (real)', async () => { const s = new PostgresStorage({ connectionString: PG_URL }); ends.push(() => s.close()); return s; }, true]);
// Sqlite file store: a :memory: Sqlite is process-local, so its liveness never answers; a file is shared.
STORES.push(['sqlite file', async () => {
  const f = `/tmp/claude-1000/-home-karaca7-Desktop-the workspace-gnl/80e84349-738a-4b93-afc4-b1f494628e55/scratchpad/claimttl-${Date.now()}-${Math.random().toString(36).slice(2, 6)}.db`;
  const s = new SqliteStorage(f); ends.push(() => (s as any).close?.()); return s;
}, true]);

const unique = () => `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
const gate = () => { let open!: () => void; const p = new Promise<void>((r) => { open = r; }); return { p, open }; };
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const settled = <T>(p: Promise<T>) => p.then((v) => v, (e) => e);
const block = (ms: number) => { const end = Date.now() + ms; while (Date.now() < end) { /* the event loop is stalled */ } };

const TTL = DEFAULT_TTL ? undefined : 150;
const STALL = DEFAULT_TTL ? 31_000 : 450;

function longCharge(mode: 'args' | 'call') {
  let executions = 0;
  let landed = false;
  const inBody = gate();
  const finish = gate();
  const tool: Record<string, unknown> = {
    sideEffect: true, ...(TTL ? { claimTtlMs: TTL } : {}), ...(mode === 'args' ? { idempotency: 'args' } : {}),
    recover: async () => (landed ? { done: true as const, output: { chargeId: 'ch_1' } } : { done: false as const }),
    execute: async () => { executions++; inBody.open(); await finish.p; landed = true; return { chargeId: `ch_${executions}` }; },
  };
  return { tool, executions: () => executions, inBody: inBody.p, finish: finish.open };
}

const rows: string[] = [];
afterAll(() => { if (rows.length) console.log(`\n[audit-claim-ttl] ttl=${TTL ?? 'default'} stall=${STALL}ms\n` + rows.join('\n')); });

for (const [name, make, hasOwnLiveness] of STORES) {
  for (const withLiveness of hasOwnLiveness ? [false, true] : [false]) {
    describe.skipIf(process.env.AUDIT_PROBE !== '1')(`${name} — ${withLiveness ? 'store liveness bound' : 'no liveness'}`, () => {
      let storage: Storage;
      afterEach(() => { if (storage) unbindLiveness(storage.runs); });
      for (const mode of ['args', 'call'] as const) {
        it(`${mode} mode: the holder stalls ${STALL} ms in its body; a twin in the same process`, async () => {
          storage = await make();
          if (withLiveness) { const l = await storeLiveness(storage.runs, { own: () => (storage as any).processLiveness?.() }); rows.push(`  bound=${l?.id} processOnly=${l?.processOnly} livenessFor=${livenessFor(storage.runs)?.id} procStamp=${JSON.stringify(procStampFor(storage.runs))}`); }
          const runId = `r-audit-${mode}-${unique()}`;
          const { tool, executions, inBody, finish } = longCharge(mode);
          const call = (toolCallId: string) => durableTool(tool as any, { journal: storage.runs, runId } as unknown as DurableCtx, 'charge').execute!({ amount: 3 }, { toolCallId } as any);
          const a = call('c1');
          await inBody;
          const pre = await storage.runs.get<any>(`${runId}:tool:c1`);
          block(STALL);
          const b = settled(call(mode === 'args' ? 'c2' : 'c1'));
          await Promise.race([b, sleep(300)]);
          const during = executions();
          finish();
          const ra = await settled(a); const rb = await b;
          rows.push(`${name.padEnd(16)} ${withLiveness ? 'liveness' : 'none    '} ${mode.padEnd(4)} executions=${executions()} (during=${during}) raw=${JSON.stringify(pre)} a=${JSON.stringify(ra?.chargeId ?? ra?.name ?? ra)} b=${JSON.stringify(rb?.chargeId ?? rb?.name ?? rb)}`);
          expect(executions()).toBe(1);
        }, 120_000);
      }
    });
  }
}
