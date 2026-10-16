// A Postgres store a queue worker ran on holds no connection once the worker stops and the store closes.
//
// The worker makes this process's liveness from the store (`storage.processLiveness()`): a session on its
// own connection. Nothing ends it, so the closed store's database keeps a connection from this process —
// measured: `DROP DATABASE` without FORCE refuses ("is being accessed by other users"), which is how
// worker-runs-once fails on a real server. Runs when GNL_PG_URL is set.
import { describe, it, expect, afterEach } from 'vitest';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { installProcessLiveness } from '@gnldev/durable';
import { createWorker } from '../src/index.js';

const here = dirname(fileURLToPath(import.meta.url));
const PG_URL = process.env.GNL_PG_URL;

describe.skipIf(!PG_URL)('a closed Postgres store a worker ran on holds no connection', () => {
  afterEach(() => installProcessLiveness(undefined));

  it('worker stopped, store closed: no connection left on its database', async () => {
    const { PostgresStorage } = await import('@gnldev/durable/postgres');
    // `pg` is @gnldev/durable's dependency, not this package's: resolved from there.
    const pg = createRequire(join(here, '..', '..', 'durable', 'package.json'))('pg');
    const admin = new pg.Client({ connectionString: PG_URL });
    await admin.connect();
    const db = `cp_qclosed_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`;
    await admin.query(`CREATE DATABASE ${db}`);
    const url = new URL(PG_URL!); url.pathname = `/${db}`;
    try {
      const storage = new PostgresStorage({ connectionString: url.toString() });
      await (storage as any).init?.();
      const w = createWorker(storage as any, { t: async () => {} }, { ttlMs: 5_000 });
      await w.runOnce();
      w.stop();
      await storage.close();
      const n = Number((await admin.query('SELECT count(*)::int AS n FROM pg_stat_activity WHERE datname = $1', [db])).rows[0].n);
      expect(n, "connections left on the closed store's database").toBe(0);
    } finally {
      await admin.query(`DROP DATABASE IF EXISTS ${db} WITH (FORCE)`);
      await admin.end();
    }
  });
});
