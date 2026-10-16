// One OS process with one queue worker (test/partition-measure.test.ts): like stalled-worker-proc.ts,
// but the effect line also names the job (`effect <name> <jobId>`): the key a provider that accepts one
// would be handed — so the measurement counts both raw executions and distinct keys.
import { appendFileSync, existsSync } from 'node:fs';
import type { Storage } from '@gnldev/durable';
import { SqliteStorage } from '@gnldev/durable/sqlite';
import { createWorker, listJobs } from '../../src/index.js';

const [kind, db, effects, go, name, ttl, runner] = process.argv.slice(2) as [string, string, string, string, string, string, string];
setInterval(() => { try { process.kill(Number(runner), 0); } catch { process.exit(1); } }, 500).unref();
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const storage: Storage = kind === 'postgres'
  ? new (await import('@gnldev/durable/postgres')).PostgresStorage({ connectionString: db }) as unknown as Storage
  : new SqliteStorage(db) as unknown as Storage;
if (kind === 'postgres') (storage as any).pool?.on?.('error', () => {});
await storage.init?.();
const worker = createWorker(storage, {
  t: async (_payload: unknown, ctx: { jobId: string }) => {
    appendFileSync(effects, `enter ${name} ${ctx.jobId}\n`);
    while (!existsSync(go)) await sleep(10);
    appendFileSync(effects, `effect ${name} ${ctx.jobId}\n`);
  },
}, { owner: name, ttlMs: Number(ttl), pollMs: 20, backoff: false });

// Finished: done, failed or cancelled. Not `in-doubt` — a handler still running here (frozen, then resumed)
// reports it when it ends, and a process that quit on seeing the job in doubt would cut that report off.
const allDone = async () => (await listJobs(storage.work!)).every((j) => j.status !== 'pending' && j.status !== 'in-doubt');
worker.start();
const deadline = Date.now() + 90_000;
while (Date.now() < deadline) {
  try { if (await allDone()) break; } catch { /* a cut session: the pool reconnects */ }
  await sleep(50);
}
worker.stop();
await storage.close?.().catch(() => undefined);
process.exit(0);
