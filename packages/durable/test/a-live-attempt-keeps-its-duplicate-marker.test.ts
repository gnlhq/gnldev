// A live attempt's duplicate marker stays live, however long the attempt runs.
//
// A side effect claims the duplicate marker in flight before its body ("these arguments are running in
// this request"). The marker was dated once, when it was claimed; past the claim TTL it read as the
// leftover of a crashed attempt, and with a dedup window (`sideEffectDuplicates.ttlMs`) shorter than the
// attempt, an identical call took it over and ran beside the attempt still in its body — under 'block'.
// The attempt renews the marker it holds along with its claim. Postgres runs when GNL_PG_URL is set.
import { describe, it, expect, vi, beforeAll, afterAll } from 'vitest';
import { durableTool } from '../src/durable-tool.js';
import { InMemoryStorage, type Storage } from '../src/index.js';
import { SqliteStorage } from '../src/sqlite-storage.js';
import { PostgresStorage } from '../src/postgres-storage.js';
import type { DurableCtx } from '../src/journal.js';

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
const gate = () => { let open!: () => void; const p = new Promise<void>((r) => { open = r; }); return { p, open }; };
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const settled = <T>(p: Promise<T>) => p.then((v) => v, (e) => e);

const TTL = 150;

describe.each(STORES)("a live attempt's duplicate marker — %s", (_name, make) => {
  it("an identical call while the attempt runs past the claim TTL and the dedup window is still blocked", async () => {
    const storage = await make();
    const runId = `r-k3-marker-${unique()}`;
    let executions = 0;
    const inBody = gate();
    const finish = gate();
    const tool = {
      sideEffect: true, claimTtlMs: TTL,
      execute: async () => { executions++; inBody.open(); await finish.p; return { chargeId: `ch_${executions}` }; },
    };
    const call = (toolCallId: string) =>
      settled(durableTool(tool as any, { journal: storage.runs, runId, limits: { sideEffectDuplicates: { action: 'block', ttlMs: 100 } } } as unknown as DurableCtx, 'charge')
        .execute!({ amount: 6 }, { toolCallId } as any));

    const a = call('c1');
    await inBody.p;
    await sleep(TTL * 3);
    const c = call('c2');
    await Promise.race([c, sleep(200)]);
    expect(executions).toBe(1);
    finish.open();
    expect(((await c) as { __gnl_limit_exceeded?: { kind?: string } }).__gnl_limit_exceeded?.kind).toBe('duplicateSideEffect');
    expect(await a).toEqual({ chargeId: 'ch_1' });
    expect(executions).toBe(1);
  });
}, 60_000);
