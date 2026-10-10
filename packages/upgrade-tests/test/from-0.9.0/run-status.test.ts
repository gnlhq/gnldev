// Every 0.9.0 file keeps its run status in four flag columns on `gnl_runs` (`suspended`, `failed`,
// `running`, `canceled`). The current code keeps it in `status`/`outcome` and refuses a file in the flag
// format until the `run-status` upgrade step has moved it — the documented refusal, and the documented
// way through (`gnl upgrade`, which runs that step first). Proven here on what 0.9.0 itself wrote: every
// fixture is refused, and after the step every run reads the status its flags decoded to in 0.9.0.
import { readdirSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { SqliteStorage } from '@gnldev/durable/sqlite';
import { FIXTURES_090, copyFixture, rawQuery } from '../support.js';

type Flags = { run_id: string; suspended: number; failed: number; running: number; canceled: number };

/** 0.9.0's decoding of the flags, as its `listRuns` read them (`outcomeOfRow`, then `deriveRunStatus`). */
function decoded090(r: Flags): string {
  const outcome = r.canceled ? 'canceled' : r.failed ? 'failed' : r.running ? 'running' : null;
  return outcome === 'canceled' ? 'canceled' : r.suspended ? 'suspended' : outcome ?? 'completed';
}

const FILES = readdirSync(FIXTURES_090).filter((f) => f.endsWith('.db')).sort();

describe('upgrade from 0.9.0 — run status', () => {
  it.each(FILES.map((f) => [f]))('%s: refused until the run-status step; after it, every run reads the status 0.9.0 read', async (file) => {
    const path = copyFixture(file);
    const flags = rawQuery<Flags>(path, 'SELECT run_id, suspended, failed, running, canceled FROM gnl_runs ORDER BY run_id');
    const want = Object.fromEntries(flags.map((r) => [r.run_id, decoded090(r)]));
    const s = new SqliteStorage(path);
    try {
      await expect(s.runs.listRuns()).rejects.toThrow(/earlier version[\s\S]*gnl upgrade/);
      const ran = await s.upgrade({ only: ['run-status'] });
      expect(ran.steps.find((x) => x.name === 'run-status')).toMatchObject({ ran: true });
      const got: Record<string, string> = {};
      let cursor: string | undefined;
      do {
        const p = await s.runs.listRuns({ limit: 25, ...(cursor ? { cursor } : {}) });
        for (const r of p.items) got[r.runId] = r.status;
        cursor = p.nextCursor;
      } while (cursor);
      expect(got).toEqual(want);
      const cols = rawQuery<{ name: string }>(path, 'PRAGMA table_info(gnl_runs)').map((c) => c.name);
      for (const f of ['suspended', 'failed', 'running', 'canceled']) expect(cols).not.toContain(f);
      expect((await s.upgrade({ only: ['run-status'] })).steps.find((x) => x.name === 'run-status')).toMatchObject({ pending: false, ran: false });
    } finally {
      await s.close();
    }
  });
});
