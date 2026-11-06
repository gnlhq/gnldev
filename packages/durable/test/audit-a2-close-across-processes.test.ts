// AUDIT A2 (evidence only, no fix), with REAL OS processes on one Postgres database: process A starts a
// detached run through createGnl and closes its storage mid-run (server shutdown without a drain);
// process B, started afterwards, is asked for the same run id through gnl.run().
// Expected (executors.ts closeExecutorFor: "another process ... continues them from the journal"):
// B continues the run and answers it whole — never a run "completed" by the close.
import { describe, it, expect } from 'vitest';
import { spawnSync } from 'node:child_process';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import pg from 'pg';

const PG_URL = process.env.GNL_PG_URL;
const here = dirname(fileURLToPath(import.meta.url));
const tsxBin = join(dirname(createRequire(import.meta.url).resolve('tsx/package.json')), 'dist/cli.mjs');
const app = join(here, 'fixtures', 'audit-a2-app.ts');

function role(r: 'start' | 'read', url: string, runId: string, variant: string): any {
  const p = spawnSync(process.execPath, [tsxBin, app, r, url, runId, variant], { encoding: 'utf8', timeout: 60_000 });
  const line = p.stdout.split('\n').find((l) => l.startsWith('A2RESULT '));
  if (!line) throw new Error(`${r} gave no result: ${p.stdout}\n${p.stderr}`);
  return JSON.parse(line.slice('A2RESULT '.length));
}

describe.skipIf(!PG_URL)('A2 across processes: storage.close() mid-run, then another process', () => {
  for (const variant of ['text', 'tool']) {
    it(`${variant}: B answers the run whole, not as "completed" by A's close`, { timeout: 120_000 }, async () => {
      const admin = new pg.Client({ connectionString: PG_URL });
      await admin.connect();
      const db = `a2x_${variant}_${Date.now().toString(36)}`;
      await admin.query(`CREATE DATABASE ${db}`);
      const url = new URL(PG_URL!); url.pathname = `/${db}`;
      try {
        const a = role('start', url.toString(), `r-${variant}`, variant);
        const b = role('read', url.toString(), `r-${variant}`, variant);
        console.log(`[A2x ${variant}] A=${JSON.stringify(a)}\n[A2x ${variant}] B=${JSON.stringify(b)}`);
        expect(a.pid).not.toBe(b.pid);
        expect(a.statuses, 'the close wrote an ending into the log').not.toContain('completed');
      } finally {
        await admin.query(`DROP DATABASE IF EXISTS ${db} WITH (FORCE)`);
        await admin.end();
      }
    });
  }
});
