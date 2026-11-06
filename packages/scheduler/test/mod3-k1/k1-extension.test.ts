// mod3 k1 — EXTENSION EXPERIMENT: a new background component (an events-consumer-like poller written
// outside the framework) attaches to the same store FIRST, through the public API, and holds a lock;
// then the app's registry (its explicit liveness given to the storage) runs. Does a second liveness open, and do
// the component's stamps name the same process as the registry's? Framework files touched: none — the
// component uses `bindOwnLiveness` when the build exports it, else `storeLiveness` (A: the only door).
import { describe, it, expect, afterEach } from 'vitest';
import { createRequire } from 'node:module';
import * as durable from '@gnldev/durable';
import { PostgresStorage } from '@gnldev/durable/postgres';

const { createGnl, postgresLiveness, acquireRunLock } = durable as any;
const req = createRequire(createRequire(import.meta.url).resolve('@gnldev/durable/package.json'));
const pg = req('pg');
const PG_URL = process.env.GNL_PG_URL!;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const ends: Array<() => unknown> = [];
afterEach(async () => { for (const e of ends.splice(0).reverse()) await e(); });
const usage = { inputTokens: { total: 1, noCache: 1, cacheRead: undefined, cacheWrite: undefined }, outputTokens: { total: 1, text: 1, reasoning: undefined } };

/** The new component: one tick takes a hold on `topic` under the store's process liveness. */
function consumer(journal: unknown) {
  return {
    async tick(topic: string) {
      if (typeof (durable as any).bindOwnLiveness === 'function') await (durable as any).bindOwnLiveness(journal);
      else await (durable as any).storeLiveness(journal, { own: () => (journal as any).processLiveness?.() });
      const lock = await acquireRunLock(journal, `evt:${topic}`, 'consumer', 5_000);
      return (await (journal as any).get(`evt:${topic}:lock`))?.proc as string | undefined;
    },
  };
}

describe.skipIf(!PG_URL)('k1 extension: a new background component on the same store', () => {
  it('attaches first; the registry (explicit liveness) runs after — one session, one id', async () => {
    const admin = new pg.Client({ connectionString: PG_URL }); await admin.connect();
    const schema = `k1x_${Date.now().toString(36)}`; await admin.query(`CREATE SCHEMA ${schema}`);
    const u = new URL(PG_URL); u.searchParams.set('options', `-c search_path=${schema}`); u.searchParams.set('application_name', schema);
    const L = await postgresLiveness({ connectionString: u.toString() });
    const storage: any = new PostgresStorage({ connectionString: u.toString(), liveness: L });
    ends.push(async () => { await storage.close(); await L.close(); await admin.query(`DROP SCHEMA ${schema} CASCADE`); await admin.end(); });
    await storage.runs.get('warm');
    const procOfHold = await consumer(storage.runs).tick('t1');
    let execOwner: string | undefined; let err = '';
    const model = { specificationVersion: 'v3', provider: 'k1', modelId: 'k1', supportedUrls: {}, doGenerate: async () => { throw new Error('x'); },
      doStream: async () => { const k: string[] = await storage.runs.listKeys('__exec__'); execOwner = (await storage.runs.get(k[0]))?.owner;
        return { stream: new ReadableStream({ start(c) { c.enqueue({ type: 'stream-start', warnings: [] }); c.enqueue({ type: 'text-start', id: 't' }); c.enqueue({ type: 'text-delta', id: 't', delta: 'ok' }); c.enqueue({ type: 'text-end', id: 't' }); c.enqueue({ type: 'finish', finishReason: { unified: 'stop', raw: 'stop' }, usage }); c.close(); } }) }; } };
    const gnl = createGnl({ storage, agents: { a: { model } } });
    try { await gnl.run('a', { runId: 'x1', prompt: 'go', resourceId: 'alice' }); } catch (e) { err = `${(e as Error).name}`; }
    await sleep(300);
    const locks = (await admin.query(`SELECT 1 FROM pg_locks l JOIN pg_stat_activity a ON a.pid = l.pid WHERE a.application_name = $1 AND l.locktype = 'advisory' AND l.objsubid = 1 AND l.granted`, [schema])).rows.length;
    console.log(`[k1] X ${JSON.stringify({ given: L.id.slice(0, 8), hold: procOfHold?.slice(0, 8), exec: execOwner?.slice(0, 8), locks, err })}`);
    expect(err).toBe('');
    expect(locks).toBe(1);
    expect(procOfHold).toBe(L.id);
    expect(execOwner).toBe(L.id);
  }, 30_000);
});
