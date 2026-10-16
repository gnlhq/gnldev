// One OS process with an application's queue (createQueue) on a shared SQLite file or Postgres database,
// shut down the way a process manager does it: SIGTERM (a-sigterm-finishes-the-held-job.test.ts).
// The handler writes `enter <proc> <job>`, waits until the `go` file exists, then writes
// `effect <proc> <job>` — the side effect, outside ctx.run, counted by the test.
// The process installs the framework's shutdown on signal; it stays up until it is signalled.
import { appendFileSync, existsSync } from 'node:fs';
import type { Storage } from '@gnldev/durable';
import * as durable from '@gnldev/durable';
import { SqliteStorage } from '@gnldev/durable/sqlite';
import { createQueue } from '../../src/index.js';

const [kind, db, effects, go, name, ttl, runner] = process.argv.slice(2) as [string, string, string, string, string, string, string];
setInterval(() => { try { process.kill(Number(runner), 0); } catch { process.exit(1); } }, 500).unref();
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const storage: Storage = kind === 'postgres'
  ? new (await import('@gnldev/durable/postgres')).PostgresStorage({ connectionString: db }) as unknown as Storage
  : new SqliteStorage(db) as unknown as Storage;
await storage.init?.();
// What an application's entry point does (the create-gnl templates): one call. Absent before.
(durable as Record<string, unknown> & { drainOnSignal?: (o: { deadlineMs: number; onDrained?: () => Promise<void> }) => void })
  .drainOnSignal?.({ deadlineMs: 30_000, onDrained: async () => { await storage.close?.(); } });
createQueue(storage, {
  t: async (p: { job: string }) => {
    appendFileSync(effects, `enter ${name} ${p.job}\n`);
    while (!existsSync(go)) await sleep(10);
    appendFileSync(effects, `effect ${name} ${p.job}\n`);
  },
}, { owner: name, ttlMs: Number(ttl), pollMs: 20, backoff: false });
appendFileSync(effects, `ready ${name}\n`);
setInterval(() => {}, 1 << 30); // a server would keep the process up the same way
