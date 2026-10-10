// `readRun` reads a run in first-write order: the position `gnl_run_journal.ord` the store assigns as it
// writes (H7). A 0.9.0 file has no such column. Opened with the current code, every record 0.9.0 wrote
// holds 0 and reads in the order 0.9.0 read it — `(created_at, key)` — and every record written after,
// by this version or by a 0.9.0 process still running on the same file, follows in write order, however
// its clock reads.
import { readdirSync } from 'node:fs';
import { createRequire } from 'node:module';
import { describe, expect, it } from 'vitest';
import { FIXTURES_090, openFixture, rawQuery } from '../support.js';

const { DatabaseSync } = createRequire(import.meta.url)('node:sqlite') as typeof import('node:sqlite');

/** The files 0.9.0 wrote run records into. */
const FILES = readdirSync(FIXTURES_090).filter((f) => f.endsWith('.db')).sort()
  .filter((f) => rawQuery(`${FIXTURES_090}${f}`, 'SELECT 1 FROM gnl_run_journal WHERE run_id IS NOT NULL LIMIT 1').length > 0);

describe('upgrade from 0.9.0 — a run reads in first-write order', () => {
  it('there are fixtures with run records', () => expect(FILES.length).toBeGreaterThan(0));

  it.each(FILES.map((f) => [f]))('%s: 0.9.0\'s records keep 0.9.0\'s order; later writes, a 0.9.0 process\'s too, follow them', async (file) => {
    // 0.9.0's own read of every run (sqlite-storage.ts readRun at 0.9.0), from the committed file.
    const before = rawQuery<{ run_id: string; key: string }>(`${FIXTURES_090}${file}`,
      'SELECT run_id, key FROM gnl_run_journal WHERE run_id IS NOT NULL ORDER BY run_id, created_at, key');
    const runs = [...new Set(before.map((r) => r.run_id))];
    const f = await openFixture(file);
    for (const runId of runs) {
      expect((await f.storage.runs.readRun(runId)).map((e) => e.key)).toEqual(before.filter((r) => r.run_id === runId).map((r) => r.key));
    }
    expect(rawQuery(f.path, 'SELECT COUNT(*) AS n FROM gnl_run_journal WHERE ord <> 0')).toEqual([{ n: 0 }]);

    // A later step by this version, then one by a 0.9.0 process (its statement: no `ord`) whose clock
    // reads 1970 — both after every 0.9.0 record, in the order they were written.
    const runId = runs[0]!;
    await f.storage.runs.put(`${runId}:model:900`, { content: [] });
    const old = new DatabaseSync(f.path);
    try {
      old.prepare(`INSERT INTO gnl_run_journal (key, run_id, kind, suspended, value, created_at) VALUES (?, ?, 'model', 0, '{"json":{}}', 1)
                   ON CONFLICT(key) DO UPDATE SET value = excluded.value, suspended = excluded.suspended`).run(`${runId}:model:901`, runId);
    } finally {
      old.close();
    }
    const keys = (await f.reopen().runs.readRun(runId)).map((e) => e.key);
    expect(keys).toEqual([...before.filter((r) => r.run_id === runId).map((r) => r.key), `${runId}:model:900`, `${runId}:model:901`]);
  });
});
