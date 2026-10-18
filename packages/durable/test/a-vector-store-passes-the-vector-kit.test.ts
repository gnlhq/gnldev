// Every vector store in the repository through the vector kit (vector-conformance.ts): durable's three
// (InMemory, SQLite, Postgres on pg-mem and, with GNL_PG_URL, on a real server; MySQL / MariaDB with
// GNL_MYSQL_URL / GNL_MARIADB_URL) and @gnldev/rag's three
// (InMemoryVectorStore, GraphRag and, with GNL_PGVECTOR_URL, the pgvector store). One kit, every store,
// the same answer — the rules live in storage.ts (`vectorQueryScope`, `vectorDeletePlan`,
// `vectorWriteBatch`, `rankVectorMatches`), and this is what keeps a store from drifting off them.
import { describe, it, afterAll } from 'vitest';
import { newDb } from 'pg-mem';
import pg from 'pg';
import { InMemoryStorage, type VectorStore } from '../src/index.js';
import { SqliteStorage } from '../src/sqlite-storage.js';
import { PostgresStorage } from '../src/postgres-storage.js';
import { vectorStoreConformance, type VectorStoreUnderTest } from '../src/testing.js';
import { mysqlStores } from './real-backends.js';
import { InMemoryVectorStore, GraphRag, PostgresVectorStore } from '../../rag/src/index.js';

const PG_URL = process.env.GNL_PG_URL;
const PGVECTOR_URL = process.env.GNL_PGVECTOR_URL;

// A real server's stores get a schema of their own, dropped after the scenario, so a scenario never
// sees another's rows. The `vector` type lives in `public`, created once: made under a per-scenario
// search_path it would be dropped with that schema.
let schemas = 0;
const admins: pg.Pool[] = [];
afterAll(async () => { for (const a of admins) await a.end(); });
async function schemaPool(url: string, vector: boolean): Promise<{ pool: pg.Pool; drop: () => Promise<void> }> {
  const schema = `vkit_${process.pid}_${Date.now().toString(36)}_${schemas++}`;
  const admin = new pg.Pool({ connectionString: url, max: 1 });
  admins.push(admin);
  if (vector) await admin.query('CREATE EXTENSION IF NOT EXISTS vector SCHEMA public');
  await admin.query(`CREATE SCHEMA ${schema}`);
  const pool = new pg.Pool({ connectionString: url, max: 4, options: `-c search_path=${schema},public` });
  return { pool, drop: async () => { await pool.end(); await admin.query(`DROP SCHEMA ${schema} CASCADE`); } };
}

const STORES: Array<[string, () => Promise<VectorStoreUnderTest>]> = [
  ['durable InMemory', async () => new InMemoryStorage().vectors!],
  ['durable SQLite', async () => { const s = new SqliteStorage(':memory:'); return { vectors: s.vectors!, close: () => s.close?.() }; }],
  ['durable Postgres (pg-mem)', async () => new PostgresStorage({ pool: new (newDb().adapters.createPg().Pool)() }).vectors!],
  ['rag InMemoryVectorStore', async () => new InMemoryVectorStore() as VectorStore],
  ['rag GraphRag', async () => new GraphRag({ threshold: 0.6 }) as VectorStore],
];
if (PG_URL) {
  STORES.push(['durable Postgres (real)', async () => { const { pool, drop } = await schemaPool(PG_URL, false); const s = new PostgresStorage({ pool }); return { vectors: s.vectors!, close: drop }; }]);
}
if (PGVECTOR_URL) {
  STORES.push(['rag pgvector (real)', async () => { const { pool, drop } = await schemaPool(PGVECTOR_URL, true); return { vectors: new PostgresVectorStore({ pool, index: 'none' }) as VectorStore, close: drop }; }]);
}

for (const [name, make] of mysqlStores(' (real)')) STORES.push([`durable ${name}`, async () => { const s = await make(); return { vectors: s.vectors!, close: () => s.close() }; }]);

// pg-mem cannot isolate two concurrent writers (the same reason journalConformance runs it with
// `exactClaim: false`); the race is held on every real store, the real Postgres one included.
for (const [name, make] of STORES) vectorStoreConformance(name, make, { describe, it, timeout: 30_000, exactClaim: !name.includes('pg-mem') });
