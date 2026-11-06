// k5 (queueUpgrade) fixture: a store as @gnldev/queue 0.16.0 leaves it, written by the 0.16.0 code itself.
//
// The committed 0.16.0 fixtures (packages/upgrade-tests/fixtures/0.16.0) are this writer's output, run by
// packages/upgrade-tests/generate/0.16.0.mjs with the fixed clock.
//
// Run as a child: the 0.16.0 packages come from GNL_016_ROOT (an `npm install` of the published
// @gnldev/durable@0.16.0 and @gnldev/queue@0.16.0 with the drivers — see `k5-queue-upgrade.test.ts`), never
// from the workspace, which would compare this version's code with itself. Prints what 0.16.0 did, as JSON.
//
//   GNL_016_ROOT=<dir> node k5-q016-writer.mjs <sqlite|postgres|mysql|mongo> <file or URL>
//
// What it leaves: system jobs, organizations' jobs and a person's jobs, all in the one `qjob` log; the
// first few (`Q016_RUN`) taken by a 0.16.0 worker — three done, the third in the log failed for good (a dead letter), the rest pending; the
// worker's `qcursor`.
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

const root = process.env.GNL_016_ROOT;
if (!root) throw new Error('GNL_016_ROOT is not set');
const [backend, target] = process.argv.slice(2);
const load = (pkg, file) => import(pathToFileURL(join(root, 'node_modules', '@gnldev', pkg, 'dist', file)).href);
const durable = await load('durable', 'index.js');
const queue = await load('queue', 'index.js');

let storage;
if (backend === 'sqlite') storage = new (await load('durable', 'sqlite-storage.js')).SqliteStorage(target);
else if (backend === 'postgres') storage = new (await load('durable', 'postgres-storage.js')).PostgresStorage({ connectionString: target });
else if (backend === 'mysql') storage = new (await load('durable', 'mysql-storage.js')).MysqlStorage({ connectionString: target });
else if (backend === 'mongo') storage = new (await load('durable', 'mongo-storage.js')).MongoStorage({ connectionString: target });
else throw new Error(`unknown backend ${backend}`);
await storage.init?.();

const SYSTEM = Number(process.env.Q016_SYSTEM ?? 6);
const PER_ORG = Number(process.env.Q016_PER_ORG ?? 5);
const ids = [];
const names = [];
const add = async (n, payload, opts) => { ids.push(await queue.enqueue(storage.work, 't', { n, ...payload }, opts)); names.push(n); };
// The dead letter third in the log, so 0.16.0's worker reaches it among the first it runs.
for (let i = 0; i < 2; i++) await add(`s${i}`);
await add('dead', { fail: true }, { orgId: 'globex' });
for (let i = 2; i < SYSTEM; i++) await add(`s${i}`);
for (const orgId of ['acme', 'globex']) for (let i = 0; i < PER_ORG; i++) await add(`${orgId}${i}`, {}, { orgId });
await add('ayse0', {}, { caller: durable.user('ayse', 'acme') });
await add('fixed', {}, { id: 'weekly-report', orgId: 'acme' });
const deadId = ids[2];

// 0.16.0's worker runs the first jobs of its one log; the one that fails, fails for good.
const ran = [];
const RUN = Number(process.env.Q016_RUN ?? 4);
const worker = queue.createWorker(storage, {
  t: async (p) => { if (p.fail) throw new Error('boom'); ran.push(p.n); },
}, { maxAttempts: 1, heartbeat: false });
for (let i = 0; i < RUN; i++) await worker.runOnce();
await worker.close?.();
const doneIds = [];
for (const id of ids) if ((await storage.work.get(`qdone:${id}`)) !== undefined) doneIds.push(id);
const qcursor = await storage.work.get('qcursor');
await storage.close?.();
process.stdout.write(JSON.stringify({ ids, names, ran, doneIds, deadId, qcursor: qcursor ?? null }));
