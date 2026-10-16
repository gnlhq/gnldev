#!/usr/bin/env node
// Writes the 0.10.0 fixtures: a store as 0.10.0 left it — runs of every kind, an erased person, an
// organization (generate/runs.mjs) — which ../test/from-0.10.0 upgrades with the current code.
//
//   node generate/0.10.0.mjs                        # Sqlite: fixtures/0.10.0/runs.db; 0.10.0 installed from npm into a temp dir
//   GNL_0100_ROOT=/path/to/0.10.0 node generate/0.10.0.mjs
//   GNL_PG_URL=postgres://… GNL_PG_DUMP='docker exec -i pg pg_dump' node generate/0.10.0.mjs --backend postgres [--db name]
//   node generate/0.10.0.mjs --check                # regenerate into a temp dir and compare: exit 1 on any difference
//
// GNL_0100_ROOT is a checkout of the 0.10.0 tag, built (`<root>/packages/<name>/dist`), or a directory
// where the published packages are installed (`<root>/node_modules/@gnldev/<name>/dist`). Never resolved
// through the workspace — see load-0.9.0.mjs for why.
//
// The clock, Math.random and randomUUID are fixed (./deterministic.mjs), so a second run writes the same
// Sqlite bytes.
import { resetDeterminism, setClock } from './deterministic.mjs';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync, readdirSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { execSync } from 'node:child_process';
import { writeRuns } from './runs.mjs';

const VERSION = '0.10.0';
/** 2026-10-05T12:00:00Z, the day 0.10.0 was released. */
const T_0100 = Date.UTC(2026, 9, 5, 12, 0, 0);

const here = dirname(fileURLToPath(import.meta.url));
const argv = process.argv.slice(2);
const flag = (name) => {
  const i = argv.indexOf(name);
  return i === -1 ? undefined : argv[i + 1];
};
const backend = flag('--backend') ?? 'sqlite';
const check = argv.includes('--check');
const outDir = resolve(flag('--out') ?? join(here, '..', 'fixtures', VERSION));

// ── where 0.10.0 comes from ─────────────────────────────────────────────────────────────────────────
const PACKAGES = ['durable', 'memory'];
function packageDir(root, name) {
  for (const d of [join(root, 'node_modules', '@gnldev', name), join(root, 'packages', name)]) if (existsSync(join(d, 'package.json'))) return d;
  throw new Error(`@gnldev/${name} not found under ${root} (looked in node_modules/@gnldev and packages/)`);
}
function install() {
  const target = mkdtempSync(join(tmpdir(), 'gnl-0100-'));
  writeFileSync(join(target, 'package.json'), JSON.stringify({ name: 'gnl-0100-install', private: true, type: 'module' }));
  const specs = [...PACKAGES.map((p) => `@gnldev/${p}@${VERSION}`), 'ai@^7', 'zod@^3.25.76', 'pg@^8'];
  console.error(`installing ${specs.join(' ')} into ${target} …`);
  execSync(`npm install --no-audit --no-fund --loglevel=error ${specs.join(' ')}`, { cwd: target, stdio: 'inherit' });
  return target;
}
const root = process.env.GNL_0100_ROOT ? resolve(process.env.GNL_0100_ROOT) : install();
for (const p of PACKAGES) {
  const v = JSON.parse(readFileSync(join(packageDir(root, p), 'package.json'), 'utf8')).version;
  if (v !== VERSION) throw new Error(`@gnldev/${p} at ${packageDir(root, p)} is ${v}, not ${VERSION}`);
}
const load = (name, file = 'index.js') => import(pathToFileURL(join(packageDir(root, name), 'dist', file)).href);
/** A dependency as the 0.10.0 packages resolve it (their node_modules), not the workspace's. */
const dep = async (name, file) => import(pathToFileURL(join(existsSync(join(root, 'node_modules', name)) ? join(root, 'node_modules', name) : join(packageDir(root, 'durable'), 'node_modules', name), file)).href);
const m = {
  durable: await load('durable'),
  AgentMemory: (await load('memory')).AgentMemory,
  z: (await dep('zod', 'index.js').catch(() => dep('zod', 'lib/index.js'))).z,
};

const notes = {};

async function scenario(storage) {
  resetDeterminism();
  setClock(T_0100);
  notes.written = await writeRuns(m, storage);
}

async function writeSqlite(dir) {
  const { SqliteStorage } = await load('durable', 'sqlite-storage.js');
  const file = join(dir, 'runs.db');
  rmSync(file, { force: true });
  const s = new SqliteStorage(file);
  await s.init();
  await scenario(s);
  await s.close();
  for (const x of ['-wal', '-shm']) rmSync(file + x, { force: true });
}

async function writePostgres(dir) {
  const url = process.env.GNL_PG_URL;
  if (!url) throw new Error('--backend postgres needs GNL_PG_URL (a server where this may create and drop a database)');
  const dump = process.env.GNL_PG_DUMP ?? 'pg_dump';
  const db = flag('--db') ?? 'gnl_fixture_0100';
  const { default: pg } = await dep('pg', 'lib/index.js').catch(() => import('pg'));
  const admin = new pg.Client({ connectionString: url });
  await admin.connect();
  const { PostgresStorage } = await load('durable', 'postgres-storage.js');
  await admin.query(`DROP DATABASE IF EXISTS ${db}`);
  await admin.query(`CREATE DATABASE ${db}`);
  const u = new URL(url);
  u.pathname = `/${db}`;
  const s = new PostgresStorage({ connectionString: u.toString() });
  await s.init();
  await scenario(s);
  await s.close();
  // Plain SQL, no owner or privilege statements, so it loads into any database as any role.
  const sql = execSync(`${dump} --no-owner --no-privileges --no-comments --inserts --rows-per-insert=1 -U ${u.username || 'postgres'} ${db}`, { encoding: 'utf8', maxBuffer: 64 << 20 });
  await admin.query(`DROP DATABASE IF EXISTS ${db} WITH (FORCE)`);
  await admin.end();
  // Drop what varies between pg_dump versions and runs but carries no data.
  const kept = sql.split('\n').filter((l) => !/^(--|SET |SELECT pg_catalog\.set_config|\\restrict|\\unrestrict)/.test(l)).join('\n').replace(/\n{3,}/g, '\n\n');
  writeFileSync(join(dir, 'postgres-runs.sql'), `-- Written by packages/upgrade-tests/generate/0.10.0.mjs --backend postgres. Do not edit.\n${kept.trim()}\n`);
}

// ── main ────────────────────────────────────────────────────────────────────────────────────────────
const sha = (file) => createHash('sha256').update(readFileSync(file)).digest('hex');
const target = check ? mkdtempSync(join(tmpdir(), 'gnl-0100-check-')) : outDir;
mkdirSync(target, { recursive: true });
if (backend === 'sqlite') await writeSqlite(target);
else if (backend === 'postgres') await writePostgres(target);
else throw new Error(`unknown --backend ${backend} (sqlite | postgres)`);
writeFileSync(join(target, `notes-${backend}.json`), `${JSON.stringify({ writtenBy: 'packages/upgrade-tests/generate/0.10.0.mjs', version: VERSION, clockStart: new Date(T_0100).toISOString(), notes }, null, 1)}\n`);

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
// The run left `running` never returns: nothing else keeps the process.
process.exit(0);
