// AUDIT C fixture: stalled-worker-proc.ts with a configured liveness id (argv: db effects go name ttl runner livenessId).
import { appendFileSync, existsSync } from 'node:fs';
import { sqliteLiveness } from '@gnldev/durable';
import { SqliteStorage } from '@gnldev/durable/sqlite';
import { createWorker, listJobs } from '../../src/index.js';

const [db, effects, go, name, ttl, runner, id] = process.argv.slice(2) as [string, string, string, string, string, string, string];
setInterval(() => { try { process.kill(Number(runner), 0); } catch { process.exit(1); } }, 500).unref();
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const storage = new SqliteStorage(db);
await storage.init();
const worker = createWorker(storage as never, {
  t: async () => {
    appendFileSync(effects, `enter ${name}\n`);
    while (!existsSync(go)) await sleep(10);
    appendFileSync(effects, `effect ${name}\n`);
  },
}, { owner: name, ttlMs: Number(ttl), pollMs: 20, backoff: false, liveness: sqliteLiveness(db, id) });
const allDone = async () => (await listJobs(storage.work!)).every((j) => j.status !== 'pending');
worker.start();
const deadline = Date.now() + 8_000;
while (!(await allDone()) && Date.now() < deadline) await sleep(20);
worker.stop();
await storage.close();
process.exit(0);
