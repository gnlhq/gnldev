// Another process on the same Sqlite file: opens the store, does one read-only job, closes it, and
// prints `{ ok, ms, ... }` as one JSON line (exit 0), or `{ ok: false, error }` (exit 1).
import { SqliteStorage } from '../../src/sqlite-storage.js';
import { pendingWork } from '../../src/pending-work.js';

const [db, job] = process.argv.slice(2) as [string, string];
const t0 = Date.now();
try {
  const storage = new SqliteStorage(db);
  const opened = Date.now() - t0;
  let out: unknown;
  if (job === 'pending') out = await pendingWork(storage.runs);
  else if (job === 'upgrade-list') out = await storage.upgrade({ dryRun: true });
  else if (job === 'read') out = { input: await storage.runs.get('r-frozen:input'), runs: ((l: any) => (Array.isArray(l) ? l : l.items))(await storage.runs.listRuns()).map((r: any) => r.runId) };
  else throw new Error(`unknown job ${job}`);
  const done = Date.now() - t0;
  await storage.close();
  console.log(JSON.stringify({ ok: true, opened, done, closed: Date.now() - t0, out }));
  process.exit(0);
} catch (e) {
  console.log(JSON.stringify({ ok: false, ms: Date.now() - t0, error: String((e as Error)?.message ?? e) }));
  process.exit(1);
}
