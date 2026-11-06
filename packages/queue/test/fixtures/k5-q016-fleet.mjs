// k5 (5e-2) fixture: a 0.16.0 process in a deploy window — its producer appends JOBS jobs to the one log,
// one every 10 ms, while its worker runs (from its own `qcursor`); then it stops producing, keeps working
// for a moment, and closes. The handler appends `<n> old` to RUNLOG at its start. The 0.16.0 code comes
// from GNL_016_ROOT (see k5-q016-writer.mjs). Prints the ids it enqueued, as JSON.
//
//   GNL_016_ROOT=<dir> node k5-q016-fleet.mjs <sqlite|postgres|mysql|mongo> <file or URL> <RUNLOG> [JOBS]
import { appendFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

const root = process.env.GNL_016_ROOT;
if (!root) throw new Error('GNL_016_ROOT is not set');
const [backend, target, runLog, jobsArg] = process.argv.slice(2);
const load = (pkg, file) => import(pathToFileURL(join(root, 'node_modules', '@gnldev', pkg, 'dist', file)).href);
const queue = await load('queue', 'index.js');
const file = { sqlite: ['sqlite-storage.js', 'SqliteStorage'], postgres: ['postgres-storage.js', 'PostgresStorage'], mysql: ['mysql-storage.js', 'MysqlStorage'], mongo: ['mongo-storage.js', 'MongoStorage'] }[backend];
const Store = (await load('durable', file[0]))[file[1]];
const storage = backend === 'sqlite' ? new Store(target) : new Store({ connectionString: target });
await storage.init?.();
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const worker = queue.createWorker(storage, {
  t: async (p) => { appendFileSync(runLog, `${p.n} old\n`); await sleep(5 + Math.floor(Math.random() * 20)); },
}, { pollMs: 20, ttlMs: 5000, concurrency: 2 });
worker.start();
const ids = [];
const JOBS = Number(jobsArg ?? 60);
for (let i = 0; i < JOBS; i++) {
  ids.push(await queue.enqueue(storage.work, 't', { n: `w${i}` }, i % 2 ? { orgId: 'acme' } : {}));
  await sleep(10);
}
await sleep(500);
await worker.close();
await storage.close?.();
process.stdout.write(JSON.stringify({ ids }));
process.exit(0);
