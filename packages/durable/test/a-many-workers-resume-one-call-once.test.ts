// Many workers resuming one call land its effect once — positive evidence for the attempt's ownership rule.
//
// N workers resume the same call at once; some of them "crash" (their journal stops answering at a random
// point), bodies may outlive the claim TTL (the heartbeat must hold it), recover() answers truthfully.
// And N workers resume one approved question at once. Both must land the effect exactly once in every
// round, on every store. (Release audit e-exactly-once P3/P4: green before the Attempt object too, so
// they do not discriminate the fixed bugs — they guard against the redesign losing what already held.)
//
// Postgres runs when GNL_PG_URL is set.
import { describe, it, expect, vi, beforeAll, afterAll } from 'vitest';
import { durableTool } from '../src/durable-tool.js';
import { InMemoryStorage, type Storage } from '../src/index.js';
import { SqliteStorage } from '../src/sqlite-storage.js';
import { PostgresStorage } from '../src/postgres-storage.js';
import { runKeys } from '../src/journal.js';
import type { DurableCtx, Journal } from '../src/journal.js';

beforeAll(() => { vi.spyOn(console, 'warn').mockImplementation(() => {}); });
const ends: Array<() => Promise<unknown>> = [];
afterAll(async () => { for (const e of ends.reverse()) await e(); });

const PG_URL = process.env.GNL_PG_URL;
const STORES: Array<[string, () => Promise<Storage>]> = [
  ['in-memory', async () => new InMemoryStorage()],
  ['sqlite', async () => new SqliteStorage(':memory:')],
];
if (PG_URL) {
  STORES.push(['postgres (real)', async () => {
    const s = new PostgresStorage({ connectionString: PG_URL });
    ends.push(() => s.close());
    return s;
  }]);
}
const unique = () => `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const settled = <T>(p: Promise<T>) => p.then((v) => v, (e) => e);
const statusOf = async (journal: Journal, key: string) => ((await journal.get(key)) as { status?: string } | undefined)?.status;

describe.each(STORES)('many workers resume one call once — %s', (_name, make) => {
  it.each([3, 5, 8])('%i workers resume the same call at once, random crashes (journal stops answering, effect lands or not), truthful recover(): landings per call', async (N) => {
    const storage = await make();
    let maxLandings = 0;
    let doubles = 0;
    let zero = 0;
    const ROUNDS = 12;
    for (let round = 0; round < ROUNDS; round++) {
      const runId = `r-aud-p3-${N}-${round}-${unique()}`;
      let landings = 0;
      const tool = {
        sideEffect: true, claimTtlMs: 120,
        recover: async () => (landings > 0 ? { done: true as const, output: { ok: 1 } } : { done: false as const }),
        execute: async () => {
          // the body takes 0–100 ms; it may outlive the claim TTL (renewal must hold it)
          await sleep(Math.random() * 100);
          landings++;
          return { ok: landings };
        },
      };
      // A worker that "crashes": its journal stops answering at a random point after its first call.
      const crashy = (j: Journal) => {
        let calls = 0; const dieAt = 1 + Math.floor(Math.random() * 12); let dead = false;
        return new Proxy(j as any, { get(t, p) { const v = t[p]; if (typeof v !== 'function') return v; return async (...a: unknown[]) => { if (dead || ++calls >= dieAt) { dead = true; return new Promise(() => {}); } return v.apply(t, a); }; } }) as Journal;
      };
      const workers: Promise<unknown>[] = [];
      for (let w = 0; w < N; w++) {
        const j = Math.random() < 0.4 ? crashy(storage.runs) : storage.runs;
        await sleep(Math.random() * 40);
        workers.push(settled(durableTool(tool as any, { journal: j, runId } as unknown as DurableCtx, 'charge').execute!({ x: 1 }, { toolCallId: 'c1' } as any)));
      }
      // Survivors: keep resuming until a terminal record (or 30 tries).
      for (let t = 0; t < 30; t++) {
        await sleep(150);
        const st = await statusOf(storage.runs, runKeys.tool(runId, 'c1'));
        if (st === 'succeeded') break;
        await settled(durableTool(tool as any, { journal: storage.runs, runId } as unknown as DurableCtx, 'charge').execute!({ x: 1 }, { toolCallId: 'c1' } as any));
      }
      await sleep(150);
      if (landings > 1) doubles++;
      if (landings === 0) zero++;
      maxLandings = Math.max(maxLandings, landings);
    }
    expect(maxLandings).toBeLessThanOrEqual(1);
  }, 120_000);

  it.each([3, 8])('%i workers resume one approved question at once: executions', async (N) => {
    const storage = await make();
    let worst = 0;
    for (let round = 0; round < 10; round++) {
      const runId = `r-aud-p4-${N}-${round}-${unique()}`;
      let executions = 0;
      const tool = { sideEffect: true, confirm: true, execute: async () => { executions++; await sleep(Math.random() * 30); return { ok: executions }; } };
      await durableTool(tool as any, { journal: storage.runs, runId } as unknown as DurableCtx, 'charge').execute!({ x: 1 }, { toolCallId: 'c1' } as any);
      await Promise.all(Array.from({ length: N }, async () => {
        await sleep(Math.random() * 5);
        return settled(durableTool(tool as any, { journal: storage.runs, runId, approvals: { c1: true } } as unknown as DurableCtx, 'charge').execute!({ x: 1 }, { toolCallId: 'c1' } as any));
      }));
      worst = Math.max(worst, executions);
    }
    expect(worst).toBe(1);
  }, 120_000);
}, 180_000);
