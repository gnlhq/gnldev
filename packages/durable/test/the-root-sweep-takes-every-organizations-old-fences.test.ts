// The root retention sweep takes every registered organization's old fences, as it takes their runs.
//
// A deleted run leaves a fence (erasure-fence.ts) in its own scope: an organization's under `org:<id>:`.
// `sweepRuns` at the root sweeps the organizations' runs (a root journal lists them) but swept only the
// root's fences: an organization's stayed until a sweep through its own view (measured, c-erasure CE-5).
//
// Siblings: an organization's own sweep still takes its own, and a fence inside the horizon stays at both.
//
// Postgres runs when GNL_PG_URL is set.
import { describe, it, expect, afterAll } from 'vitest';
import pg from 'pg';
import { InMemoryStorage, toJournal, withOrg, purgeRun, sweepRuns, ORG_RECORD_PRE, type Storage } from '../src/index.js';
import { runDurable } from '../src/run.js';
import { SqliteStorage } from '../src/sqlite-storage.js';
import { PostgresStorage } from '../src/postgres-storage.js';
import { createMockModel, finalTextResult } from './mock.js';

const PG_URL = process.env.GNL_PG_URL;
const ends: Array<() => Promise<unknown>> = [];
afterAll(async () => { for (const e of ends.reverse()) await e(); });
const STORES: Array<[string, () => Promise<Storage>]> = [
  ['in-memory', async () => new InMemoryStorage()],
  ['sqlite', async () => new SqliteStorage(':memory:') as unknown as Storage],
];
if (PG_URL) {
  // A database of its own: a sweep past the horizon takes every old run in the store, and other test
  // files share GNL_PG_URL's.
  let seq = 0;
  STORES.push(['postgres (real)', async () => {
    const name = `gnl_fence_sweep_${process.pid}_${Date.now().toString(36)}_${seq++}`;
    const admin = new pg.Client({ connectionString: PG_URL });
    await admin.connect();
    await admin.query(`CREATE DATABASE ${name}`);
    const u = new URL(PG_URL);
    u.pathname = `/${name}`;
    const s = new PostgresStorage({ connectionString: u.toString() });
    await s.init();
    ends.push(async () => { await s.close(); await admin.query(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`); await admin.end(); });
    return s as unknown as Storage;
  }]);
}
const unique = () => `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
const model = createMockModel(async () => finalTextResult('ok'));

describe.each(STORES)('fences under the retention horizon — %s', (_name, make) => {
  async function world() {
    const s = await make();
    const root = toJournal(s.runs);
    const id = unique();
    const org = `acme${id}`;
    await root.put(`${ORG_RECORD_PRE}${org}`, { id: org });
    const acme = withOrg(root, org);
    await runDurable({ runId: `r-o-${id}`, journal: acme, model, prompt: 'hi' } as any);
    await runDurable({ runId: `r-r-${id}`, journal: root, model, prompt: 'hi' } as any);
    await purgeRun(acme, `r-o-${id}`);
    await purgeRun(root, `r-r-${id}`);
    const fences = async () => (await root.listKeys!('')).filter((k) => k.includes('__run_erased__:') && (k.startsWith(`org:${org}:`) || k.startsWith('__run_erased__:')));
    return { root, acme, fences, org };
  }

  it('the root sweep past the horizon takes the root\'s fences and every registered organization\'s', async () => {
    const { root, fences } = await world();
    expect((await fences()).length).toBeGreaterThanOrEqual(2);
    const r = await sweepRuns(root as any, { olderThanMs: 1000, now: Date.now() + 10 ** 9 });
    expect(r.fencesSwept).toBeGreaterThanOrEqual(2);
    expect(await fences()).toEqual([]);
  });

  it('sibling: inside the horizon both stay; an organization\'s own sweep takes its own', async () => {
    const { root, acme, fences, org } = await world();
    const before = await fences();
    await sweepRuns(root as any, { olderThanMs: 60_000 });
    expect(await fences()).toEqual(before);
    await sweepRuns(acme as any, { olderThanMs: 1000, now: Date.now() + 10 ** 9 });
    expect((await fences()).filter((k) => k.startsWith(`org:${org}:`))).toEqual([]);
  });
});
