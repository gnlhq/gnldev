#!/usr/bin/env node
// Writes the 0.16.0 fixtures: a queue as 0.16.0 left it — every job in the one `qjob` log, the first few
// run by a 0.16.0 worker (one dead-lettered), its `qcursor` — which @gnldev/queue's
// test/k5-queue-upgrade.test.ts upgrades with the current code (`queue/lanes`, `queue/lanes-cleanup`).
//
//   node generate/0.16.0.mjs                        # Sqlite: fixtures/0.16.0/queue*.db; 0.16.0 installed from npm into a temp dir
//   GNL_016_ROOT=/path/to/0.16.0 node generate/0.16.0.mjs
//   GNL_PG_URL=postgres://… GNL_PG_DUMP='docker exec -i pg pg_dump' node generate/0.16.0.mjs --backend postgres
//   GNL_MYSQL_URL=mysql://root:pw@localhost:3306/mysql GNL_MYSQL_DUMP='docker exec -i my mysqldump' node generate/0.16.0.mjs --backend mysql
//   GNL_MONGO_URL='mongodb://root:pw@localhost:27017/admin?authSource=admin' node generate/0.16.0.mjs --backend mongo
//   node generate/0.16.0.mjs --check                # regenerate into a temp dir and compare: exit 1 on any difference
//
// The scenario is the queue's own 0.16.0 writer (packages/queue/test/fixtures/k5-q016-writer.mjs), run
// in a child with ./deterministic.mjs imported first: the clock, Math.random and randomUUID are fixed,
// so a second run writes the same rows (and Sqlite bytes). GNL_016_ROOT is a directory where the
// published packages are installed (`<root>/node_modules/@gnldev/<name>/dist`) — never the workspace.
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync, readdirSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { execFileSync, execSync } from 'node:child_process';
import { createRequire } from 'node:module';

const VERSION = '0.16.0';
const here = dirname(fileURLToPath(import.meta.url));
const WRITER = resolve(here, '..', '..', 'queue', 'test', 'fixtures', 'k5-q016-writer.mjs');
const argv = process.argv.slice(2);
const flag = (name) => {
  const i = argv.indexOf(name);
  return i === -1 ? undefined : argv[i + 1];
};
const backend = flag('--backend') ?? 'sqlite';
const check = argv.includes('--check');
const outDir = resolve(flag('--out') ?? join(here, '..', 'fixtures', VERSION));

/**
 * The fixtures, by name: `queue` — 6 system jobs, 5 of each of two organizations, a person's, a fixed id,
 * the first 4 taken (3 done, the third in the log dead-lettered); `queue-many` — 160 system jobs, the
 * first 60 taken, so 0.16.0's worker passed a full page of finished jobs and wrote its `qcursor`.
 */
const SCENARIOS = { queue: {}, 'queue-many': { Q016_SYSTEM: '160', Q016_RUN: '60' } };

// ── where 0.16.0 comes from ─────────────────────────────────────────────────────────────────────────
const PACKAGES = ['durable', 'queue'];
function install() {
  const target = mkdtempSync(join(tmpdir(), 'gnl-016-'));
  writeFileSync(join(target, 'package.json'), JSON.stringify({ name: 'gnl-016-install', private: true, type: 'module' }));
  const specs = [...PACKAGES.map((p) => `@gnldev/${p}@${VERSION}`), 'pg@^8', 'mysql2@^3', 'mongodb@^6'];
  console.error(`installing ${specs.join(' ')} into ${target} …`);
  execSync(`npm install --no-audit --no-fund --loglevel=error ${specs.join(' ')}`, { cwd: target, stdio: 'inherit' });
  return target;
}
const root = process.env.GNL_016_ROOT ? resolve(process.env.GNL_016_ROOT) : install();
for (const p of PACKAGES) {
  const v = JSON.parse(readFileSync(join(root, 'node_modules', '@gnldev', p, 'package.json'), 'utf8')).version;
  if (v !== VERSION) throw new Error(`@gnldev/${p} under ${root} is ${v}, not ${VERSION}`);
}
/** One scenario written by 0.16.0's code, in a child with the fixed clock: what it did, as the writer prints it. */
function write(kind, target, env) {
  // MongoDB: the driver's own ObjectIds fixed too (deterministic-bson.mjs).
  const fixed = ['deterministic.mjs', ...(kind === 'mongo' ? ['deterministic-bson.mjs'] : [])].flatMap((f) => ['--import', pathToFileURL(join(here, f)).href]);
  const out = execFileSync(process.execPath, [...fixed, WRITER, kind, target], {
    env: { ...process.env, ...env, GNL_016_ROOT: root },
    stdio: ['ignore', 'pipe', 'inherit'],
  });
  return JSON.parse(out.toString());
}

const notes = {};

function writeSqlite(dir) {
  for (const [name, env] of Object.entries(SCENARIOS)) {
    const file = join(dir, `${name}.db`);
    for (const x of ['', '-wal', '-shm']) rmSync(file + x, { force: true });
    notes[name] = write('sqlite', file, env);
    for (const x of ['-wal', '-shm']) rmSync(file + x, { force: true });
  }
  // The process registry 0.16.0's Sqlite liveness keeps beside the file (one entry per process): not data.
  for (const f of readdirSync(dir)) if (f.endsWith('.gnl-procs')) rmSync(join(dir, f), { recursive: true, force: true });
}

async function writePostgres(dir) {
  const url = process.env.GNL_PG_URL;
  if (!url) throw new Error('--backend postgres needs GNL_PG_URL (a server where this may create and drop a database)');
  const dump = process.env.GNL_PG_DUMP ?? 'pg_dump';
  const pg = createRequire(join(root, 'package.json'))('pg');
  const admin = new pg.Client({ connectionString: url });
  await admin.connect();
  for (const [name, env] of Object.entries(SCENARIOS)) {
    const db = `gnl_fixture_016_${name.replace(/-/g, '_')}`;
    await admin.query(`DROP DATABASE IF EXISTS ${db} WITH (FORCE)`);
    await admin.query(`CREATE DATABASE ${db}`);
    const u = new URL(url);
    u.pathname = `/${db}`;
    notes[name] = write('postgres', u.toString(), env);
    // Plain SQL, no owner or privilege statements, so it loads into any database as any role.
    const sql = execSync(`${dump} --no-owner --no-privileges --no-comments --inserts --rows-per-insert=1 -U ${u.username || 'postgres'} ${db}`, { encoding: 'utf8', maxBuffer: 64 << 20 });
    await admin.query(`DROP DATABASE IF EXISTS ${db} WITH (FORCE)`);
    // Drop what varies between pg_dump versions and runs but carries no data.
    const kept = sql.split('\n').filter((l) => !/^(--|SET |SELECT pg_catalog\.set_config|\\restrict|\\unrestrict)/.test(l)).join('\n').replace(/\n{3,}/g, '\n\n');
    writeFileSync(join(dir, `postgres-${name}.sql`), `-- Written by packages/upgrade-tests/generate/0.16.0.mjs --backend postgres. Do not edit.\n${kept.trim()}\n`);
  }
  await admin.end();
}

/**
 * MySQL: `mysqldump` of a fresh database per scenario — one INSERT per row, no comments, no dump date, no
 * version-conditional SET lines (they carry the server's settings, not data): what remains loads into any
 * database as plain statements (`multipleStatements`).
 */
async function writeMysql(dir) {
  const url = process.env.GNL_MYSQL_URL;
  if (!url) throw new Error('--backend mysql needs GNL_MYSQL_URL (a server where this may create and drop a database)');
  const dump = process.env.GNL_MYSQL_DUMP ?? 'mysqldump';
  const my = createRequire(join(root, 'package.json'))('mysql2/promise');
  const admin = await my.createConnection(url);
  const u0 = new URL(url);
  for (const [name, env] of Object.entries(SCENARIOS)) {
    const db = `gnl_fixture_016_${name.replace(/-/g, '_')}`;
    await admin.query(`DROP DATABASE IF EXISTS ${db}`);
    await admin.query(`CREATE DATABASE ${db}`);
    const u = new URL(url);
    u.pathname = `/${db}`;
    notes[name] = write('mysql', u.toString(), env);
    const pw = decodeURIComponent(u0.password);
    const sql = execSync(`${dump} --compact --skip-extended-insert --skip-dump-date --no-tablespaces --skip-comments -u${decodeURIComponent(u0.username) || 'root'}${pw ? ` -p${pw}` : ''} ${db}`, { encoding: 'utf8', maxBuffer: 64 << 20, stdio: ['ignore', 'pipe', 'ignore'] });
    await admin.query(`DROP DATABASE IF EXISTS ${db}`);
    const kept = sql.split('\n').filter((l) => !/^\/\*!/.test(l)).join('\n').replace(/\n{3,}/g, '\n\n');
    writeFileSync(join(dir, `mysql-${name}.sql`), `-- Written by packages/upgrade-tests/generate/0.16.0.mjs --backend mysql. Do not edit.\n${kept.trim()}\n`);
  }
  await admin.end();
}

/**
 * MongoDB: no tool's dump is reproducible byte for byte (a `mongodump` archive carries collection UUIDs and
 * its own metadata), so the fixture is the data itself as canonical Extended JSON (`relaxed: false`, which
 * keeps every BSON type — an Int32 stays an Int32, a Long a Long, a date a date): per collection its index
 * specs, sorted by name, and its documents, sorted by `_id`, one per line — text a diff can read and a test
 * loads with `EJSON.parse` and `insertMany`. `gnl_liveness_users` is left out: it names the database user the
 * writer connected as (process state, like Sqlite's `.gnl-procs`), not data.
 */
const MONGO_SKIP = new Set(['gnl_liveness_users']);
async function writeMongo(dir) {
  const url = process.env.GNL_MONGO_URL;
  if (!url) throw new Error('--backend mongo needs GNL_MONGO_URL (a server where this may create and drop a database)');
  const { MongoClient, BSON } = createRequire(join(root, 'package.json'))('mongodb');
  const { EJSON } = BSON;
  const client = new MongoClient(url);
  await client.connect();
  const canon = (v) => EJSON.stringify(v, { relaxed: false });
  for (const [name, env] of Object.entries(SCENARIOS)) {
    const db = `gnl_fixture_016_${name.replace(/-/g, '_')}`;
    await client.db(db).dropDatabase();
    const u = new URL(url);
    u.pathname = `/${db}`;
    notes[name] = write('mongo', u.toString(), env);
    const d = client.db(db);
    const lines = [];
    for (const c of (await d.listCollections({}, { nameOnly: true }).toArray()).map((x) => x.name).filter((n) => !MONGO_SKIP.has(n)).sort()) {
      const indexes = (await d.collection(c).listIndexes().toArray()).map(({ v, ns, ...spec }) => spec).sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
      lines.push(`{"collection":${JSON.stringify(c)},"indexes":${canon(indexes)}}`);
      const docs = (await d.collection(c).find({}).toArray()).map((x) => [canon(x._id), canon(x)]).sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
      for (const [, doc] of docs) lines.push(doc);
    }
    await d.dropDatabase();
    writeFileSync(join(dir, `mongo-${name}.ejson`), `${lines.join('\n')}\n`);
  }
  await client.close();
}

// ── main ────────────────────────────────────────────────────────────────────────────────────────────
const sha = (file) => createHash('sha256').update(readFileSync(file)).digest('hex');
const target = check ? mkdtempSync(join(tmpdir(), 'gnl-016-check-')) : outDir;
mkdirSync(target, { recursive: true });
if (backend === 'sqlite') writeSqlite(target);
else if (backend === 'postgres') await writePostgres(target);
else if (backend === 'mysql') await writeMysql(target);
else if (backend === 'mongo') await writeMongo(target);
else throw new Error(`unknown --backend ${backend} (sqlite | postgres | mysql | mongo)`);
writeFileSync(join(target, `notes-${backend}.json`), `${JSON.stringify({ writtenBy: 'packages/upgrade-tests/generate/0.16.0.mjs', version: VERSION, notes }, null, 1)}\n`);

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
process.exit(0);
