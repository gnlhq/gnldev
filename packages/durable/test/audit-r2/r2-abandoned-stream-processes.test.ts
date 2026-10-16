// AUDIT ROUND 2 (red, real processes): a direct streamDurable whose reader went away is held by its process
// for good (d4924273 settles the hold only on onFinish/onError/onAbort). Another process's `pendingWork`
// (gnl pending / gnl upgrade) reads "the run is executing" for a run nothing executes, and the holder's
// SIGTERM drain cannot finish: it waits for its deadline and answers `drained: false`.
import { describe, it, expect } from 'vitest';
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { mkdtempSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { pendingWork, installProcessLiveness, sqliteLiveness, toJournal } from '../../src/index.js';
import { SqliteStorage } from '../../src/sqlite-storage.js';

const here = dirname(fileURLToPath(import.meta.url));
const tsxLoader = join(dirname(createRequire(import.meta.url).resolve('tsx/package.json')), 'dist', 'loader.mjs');
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const read = (f: string) => (existsSync(f) ? readFileSync(f, 'utf8') : '');

describe('an abandoned direct stream (real processes, Sqlite)', () => {
  it('is not listed as executing by another process, and does not stop the drain', async () => {
    const d = mkdtempSync(join(tmpdir(), 'a2-ab-'));
    const db = join(d, 'app.db');
    const out = join(d, 'out.log');
    const child = spawn(process.execPath, ['--import', tsxLoader, join(here, 'fixtures', 'r2-abandoned-stream-proc.ts'), db, out], { stdio: ['ignore', 'ignore', 'inherit'] });
    try {
      for (let i = 0; i < 400 && !read(out).includes('abandoned'); i++) await sleep(25);
      await sleep(1_500); // the model's stream (500 ms) is long over
      const storage = new SqliteStorage(db);
      const l = sqliteLiveness(db);
      installProcessLiveness(l);
      const running = (await pendingWork(toJournal(storage.runs) as any)).running.map((r: any) => `${r.runId}: ${r.what}`);
      await l.close(); installProcessLiveness(undefined);
      child.kill('SIGTERM');
      for (let i = 0; i < 400 && !read(out).includes('drain'); i++) await sleep(25);
      const drain = read(out).split('\n').find((x) => x.startsWith('drain')) ?? 'no drain line';
      expect({ running, drain: drain.replace(/ \d+$/, '') }).toEqual({ running: [], drain: 'drain {"drained":true}' });
    } finally { child.kill('SIGKILL'); }
  }, 30_000);
});
