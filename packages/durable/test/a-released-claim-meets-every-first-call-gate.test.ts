// A claim released with releaseFailedClaim is a first call again — it meets the gates a first call meets.
//
// releaseFailedClaim replaces a failed cross-run (or thread) claim with a 'released' tombstone once an
// operator has established the side effect did not happen; the next call runs. But the gates that answer
// only a FRESH call (`confirm`, the semantic gate) test for "no record", and the tombstone is a record:
// a `confirm: true` tool ran straight after the release without asking anyone (measured: executed, no
// question). The tombstone now reads as no record, like the one a claim given back before its body
// leaves. Postgres runs when GNL_PG_URL is set.
import { describe, it, expect, vi, beforeAll, afterAll } from 'vitest';
import { durableTool } from '../src/durable-tool.js';
import { InMemoryStorage, stampFormat, type Storage } from '../src/index.js';
import { SqliteStorage } from '../src/sqlite-storage.js';
import { PostgresStorage } from '../src/postgres-storage.js';
import { releaseFailedClaim } from '../src/idempotent-tools.js';
import { runKeys, type DurableCtx } from '../src/journal.js';
import { argsHash } from '../src/hash.js';

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

describe.each(STORES)('a released claim — %s', (_name, make) => {
  it('a confirm tool asks before it runs again, and runs once when approved', async () => {
    const storage = await make();
    const args = { order: `o-${unique()}` };
    let executions = 0;
    const tool = { sideEffect: true, confirm: true, idempotencyWindow: 'cross-run', execute: async () => { executions++; return { charged: executions }; } };
    await storage.runs.put(runKeys.toolCrossRun('charge', argsHash(args)), stampFormat({ status: 'failed', error: 'reset', attempts: 1, sideEffect: true }));
    expect(await releaseFailedClaim(storage.runs, { toolName: 'charge', args })).toBe(true);
    const call = (runId: string, approvals?: Record<string, boolean>) =>
      durableTool(tool as any, { journal: storage.runs, runId, identity: { kind: 'staff', runId }, ...(approvals ? { approvals } : {}) } as unknown as DurableCtx, 'charge')
        .execute!(args, { toolCallId: 'c1' } as any);

    const runId = `r-rel-${unique()}`;
    const asked = await call(runId);
    expect(executions).toBe(0);
    expect((asked as { __gnl_suspend?: { kind?: string } }).__gnl_suspend?.kind).toBe('confirm');
    expect(await call(runId, { c1: true })).toEqual({ charged: 1 });
    expect(await call(`r-other-${unique()}`)).toEqual({ charged: 1 }); // and it is the cross-run record again
    expect(executions).toBe(1);
  });
}, 60_000);
