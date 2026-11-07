#!/usr/bin/env node
// Writes the 0.16.0 run fixtures: a store as 0.16.0 left it outside the queue — a completed run, two runs
// stopped inside a tool (one whose tool can say whether it ran, one whose cannot), a run waiting for an
// approval, a thread with its messages (generate/crash-runs.mjs) — which ../test/from-0.16.0 opens with the
// current code and continues. The queue's 0.16.0 fixtures are generate/0.16.0.mjs's.
//
//   node generate/0.16.0-runs.mjs                   # Sqlite: fixtures/0.16.0/runs.db; 0.16.0 installed from npm into a temp dir
//   GNL_016_ROOT=/path/to/0.16.0 node generate/0.16.0-runs.mjs
//   GNL_PG_URL=postgres://… GNL_PG_DUMP='docker exec -i pg pg_dump' node generate/0.16.0-runs.mjs --backend postgres [--db name]
//   node generate/0.16.0-runs.mjs --check           # regenerate into a temp dir and compare: exit 1 on any difference
//
// GNL_016_ROOT is a directory where the published packages are installed (`<root>/node_modules/@gnldev/<name>/dist`,
// with `zod` and `ai` beside them) — never the workspace; see load-0.16.0.mjs. The clock, Math.random and
// randomUUID are fixed (./deterministic.mjs), so a second run writes the same rows.
import { resetDeterminism, setClock } from './deterministic.mjs';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync, readdirSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { execSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { DatabaseSync } from 'node:sqlite';
import { assert016, install016 } from './load-0.16.0.mjs';
import { writeCrashRuns } from './crash-runs.mjs';

const VERSION = '0.16.0';
/** 2026-11-02T12:00:00Z, the day 0.16.0 was released. */
const T_0160 = Date.UTC(2026, 10, 2, 12, 0, 0);

const here = dirname(fileURLToPath(import.meta.url));
const argv = process.argv.slice(2);
const flag = (name) => {
  const i = argv.indexOf(name);
  return i === -1 ? undefined : argv[i + 1];
};
const backend = flag('--backend') ?? 'sqlite';
const check = argv.includes('--check');
const outDir = resolve(flag('--out') ?? join(here, '..', 'fixtures', VERSION));

const root = process.env.GNL_016_ROOT ? resolve(process.env.GNL_016_ROOT) : install016(undefined, ['pg@^8', 'ai@^7', 'zod@^3.25.76']);
assert016(root, ['durable']);
const rootRequire = createRequire(join(root, 'package.json'));
const load = (file) => import(pathToFileURL(join(root, 'node_modules', '@gnldev', 'durable', 'dist', file)).href);
const durable = await load('index.js');
const { z } = rootRequire('zod');
const m = { durable, z };

const notes = {};

async function scenario(storage) {
  resetDeterminism();
  setClock(T_0160);
  notes.written = await writeCrashRuns(m, storage);
}

async function writeSqlite(dir) {
  const { SqliteStorage } = await load('sqlite-storage.js');
  const file = join(dir, 'runs.db');
  for (const x of ['', '-wal', '-shm']) rmSync(file + x, { force: true });
  const s = new SqliteStorage(file);
  await s.init();
  await scenario(s);
  // The store is NOT closed: a process that died inside a tool does not close it, and 0.16.0's close() on a
  // store with a run in flight writes a `completed` status event on that run's log (measured) — a record
  // a crash never leaves. What the writer put in the WAL goes into the file through a second connection.
  const second = new DatabaseSync(file);
  second.exec('PRAGMA wal_checkpoint(TRUNCATE)');
  second.close();
  for (const x of ['-wal', '-shm']) rmSync(file + x, { force: true });
}

async function writePostgres(dir) {
  const url = process.env.GNL_PG_URL;
  if (!url) throw new Error('--backend postgres needs GNL_PG_URL (a server where this may create and drop a database)');
  const dump = process.env.GNL_PG_DUMP ?? 'pg_dump';
  const db = flag('--db') ?? 'gnl_fixture_016_runs';
  const pg = rootRequire('pg');
  const admin = new pg.Client({ connectionString: url });
  await admin.connect();
  const { PostgresStorage } = await load('postgres-storage.js');
  await admin.query(`DROP DATABASE IF EXISTS ${db} WITH (FORCE)`);
  await admin.query(`CREATE DATABASE ${db}`);
  const u = new URL(url);
  u.pathname = `/${db}`;
  const s = new PostgresStorage({ connectionString: u.toString() });
  await s.init();
  await scenario(s);
  // Not closed either (see writeSqlite): the dump is taken with the runs still in their tools.
  const sql = execSync(`${dump} --no-owner --no-privileges --no-comments --inserts --rows-per-insert=1 -U ${u.username || 'postgres'} ${db}`, { encoding: 'utf8', maxBuffer: 64 << 20 });
  // The drop ends the storage's connections; its logs about that are not news.
  console.error = () => undefined;
  await admin.query(`DROP DATABASE IF EXISTS ${db} WITH (FORCE)`);
  await admin.end();
  // Plain SQL, no owner or privilege statements, so it loads into any database as any role.
  const kept = sql.split('\n').filter((l) => !/^(--|SET |SELECT pg_catalog\.set_config|\\restrict|\\unrestrict)/.test(l)).join('\n').replace(/\n{3,}/g, '\n\n');
  writeFileSync(join(dir, 'postgres-runs.sql'), `-- Written by packages/upgrade-tests/generate/0.16.0-runs.mjs --backend postgres. Do not edit.\n${kept.trim()}\n`);
}

// ── main ────────────────────────────────────────────────────────────────────────────────────────────
const sha = (file) => createHash('sha256').update(readFileSync(file)).digest('hex');
const target = check ? mkdtempSync(join(tmpdir(), 'gnl-016-runs-check-')) : outDir;
mkdirSync(target, { recursive: true });
if (backend === 'sqlite') await writeSqlite(target);
else if (backend === 'postgres') await writePostgres(target);
else throw new Error(`unknown --backend ${backend} (sqlite | postgres)`);
// The process registry 0.16.0's Sqlite liveness keeps beside the file (one entry per process): not data.
for (const f of readdirSync(target)) if (f.endsWith('.gnl-procs')) rmSync(join(target, f), { recursive: true, force: true });
writeFileSync(join(target, `notes-runs-${backend}.json`), `${JSON.stringify({ writtenBy: 'packages/upgrade-tests/generate/0.16.0-runs.mjs', version: VERSION, clockStart: new Date(T_0160).toISOString(), notes }, null, 1)}\n`);

if (check) {
  let diff = 0;
  for (const f of readdirSync(target)) {
    const committed = join(outDir, f);
    const same = existsSync(committed) && sha(committed) === sha(join(target, f));
    if (!same) diff++;
    console.log(`${same ? 'same   ' : 'DIFFERS'} ${f}`);
  }
  rmSync(target, { recursive: true, force: true });
  process.exit(diff ? 1 : 0);
}
for (const f of readdirSync(target)) console.log(`${sha(join(target, f)).slice(0, 12)}  ${f}`);
// The runs left in a tool never return: nothing else ends the process.
process.exit(0);
