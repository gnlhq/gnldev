// `gnl pending` closes the store it opened, as `gnl upgrade` does.
//
// Measured by the panel's measurer (raporlar/2026-10-15-heyet-wait/olcum.md): on Postgres the answer was
// printed at 0.46 s and the process ended at 10.5 s — the pool's idle timeout, because nothing closed it.
// Every call of a deploy script paid 10 s. Real process, real Postgres (GNL_PG_URL).
import { describe, it, expect, afterEach } from 'vitest';
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const PG_URL = process.env.GNL_PG_URL;
const cli = join(__dirname, '..', 'dist', 'cli.js');
const created: string[] = [];
afterEach(() => { for (const d of created.splice(0)) rmSync(d, { recursive: true, force: true }); });

function config(): string {
  const dir = mkdtempSync(join(__dirname, '.tmp-'));
  created.push(dir);
  const p = join(dir, 'gnl.config.ts');
  writeFileSync(p, `
import { PostgresStorage } from '@gnldev/durable/postgres';
export default { storage: new PostgresStorage({ connectionString: ${JSON.stringify(PG_URL)} }), agents: {} };
`);
  return p;
}

/** Runs the CLI; how long after its first output it took to exit, and the exit code. */
function run(args: string[]): Promise<{ code: number | null; afterPrintMs: number; out: string; err: string }> {
  return new Promise((resolve) => {
    const c = spawn(process.execPath, [cli, ...args], { stdio: ['ignore', 'pipe', 'pipe'] });
    let printedAt: number | undefined;
    let out = '';
    let err = '';
    c.stdout.on('data', (d) => { printedAt ??= Date.now(); out += String(d); });
    c.stderr.on('data', (d) => { err += String(d); });
    const kill = setTimeout(() => c.kill('SIGKILL'), 30_000);
    c.on('exit', (code) => { clearTimeout(kill); resolve({ code, afterPrintMs: Date.now() - (printedAt ?? Date.now()), out, err }); });
  });
}

describe.skipIf(!PG_URL)('gnl pending ends when it has answered (real Postgres)', () => {
  it('plain and --json: the process exits within 2 s of printing', async () => {
    const cfg = config();
    for (const extra of [[], ['--json']]) {
      const r = await run(['pending', '--config', cfg, ...extra]);
      // Not stderr: on a database other tests share, the store may warn about runs another version wrote
      // (relations not placed yet). The property here is that the process ends once it has answered.
      expect({ code: r.code, fast: r.afterPrintMs < 2_000 }, `${r.out}\n${r.err}`).toEqual({ code: 0, fast: true });
    }
  }, 60_000);

  it('--wait --timeout: the same', async () => {
    const r = await run(['pending', '--config', config(), '--wait', '--timeout', '5s']);
    expect({ code: r.code, fast: r.afterPrintMs < 2_000 }).toEqual({ code: 0, fast: true });
  }, 60_000);
});
