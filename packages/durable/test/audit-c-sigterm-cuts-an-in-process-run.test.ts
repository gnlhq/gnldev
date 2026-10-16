// AUDIT C (red): the same as audit-c-drain-waits-for-an-in-process-run.test.ts with a real process and a
// real SIGTERM: drainOnSignal exits 0 ("everything in hand finished") while the tool body is mid-way.
import { describe, it, expect, afterAll } from 'vitest';
import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const here = dirname(fileURLToPath(import.meta.url));
const tsxLoader = join(dirname(createRequire(import.meta.url).resolve('tsx/package.json')), 'dist', 'loader.mjs');
const dirs: string[] = [];
afterAll(() => { for (const d of dirs) rmSync(d, { recursive: true, force: true }); });

describe('SIGTERM while a runDurable tool body runs (separate process)', () => {
  it('the body finishes before the process exits', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'gnl-sigterm-run-'));
    dirs.push(dir);
    const out = join(dir, 'out.txt');
    const p = spawn(process.execPath, ['--import', tsxLoader, join(here, 'fixtures', 'audit-c-sigterm-runDurable-proc.ts'), out], { stdio: 'ignore' });
    const exited = new Promise<number | null>((r) => p.on('close', (c) => r(c)));
    const end = Date.now() + 20_000;
    while (!(existsSync(out) && readFileSync(out, 'utf8').includes('enter')) && Date.now() < end) await new Promise((r) => setTimeout(r, 20));
    p.kill('SIGTERM');
    const code = await exited;
    expect({ code, lines: readFileSync(out, 'utf8').trim().split('\n') }).toEqual({ code: 0, lines: ['enter', 'effect'] });
  }, 30_000);
});
