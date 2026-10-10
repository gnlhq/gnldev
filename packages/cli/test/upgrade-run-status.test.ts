// `gnl upgrade` and `gnl doctor` on a store 0.10 left: its run table keeps status in four flag columns,
// which this version refuses to serve until the `run-status` step has run. `gnl upgrade` must reach the
// step without booting the store first (a boot is what refuses), and `gnl doctor` must say what is
// pending instead of dying on the refusal.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRequire } from 'node:module';
import { SqliteStorage } from '@gnldev/durable/sqlite';

const loadConfig = vi.fn();
vi.mock('../src/config.js', () => ({ loadConfig: (...a: unknown[]) => loadConfig(...a) }));
const { upgradeCommand } = await import('../src/commands/upgrade.js');
const { doctorCommand } = await import('../src/commands/doctor.js');
const { DatabaseSync } = createRequire(import.meta.url)('node:sqlite') as { DatabaseSync: new (p: string) => any };

let dir: string;
let logged: string[] = [];
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'gnl-cli-runstatus-'));
  logged = [];
  vi.spyOn(console, 'log').mockImplementation((...a: unknown[]) => { logged.push(a.join(' ')); });
});
afterEach(() => { vi.restoreAllMocks(); loadConfig.mockReset(); process.exitCode = undefined; rmSync(dir, { recursive: true, force: true }); });

/** A Sqlite file whose `gnl_runs` is in 0.10's shape (four flags, the flag index), with a suspended run and a failed one. */
async function flagStore(): Promise<string> {
  const file = join(dir, 'runs.db');
  const fresh = new SqliteStorage(file);
  await fresh.runs.put('r1:model:0', { text: 'x' });
  await fresh.close();
  const db = new DatabaseSync(file);
  for (const sql of [
    `ALTER TABLE gnl_runs ADD COLUMN suspended INTEGER NOT NULL DEFAULT 0`, `ALTER TABLE gnl_runs ADD COLUMN failed INTEGER NOT NULL DEFAULT 0`,
    `ALTER TABLE gnl_runs ADD COLUMN running INTEGER NOT NULL DEFAULT 0`, `ALTER TABLE gnl_runs ADD COLUMN canceled INTEGER NOT NULL DEFAULT 0`,
    `DROP INDEX gnl_runs_open`, `DROP INDEX gnl_runs_status`, `ALTER TABLE gnl_runs DROP COLUMN status`, `ALTER TABLE gnl_runs DROP COLUMN outcome`,
    `CREATE INDEX gnl_runs_open ON gnl_runs (created_at, run_id) WHERE canceled = 1 OR suspended = 1 OR failed = 1 OR running = 1`,
    `INSERT INTO gnl_runs (run_id, suspended, suspended_count, created_at, updated_at) VALUES ('r2', 1, 1, 2, 2)`,
    `INSERT INTO gnl_runs (run_id, failed, created_at, updated_at) VALUES ('r3', 1, 3, 3)`,
  ]) db.exec(sql);
  db.close();
  return file;
}

describe('a store in 0.10\'s run-status format', () => {
  it('gnl upgrade runs the run-status step (no boot first), and the store is served after it', async () => {
    const file = await flagStore();
    loadConfig.mockImplementation(async () => ({ storage: new SqliteStorage(file) })); // each command closes its store
    await upgradeCommand.run({ argv: ['--list'] });
    expect(logged.join('\n')).toMatch(/pending[\s\S]*run-status/);
    logged = [];
    await upgradeCommand.run({ argv: [] });
    expect(logged.join('\n')).toMatch(/ran[\s\S]*run-status/);
    const after = new SqliteStorage(file);
    const page = await after.runs.listRuns();
    expect(Object.fromEntries(page.items.map((r) => [r.runId, r.status]))).toEqual({ r1: 'completed', r2: 'suspended', r3: 'failed' });
    await after.close();
  });

  it('gnl doctor lists the pending step and the refusal, and exits non-zero, instead of crashing', async () => {
    const storage = new SqliteStorage(await flagStore());
    const config = join(dir, 'gnl.config.ts');
    writeFileSync(config, 'export default {}\n');
    loadConfig.mockResolvedValue({ storage, agents: {} });
    await doctorCommand.run({ argv: ['--config', config] });
    const out = logged.join('\n');
    expect(out).toMatch(/upgrade pending[\s\S]*run-status/);
    expect(out).toMatch(/gnl upgrade/);
    expect(process.exitCode).toBe(1);
  });
});
