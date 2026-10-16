// The stores a round-2 test runs on: in-memory, Sqlite, and real Postgres when GNL_PG_URL is set.
import { afterAll } from 'vitest';
import { InMemoryStorage } from '../../src/index.js';
import { SqliteStorage } from '../../src/sqlite-storage.js';
import { PostgresStorage } from '../../src/postgres-storage.js';

const ends: Array<() => Promise<unknown>> = [];
afterAll(async () => { for (const e of ends.reverse()) await e(); });
export const STORES: Array<[string, () => Promise<any>]> = [['in-memory', async () => new InMemoryStorage()], ['sqlite', async () => new SqliteStorage(':memory:')]];
if (process.env.GNL_PG_URL) {
  STORES.push(['postgres (real)', async () => {
    const s = new PostgresStorage({ connectionString: process.env.GNL_PG_URL! });
    ends.push(() => s.close());
    await (s as any).init?.();
    return s;
  }]);
}
export const unique = () => `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
