// THE POSTGRES CONNECTION BUDGET — every test file of the repository runs under it (vitest.config.ts `setupFiles`).
//
// The rule it makes true by construction: the real-backend "shared" group runs WORKERS test files at once
// against ONE Postgres (`max_connections = 100`), so it stays under the server's limit only if
//
//     WORKERS x connections-per-process  <=  SERVER_MAX - HEADROOM
//
// Before this file the right-hand side held by luck: node-postgres opens up to 10 connections per pool, a
// test file may open a dozen stores, and the three heaviest files (erase-relations, detached-run-scale-postgres,
// a-derived-run-is-born-by-the-engine) each reach 44-55 on their own. Measured 7 Nov 2026 (pg-budget-audit/RAPOR.md):
// those three together asked for 82 of 100; with `max_connections = 60` the same three failed 10 tests with
// `too many clients`. Fixing one file's leak (PR #53) moved the peak from 99 to 64 but chose no limit.
//
// How: every `pg.Client` of this test process takes one of PER_PROCESS slots before it connects and gives it
// back when its socket ends. A pool is only a set of Clients, so this bounds pools, standalone clients, the
// boot-lock session and liveness sessions alike — whatever the file opens, and however many stores it opens.
// It is test-only: nothing under packages/*/src is touched, and a deployment's pool sizing is its own.
//
// A file that wants more than its share WAITS (a slot frees when a pool's idle client expires, 10 s by default,
// or a store closes) and, if nothing frees one within WAIT_MS, FAILS with a message that names this file and
// the holders' count. It never slips through silently and never turns into a server-side `too many clients`
// that blames an innocent neighbour.
import { createRequire } from 'node:module';
import { basename, join } from 'node:path';
import { expect } from 'vitest';

/** What CI's two Postgres services allow (`postgres:15-alpine` and `postgres:16`, both default). */
const SERVER_MAX = 100;
/** Not ours to spend: Postgres's superuser_reserved_connections (3), and the PgBouncer service of the same job, which holds server connections to
 *  this Postgres for the pooler tests (ci.yml). Its default pool would allow 20; the pooler tests open a handful, so 8 is allowed here.
 *  That 8 is an ASSUMPTION: PgBouncer is not run in the local experiments, so its real use was not measured. */
const HEADROOM = 3 + 8;
/** CI runs `vitest --maxWorkers=3` for the shared group; a developer machine with more cores must pass --maxWorkers=3 too, or the sum rises. */
const WORKERS = 3;
/**
 * A process a test SPAWNS (a fixture "app process") has a cap of its own, passed through NODE_OPTIONS to every child. 8 is measured from both
 * sides: at 5 six real-process tests (a-background-tool-wake, a-background-tool-across-processes, detached-run-failures-across-processes,
 * one-process-two-databases, b1-continuation-id-hijack-processes) timed out because their children need ~6 (pool + boot lock + liveness),
 * (at 8 those five pass). detached-run-scale-postgres is the exception below.
 */
const CHILD_LIMIT = 8;
/**
 * One test is a FLEET: detached-run-scale-postgres starts 4 app processes against one database and measures throughput and completion
 * across them. Each child runs node-postgres's pool of 10 plus a liveness session (11), which is what the test measures, so it is NOT
 * capped below that: at 6 the test stopped completing its 200 runs, at 8 it passed alone but lost 12 of 200 runs in 3 of 4 modes in a full
 * run on a loaded machine (measured, RAPOR.md). Its parent is small (an admin connection, a store). So the fleet is given the share its
 * subject needs, 4 + 4 x 11 = 48, and the other workers' share is what is left. Every other file's children are NOT summed with its parent.
 */
const FLEET: Record<string, { parent: number; child: number; children: number }> = {
  'detached-run-scale-postgres.test.ts': { parent: 4, child: 11, children: 4 },
};
const FLEET_TOTAL = Math.max(...Object.values(FLEET).map((f) => f.parent + f.children * f.child));
/**
 * What every other file's own process may hold: WORKERS x this + the fleet's extra <= SERVER_MAX - HEADROOM, i.e. (100 - 11 - 48) / 2 = 20.
 * Worst case: the fleet file and two others at once = 48 + 20 + 20 = 88 <= 89. `GNL_TEST_PG_PER_PROCESS` overrides it for an experiment.
 */
const PER_PROCESS = Number(process.env.GNL_TEST_PG_PER_PROCESS) || Math.floor((SERVER_MAX - HEADROOM - FLEET_TOTAL) / (WORKERS - 1));
/** A pool's idle client expires after 10 s (pg-pool default), so 20 s covers two expiries; the 30 s test timeout stays above it. */
const WAIT_MS = 20_000;

/**
 * Files whose SUBJECT is how many connections gnl opens or how a pool behaves, so a cap would change what they measure.
 * Each is listed with why; a file that is not here is under the budget.
 */
const EXEMPT: Record<string, string> = {
  'k4-burst.test.ts': 'a measurement of the scheduler burst\'s own maxConn (pg_stat_activity); skipped unless K4_CAND is set',
  'k4-burst-unl.test.ts': 'the same measurement, unlimited variant; skipped unless K4_CAND is set',
};

type Budget = { limit: number };
const G = globalThis as unknown as { __gnlPgBudget?: Budget };
const here = new URL('.', import.meta.url).pathname;

// `GNL_TEST_PG_BUDGET=off` removes the cap: only for measuring what it prevents (negative control), never in CI.
if (process.env.GNL_TEST_PG_BUDGET !== 'off' && (process.env.GNL_PG_URL || process.env.GNL_PG_ADMIN_URL || process.env.GNL_PGVECTOR_URL || process.env.GNL_PG_TXPOOL_URL)) {
  const file = () => basename(expect.getState().testPath ?? 'unknown');
  const state = (G.__gnlPgBudget ??= (createRequire(import.meta.url)('./pg-connection-budget.cjs') as {
    install(limit: number, waitMs: number, who: () => string, share: string): Budget;
  }).install(PER_PROCESS, WAIT_MS, file, `the share of one of ${WORKERS} workers, of the server's ${SERVER_MAX}`));
  const fleet = FLEET[file()];
  state.limit = EXEMPT[file()] ? Infinity : fleet ? fleet.parent : PER_PROCESS;
  // Children of this worker: the same rule through a preload.
  const preload = `--require ${join(here, 'pg-connection-budget.cjs')}`;
  if (!process.env.NODE_OPTIONS?.includes(preload)) process.env.NODE_OPTIONS = `${process.env.NODE_OPTIONS ?? ''} ${preload}`.trim();
  process.env.GNL_TEST_PG_CHILD_LIMIT = state.limit === Infinity ? '' : String(fleet ? fleet.child : CHILD_LIMIT);
}
