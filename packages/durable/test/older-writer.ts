// How a process of the PREVIOUS version writes one journal key on Sqlite and Postgres: its statements,
// no relation columns. Shared by erase-relations.test.ts and journal-conformance.test.ts, which both ask
// the stores to find rows such a process left unplaced.
import { parseJournalKey, runIdOfKey } from '../src/journal.js';
import { serialize } from '../src/serialize.js';

/** The previous version's journal write, as SQL text with `?` or `$n` placeholders. */
export const OLD = {
  sqliteJournal: `INSERT INTO gnl_run_journal (key, run_id, kind, suspended, value, created_at) VALUES (?, ?, ?, ?, ?, ?)
                  ON CONFLICT(key) DO UPDATE SET value = excluded.value, suspended = excluded.suspended`,
  // The run's row in this version's status columns: since the `run-status` step a 0.10 process cannot
  // write here at all (run-status-columns.test.ts); these rows stand for what it wrote before the upgrade
  // and for any writer that knows nothing of the relation columns (a restore, plain SQL).
  sqliteRun: `INSERT INTO gnl_runs (run_id, model_steps, tool_calls, suspended_count, status, created_at, updated_at)
              VALUES (?, 0, 0, 0, 'completed', ?, ?) ON CONFLICT(run_id) DO UPDATE SET updated_at = excluded.updated_at`,
  pgJournal: `INSERT INTO gnl_run_journal (key, run_id, kind, suspended, value, created_at) VALUES ($1,$2,$3,$4,$5,$6)
              ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, suspended = EXCLUDED.suspended`,
  pgRun: `INSERT INTO gnl_runs (run_id, model_steps, tool_calls, suspended_count, status, created_at, updated_at)
          VALUES ($1,0,0,0,'completed',$2,$3) ON CONFLICT (run_id) DO UPDATE SET updated_at = EXCLUDED.updated_at`,
};
/** Which run a key registers, as the previous version decided it (the same rule as this one). */
export const oldRunOf = (key: string, value: unknown) => parseJournalKey(key)?.runId ?? runIdOfKey(key, value);

/** The previous version's write on a Sqlite file, from its own connection (`node:sqlite` DatabaseSync). */
export function oldSqlitePut(db: { prepare(sql: string): { run(...a: unknown[]): unknown } }, key: string, value: unknown): void {
  const p = parseJournalKey(key);
  const now = Date.now();
  db.prepare(OLD.sqliteJournal).run(key, p?.runId ?? null, p?.kind ?? null, 0, serialize(value), now);
  const run = oldRunOf(key, value);
  if (run) db.prepare(OLD.sqliteRun).run(run, now, now);
}

/** The previous version's write on Postgres, from its own pool. */
export async function oldPgPut(pool: { query(sql: string, params?: unknown[]): Promise<unknown> }, key: string, value: unknown): Promise<void> {
  const p = parseJournalKey(key);
  const now = Date.now();
  await pool.query(OLD.pgJournal, [key, p?.runId ?? null, p?.kind ?? null, false, serialize(value), now]);
  const run = oldRunOf(key, value);
  if (run) await pool.query(OLD.pgRun, [run, now, now]);
}
