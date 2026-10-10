// Greenfield storage contracts — the SAME suite runs against both InMemoryStorage and SqliteStorage
// → concrete proof of "portability" (every storage satisfies the same contract). + composite/capability verification.
import { describe, it, expect } from 'vitest';
import { newDb } from 'pg-mem';
import { InMemoryStorage, composite, requireCapability, CapabilityError, toJournal } from '../src/index.js';
import { SqliteStorage } from '../src/sqlite-storage.js';
import { PostgresStorage } from '../src/postgres-storage.js';
import { memoryConformance } from './memory-conformance.js';
import type { Storage, MessageRecord, ThreadRecord } from '../src/index.js';

const msg = (threadId: string, seq: number, text: string, embedding?: number[]): MessageRecord => ({
  threadId, seq, role: 'user', text, embedding, ts: seq, message: { role: 'user', content: text },
});
const thread = (id: string, resourceId: string, updatedAt: number): ThreadRecord => ({
  id, resourceId, createdAt: updatedAt, updatedAt,
});

// Storage matrix. exactCas=false: the storage can't model CAS's boolean return in the test environment
// (pg-mem's `ON CONFLICT DO NOTHING RETURNING` returns a row/rowCount=1 even on conflict — a pg-mem
// limitation; the code is correct for real Postgres, same pattern as PostgresJournal, verified in the
// docker integration).
// The data-level invariant (value is preserved / marker written once) is still verified on every storage.
// The memory/vectors skip decision is NOT a manual flag — it's derived from the storage's own capability
// declaration (below, in the describe setup): for a storage declaring 'none' for a port (or one whose
// probe withdrew it, as PostgresStorage does on pg-mem), that port's conformance tests are skipped.
// serialisesAppends=false: the storage cannot serialise two concurrent appends to one thread in this
// test environment. pg-mem has no `pg_advisory_xact_lock`, so four callers all read the same free
// position and collide. That collision is now a LOUD error rather than a silent drop, which is the
// intended behaviour — but it means the racing assertion below cannot run here. Real proof of that path
// belongs against a real server (integration-real.test.ts, GNL_INTEGRATION=1); this flag exists so the
// gap is declared instead of quietly absent.
type Caps = { exactCas: boolean; serialisesAppends: boolean };
const storages: [string, () => Storage, Caps][] = [['InMemoryStorage', () => new InMemoryStorage(), { exactCas: true, serialisesAppends: true }]];
try {
  const probe = new SqliteStorage();
  (probe as any).close?.();
  storages.push(['SqliteStorage', () => new SqliteStorage(':memory:'), { exactCas: true, serialisesAppends: true }]);
} catch {
  // node:sqlite unavailable (old Node / flag) → SQLite suite is skipped.
}
// Postgres: fresh db per test via pg-mem (in-memory real SQL).
const pgmemPool = () => { const { Pool } = newDb().adapters.createPg(); return new Pool(); };
storages.push(['PostgresStorage(pg-mem)', () => new PostgresStorage({ pool: pgmemPool() }), { exactCas: false, serialisesAppends: false }]);

for (const [name, make, caps] of storages) {
  // The port-skip decision comes from the storage's OWN declaration: capability 'none' (or the port not
  // existing at all) → that port's conformance tests are skipped. This makes divergence between a manual
  // flag and the declaration impossible.
  const probe = make();
  // `init()` FIRST. Some capabilities are only knowable after touching the server — PostgresStorage
  // probes for `pg_advisory_xact_lock` there and disables the memory port when it is absent, which is
  // exactly the case under pg-mem. Reading `capabilities` before that probe runs gives the value the
  // adapter held before it knew, so the suite would enrol a port the adapter has since withdrawn and
  // every memory test would fail on the refusal instead of being skipped.
  await (probe as { init?: () => Promise<void> }).init?.().catch(() => {});
  const skipMemory = probe.capabilities.memory === 'none' || probe.memory == null;
  const skipVectors = probe.capabilities.vectors === 'none' || probe.vectors == null;
  (probe as any).close?.();

  describe(`Storage contract: ${name}`, () => {
    // The RunJournal contract (get/put, putIfAbsent, putIfMatch, counters, applyBatch, getMany, the run
    // listing, its filters and paging, status counts) moved to `@gnldev/durable/testing` and runs on every
    // store in journal-conformance.test.ts.

    // MemoryStore conformance is skipped for storages that don't provide the memory port.
    if (!skipMemory) {
      memoryConformance(make, caps);
    } // /memory capability

    it('WorkStore: idempotent append + ackOnce CAS', async () => {
      const b = make();
      await b.work!.append('qjob', { type: 'x' }, 'j1');
      await b.work!.append('qjob', { type: 'x' }, 'j1');
      expect((await b.work!.list('qjob')).items.length).toBe(1);
      expect(await b.work!.ackOnce('ack:c1:e1')).toBe(true);
      const ack2 = await b.work!.ackOnce('ack:c1:e1');
      if (caps.exactCas) expect(ack2).toBe(false);
    });

    // 8.2 — the queue's terminal writes (qdone/qfail/qatt) rely on this for in-engine fencing (see
    // @gnldev/queue createWorker: stillOwns()). EXACTLY the same shape as RunJournal's putIfMatch (H1)
    // test, adapted to WorkStore's flat key schema (no envelope → direct value comparison).
    it('WorkStore: putIfMatch — matching expected updates, mismatching (stale token) leaves untouched, missing key false', async () => {
      const b = make();
      const w = b.work as unknown as {
        get<T = unknown>(k: string): Promise<T | undefined>;
        put(k: string, v: unknown): Promise<void>;
        putIfMatch(k: string, e: unknown, v: unknown): Promise<boolean>;
      };
      const key = 'qown:job-x';
      await w.put(key, 'token-a');
      const cur = await w.get(key); // roundtripped expected (as the queue's own CAS gate does)
      expect(await w.putIfMatch(key, cur, 'token-a')).toBe(true); // matched (same owner re-confirms)
      expect(await w.get(key)).toBe('token-a');
      // Takeover simulation: another worker (e.g. claim after lock takeover) switches the key to ITS OWN
      // token — the stale worker's (still expecting 'token-a') terminal write attempt is REJECTED.
      await w.put(key, 'token-b');
      expect(await w.putIfMatch(key, 'token-a', 'STALE-WRITE-SHOULD-NOT-LAND')).toBe(false);
      expect(await w.get(key)).toBe('token-b'); // value PRESERVED — the stale write never landed
      // Missing key → false (never writes).
      expect(await w.putIfMatch('qown:missing', 'token-a', 'x')).toBe(false);
      expect(await w.get('qown:missing')).toBeUndefined();
    });

    it('CacheStore: set/get + TTL expiry + delete', async () => {
      const b = make();
      await b.cache!.set('k', 42);
      expect(await b.cache!.get('k')).toBe(42);
      await b.cache!.set('k2', 'v', { ttlMs: -1 });
      expect(await b.cache!.get('k2')).toBeUndefined();
      await b.cache!.delete('k');
      expect(await b.cache!.get('k')).toBeUndefined();
    });

    if (!skipVectors) {
    it('VectorStore: upsert + query topK', async () => {
      const b = make();
      await b.vectors!.upsert([
        { id: 'a', text: 'cats', embedding: [1, 0] },
        { id: 'b', text: 'dogs', embedding: [0, 1] },
      ]);
      const m = await b.vectors!.query([1, 0], 1);
      expect(m.map((x) => x.text)).toEqual(['cats']);
    });
    } // /vectors capability
  });
}

describe('composite + capability', () => {
  it('per-store override routes correctly + recomputes the capability matrix', async () => {
    const def = new InMemoryStorage();
    const cacheStorage = new InMemoryStorage();
    const b = composite({ default: def, overrides: { cache: cacheStorage } });
    await b.cache!.set('k', 1);
    expect(await cacheStorage.cache.get('k')).toBe(1);
    expect(await def.cache.get('k')).toBeUndefined();
    expect(b.runs).toBe(def.runs);
    expect(b.capabilities.cache).toBe('full');
  });

  it('requireCapability throws CapabilityError for a missing store', () => {
    const fake = {
      name: 'x',
      capabilities: { runs: 'full', memory: 'none', vectors: 'none', work: 'none', cache: 'none' },
      runs: new InMemoryStorage().runs,
      meta: new InMemoryStorage().meta,
    } as unknown as Storage;
    expect(() => requireCapability(fake, 'memory')).toThrow(CapabilityError);
    expect(() => requireCapability(fake, 'runs')).not.toThrow();
  });

  // Bug: toJournal was NOT forwarding optional methods (deletePrefix etc.) → studio's org-delete
  // path returned a "requires deletePrefix support" 501 (even when the underlying SqliteStorage provided it).
  it('toJournal: forwards RunJournal optional methods (deletePrefix/putIfMatch/incrBy…)', async () => {
    const s = new SqliteStorage(':memory:'); // SqliteStorage.runs provides deletePrefix/putIfMatch/incrBy
    const j = toJournal(s.runs);
    expect(typeof j.deletePrefix).toBe('function');
    expect(typeof j.putIfMatch).toBe('function');
    expect(typeof j.incrBy).toBe('function');
    // Verify it actually works: write → delete with deletePrefix → gone (studio's org-delete path).
    await j.put('org:acme:x', 1);
    await j.put('org:acme:y', 2);
    expect(await j.deletePrefix!('org:acme:')).toBe(2);
    expect(await j.get('org:acme:x')).toBeUndefined();
  });

  it('toJournal: does NOT forward an optional method the underlying RunJournal does not provide (old behavior)', () => {
    const bare = {
      get: async () => undefined, put: async () => {}, putIfAbsent: async () => true,
      listKeys: async () => [], readRun: async () => [], listRuns: async () => ({ items: [], total: 0 }),
    } as any; // NO deletePrefix
    const j = toJournal(bare);
    expect(j.deletePrefix).toBeUndefined();
  });

  // P0.3 (AUDIT-R2): toJournal's listRunsPaged bridge — a straight delegation to the
  // underlying RunJournal.listRuns(q) (unconditional, since RunJournal.listRuns is MANDATORY, unlike
  // the optional-methods loop above). Proves the filter+pagination contract survives the bridge intact.
  it('toJournal: bridges listRunsPaged straight through to RunJournal.listRuns (filters + pagination intact)', async () => {
    const storage = new InMemoryStorage();
    await storage.runs.put('tj-done:model:0', { ok: true });
    await storage.runs.put('tj-susp:model:0', { ok: true });
    await storage.runs.put('tj-susp:tool:t1', { status: 'suspended', output: {} });
    const j = toJournal(storage.runs);
    expect(typeof j.listRunsPaged).toBe('function');
    const page = await j.listRunsPaged!({ status: 'suspended' });
    expect(page.items.map((r) => r.runId)).toEqual(['tj-susp']);
    // the array bridge (listRuns()) stays legacy/unfiltered — the two methods are independent surfaces.
    expect((await j.listRuns()).map((r) => r.runId).sort()).toEqual(['tj-done', 'tj-susp']);
  });
});
