// One process writing to two Postgres databases (a database per tenant): a live claim it holds in the
// second database is not taken over by a process that judges that database.
//
// A process's liveness is a session advisory lock, and Postgres scopes advisory locks to the database
// the session is connected to (pg_locks.database); `isAlive` asks for the lock in ITS session's
// database. The liveness is made from the first store a process opens and installed for the process,
// and every claim it writes carries that id — also a claim in another database. A process judging that
// other database finds no lock for the id there and reads a live holder as dead.
//
// Here: process P opens tenant 1's store first (its liveness lives in db1), then runs an idempotent
// tool on tenant 2's store and stays inside its body. This test process, a worker of tenant 2 (its
// liveness in db2), resumes the same call. P is alive the whole time. Postgres runs when GNL_PG_URL is set.
import { describe, it, expect, afterAll, afterEach } from 'vitest';
import { spawn, type ChildProcess } from 'node:child_process';
import { mkdtempSync, existsSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import pg from 'pg';
import { durableTool } from '../src/durable-tool.js';
import { PostgresStorage } from '../src/postgres-storage.js';
import { installProcessLiveness } from '../src/process-liveness.js';
import { RunBusyError } from '../src/index.js';
import { spawnFixtureEnv } from './fixtures/watchdog.js';
import type { DurableCtx } from '../src/journal.js';

const PG_URL = process.env.GNL_PG_URL;
const here = dirname(fileURLToPath(import.meta.url));
const tsxLoader = join(dirname(createRequire(import.meta.url).resolve('tsx/package.json')), 'dist', 'loader.mjs');
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const ends: Array<() => Promise<unknown>> = [];
afterAll(async () => { for (const e of ends.reverse()) await e(); });
afterEach(() => installProcessLiveness(undefined));

async function database(admin: pg.Client, tag: string): Promise<string> {
  const name = `cp_2db_${tag}_${process.pid}_${Date.now().toString(36)}`;
  await admin.query(`CREATE DATABASE ${name}`);
  ends.push(() => admin.query(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`));
  const u = new URL(PG_URL!); u.pathname = `/${name}`;
  return u.toString();
}

describe.skipIf(!PG_URL)('one process, two databases', () => {
  it("a live claim in the second database is not taken over by that database's worker", async () => {
    const admin = new pg.Client({ connectionString: PG_URL });
    await admin.connect();
    ends.push(() => admin.end());
    const db1 = await database(admin, 't1');
    const db2 = await database(admin, 't2');
    const dir = mkdtempSync(join(tmpdir(), 'gnl-2db-'));
    ends.push(async () => rmSync(dir, { recursive: true, force: true }));
    const effects = join(dir, 'effects');

    const p: ChildProcess = spawn(process.execPath, ['--import', tsxLoader, join(here, 'fixtures', 'two-db-holder.ts'), db1, db2, effects], { stdio: ['ignore', 'ignore', 'pipe'], env: spawnFixtureEnv() });
    let err = '';
    p.stderr!.on('data', (d) => { err += String(d); });
    ends.push(async () => { p.kill('SIGKILL'); });
    for (let i = 0; i < 400 && !existsSync(effects); i++) await sleep(50);
    expect(existsSync(effects), `P never entered the body: ${err}`).toBe(true);

    // This process: tenant 2's worker, its liveness in db2.
    const s2 = new PostgresStorage({ connectionString: db2 });
    ends.push(() => s2.close());
    installProcessLiveness(await s2.processLiveness());
    let executions = 0;
    const tool = { idempotent: true, execute: async () => { executions++; return { ok: true }; } };
    const resumed = durableTool(tool as any, { journal: s2.runs, runId: 'tenant2-run' } as unknown as DurableCtx, 'sync')
      .execute!({}, { toolCallId: 'c1' } as any).then(() => 'ran', (e) => e);
    const outcome = await resumed;

    expect(p.exitCode, 'P is alive').toBe(null);
    expect(executions, 'bodies run beside the live one').toBe(0);
    expect(outcome).toBeInstanceOf(RunBusyError);
    expect(readFileSync(effects, 'utf8').trim().split('\n').length).toBe(1);
  });
}, 60_000);
