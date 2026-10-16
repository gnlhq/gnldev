// One OS process with one queue worker on a shared SQLite file or Postgres database
// (a-stalled-worker-keeps-its-job.test.ts).
// The handler writes `enter <name>`, waits until the `go` file exists, then writes `effect <name>` — the
// side effect, outside ctx.run, counted by the test. Exits when every job is terminal.
import { appendFileSync, existsSync } from 'node:fs';
import type { Storage } from '@gnldev/durable';
import { SqliteStorage } from '@gnldev/durable/sqlite';
import { createWorker, listJobs } from '../../src/index.js';

const [kind, db, effects, go, name, ttl, runner] = process.argv.slice(2) as [string, string, string, string, string, string, string];
// Exits once the test runner that spawned it is gone (an interrupted run leaves no orphan behind).
setInterval(() => { try { process.kill(Number(runner), 0); } catch { process.exit(1); } }, 500).unref();
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const storage: Storage = kind === 'postgres'
  ? new (await import('@gnldev/durable/postgres')).PostgresStorage({ connectionString: db }) as unknown as Storage
  : new SqliteStorage(db) as unknown as Storage;
await storage.init?.();
const worker = createWorker(storage, {
  t: async () => {
    appendFileSync(effects, `enter ${name}\n`);
    while (!existsSync(go)) await sleep(10);
    appendFileSync(effects, `effect ${name}\n`);
  },
}, { owner: name, ttlMs: Number(ttl), pollMs: 20, backoff: false });

const allDone = async () => (await listJobs(storage.work!)).every((j) => j.status !== 'pending');
worker.start();
const deadline = Date.now() + 60_000;
while (!(await allDone()) && Date.now() < deadline) await sleep(20);
worker.stop();
await storage.close?.();
process.exit(0);
