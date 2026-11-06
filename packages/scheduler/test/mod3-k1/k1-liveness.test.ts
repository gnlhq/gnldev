// mod3 k1 — "a process holds ONE liveness session per store, and every stamp it writes there names it —
// whatever component attaches first", on every store (Sqlite, libSQL, Postgres, MySQL, MongoDB).
// One process, a real database each (a schema / database / file per test).
//   L1 (Q-liveness)  an explicit liveness for the app, given to the STORE (`new XStorage({ liveness })`);
//                    the queue worker attaches before / after the executor.
//   L2 (order)       no explicit liveness; worker, executor and scheduler attach in three orders.
//   L3 (A4)          a bare scheduler (custom runner, no createGnl): its fire lock names the process.
//   L4               a queue worker alone (no createGnl).
//   C1               a liveness handed to a component BESIDE the store's own is refused, loudly.
// Measured: process-liveness sessions held in the database, and the `proc`/`owner` each stamp carries.
import { describe, it, expect, afterEach, vi } from 'vitest';
import { createGnl, LivenessConflictError } from '@gnldev/durable';
import { createWorker, enqueue } from '../../../queue/src/index.js';
import { createScheduler, scheduleWorkflow, type WorkflowRunner } from '../../src/index.js';
import { kinds, freshDatabase, makeLiveness, openStore, type Kind } from '../../../durable/test/mod3-k1/stores.js';
import { distMods } from '../../../durable/test/mod3-k1/dist-mods.js';

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const ends: Array<() => unknown> = [];
afterEach(async () => { for (const e of ends.splice(0).reverse()) await e(); });

const usage = { inputTokens: { total: 1, noCache: 1, cacheRead: undefined, cacheWrite: undefined }, outputTokens: { total: 1, text: 1, reasoning: undefined } };
/** A streamed one-word answer that first reads the run's execution record (who executes it). */
function model(onExec: (owner: string | undefined) => void, storage: any): any {
  return {
    specificationVersion: 'v3', provider: 'k1', modelId: 'k1', supportedUrls: {},
    doGenerate: async () => { throw new Error('stream only'); },
    doStream: async () => {
      const keys: string[] = await storage.runs.listKeys('__exec__');
      const recs = await Promise.all(keys.map((k) => storage.runs.get(k)));
      onExec((recs.find((r: any) => r?.status === 'running') as any)?.owner);
      return { stream: new ReadableStream({ start(c) {
        c.enqueue({ type: 'stream-start', warnings: [] });
        c.enqueue({ type: 'text-start', id: 't' }); c.enqueue({ type: 'text-delta', id: 't', delta: 'ok' }); c.enqueue({ type: 'text-end', id: 't' });
        c.enqueue({ type: 'finish', finishReason: { unified: 'stop', raw: 'stop' }, usage }); c.close();
      } }) };
    },
  };
}

/** One app process: storage, registry, queue worker, scheduler — each attached on demand, in `order`. */
async function app(kind: Kind, order: Array<'worker' | 'gnl' | 'sched'>, explicit: boolean) {
  const fresh = await freshDatabase(kind, 'liveness');
  const L = explicit ? await makeLiveness(distMods, fresh.conn) : undefined;
  const storage: any = openStore(distMods, fresh.conn, L);
  ends.push(async () => { await storage.close(); await L?.close(); await fresh.dispose(); });
  await storage.runs.get('warm');
  const seen: Record<string, string | undefined> = {};
  const gnl = createGnl({ storage, agents: { a: { model: model((o) => { seen.exec = o; }, storage) } } } as any);
  const worker = createWorker(storage, { t: async (_p: unknown, ctx: any) => { seen.lease = (await storage.runs.get(`${ctx.runId}:lease:lock`))?.proc; } }, { ttlMs: 5_000 });
  ends.push(async () => { worker.stop(); await worker.close(); });
  const runner: WorkflowRunner = { async runWorkflow(_n, _i, o) { seen.fire = (await storage.runs.get(`${o!.runId}:fire:lock`))?.proc; return { runId: o!.runId! }; } };
  const sched = createScheduler(storage.runs, runner, { pollMs: 100, lockTtlMs: 5_000 });
  const errors: string[] = [];
  for (const step of order) {
    try {
      if (step === 'worker') { await enqueue(storage.work, 't', {}); await worker.runOnce(); }
      if (step === 'gnl') await gnl.run('a', { runId: `r-${Math.random().toString(36).slice(2, 7)}`, prompt: 'go', resourceId: 'alice' } as any);
      if (step === 'sched') { await scheduleWorkflow(storage.runs, { id: 's1', name: 'wf', at: Date.now() - 1 }); await sched.poll(); }
    } catch (e) { errors.push(`${step}: ${(e as Error).name}: ${(e as Error).message.slice(0, 120)}`); }
  }
  return { L, seen, errors, locks: await fresh.sessions() };
}

for (const kind of kinds()) {
  describe(`k1 one liveness per store per process — ${kind}`, () => {
    for (const order of [['worker', 'gnl'], ['gnl', 'worker']] as const) {
      it(`L1 Q-liveness: explicit liveness given to the store, ${order.join(' → ')}`, async () => {
        const r = await app(kind, [...order], true);
        console.log(`[k1] L1 ${kind} ${order.join('→')}:`, JSON.stringify({ given: r.L!.id.slice(0, 8), seen: Object.fromEntries(Object.entries(r.seen).map(([k, v]) => [k, v?.slice(0, 8)])), locks: r.locks, errors: r.errors }));
        expect(r.errors).toEqual([]);
        expect(r.locks).toBe(1);
        expect(r.seen.lease).toBe(r.L!.id);
        expect(r.seen.exec).toBe(r.L!.id);
      }, 30_000);
    }
    it('L1b the scheduler too: its fire lock names the liveness the store was given', async () => {
      const r = await app(kind, ['sched', 'worker', 'gnl'], true);
      expect(r.errors).toEqual([]);
      expect(r.locks).toBe(1);
      expect(new Set([r.seen.lease, r.seen.exec, r.seen.fire])).toEqual(new Set([r.L!.id]));
    }, 30_000);
    for (const order of [['worker', 'gnl', 'sched'], ['sched', 'worker', 'gnl'], ['gnl', 'sched', 'worker']] as const) {
      it(`L2 order: ${order.join(' → ')} (store's own liveness)`, async () => {
        const r = await app(kind, [...order], false);
        console.log(`[k1] L2 ${kind} ${order.join('→')}:`, JSON.stringify({ seen: Object.fromEntries(Object.entries(r.seen).map(([k, v]) => [k, v?.slice(0, 8)])), locks: r.locks, errors: r.errors }));
        expect(r.errors).toEqual([]);
        expect(r.locks).toBe(1);
        expect(r.seen.lease).toBeTruthy();
        expect(new Set([r.seen.lease, r.seen.exec, r.seen.fire]).size).toBe(1);
      }, 30_000);
    }
    it('L3 A4: a bare scheduler with its own runner — its fire lock names the process', async () => {
      const r = await app(kind, ['sched'], false);
      console.log(`[k1] L3 ${kind}:`, JSON.stringify({ fire: r.seen.fire?.slice(0, 8), locks: r.locks, errors: r.errors }));
      expect(r.errors).toEqual([]);
      expect(r.seen.fire).toBeTruthy();
      expect(r.locks).toBe(1);
    }, 30_000);
    it('L4 a queue worker alone: one session, its leases name it', async () => {
      const r = await app(kind, ['worker'], false);
      console.log(`[k1] L4 ${kind}:`, JSON.stringify({ lease: r.seen.lease?.slice(0, 8), locks: r.locks, errors: r.errors }));
      expect(r.errors).toEqual([]);
      expect(r.seen.lease).toBeTruthy();
      expect(r.locks).toBe(1);
    }, 30_000);

    // C1: the store answers for its liveness (its own, or the one it was given). A component handed another
    // one beside it would make a second session, so it is refused where it is first used — never bound over.
    it('C1 a liveness given to createGnl beside the store\'s own is refused', async () => {
      const fresh = await freshDatabase(kind, 'liveness');
      const storage: any = openStore(distMods, fresh.conn);
      const other = await makeLiveness(distMods, fresh.conn);
      ends.push(async () => { await storage.close(); await other.close(); await fresh.dispose(); });
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
      ends.push(() => warn.mockRestore());
      const gnl = createGnl({ storage, liveness: other, agents: { a: { model: model(() => undefined, storage) } } } as any);
      const err = await gnl.run('a', { runId: 'c1', prompt: 'go', resourceId: 'alice' } as any).catch((e: unknown) => e);
      expect(err).toBeInstanceOf(LivenessConflictError);
      expect((err as Error).message).toContain('its `liveness` option');
    }, 30_000);
    it('C1b a liveness given to createWorker beside the store\'s own is refused', async () => {
      const fresh = await freshDatabase(kind, 'liveness');
      const storage: any = openStore(distMods, fresh.conn);
      const other = await makeLiveness(distMods, fresh.conn);
      const worker = createWorker(storage, { t: async () => undefined }, { ttlMs: 5_000, liveness: other });
      ends.push(async () => { worker.stop(); await worker.close(); await storage.close(); await other.close(); await fresh.dispose(); });
      await enqueue(storage.work, 't', {});
      const err = await worker.runOnce().catch((e: unknown) => e);
      expect(err).toBeInstanceOf(LivenessConflictError);
    }, 30_000);
    it('C1c a liveness given to the store AND to a component is refused too (the store\'s is the one)', async () => {
      const fresh = await freshDatabase(kind, 'liveness');
      const L = await makeLiveness(distMods, fresh.conn);
      const storage: any = openStore(distMods, fresh.conn, L);
      ends.push(async () => { await storage.close(); await L.close(); await fresh.dispose(); });
      const worker = createWorker(storage, { t: async () => undefined }, { ttlMs: 5_000, liveness: L });
      ends.push(async () => { worker.stop(); await worker.close(); });
      await enqueue(storage.work, 't', {});
      const err = await worker.runOnce().catch((e: unknown) => e);
      expect(err).toBeInstanceOf(LivenessConflictError);
    }, 30_000);
    // S1: who ends a liveness. The store ends the one it made; the one it was given is its owner's.
    it('S1 close(): the store ends its own liveness, and leaves a given one to its owner', async () => {
      const settled = async (fresh: Awaited<ReturnType<typeof freshDatabase>>, want: number): Promise<number> => {
        let n = await fresh.sessions();
        for (let i = 0; i < 20 && n !== want; i++) { await sleep(250); n = await fresh.sessions(); }
        return n;
      };
      const fresh = await freshDatabase(kind, 'liveness');
      ends.push(() => fresh.dispose());
      const own: any = openStore(distMods, fresh.conn);
      await own.processLiveness();
      expect(await fresh.sessions()).toBe(1);
      await own.close();
      expect(await settled(fresh, 0)).toBe(0); // its own: ended with the store

      const L = await makeLiveness(distMods, fresh.conn);
      const given: any = openStore(distMods, fresh.conn, L);
      expect(await given.processLiveness()).toBe(L);
      await given.close();
      expect(await fresh.sessions()).toBe(1); // the given one: still held
      expect(await L.confirm()).toBe(true);
      await L.close();
      expect(await settled(fresh, 0)).toBe(0);
    }, 60_000);
    it('C2 an unknown storage option is still refused by name', async () => {
      const fresh = await freshDatabase(kind, 'liveness');
      ends.push(() => fresh.dispose());
      const open = () => (kind === 'sqlite' ? new (distMods.SqliteStorage as any)(fresh.conn.path, { livness: 1 })
        : kind === 'libsql' ? new (distMods.LibsqlStorage as any)(fresh.conn.path, { livness: 1 })
        : kind === 'postgres' ? new (distMods.PostgresStorage as any)({ connectionString: fresh.conn.url, livness: 1 })
        : kind === 'mysql' ? new (distMods.MysqlStorage as any)({ connectionString: fresh.conn.url, livness: 1 })
        : new (distMods.MongoStorage as any)({ connectionString: fresh.conn.url, database: fresh.conn.database, livness: 1 }));
      expect(open).toThrow(/livness/);
    });
  });
}
