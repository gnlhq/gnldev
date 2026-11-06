// k5 (5g-1) fixture: one 0.16.0 worker polling a store — what `queue/lanes-cleanup` must see before it
// deletes the old log. It starts (0.16.0 announces itself in `__qworkers__` as it polls), prints READY once
// its presence is written, and runs until a signal: SIGTERM closes it (0.16.0's close takes its presence
// back) and exits 0; SIGKILL leaves its presence to expire. The 0.16.0 code comes from GNL_016_ROOT (see
// k5-q016-writer.mjs).
//
//   GNL_016_ROOT=<dir> node k5-q016-worker.mjs <sqlite|postgres|mysql|mongo> <file or URL> <ttlMs>
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

const root = process.env.GNL_016_ROOT;
if (!root) throw new Error('GNL_016_ROOT is not set');
const [backend, target, ttlArg] = process.argv.slice(2);
const load = (pkg, file) => import(pathToFileURL(join(root, 'node_modules', '@gnldev', pkg, 'dist', file)).href);
const queue = await load('queue', 'index.js');
const file = { sqlite: ['sqlite-storage.js', 'SqliteStorage'], postgres: ['postgres-storage.js', 'PostgresStorage'], mysql: ['mysql-storage.js', 'MysqlStorage'], mongo: ['mongo-storage.js', 'MongoStorage'] }[backend];
const Store = (await load('durable', file[0]))[file[1]];
const storage = backend === 'sqlite' ? new Store(target) : new Store({ connectionString: target });
await storage.init?.();
const owner = `w016-${process.pid}`;
const worker = queue.createWorker(storage, { t: async () => {} }, { owner, pollMs: 50, ttlMs: Number(ttlArg ?? 3000) });
worker.start();
for (;;) {
  const p = await storage.work.get('__qworkers__');
  if (p && p[owner]) break;
  await new Promise((r) => setTimeout(r, 20));
}
process.stdout.write(`READY ${owner}\n`);
process.on('SIGTERM', async () => {
  await worker.close();
  await storage.close?.();
  process.exit(0);
});
setInterval(() => {}, 1 << 30);
