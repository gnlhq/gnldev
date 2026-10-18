// A process that calls a primitive directly — `durableTool` with no executor and no worker, the host
// binding no liveness — and is frozen while it holds the claim, keeps it.
//
// The claim is judged by the holder's process liveness (a Sqlite file lock, a Postgres session lock),
// which a frozen process still holds. Only `createGnl`'s executor and `createWorker` bound one before, so
// a direct call wrote its claim without naming its process, and another process judged it by its age:
// past the TTL, it ran the effect beside the frozen holder (audit 2026-10-16). Now the primitive binds
// its store's own liveness on its first call, as the executor does.
//
// Here process P is frozen (SIGSTOP) inside the body for 4 claim TTLs; this process resumes the same call
// on the same store, directly too. Postgres runs when GNL_PG_URL is set.
import { describe, it, expect, afterAll, afterEach, vi, beforeAll } from 'vitest';
import { spawn, type ChildProcess } from 'node:child_process';
import { mkdtempSync, existsSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import pg from 'pg';
import { durableTool } from '../src/durable-tool.js';
import { SqliteStorage } from '../src/sqlite-storage.js';
import { PostgresStorage } from '../src/postgres-storage.js';
import { RunBusyError, type Storage } from '../src/index.js';
import { installProcessLiveness, postgresLiveness, TransactionPoolerError } from '../src/process-liveness.js';
import { spawnFixtureEnv } from './fixtures/watchdog.js';
import type { DurableCtx } from '../src/journal.js';

beforeAll(() => { vi.spyOn(console, 'warn').mockImplementation(() => {}); });
const PG_URL = process.env.GNL_PG_URL;
const here = dirname(fileURLToPath(import.meta.url));
const tsxLoader = join(dirname(createRequire(import.meta.url).resolve('tsx/package.json')), 'dist', 'loader.mjs');
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const TTL = 300;

const ends: Array<() => Promise<unknown> | unknown> = [];
afterAll(async () => { for (const e of ends.reverse()) await e(); });
afterEach(() => installProcessLiveness(undefined));

type Target = { kind: 'sqlite' | 'postgres'; target: string; open: () => Storage };
const TARGETS: Array<[string, () => Promise<Target>]> = [
  ['sqlite (file)', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'gnl-frozen-'));
    ends.push(() => rmSync(dir, { recursive: true, force: true }));
    const file = join(dir, 'runs.db');
    return { kind: 'sqlite', target: file, open: () => { const s = new SqliteStorage(file); ends.push(() => s.close()); return s; } };
  }],
];
if (PG_URL) TARGETS.push(['postgres (real)', async () => {
  const admin = new pg.Client({ connectionString: PG_URL });
  await admin.connect();
  const name = `cp_frozen_${process.pid}_${Date.now().toString(36)}`;
  await admin.query(`CREATE DATABASE ${name}`);
  ends.push(async () => { await admin.query(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`); await admin.end(); });
  const u = new URL(PG_URL); u.pathname = `/${name}`;
  const url = u.toString();
  return { kind: 'postgres', target: url, open: () => { const s = new PostgresStorage({ connectionString: url }); ends.push(() => s.close()); return s; } };
}]);

describe.each(TARGETS)('a frozen process keeps its direct claim — %s', (_name, make) => {
  it('another process resuming the call directly is busy: the effect runs once', async () => {
    const t = await make();
    // The schema exists before P writes (P and this process would otherwise race to create it).
    const mine = t.open();
    await mine.runs.get('warm');
    const dir = mkdtempSync(join(tmpdir(), 'gnl-frozen-fx-'));
    ends.push(() => rmSync(dir, { recursive: true, force: true }));
    const effects = join(dir, 'effects');
    const p: ChildProcess = spawn(process.execPath, ['--import', tsxLoader, join(here, 'fixtures', 'stalled-direct-holder.ts'), t.kind, t.target, effects, String(TTL)], { stdio: ['ignore', 'ignore', 'pipe'], env: spawnFixtureEnv() });
    let err = '';
    p.stderr!.on('data', (d) => { err += String(d); });
    ends.push(() => { p.kill('SIGCONT'); p.kill('SIGKILL'); });
    for (let i = 0; i < 400 && !existsSync(effects); i++) await sleep(50);
    expect(existsSync(effects), `P never entered the body: ${err}`).toBe(true);

    p.kill('SIGSTOP');
    await sleep(TTL * 4);
    let executions = 0;
    const tool = { sideEffect: true, claimTtlMs: TTL, recover: async () => ({ done: false as const }), execute: async () => { executions++; return { chargeId: 'here' }; } };
    const outcome = await durableTool(tool as any, { journal: mine.runs, runId: 'stalled-direct' } as unknown as DurableCtx, 'charge')
      .execute!({ amount: 1 }, { toolCallId: 'c1' } as any).then((v) => v, (e) => e);

    expect(p.exitCode, 'P is alive (frozen)').toBe(null);
    expect(executions, 'the body ran beside the frozen holder').toBe(0);
    expect(outcome).toBeInstanceOf(RunBusyError);
    expect(readFileSync(effects, 'utf8').trim().split('\n').length).toBe(1);
  });
}, 60_000);

// The same store reached through a transaction-mode pooler (GNL_PG_TXPOOL_URL, the server GNL_PG_URL names).
// Its own liveness is refused there (a-transaction-pooler-is-refused-at-open.test.ts), and a direct call must
// not fall back to judging the frozen holder's claim by its age: measured, that ran the body twice.
const TXPOOL_URL = process.env.GNL_PG_TXPOOL_URL;
describe.skipIf(!PG_URL || !TXPOOL_URL)('a store reached through a transaction-mode pooler', () => {
  const database = async () => {
    const admin = new pg.Client({ connectionString: PG_URL });
    await admin.connect();
    const name = `cp_frozen_tx_${process.pid}_${Date.now().toString(36)}`;
    await admin.query(`CREATE DATABASE ${name}`);
    ends.push(async () => { await admin.query(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`); await admin.end(); });
    const at = (base: string) => { const u = new URL(base); u.pathname = `/${name}`; return u.toString(); };
    const pooled = at(TXPOOL_URL!);
    const storage = new PostgresStorage({ connectionString: pooled });
    ends.push(() => storage.close());
    await storage.runs.get('warm');
    return { pooled, direct: at(PG_URL!), storage };
  };
  const call = (storage: PostgresStorage, count: () => void) => durableTool(
    { sideEffect: true, claimTtlMs: TTL, recover: async () => ({ done: false as const }), execute: async () => { count(); return { ok: true }; } } as any,
    { journal: storage.runs, runId: 'stalled-direct' } as unknown as DurableCtx, 'charge',
  ).execute!({ amount: 1 }, { toolCallId: 'c1' } as any).then((v) => v, (e) => e);

  it('a direct call with no liveness of its own is refused before its body, naming the pooler', async () => {
    const { storage } = await database();
    let executions = 0;
    const outcome = await call(storage, () => { executions++; });
    expect(outcome).toBeInstanceOf(TransactionPoolerError);
    expect(executions).toBe(0);
    // And again: the refusal is not a one-time warning after which claims are judged by their age.
    expect(await call(storage, () => { executions++; })).toBeInstanceOf(TransactionPoolerError);
    expect(executions).toBe(0);
  }, 60_000);

  it('with a liveness installed on a direct URL, a frozen holder keeps its claim: the effect runs once', async () => {
    const { pooled, direct, storage } = await database();
    const dir = mkdtempSync(join(tmpdir(), 'gnl-frozen-tx-'));
    ends.push(() => rmSync(dir, { recursive: true, force: true }));
    const effects = join(dir, 'effects');
    const p: ChildProcess = spawn(process.execPath, ['--import', tsxLoader, join(here, 'fixtures', 'stalled-direct-holder.ts'), 'postgres', pooled, effects, String(TTL), direct], { stdio: ['ignore', 'ignore', 'pipe'], env: spawnFixtureEnv() });
    let err = '';
    p.stderr!.on('data', (d) => { err += String(d); });
    ends.push(() => { p.kill('SIGCONT'); p.kill('SIGKILL'); });
    for (let i = 0; i < 400 && !existsSync(effects); i++) await sleep(50);
    expect(existsSync(effects), `P never entered the body: ${err}`).toBe(true);

    p.kill('SIGSTOP');
    await sleep(TTL * 4);
    const mine = await postgresLiveness({ connectionString: direct });
    ends.push(() => mine.close());
    installProcessLiveness(mine);
    let executions = 0;
    const outcome = await call(storage, () => { executions++; });
    expect(p.exitCode, 'P is alive (frozen)').toBe(null);
    expect(executions, 'the body ran beside the frozen holder').toBe(0);
    expect(outcome).toBeInstanceOf(RunBusyError);
    expect(readFileSync(effects, 'utf8').trim().split('\n').length).toBe(1);
  }, 60_000);
});
