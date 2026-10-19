#!/usr/bin/env node
// Which test files need a real server (Postgres, MySQL, MariaDB, MongoDB) — found, not listed.
//
// A file needs one when it, or a local module it imports, reads one of the variables a real server is
// handed through: GNL_PG_URL, GNL_PG_ADMIN_URL, GNL_PGVECTOR_URL, GNL_MYSQL_URL, GNL_MARIADB_URL, GNL_MONGO_URL,
// GNL_MONGO_STANDALONE_URL, GNL_QDRANT_URL, GNL_CHROMA_URL or GNL_PG_TXPOOL_URL (a transaction-mode pooler). Without the
// server such a file skips itself, so the default run stays green whether or not it was ever run. The CI job and
// scripts/check-real-backends.mjs used to name these files by hand; measured on 12 Oct 2026, 50 of them
// were named nowhere and ran only on a developer's machine — the new queue liveness and SIGTERM tests
// among them. A rule cannot forget a file that a list can.
//
// Two groups, because one kind of file must run alone: a test that terminates backends
// (`pg_terminate_backend`) reaches every other file's open pools when vitest runs them side by side.
//
//   node scripts/real-backend-tests.mjs                      # every file, one per line
//   node scripts/real-backend-tests.mjs --group alone         # only the ones that terminate backends
//   node scripts/real-backend-tests.mjs --run shared [-- ...]  # vitest over a group (args after -- go to vitest)
//
// The gates use --run rather than `vitest run $(… --group …)`: an empty substitution would make vitest
// run the WHOLE suite against the server and report it as the real-backend gate.
//
// packages/upgrade-tests is left out: it runs on its own (`pnpm test:legacy`) in its own CI job, which
// already hands it the server.
import { readdirSync, readFileSync, existsSync, statSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { join, dirname, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');

const SERVER_VARIABLE = /process\.env(?:\.|\[['"])GNL_(PG_URL|PG_ADMIN_URL|PGVECTOR_URL|MYSQL_URL|MARIADB_URL|MONGO_URL|MONGO_STANDALONE_URL|QDRANT_URL|CHROMA_URL|PG_TXPOOL_URL)\b/;
const TERMINATES_BACKENDS = /\bpg_terminate_backend\b/;
const LOCAL_IMPORT = /(?:from\s+|import\s*\(\s*|import\s+)['"](\.{1,2}\/[^'"]+)['"]/g;
const TEST_FILE = /\.test\.tsx?$/;
const LEFT_OUT = ['packages/upgrade-tests/'];

function walk(dir, out) {
  if (!existsSync(dir)) return out;
  for (const name of readdirSync(dir)) {
    if (name === 'node_modules' || name === 'dist') continue;
    const p = join(dir, name);
    if (statSync(p).isDirectory()) walk(p, out);
    else if (TEST_FILE.test(name)) out.push(p);
  }
  return out;
}

/** The source file a relative specifier names: `./x.js` is written for `./x.ts` under NodeNext. */
function resolveLocal(from, spec) {
  const base = resolve(dirname(from), spec);
  const stem = base.replace(/\.(m?js|tsx?)$/, '');
  for (const c of [base, `${stem}.ts`, `${stem}.tsx`, `${stem}.mts`, `${stem}.js`, `${stem}.mjs`, join(base, 'index.ts')]) {
    if (existsSync(c) && statSync(c).isFile()) return c;
  }
  return undefined;
}

const reads = new Map();
/** Whether `file`, or a local module it imports (transitively), reads a real server's variable. */
function readsServer(file, seen = new Set()) {
  if (reads.has(file)) return reads.get(file);
  if (seen.has(file)) return false;
  seen.add(file);
  const src = readFileSync(file, 'utf8');
  let hit = SERVER_VARIABLE.test(src);
  if (!hit) {
    for (const m of src.matchAll(LOCAL_IMPORT)) {
      const dep = resolveLocal(file, m[1]);
      if (dep && readsServer(dep, seen)) { hit = true; break; }
    }
  }
  reads.set(file, hit);
  return hit;
}

/** Every test file that needs a real server, as repository-relative paths, sorted; `alone` marks the ones that terminate backends. */
export function realBackendTests() {
  const dirs = [];
  for (const top of ['packages', 'examples']) {
    const d = join(root, top);
    if (!existsSync(d)) continue;
    for (const name of readdirSync(d)) dirs.push(join(d, name, 'test'));
  }
  dirs.push(join(root, 'test'));
  const files = dirs.flatMap((d) => walk(d, []))
    .map((f) => ({ abs: f, path: relative(root, f).split('\\').join('/') }))
    .filter((f) => !LEFT_OUT.some((p) => f.path.startsWith(p)))
    .filter((f) => readsServer(f.abs));
  return files
    .map((f) => ({ path: f.path, alone: TERMINATES_BACKENDS.test(readFileSync(f.abs, 'utf8')) }))
    .sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const argv = process.argv.slice(2);
  const dashes = argv.indexOf('--');
  const own = dashes < 0 ? argv : argv.slice(0, dashes);
  const passOn = dashes < 0 ? [] : argv.slice(dashes + 1);
  const flag = own.includes('--run') ? '--run' : own.includes('--group') ? '--group' : undefined;
  const group = flag ? own[own.indexOf(flag) + 1] : undefined;
  if (flag && group !== 'alone' && group !== 'shared') {
    console.error(`real-backend-tests: ${flag} takes "alone" or "shared", not "${group}"`);
    process.exit(2);
  }
  const files = realBackendTests().filter((f) => group === undefined || (group === 'alone') === f.alone).map((f) => f.path);
  if (flag !== '--run') {
    process.stdout.write(files.join('\n') + (files.length ? '\n' : ''));
  } else {
    if (files.length === 0) {
      console.error(`real-backend-tests: the rule found no "${group}" file — a gate that runs nothing has not passed`);
      process.exit(1);
    }
    console.log(`real-backend-tests: ${files.length} "${group}" file(s)`);
    const r = spawnSync('pnpm', ['exec', 'vitest', 'run', ...passOn, ...files], { cwd: root, stdio: 'inherit' });
    process.exit(r.status ?? 1);
  }
}
