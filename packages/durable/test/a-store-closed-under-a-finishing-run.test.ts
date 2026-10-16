// A store closed while a run's executor is still settling it raises nothing the process cannot catch.
//
// After a run's stream ends, its executor settles it (erasure-fence: once more after its last write)
// on the store. A store closed in that moment — a server shutting down right after answering — ended
// its pool under the settle, whose read then rejected with no handler: an unhandled rejection, which
// Node turns into a process exit by default. Measured on a real Postgres in
// a-cross-channel-id-is-claimed-before-the-effect.test.ts ("Cannot use a pool after calling end on the
// pool", from DetachedRuns.erasedRun in the settle). Postgres runs when GNL_PG_URL is set.
import { describe, it, expect, afterEach } from 'vitest';
import pg from 'pg';
import { createGnl, STAFF } from '../src/index.js';
import { PostgresStorage } from '../src/postgres-storage.js';
import { installProcessLiveness } from '../src/process-liveness.js';
import { createMockModel, finalTextResult } from './mock.js';

const PG_URL = process.env.GNL_PG_URL;
afterEach(() => installProcessLiveness(undefined));

describe.skipIf(!PG_URL)('a store closed under a finishing run', () => {
  it('no unhandled rejection when the store closes right after the run answers', async () => {
    const admin = new pg.Client({ connectionString: PG_URL });
    await admin.connect();
    const db = `cp_settle_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`;
    await admin.query(`CREATE DATABASE ${db}`);
    const url = new URL(PG_URL!); url.pathname = `/${db}`;
    const unhandled: unknown[] = [];
    const onUnhandled = (e: unknown) => { unhandled.push(e); };
    process.on('unhandledRejection', onUnhandled);
    try {
      for (let i = 0; i < 5; i++) {
        const storage = new PostgresStorage({ connectionString: url.toString() });
        const model = createMockModel(async () => finalTextResult('ok'));
        await createGnl({ storage, agents: { a: { model } } } as any).run('a', { runId: `settle-${i}`, prompt: 'go', caller: STAFF } as any);
        await storage.close();
      }
      await new Promise((r) => setTimeout(r, 500));
      expect(unhandled.map((e) => String((e as Error)?.message ?? e))).toEqual([]);
    } finally {
      process.off('unhandledRejection', onUnhandled);
      await admin.query(`DROP DATABASE IF EXISTS ${db} WITH (FORCE)`);
      await admin.end();
    }
  });
});
