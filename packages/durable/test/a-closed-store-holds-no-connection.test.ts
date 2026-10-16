// A Postgres store that is closed holds no connection to its database.
//
// The run executor and the queue worker each make this process's liveness from the store they are
// given (`storage.processLiveness()`): a session on its own connection, installed for the process. The
// store's close() stops the executor but nothing ends that session, so the database the store was
// closed on keeps a connection from this process — measured: `DROP DATABASE` without FORCE refuses
// ("is being accessed by other users"), which is how a-seat-under-load and worker-runs-once fail on a
// real server. Postgres runs when GNL_PG_URL is set.
import { describe, it, expect, afterEach, vi } from 'vitest';
import pg from 'pg';
import { createGnl, STAFF } from '../src/index.js';
import { PostgresStorage } from '../src/postgres-storage.js';
import { installProcessLiveness } from '../src/process-liveness.js';
import { createMockModel, finalTextResult } from './mock.js';

const PG_URL = process.env.GNL_PG_URL;

async function withDatabase<T>(fn: (url: string, connections: () => Promise<string[]>) => Promise<T>): Promise<T> {
  const admin = new pg.Client({ connectionString: PG_URL });
  await admin.connect();
  const db = `cp_closed_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`;
  await admin.query(`CREATE DATABASE ${db}`);
  const url = new URL(PG_URL!); url.pathname = `/${db}`;
  // What is still connected, by its last statement: names the holder when the count is not 0.
  const connections = async () => (await admin.query('SELECT query FROM pg_stat_activity WHERE datname = $1', [db])).rows.map((r: { query: string }) => r.query);
  try {
    return await fn(url.toString(), connections);
  } finally {
    await admin.query(`DROP DATABASE IF EXISTS ${db} WITH (FORCE)`);
    await admin.end();
  }
}

describe.skipIf(!PG_URL)('a closed Postgres store holds no connection to its database', () => {
  // Each case starts as a fresh process would: no liveness installed yet.
  afterEach(() => installProcessLiveness(undefined));

  it('after a registry run on it', async () => {
    await withDatabase(async (url, connections) => {
      const storage = new PostgresStorage({ connectionString: url });
      const model = createMockModel(async () => finalTextResult('ok'));
      await createGnl({ storage, agents: { a: { model } } } as any).run('a', { runId: 'closed-1', prompt: 'go', caller: STAFF } as any);
      await storage.close();
      // Waited for: the server ends a backend after the client has closed it, so pg_stat_activity may list it
      // for a moment after close() returns (CI, Postgres en_US.utf8). A held connection never leaves.
      await vi.waitFor(async () => expect(await connections(), 'connections left on the closed store\'s database').toEqual([]), { timeout: 2_000 });
    });
  });
});
