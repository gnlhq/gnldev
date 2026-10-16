// AUDIT C (red): a Sqlite process that dies (SIGKILL, OOM) leaves `<db>.procs/<id>.lock` and its
// `-journal` behind. Nothing ever removes them — not the probe that finds the id dead, not a later
// process — so a long-lived deployment accumulates two files per crash, and every reader that meets an
// old stamp opens them again.
import { describe, it, expect, afterAll } from 'vitest';
import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { sqliteLiveness, sqliteLivenessDir } from '../src/process-liveness.js';

const here = dirname(fileURLToPath(import.meta.url));
const tsxLoader = join(dirname(createRequire(import.meta.url).resolve('tsx/package.json')), 'dist', 'loader.mjs');
const dirs: string[] = [];
afterAll(() => { for (const d of dirs) rmSync(d, { recursive: true, force: true }); });

describe('the lock file of a process that died', () => {
  it('is gone once the process is known dead', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'gnl-lockleak-'));
    dirs.push(dir);
    const db = join(dir, 'app.db');
    const p = spawn(process.execPath, ['--import', tsxLoader, join(here, 'fixtures', 'audit-c-liveness-holder-proc.ts'), db, 'dead-1'], { stdio: 'ignore' });
    const exited = new Promise((r) => p.on('close', r));
    for (let i = 0; i < 1000 && !existsSync(`${db}.ready-dead-1`); i++) await new Promise((r) => setTimeout(r, 20));
    p.kill('SIGKILL');
    await exited;
    const deadId = readFileSync(`${db}.ready-dead-1`, 'utf8');
    const me = sqliteLiveness(db);
    expect(await me.isAlive(deadId)).toBe(false);
    await me.close();
    expect(readdirSync(sqliteLivenessDir(db))).toEqual([]);
  }, 30_000);
});
