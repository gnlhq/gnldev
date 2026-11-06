// k3 perf: store queries per second while a twin legitimately waits out a live claim past its TTL.
// Hypothesis: A re-reads every 5 ms once the stamp's age has run out (claimTimeLeft = 0), B/C back off.
// Refuted if B's/C's median q/s is not below a fifth of A's. 10 rounds, median + min/max.
import { it, beforeAll, afterAll } from 'vitest';
import pg from 'pg';
import { durableTool } from '../../src/durable-tool.js';
import { PostgresStorage } from '../../src/postgres-storage.js';
import { storeLiveness } from '../../src/process-liveness.js';

const URL_ = process.env.GNL_PG_URL!;
// A measurement against a real Postgres: skipped without one, as every real-backend test is.
const live = it.skipIf(!(process.env.GNL_PG_URL));
let storage: PostgresStorage;
let queries = 0;
let counting = false;
beforeAll(async () => {
  if (!(process.env.GNL_PG_URL)) return;
  storage = new PostgresStorage({ connectionString: URL_ });
  await storage.runs.get('warm');
  await storeLiveness(storage.runs, { own: () => storage.processLiveness() });
  const oq = (pg as any).Client.prototype.query;
  (pg as any).Client.prototype.query = function (this: unknown, ...a: unknown[]) { if (counting) queries++; return oq.apply(this, a); };
});
afterAll(async () => { await storage?.close(); });
const pause = (ms: number) => new Promise((r) => setTimeout(r, ms));

live('P1: q/s during a legitimate same-process wait (body 2 s, claimTtl 300 ms), 10 rounds', async () => {
  const rates: number[] = [];
  for (let round = 0; round < 10; round++) {
    const runId = `k3p-${Date.now().toString(36)}-${round}`;
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const tool = { sideEffect: true, claimTtlMs: 300, idempotency: 'args' as const, recover: async () => ({ done: false as const }), execute: async () => { await gate; return { ok: 1 }; } };
    const call = (id: string) => durableTool(tool as any, { journal: storage.runs, runId } as any, 'charge').execute!({ o: round }, { toolCallId: id } as any);
    const p1 = call('c1');
    await pause(500); // the first claim is past its TTL; its holder is in flight
    queries = 0; counting = true;
    const t0 = performance.now();
    const p2 = call('c2');
    await pause(1500);
    counting = false;
    const ms = performance.now() - t0;
    release();
    await Promise.all([p1, p2]);
    rates.push(Math.round(queries / (ms / 1000)));
  }
  const s = [...rates].sort((a, b) => a - b);
  console.log(`[k3 P1] q/s median=${(s[4]! + s[5]!) / 2} min=${s[0]} max=${s[9]} all=${JSON.stringify(rates)}`);
}, 120_000);
