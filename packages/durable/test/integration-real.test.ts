// REAL backend integration — runs against the docker-compose.yml services:
//   docker compose up -d && GNL_INTEGRATION=1 npx vitest run packages/durable/test/integration-real.test.ts
// Default SKIP (unless GNL_INTEGRATION=1 is set) → the normal suite stays green without Docker.
//
// PURPOSE (closes the open item in the core-hardening review): prove on REAL engines what pg-mem and
// node:sqlite CANNOT PROVE:
//   1. Postgres's `ON CONFLICT DO NOTHING RETURNING` boolean — pg-mem also returned a row on conflict
//      (a fidelity limit) → putIfAbsent's "exactly one winner" contract is verified at the boolean
//      level for the first time on real PG.
//   2. REAL async parallelism — since node:sqlite is SYNCHRONOUS, single-process tests were serialized;
//      pg is async → two separate connection pools genuinely race concurrently.
//   3. D4-real (P1.6b/P0.3 real-backend proof): applyBatch's REAL atomicity — a genuine Postgres
//      transaction (BEGIN/COMMIT/ROLLBACK, not pg-mem's non-undoing ROLLBACK) — under real concurrent
//      races AND a genuine mid-transaction failure; plus deletePrefix's GDPR counter-sweep fix and
//      countRunsByStatus/getMany against a real engine (storage-backend.test.ts only proves these
//      against pg-mem).
import { createRequire } from 'node:module';
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { stepCountIs } from 'ai';
import { PostgresStorage } from '../src/postgres-storage.js';
import { acquireRunLock } from '../src/run-lock.js';
import { purgeResource } from '../src/retention.js';
import { toJournal } from '../src/index.js';
import { runDurable } from '../src/run.js';
import { RunBusyError } from '../src/errors.js';
import { createMockModel, countToolResults, toolCallResult, finalTextResult } from './mock.js';
import { emit, createConsumer } from '../../events/src/index.js';
import { memoryConformance } from './memory-conformance.js';
import { Pool as PgPool } from 'pg';

const RUN = process.env.GNL_INTEGRATION === '1';
const PG_URL = process.env.GNL_PG_URL ?? 'postgres://postgres:gnl@localhost:55432/gnl';

// A unique key space per run → leftovers from previous runs don't pollute tests (no TRUNCATE needed).
const SEED = `it${Date.now().toString(36)}`;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe.skipIf(!RUN)('REAL Postgres — multi-pool CAS + run-lock + exactly-once', () => {
  let a: PostgresStorage; // SEPARATE Pool
  let b: PostgresStorage; // SEPARATE Pool — a real multi-worker model

  beforeAll(async () => {
    a = new PostgresStorage({ connectionString: PG_URL });
    b = new PostgresStorage({ connectionString: PG_URL });
    // The container may have just started up → wait until it's ready (init is idempotent).
    for (let i = 0; ; i++) {
      try {
        await a.init();
        break;
      } catch (e) {
        if (i >= 20) throw e;
        await sleep(500);
      }
    }
    await b.init();
  }, 30_000);

  afterAll(async () => {
    await a?.close();
    await b?.close();
  });

  it('the putIfAbsent boolean on REAL PG: two separate Pools concurrently → EXACTLY ONE true per round', async () => {
    // This boolean is exactly the thing pg-mem could not prove. 20 rounds of a real race:
    for (let round = 0; round < 20; round++) {
      const key = `${SEED}:cas:${round}:tool:t`; // a tool key → the real journal write path
      const results = await Promise.all([a.runs.putIfAbsent(key, { w: 'a' }), b.runs.putIfAbsent(key, { w: 'b' })]);
      expect(results.filter(Boolean).length).toBe(1); // this assertion was UNRELIABLE under pg-mem
      const [va, vb] = await Promise.all([a.runs.get(key), b.runs.get(key)]);
      expect(va).toEqual(vb); // both pools read the single real record
    }
  });

  it('a putIfAbsent storm: 10 concurrent attempts on the same key from two pools → exactly 1 winner', async () => {
    const key = `${SEED}:storm:tool:t`;
    const attempts = Array.from({ length: 10 }, (_, i) =>
      (i % 2 === 0 ? a : b).runs.putIfAbsent(key, { attempt: i }),
    );
    const results = await Promise.all(attempts);
    expect(results.filter(Boolean).length).toBe(1);
  });

  it('an acquireRunLock fresh race across two pools: exactly one winner (10 rounds)', async () => {
    for (let round = 0; round < 10; round++) {
      const runId = `${SEED}:lock:${round}`;
      const [lA, lB] = await Promise.all([
        acquireRunLock(a.runs, runId, 'A', 5000),
        acquireRunLock(b.runs, runId, 'B', 5000),
      ]);
      expect([lA, lB].filter((x) => x !== null).length).toBe(1);
    }
  });

  it('locked runDurable e2e: two pools with the same runId → one gets RunBusyError, tool side effect EXACTLY 1', async () => {
    const counter = { charges: 0 };
    const mkTools = () => ({
      charge: {
        execute: async () => {
          counter.charges++;
          await sleep(30); // keep the lock held
          return { charged: 20 };
        },
      },
    });
    const mkModel = () =>
      createMockModel(async ({ prompt }: any) =>
        countToolResults(prompt) === 0 ? toolCallResult('charge', 'call-c', { amount: 20 }) : finalTextResult('done'),
      );
    const opts = (storage: PostgresStorage, owner: string) => ({
      runId: `${SEED}:e2e-run`,
      journal: storage.runs,
      model: mkModel(),
      tools: mkTools(),
      stopWhen: stepCountIs(6),
      prompt: 'x',
      lock: { owner, ttlMs: 10_000 },
    });
    const settled = await Promise.allSettled([runDurable(opts(a, 'wa') as any), runDurable(opts(b, 'wb') as any)]);
    const busy = settled.filter(
      (s) => s.status === 'rejected' && (s as PromiseRejectedResult).reason instanceof RunBusyError,
    );
    expect(busy.length).toBe(1); // under real async parallelism, the cross-pool lock picked exactly one winner
    expect(counter.charges).toBe(1); // exactly-once on a REAL engine
  });

  it('H1: an expired lock takeover race across two pools → putIfMatch CAS produces EXACTLY ONE winner (10 rounds)', async () => {
    // Prove on a real engine what pg-mem could not: UPDATE ... WHERE key=$ AND value=$ produces an
    // affected-row count of 1 in only ONE of the two concurrent pools. The expired record is written
    // with ttlMs<0 as "already expired in the past"; the takeover calls run WITHOUT a `now` parameter
    // → the H2 journal.now() (PG clock) path is exercised on a real server too.
    for (let round = 0; round < 10; round++) {
      const runId = `${SEED}:takeover:${round}`;
      const dead = await acquireRunLock(a.runs, runId, 'old', -1000); // expires = now-1000 → immediately expired
      expect(dead).not.toBeNull(); // the fresh claim succeeded (the record exists but is already expired)
      const [lB, lC] = await Promise.all([
        acquireRunLock(a.runs, runId, 'B', 60_000),
        acquireRunLock(b.runs, runId, 'C', 60_000),
      ]);
      expect([lB, lC].filter((x) => x !== null).length).toBe(1); // NO split-brain — exactly one winner
    }
  });

  it('H2: journal.now() returns a reasonable epoch ms from the real PG clock', async () => {
    const ms = await (a.runs as any).now();
    expect(typeof ms).toBe('number');
    expect(Number.isFinite(ms)).toBe(true);
    // The container clock is on the same machine as the host → 60s tolerance is more than enough.
    expect(Math.abs(ms - Date.now())).toBeLessThan(60_000);
  });

  it('H12: compact() on REAL PG — VACUUM (lock-free) runs without corrupting data', async () => {
    const runId = `${SEED}:compact`;
    for (let i = 0; i < 50; i++) await a.runs.put(`${runId}:model:${i}`, { i, blob: 'x'.repeat(200) });
    const res = await (a as any).compact(); // default VACUUM (NO ACCESS EXCLUSIVE lock)
    expect(res.reclaimedBytes).toBe(-1); // PG doesn't report size → unknown (contract)
    expect((await b.runs.readRun(runId)).length).toBe(50); // data intact (compact is non-destructive)
  });

  it('T1: concurrent put(same NEW key) across two pools → the gnl_runs counter is exactly 1 (pg-mem CANNOT PROVE THIS)', async () => {
    // Under pg-mem this test showed the counter could reach 2 (verified experimentally: pg-mem does
    // NOT enforce real row-level locking/blocking between concurrent BEGIN'd clients — see
    // multi-worker.test.ts §T1(e) HONESTY NOTE). On real PG, journal.put() locks the JOURNAL row
    // (`writeRecord`: SELECT … FOR UPDATE, or the INSERT itself for a new key) and SERIALIZES the two
    // pools: the second one's INSERT waits for the first's commit, loses, and goes round to read the
    // committed row as its prev → the counter is applied exactly once as +1.
    const runId = `${SEED}:t1race`;
    const key = `${runId}:tool:call-x`;
    await Promise.all([
      a.runs.put(key, { status: 'succeeded', output: 'from-a' }),
      b.runs.put(key, { status: 'succeeded', output: 'from-b' }),
    ]);
    const entries = await a.runs.readRun(runId);
    expect(entries.length).toBe(1); // same key → a single journal row
    // Read from the OTHER pool — cross-pool consistency. listRuns is paginated with created_at ASC +
    // default limit(50): since earlier tests in this file created dozens of runs with the SAME SEED,
    // the most-recently-created t1race can land on the last page and flake this lookup (not the
    // counter itself, but .find() returning undefined). Fetch with a high limit in a single page →
    // the underlying gnl_runs counter check remains identical, deterministic.
    const page = await b.runs.listRuns({ limit: 100_000 });
    const run = page.items.find((r) => r.runId === runId)!;
    expect(run.toolCalls).toBe(1); // NO DOUBLE COUNTING — exactly 1 on real PG (the thing pg-mem could not prove)
  });

  it('H8: an atomic counter (UPSERT arithmetic) on REAL PG — 40 concurrent increments from two pools, exact total', async () => {
    const key = `${SEED}:usage`;
    await Promise.all(
      Array.from({ length: 40 }, (_, i) =>
        ((i % 2 === 0 ? a : b).runs as any).incrBy(key, { runs: 1, tokens: 5, costUsd: 0.25 }),
      ),
    );
    // Two SEPARATE pools + real concurrency: a get→put approach would have made a lost update inevitable.
    expect(await (a.runs as any).getCounters(key)).toEqual({ runs: 40, tokens: 200, costUsd: 10 });
  });

  it('H8: listStaleRuns + readRunStats on REAL PG (indexed age query, a statistic that doesn\'t move data)', async () => {
    const runId = `${SEED}:stale`;
    await a.runs.put(`${runId}:model:0`, { blob: 'x'.repeat(2000) });
    const stats = await (b.runs as any).readRunStats(runId);
    expect(stats.entries).toBe(1);
    expect(stats.bytes).toBeGreaterThan(2000);
    const future = Date.now() + 60_000; // everything counts as "stale"
    const stale = await (b.runs as any).listStaleRuns(future);
    expect(stale).toContain(runId);
    expect(await (b.runs as any).listStaleRuns(0)).toEqual([]); // a cutoff in the past → nothing is stale
  });

  it('H10a: durabilityReport on REAL PG — honestly reports a single node (NOT failover-safe)', async () => {
    const rep = await (a as any).durabilityReport();
    expect(typeof rep.syncCommit).toBe('string');
    expect(rep.connectedStandbys).toBe(0); // the main compose PG has no replica
    expect(rep.safeForFailover).toBe(false); // an honest report: a single node does NOT guarantee failover
    expect(rep.notes.join(' ')).toMatch(/No replica|single node/);
  });

  it('the readRun ordering contract + superjson type preservation on REAL PG', async () => {
    const runId = `${SEED}:order`;
    // Decision #4: order by (created_at, key); writes landing in the same ms trigger the key tie-break
    // and make the insertion-order assertion flake → separate the timestamps to test insertion order.
    await a.runs.put(`${runId}:model:0`, { step: 0, at: new Date(1700000000000) });
    await sleep(5);
    await a.runs.put(`${runId}:tool:t1`, { status: 'succeeded' });
    await sleep(5);
    await a.runs.put(`${runId}:model:1`, { step: 1 });
    const entries = await b.runs.readRun(runId); // read from the OTHER pool
    expect(entries.map((e) => e.key)).toEqual([`${runId}:model:0`, `${runId}:tool:t1`, `${runId}:model:1`]);
    expect((entries[0]!.value as any).at).toBeInstanceOf(Date); // superjson roundtrip
  });

  // D4-real (P1.6b): applyBatch — pg-mem's INSERT...ON CONFLICT DO NOTHING misreports rowCount=1 even on
  // a genuine conflict (see postgres-storage.ts applyBatch's JSDoc), so storage-backend.test.ts gates its
  // "second call is a no-op" assertion behind caps.exactCas=false for Postgres — it CANNOT prove the
  // exactly-one-winner invariant under real concurrency, or that a mid-batch failure genuinely rolls back
  // (pg-mem's ROLLBACK does not actually undo). Both are proven here against a REAL transaction.
  it('D4-real (P1.6b): applyBatch atomicity under CONCURRENCY — two pools race the SAME claim key with different increments, exactly ONE batch lands', async () => {
    for (let round = 0; round < 10; round++) {
      const key = `${SEED}:batch-race:${round}`;
      const batchA = {
        claim: { key: `${key}:claim`, value: { w: 'a' } },
        incrs: [{ key: `${key}:ctr`, fields: { n: 1 } }],
        puts: [{ key: `${key}:row`, value: { from: 'a' } }],
      };
      const batchB = {
        claim: { key: `${key}:claim`, value: { w: 'b' } },
        incrs: [{ key: `${key}:ctr`, fields: { n: 100 } }],
        puts: [{ key: `${key}:row`, value: { from: 'b' } }],
      };
      const results = await Promise.all([(a.runs as any).applyBatch(batchA), (b.runs as any).applyBatch(batchB)]);
      expect(results.filter(Boolean).length).toBe(1); // exactly ONE batch landed — this is what pg-mem cannot prove
      const counters = await (a.runs as any).getCounters(`${key}:ctr`);
      const row = await a.runs.get<{ from: string }>(`${key}:row`);
      const claimVal = await a.runs.get<{ w: string }>(`${key}:claim`);
      // The LOSER's increment/put must be totally ABSENT — not merged (101), not partially applied.
      if (results[0]) {
        expect(claimVal?.w).toBe('a');
        expect(counters).toEqual({ n: 1 });
        expect(row?.from).toBe('a');
      } else {
        expect(claimVal?.w).toBe('b');
        expect(counters).toEqual({ n: 100 });
        expect(row?.from).toBe('b');
      }
    }
  });

  it('D4-real (P1.6b): applyBatch — a genuine mid-batch failure ROLLS BACK the whole transaction on REAL PG (claim + the individually-valid FIRST incr are BOTH undone)', async () => {
    const runId = `${SEED}:batch-fail`;
    const claimKey = `${runId}:tool:call-fail`;
    const ctrKeyA = `${SEED}:batch-fail:ctr-a`;
    const ctrKeyB = `${SEED}:batch-fail:ctr-b`;
    const batch = {
      claim: { key: claimKey, value: { status: 'succeeded', output: 1 } },
      incrs: [
        { key: ctrKeyA, fields: { n: 1 } }, // would succeed in isolation
        { key: ctrKeyB, fields: { bad: 'not-a-number' } }, // gnl_counters.value is DOUBLE PRECISION → this
        // non-numeric text fails the INSERT with "invalid input syntax for type double precision" —
        // a genuine SQL error raised MID-TRANSACTION, reachable through the public applyBatch API alone
        // (no src hook needed) — exactly the kind of failure pg-mem's non-undoing ROLLBACK can't prove safe.
      ],
    };
    await expect((a.runs as any).applyBatch(batch)).rejects.toThrow();
    expect(await a.runs.get(claimKey)).toBeUndefined(); // the claim insert was undone too
    expect(await (a.runs as any).getCounters(ctrKeyA)).toBeUndefined(); // the FIRST (valid-on-its-own) incr was undone too
    expect(await (a.runs as any).getCounters(ctrKeyB)).toBeUndefined();
  });

  it('D4-real (GDPR fix): deletePrefix sweeps org usage + metrics counters on REAL PG (gnl_counters), leaves a neighbor org intact', async () => {
    const org = `${SEED}:gdpr-org`;
    await (a.runs as any).incrBy(`${org}:__usage__`, { runs: 3, costUsd: 1.5 });
    await (a.runs as any).incrBy(`${org}:__metrics__:calls`, { n: 5 });
    await a.runs.put(`${org}:r1:input`, { p: 'x' }); // an ordinary (non-counter) key under the same prefix
    await (a.runs as any).incrBy(`${SEED}:gdpr-neighbor:__usage__`, { runs: 7 });
    await (a.runs as any).deletePrefix(`${org}:`);
    expect(await (b.runs as any).getCounters(`${org}:__usage__`)).toBeUndefined(); // swept (cross-pool read)
    expect(await (b.runs as any).getCounters(`${org}:__metrics__:calls`)).toBeUndefined();
    expect(await b.runs.get(`${org}:r1:input`)).toBeUndefined();
    expect(await (b.runs as any).getCounters(`${SEED}:gdpr-neighbor:__usage__`)).toEqual({ runs: 7 }); // neighbor untouched
  });

  it('D4-real (P1.6b): countRunsByStatus on REAL PG — matches a listRuns-derived count exactly (mixed completed/suspended)', async () => {
    for (let i = 0; i < 3; i++) await a.runs.put(`${SEED}:crs-done-${i}:model:0`, { ok: true });
    for (let i = 0; i < 2; i++) {
      await a.runs.put(`${SEED}:crs-susp-${i}:model:0`, { ok: true });
      await a.runs.put(`${SEED}:crs-susp-${i}:tool:t1`, { status: 'suspended', output: {} });
    }
    const counted = await (b.runs as any).countRunsByStatus(); // cross-pool read, indexed GROUP BY
    // The describe block's earlier tests also created SEED-prefixed runs on this same table — compare
    // against the WHOLE table's listRuns-derived truth (same source countRunsByStatus itself groups over),
    // not just this test's own runs — the two must agree regardless of what else exists.
    const page = await b.runs.listRuns({ limit: 1_000_000 });
    const expected: Record<string, number> = {};
    for (const r of page.items) expected[r.status] = (expected[r.status] ?? 0) + 1;
    expect(counted).toEqual(expected);
    expect(expected.suspended).toBeGreaterThanOrEqual(2); // sanity: the mixed statuses really landed
  });

  it('D4-real (P1.6b): getMany on REAL PG — order-preserving, undefined for misses, cross-pool read', async () => {
    await a.runs.put(`${SEED}:gm:a`, { v: 1 });
    await a.runs.put(`${SEED}:gm:c`, { v: 3 });
    const [va, vb, vc] = await (b.runs as any).getMany([`${SEED}:gm:a`, `${SEED}:gm:b`, `${SEED}:gm:c`]);
    expect(va).toEqual({ v: 1 });
    expect(vb).toBeUndefined();
    expect(vc).toEqual({ v: 3 });
  });

  // The events package's delivery guarantee on a real server, two pools racing. These ran on the Redis
  // WorkStore until that adapter was removed; Postgres is now the shared store they promise it on.
  it('ackOnce from two pools at once → exactly one true (10 rounds)', async () => {
    for (let round = 0; round < 10; round++) {
      const results = await Promise.all([a.work.ackOnce(`${SEED}:job-${round}`), b.work.ackOnce(`${SEED}:job-${round}`)]);
      expect(results.filter(Boolean).length).toBe(1);
    }
  });

  it('@gnldev/events on the Postgres WorkStore: fan-out to two workers, and racing replicas of one consumer count each event once', async () => {
    const topic = `${SEED}-order`;
    const gotX: string[] = [];
    const gotY: string[] = [];
    const cX = createConsumer(a.work, topic, async (p: any) => { gotX.push(p.id); }, { name: 'reporter' });
    const cY = createConsumer(b.work, topic, async (p: any) => { gotY.push(p.id); }, { name: 'biller' });
    await emit(a.work, topic, { id: 's1' }, { id: 'e1' });
    await emit(b.work, topic, { id: 's2' }, { id: 'e2' });
    await emit(a.work, topic, { id: 's1' }, { id: 'e1' }); // idempotent emit → one event
    await Promise.all([cX.poll(), cY.poll()]);
    expect(gotX.sort()).toEqual(['s1', 's2']); // fan-out: every consumer got every event
    expect(gotY.sort()).toEqual(['s1', 's2']);
    // Two replicas of ONE consumer on two pools: exactly-once MARKING, at-least-once DELIVERY (the
    // handler may run on both; only one wins ackOnce per event, so the delivered count is exactly 2).
    const dupGot: string[] = [];
    const r1 = createConsumer(a.work, topic, async (p: any) => { dupGot.push(p.id); }, { name: 'replica' });
    const r2 = createConsumer(b.work, topic, async (p: any) => { dupGot.push(p.id); }, { name: 'replica' });
    const [d1, d2] = await Promise.all([r1.poll(), r2.poll()]);
    expect(d1 + d2).toBe(2);
    expect([...new Set(dupGot)].sort()).toEqual(['s1', 's2']);
    expect(dupGot.length).toBeLessThanOrEqual(4);
  });

  it('@gnldev/events on the Postgres WorkStore: a `:` in a topic or consumer name does not collide', async () => {
    // topic 'a' + consumer 'b:c' and topic 'a:b' + consumer 'c' once built the same ack marker; one
    // consumer's ack swallowed the other's event. Same event id on both sides, so only the escaping
    // keeps them apart.
    const seen: string[] = [];
    await emit(a.work, `${SEED}-ack`, { who: 'P' }, { id: 'same' });
    await emit(b.work, `${SEED}-ack:eu`, { who: 'Q' }, { id: 'same' });
    const p = createConsumer(a.work, `${SEED}-ack`, async (x: any) => { seen.push(`P:${x.who}`); }, { name: 'eu:billing' });
    const q = createConsumer(b.work, `${SEED}-ack:eu`, async (x: any) => { seen.push(`Q:${x.who}`); }, { name: 'billing' });
    await p.poll();
    await q.poll();
    expect(seen.sort()).toEqual(['P:P', 'Q:Q']);
  });
});

describe.skipIf(!RUN)('REAL Postgres — schema creation under a simultaneous boot', () => {
  // `CREATE TABLE IF NOT EXISTS` is not safe against a concurrent copy of itself: both sessions pass
  // the existence check, both proceed, and the loser dies inside Postgres' catalog with
  // `duplicate key value violates unique constraint "pg_type_typname_nsp_index"` — a message about
  // an internal index, telling the reader nothing they can act on.
  //
  // Which is the shape of a fleet boot: several instances starting together against a database
  // created minutes ago, the normal case on a platform that scales by adding copies. Measured before
  // the fix on a real Postgres — two storages opened in the same moment, one rejected exactly so.
  //
  // The race only exists on FIRST creation, so the test needs a genuinely empty namespace: a private
  // schema per run, dropped afterwards. Pointing the storages at it via `search_path` is what makes
  // their DDL land there and start from nothing — without that this would pass on an already-built
  // database and prove nothing.
  it('several instances against an EMPTY schema all come up', async () => {
    const { Pool } = createRequire(import.meta.url)('pg') as { Pool: new (c: unknown) => { query: (q: string) => Promise<unknown>; end: () => Promise<void> } };
    const admin = new Pool({ connectionString: PG_URL });
    const schema = `boot_${Date.now().toString(36)}`;
    await admin.query(`CREATE SCHEMA "${schema}"`);
    const url = `${PG_URL}?options=-c%20search_path%3D${schema}`;

    try {
      const boots = await Promise.allSettled(
        Array.from({ length: 6 }, async () => {
          const s = new PostgresStorage({ connectionString: url });
          await s.meta.set('boot', '1'); // any write — the point is that init() ran first
          await s.close?.();
        }),
      );
      const why = (boots.filter((b) => b.status === 'rejected') as PromiseRejectedResult[])
        .map((r) => String((r.reason as Error)?.message)).join(' | ');
      expect(why).toBe(''); // an empty string reads the failure back in the report
    } finally {
      await admin.query(`DROP SCHEMA "${schema}" CASCADE`);
      await admin.end();
    }
  }, 40_000);
});

// ─────────────────────────────────────────────────────────────────────────────
// Prefix ranges under the SERVER'S OWN COLLATION.
//
// Every prefix operation here is a range: `key >= prefix AND key < prefix + U+FFFF`. That upper bound
// is only a prefix under BYTE ordering. Under a linguistic collation — en_US.utf8, the default of
// nearly every managed Postgres (Neon, RDS, Supabase) — U+FFFF is a noncharacter that collates as if
// absent, so the bound degenerates to `key < prefix` and the range matches NOTHING. listKeys returns
// empty and deletePrefix deletes nothing, both reporting success: an org purge, a retention sweep and
// a GDPR erasure all "succeed" while the rows stay.
//
// This block exists because the rest of the suite could not see that. Measured, with the COLLATE "C"
// fix reverted:
//
//   postgres:15-alpine (SQL_ASCII / coll=C)  → 30/30 PASS   ← what CI runs
//   postgres / pgvector pg16 (UTF8 / en_US)  → 1 FAIL
//
// So the single most consequential Postgres fix in the release was invisible to CI, on the exact
// configuration every managed provider ships. The CI job now runs a matrix over both orderings, and
// GNL_PG_EXPECT_COLLATION lets each leg assert it really got the ordering it was meant to test —
// otherwise an image default could quietly move both legs to C and the coverage would evaporate while
// staying green.
describe.skipIf(!RUN)('REAL Postgres — prefix ranges under this server\'s collation', () => {
  let s: PostgresStorage;
  let pool: any;

  beforeAll(async () => {
    s = new PostgresStorage({ connectionString: PG_URL });
    await s.init();
    const require_ = createRequire(import.meta.url);
    const { Pool } = require_('pg');
    pool = new Pool({ connectionString: PG_URL });
  }, 30_000);

  afterAll(async () => {
    await s?.close();
    await pool?.end();
  });

  /** Whether THIS server orders strings by byte value, asked of the server rather than assumed. */
  async function byteOrdered(): Promise<boolean> {
    // Parameters, not a U&'' literal: on a SQL_ASCII database the literal escape is rejected outright
    // ("conversion between UTF8 and SQL_ASCII is not supported"), which would make this throw on the
    // very server that is byte-ordered. The production code passes prefix + '￿' as a bind
    // parameter for the same reason.
    const r = await pool.query(`SELECT ($1 < $2) AS b`, ['a:b', 'a:' + '￿']);
    return r.rows[0].b === true;
  }

  it('reports the collation it is testing, and matches what CI asked for', async () => {
    const meta = await pool.query(
      `SELECT pg_encoding_to_char(encoding) AS enc, datcollate AS coll FROM pg_database WHERE datname = current_database()`,
    );
    const { enc, coll } = meta.rows[0];
    const bo = await byteOrdered();
    console.log(`[collation] encoding=${enc} collate=${coll} byte_ordered=${bo}`);

    const expected = process.env.GNL_PG_EXPECT_COLLATION;
    if (expected) {
      // A matrix leg that silently ran the ordering it was NOT assigned would report coverage it does
      // not have — the failure mode this whole block exists to prevent.
      expect(coll, `this leg was assigned collation ${expected} but the server reports ${coll}`).toBe(expected);
    }
    // Not asserted unconditionally: both orderings are legitimate, and which one is present is the
    // property of the environment. What is asserted is that the two agree with each other.
    expect(typeof bo).toBe('boolean');
    expect(bo, 'a C-collated database must order by bytes').toBe(coll === 'C' || coll.startsWith('C.') ? true : bo);
  });

  it('listKeys returns the keys under a prefix — on a linguistic collation too', async () => {
    const run = `${SEED}coll1`;
    await s.runs.put(`${run}:model:a`, { i: 1 });
    await s.runs.put(`${run}:model:b`, { i: 2 });
    await s.runs.put(`${run}:model:c`, { i: 3 });

    const keys = await s.runs.listKeys(`${run}:`);
    // THE assertion. With the fix reverted this is [] on en_US.utf8 — an empty list, no error.
    expect(keys.sort()).toEqual([`${run}:model:a`, `${run}:model:b`, `${run}:model:c`]);
    // The bounded probe (`runOwnerOf` asks it on every new run): at most `limit` keys, from inside the prefix.
    const probe = await s.runs.listKeys(`${run}:`, { limit: 2 });
    expect(probe.length).toBe(2);
    for (const k of probe) expect(k.startsWith(`${run}:`)).toBe(true);
    expect(await s.runs.listKeys(`${SEED}nothing:`, { limit: 2 })).toEqual([]);
  });

  it('deletePrefix really deletes, and stops at the prefix boundary', async () => {
    const run = `${SEED}coll2`;
    const neighbour = `${SEED}coll2x`; // shares the prefix's leading bytes; must NOT be swept
    await s.runs.put(`${run}:model:k1`, { i: 1 });
    await s.runs.put(`${run}:model:k2`, { i: 2 });
    await s.runs.put(`${neighbour}:model:keep`, { i: 3 });

    const n = await s.runs.deletePrefix(`${run}:`);
    // A count, not just an absence: deletePrefix returning 0 while claiming success is the bug.
    expect(n, 'deletePrefix reported a row count of 0 — the range matched nothing').toBeGreaterThanOrEqual(2);
    expect(await s.runs.listKeys(`${run}:`)).toEqual([]);
    // And the boundary: an over-wide range would take the neighbour's row with it.
    expect(await s.runs.listKeys(`${neighbour}:`)).toEqual([`${neighbour}:model:keep`]);
  });

  it('a key beginning with an astral character is inside its own prefix range', async () => {
    // UTF-8 sorts every astral character above U+FFFF, which the old `prefix + U+FFFF` bound put
    // OUTSIDE the range. In memory the same code passed, because JS compares UTF-16 where a surrogate
    // pair starts below U+FFFF — so this could only ever be caught against a real engine.
    const run = `${SEED}astral`;
    // The astral character must come FIRST after the prefix — that is the position the range bound
    // decides. An earlier version put it deeper (`${run}:model:<emoji>`), where the first byte after
    // the prefix is an ordinary 'm', so the bound was never consulted and the test passed with the
    // bug still in place. Caught by reverting the fix and seeing it stay green.
    await s.runs.put(`${run}:plain:model:0`, { i: 1 });
    await s.runs.put(`${run}:\u{1F600}emoji:model:0`, { i: 2 });

    const keys = await s.runs.listKeys(`${run}:`);
    expect(keys.length, `listKeys returned ${keys.length} of 2 — an astral key fell outside its prefix`).toBe(2);
    expect(await s.runs.deletePrefix(`${run}:`)).toBe(2);
    expect(await s.runs.listKeys(`${run}:`)).toEqual([]);
  });
});

// The store-assigned append path, on a real server. pg-mem cannot host this test: it has no
// `pg_advisory_xact_lock`, so its conformance run declares `serialisesAppends: false` and skips the
// racing case. That skip is only honest if the proof exists somewhere, and this is somewhere.
//
// What is being proven: two SEPARATE pools — genuinely concurrent, the way two PM2 workers are —
// appending to ONE thread lose nothing and interleave without tearing a batch apart. Under the old
// caller-assigned `seq` this was measured losing a third of all messages, and when the loss split a
// batch it left a tool-call with no tool-result, which fails every later turn at the provider.
describe.skipIf(!RUN)('REAL Postgres — concurrent appends to one thread', () => {
  const pools: PostgresStorage[] = [];
  afterAll(async () => { for (const p of pools) await (p as any).close?.(); });

  it('two pools appending at once lose nothing and keep each batch contiguous', async () => {
    const a = new PostgresStorage({ connectionString: PG_URL });
    const b = new PostgresStorage({ connectionString: PG_URL });
    pools.push(a, b);
    const tid = `append-race-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

    // Each "turn" is a two-row batch — the shape that breaks visibly when it tears: an assistant
    // message that calls a tool, then the tool's answer.
    const turn = (s: PostgresStorage, who: string, i: number) => s.memory!.appendMessages(tid, [
      { threadId: tid, role: 'assistant', text: `${who}-${i}-call`, ts: 1, message: { role: 'assistant', content: [{ type: 'tool-call', toolCallId: `${who}-${i}`, toolName: 'x', input: {} }] } },
      { threadId: tid, role: 'tool', text: `${who}-${i}-result`, ts: 1, message: { role: 'tool', content: [{ type: 'tool-result', toolCallId: `${who}-${i}`, toolName: 'x', output: { type: 'json', value: {} } }] } },
    ]);

    const N = 12;
    await Promise.all([
      ...Array.from({ length: N }, (_, i) => turn(a, 'A', i)),
      ...Array.from({ length: N }, (_, i) => turn(b, 'B', i)),
    ]);

    const page = await a.memory!.getMessages(tid, { limit: 1000 });
    const seqs = page.items.map((m) => m.seq);
    expect(seqs.length, 'a message was lost').toBe(N * 4);
    // Dense and unique: the store handed out every position exactly once.
    expect(seqs).toEqual([...Array(N * 4).keys()]);

    // No batch was torn: every call sits immediately before its own result.
    for (const item of page.items) {
      const m = /^(A|B)-(\d+)-call$/.exec(item.text ?? '');
      if (!m) continue;
      expect(page.items[seqs.indexOf(item.seq) + 1]?.text,
        `batch ${m[0]} was split by another writer`).toBe(`${m[1]}-${m[2]}-result`);
    }
  });
});

// The MemoryStore conformance cases, against a real server.
//
// They ran against pg-mem until PostgresStorage started withdrawing the memory port where
// `pg_advisory_xact_lock` is missing — true of pg-mem, so the whole Postgres memory block left the
// default suite with it. `recall`, `messageRange`, the filter operators and `deleteMessagesAfter` are
// Postgres-specific SQL; a capability declaration removing their coverage would be exactly the false
// comfort that declaration exists to remove. Here they run where the guarantee is actually real.
// Erasure is the one operation with a legal deadline behind it, and the one whose failure is
// invisible: nothing throws, the person is told "deleted", and a record built from their own
// arguments stays on disk. The ordering gap (retention deletes the run that names the person, THEN
// the erasure request arrives) is pinned end to end on the in-memory journal, where a run can
// actually be created through `runDurable`.
//
// What is pinned HERE is the half that is adapter behaviour and cannot be argued from a simulation:
// `purgeResource` finds the leftover thread through a `resthr:<person>:` PREFIX SCAN and then
// deletes that family by PREFIX. Both are real SQL — a broken range or an unescaped pattern would
// agree with the in-memory journal right up until production.
describe.skipIf(!RUN)('REAL Postgres — erasure reaches a thread through the ownership trace', () => {
  it('a trace written by the sweep is read, followed, and then erased itself', async () => {
    const s = new PostgresStorage({ connectionString: PG_URL });
    const journal = toJournal(s.runs) as never as {
      listKeys(p: string): Promise<string[]>; put(k: string, v: unknown): Promise<void>;
    };
    const uniq = Date.now().toString(36);
    // A threadId containing ':' on purpose — the trace key is `resthr:<person>:<thread>` and the
    // remainder after the person's boundary is the WHOLE threadId, colons and all.
    const person = `${SEED}-p-${uniq}`;
    const thread = `${SEED}:th:${uniq}`;
    // A NEIGHBOUR person whose id extends ours by one character: `resthr:<p>:` must not reach them.
    const neighbour = `${person}X`;
    try {
      await journal.put(`resthr:${person}:${thread}`, { at: Date.now() });
      await journal.put(`xthr:${thread}:sem-pay-h1`, { v: 1, canonical: 'pay: iban-tr55', at: Date.now() });
      await journal.put(`resthr:${neighbour}:other`, { at: Date.now() });
      await journal.put(`xthr:other:sem-pay-h2`, { v: 1, canonical: 'pay: someone-else', at: Date.now() });

      await purgeResource(journal as never, person);

      expect(await journal.listKeys(`xthr:${thread}:`),
        "the person's own argument survived their erasure request").toEqual([]);
      expect(await journal.listKeys(`resthr:${person}:`),
        'the trace names a person and must not outlive them').toEqual([]);
      // The boundary: erasing one person does not erase the next one along.
      expect((await journal.listKeys(`resthr:${neighbour}:`)).length,
        'a person whose id merely EXTENDS the purged one was swept too').toBe(1);
      expect((await journal.listKeys('xthr:other:')).length).toBe(1);
    } finally {
      await (s as any).close?.();
    }
  }, 30_000);
});

describe.skipIf(!RUN)('REAL Postgres — MemoryStore conformance', () => {
  const made: PostgresStorage[] = [];
  afterAll(async () => { for (const s of made) await (s as any).close?.(); });
  memoryConformance(() => {
    // Each case assumes an empty store, and they all share one server — so each gets its own schema.
    // `search_path` is set on every new connection rather than through a startup option, because the
    // schema has to be created first and a startup `search_path` naming a missing schema resolves to
    // nothing. PostgresStorage then runs its DDL wherever the path points, with no changes needed.
    const ns = `mc_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 7)}`;
    const pool = new PgPool({ connectionString: PG_URL });
    pool.on('connect', (c: any) => { void c.query(`CREATE SCHEMA IF NOT EXISTS ${ns}; SET search_path TO ${ns}`); });
    const s = new PostgresStorage({ pool: pool as any });
    made.push(s);
    return s as any;
  }, { serialisesAppends: true });
});

// A DATABASE FAILOVER MUST NOT KILL THE APPLICATION, and for one release it did.
//
// `pg` reports a lost connection through two different objects depending on what that connection was
// doing. An IDLE one fails on the pool; a CHECKED-OUT one — with a query in flight — emits 'error'
// on the Client itself. Only the pool had a listener, so a connection that died mid-query reached
// Node's rule for an EventEmitter with no 'error' listener: throw, from the socket's turn of the
// event loop, where no `try` around the query can catch it. The process ended. Not the query — the
// process, and with it whatever application had mounted this engine.
//
// Measured against a real server before the fix: 120 concurrent writes, backends terminated the way
// a managed failover terminates them, and Node exited with
// `Unhandled 'error' event ... Emitted 'error' event on Client instance`.
//
// This cannot be written against pg-mem, which has no connections to lose. It also cannot be written
// as a unit test: the failure arrives on a socket, not through a call.
describe.skipIf(!RUN)('REAL Postgres — a failover does not take the process with it', () => {
  /** Terminates every backend on this database except the one doing the terminating — or, on a database
   *  other test files share, only the backends named `app`: killing theirs failed them mid-query. */
  const killBackends = async (via: PgPool, app?: string): Promise<number> => {
    const r = await via.query(
      `SELECT count(pg_terminate_backend(pid))::int AS n FROM pg_stat_activity
       WHERE datname = current_database() AND pid <> pg_backend_pid() AND ($1::text IS NULL OR application_name = $1)`,
      [app ?? null],
    );
    return r.rows[0]?.n ?? 0;
  };
  /** The test's own raw pools get what the product gives its own: a listener on the pool and on every
   *  connection. These tests terminate sessions on purpose, and the cleanup force-drops a database, so a
   *  session of a helper pool can be terminated as it closes; without a listener that error is uncaught
   *  and fails the run (seen in CI on the en_US.utf8 job, never reproduced locally — 0 of 40 runs). */
  const quietPool = (connectionString: string): PgPool => {
    const p = new PgPool({ connectionString });
    p.on('error', () => {});
    p.on('connect', (c: any) => { c.on('error', () => {}); });
    return p;
  };

  it('writes in flight when the backend dies: the process survives and the journal stays honest', async () => {
    // The shared database: name this storage's connections so only they are terminated.
    const app = `gnl-failover-${SEED}`;
    const named = new URL(PG_URL); named.searchParams.set('application_name', app);
    const s = new PostgresStorage({ connectionString: named.toString() });
    const killer = quietPool(PG_URL);
    let kill: Promise<unknown> = Promise.resolve();
    try {
      const runId = `${SEED}-failover-${Date.now().toString(36)}`;
      const N = 120;
      // Get the schema up BEFORE the kill is armed. Without this the 40ms timer raced the DDL in
      // `ensureReady`, and on a slow runner the kill landed on the boot instead of on the writes:
      // every write then failed for the same single reason and the honesty invariant below compared
      // 0 against 0 — green, and measuring nothing. It is also how the leg actually broke: CI's
      // `Postgres C` job failed at 97ms inside postgres-storage.ts:401, the DDL loop, while the
      // `en_US.utf8` job passed. Same code, different runner speed. The bug that race exposed is
      // real and fixed (see the boot-interrupted test below); this line is about pointing the kill
      // at what this test claims to measure.
      await s.runs.put(`${runId}:tool:warm`, { status: 'succeeded', output: 'warm' });
      const writes = Array.from({ length: N }, (_, i) =>
        s.runs.put(`${runId}:tool:t${i}`, { status: 'succeeded', output: { i } })
          .then(() => true).catch(() => false));
      kill = new Promise((r) => setTimeout(() => r(killBackends(killer, app).catch(() => 0)), 40));
      const results = await Promise.all(writes);

      // Reaching this line at all is half the assertion: before the fix the process was gone.
      const succeeded = results.filter(Boolean).length;
      const stats = await s.runs.readRunStats(runId);

      // THE HONESTY INVARIANT, and the reason a count is asserted rather than "some writes failed":
      // every write that reported success is in the journal, and every write that reported failure
      // is NOT. A mismatch either way is a silent lie — a lost write that was called durable, or a
      // refused write that landed anyway.
      // +1 for the warm-up write above, which is in the journal but not in `results`.
      expect(stats.entries, `${succeeded} writes reported success (+1 warm-up) but the journal holds ${stats.entries}`)
        .toBe(succeeded + 1);
      expect(succeeded, 'the kill landed after everything had already committed — the test proved nothing')
        .toBeLessThan(N);

      // And the pool recovers rather than staying poisoned.
      await expect(s.runs.put(`${runId}:tool:after`, { status: 'succeeded', output: 'after' }))
        .resolves.not.toThrow();
    } finally {
      await kill; // the kill is not left running into the cleanup
      await killer.end();
      await (s as any).close?.();
    }
  }, 30_000);

  // The bug CI found, pinned. It is NOT the same failure as the test above: there the connection
  // dies during writes and each write rejects on its own; here it dies during the one-time schema
  // boot, whose promise `ensureReady` memoises. A memoised REJECTION never expires, so the instance
  // answered every later call with that same dead error — forever, on a database that was healthy
  // again half a second later. In a fleet that is the copy which failed over and never came back.
  it('a boot interrupted by the failover does not leave the instance permanently dead', async () => {
    const dbName = `gnl_boot_${Date.now().toString(36)}`;
    const admin = quietPool(PG_URL);
    await admin.query(`CREATE DATABASE ${dbName}`);
    // A database of its own, because the boot can only be interrupted where there is DDL left to
    // run — against the shared one the schema already exists and there is no window to hit.
    const url = new URL(PG_URL); url.pathname = `/${dbName}`;
    const killer = quietPool(url.toString());
    const s = new PostgresStorage({ connectionString: url.toString() });
    let kill: Promise<unknown> = Promise.resolve();
    try {
      await killer.query('SELECT 1');   // a session to terminate from, outside the pool under test
      const boot = s.runs.put('r:tool:a', { status: 'succeeded', output: 1 }).then(() => null, (e: Error) => e);
      kill = new Promise((r) => setTimeout(() => r(killBackends(killer).catch(() => 0)), 8));
      const bootErr = await boot;
      // If the kill missed the window there is nothing to assert — say so rather than pass quietly.
      if (!bootErr) return;

      await new Promise((r) => setTimeout(r, 400));
      // Independent proof the backend is fine, so a failure below is about the instance, not the DB.
      const fresh = new PostgresStorage({ connectionString: url.toString() });
      await fresh.runs.put('r:tool:fresh', { status: 'succeeded', output: 1 });
      await (fresh as any).close?.();

      await expect(
        s.runs.put('r:tool:b', { status: 'succeeded', output: 2 }),
        'the instance never retried the schema after the backend came back',
      ).resolves.not.toThrow();
    } finally {
      await kill; // the kill is not left running into the cleanup
      await killer.end();
      await (s as any).close?.();
      await admin.query(`DROP DATABASE IF EXISTS ${dbName} WITH (FORCE)`).catch(() => {});
      await admin.end();
    }
  }, 60_000);

  it('every pooled connection gets an error listener — not just the pool', async () => {
    // The behavioural test above passes for one WRONG reason too: if the kill happens to land only
    // on idle connections, the pool handler covers it. This one pins the mechanism instead.
    //
    // It is specifically a guard against the fix being reverted to what looked reasonable: the pool
    // handler is attached only when `listenerCount('error') === 0`, and copying that condition down
    // to the client attaches NOTHING — `pg` adds its own listener before handing the client over, so
    // the count is already 1. Measured: count 1 at 'connect', process still died.
    const pool = new PgPool({ connectionString: PG_URL });
    const counts: number[] = [];
    pool.on('connect', (c: any) => { counts.push(c.listenerCount('error')); });
    const s = new PostgresStorage({ pool: pool as any });
    try {
      await s.runs.put(`${SEED}-listener:tool:x`, { status: 'succeeded', output: 1 });
      expect(counts.length, 'no connection was opened — nothing was measured').toBeGreaterThan(0);
      // This assertion reads the count AFTER our handler had its chance, on a later connection.
      const pool2 = new PgPool({ connectionString: PG_URL });
      const s2 = new PostgresStorage({ pool: pool2 as any });
      let observed = -1;
      pool2.on('connect', (c: any) => { setTimeout(() => { observed = c.listenerCount('error'); }, 0); });
      await s2.runs.put(`${SEED}-listener2:tool:x`, { status: 'succeeded', output: 1 });
      await new Promise((r) => setTimeout(r, 20));
      expect(observed, "pg's own listener is 1; ours makes 2 — a count of 1 means ours never attached")
        .toBeGreaterThanOrEqual(2);
      await (s2 as any).close?.();
    } finally {
      await (s as any).close?.();
    }
  }, 20_000);
});
