// A process that is in the middle of a write to a Sqlite store when it is frozen (SIGSTOP by the test).
// It opens the store as every gnl process does, writes a run, then opens a write transaction the way the
// store's own writes do (`BEGIN IMMEDIATE` … `COMMIT`, synchronous) and stops right inside it: the state a
// process is in when SIGSTOP lands between its BEGIN and its COMMIT. Writes `<db>.frozen-ready` then.
import { writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { SqliteStorage } from '../../src/sqlite-storage.js';
import { runKeys } from '../../src/journal.js';
import { stampFormat } from '../../src/format.js';

const db = process.argv[2]!;
const storage = new SqliteStorage(db);
await storage.runs.put(runKeys.input('r-frozen'), stampFormat({ at: Date.now(), prompt: 'p', resourceId: 'ayse' }));
const { DatabaseSync } = createRequire(import.meta.url)('node:sqlite') as { DatabaseSync: new (p: string) => any };
const raw = new DatabaseSync(db);
raw.exec('BEGIN IMMEDIATE');
raw.prepare('INSERT INTO gnl_meta(k, v) VALUES (?, ?)').run('frozen-mid-write', '1');
writeFileSync(`${db}.frozen-ready`, String(process.pid));
setInterval(() => {}, 1_000);
