// One OS process with three queue workers on a shared SQLite file (worker-runs-once.test.ts). Each
// handler run appends `<k> <process>` to the effects file — a side effect outside ctx.run, counted by
// the test. Exits when every job is terminal.
import { appendFileSync } from 'node:fs';
import { SqliteStorage } from '@gnldev/durable/sqlite';
import { createWorker, listJobs } from '../../src/index.js';

const [db, effects, name] = process.argv.slice(2) as [string, string, string];
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const stores = [0, 1, 2].map(() => new SqliteStorage(db));
const workers = stores.map((s, i) => createWorker(s, {
  t: async (p: { k: string }) => {
    appendFileSync(effects, `${p.k} ${name}-${i}\n`);
    await sleep(Math.random() * 2);
  },
}, { owner: `${name}-${i}`, ttlMs: 10_000, heartbeat: false }));

const allDone = async () => (await listJobs(stores[0]!.work!)).every((j) => j.status !== 'pending');
let stop = false;
const loops = workers.map(async (w) => {
  while (!stop) {
    if (!(await w.runOnce())) await sleep(2);
  }
});
const deadline = Date.now() + 60_000;
while (!(await allDone()) && Date.now() < deadline) await sleep(20);
stop = true;
await Promise.all(loops);
for (const s of stores) await s.close();
