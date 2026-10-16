// Every store dates the same runs for retention: the runs `runRecordOf` names, the outcome-only run included.
//
// A run canceled before it started has one record, its outcome. The SQL stores list it (its outcome write
// creates its row) and date it; the in-memory store's stale-run scan kept its own copy of the
// record → run rule, without the outcome, so that run was never stale there and retention never swept it.
// The rule now has one owner (`runRecordOf`), and the scan reads it.
import { it, expect, vi, afterEach } from 'vitest';
import { newDb } from 'pg-mem';
import { InMemoryJournal } from '../src/journal.js';
import { stampFormat } from '../src/format.js';
import { SqliteStorage } from '../src/sqlite-storage.js';
import { PostgresStorage } from '../src/postgres-storage.js';

afterEach(() => { vi.restoreAllMocks(); });

const STORES: Array<[string, () => any]> = [
  ['InMemory', () => new InMemoryJournal()],
  ['Sqlite', () => new SqliteStorage(':memory:').runs],
  ['Postgres (pg-mem)', () => { const { Pool } = newDb().adapters.createPg(); return new PostgresStorage({ pool: new Pool() }).runs; }],
];

it.each(STORES)('%s: an outcome-only run, a run with only its :input and a run with steps are all dated — a lock key is not a run', async (_name, make) => {
  const j = make();
  const old = Date.now() - 60_000;
  vi.spyOn(Date, 'now').mockReturnValue(old);
  await j.put('never:outcome', { status: 'canceled', at: old });
  await j.put('early:input', stampFormat({ at: old, prompt: 'x' }));
  await j.put('steps:model:0', { text: 'a' });
  await j.put('nothing:lock', { at: old });
  vi.restoreAllMocks();
  expect((await j.listStaleRuns(Date.now() - 1_000)).sort()).toEqual(['early', 'never', 'steps']);
});
