// A run listing pages by run, not by row number (run-cursor.ts). Two promises, on every first-party
// store that keys its order on (created_at, run_id) and on the array readers:
//   1. walking the pages — any page size, either order, any filter — yields exactly the full list;
//   2. runs inserted and deleted between two page requests neither repeat nor skip a surviving run.
// The second is the reason for the change: under row-number cursors, deleting runs already shown
// shifted every later row back, and the next page skipped as many runs as were deleted.
import { describe, it, expect, afterAll } from 'vitest';
import pg from 'pg';
import { InMemoryStorage, purgeRun, toJournal, withOrg } from '../src/index.js';
import { SqliteStorage } from '../src/sqlite-storage.js';
import { PostgresStorage } from '../src/postgres-storage.js';
import type { RunSummary } from '../src/journal.js';

// The real-backend CI job sets GNL_PG_URL; a database is created and dropped per store under it.
const PG_ADMIN = process.env.GNL_PG_ADMIN_URL ?? process.env.GNL_PG_URL; // e.g. postgres://postgres:t@127.0.0.1:41260/postgres
const created: string[] = [];
afterAll(async () => {
  if (!PG_ADMIN || !created.length) return;
  const admin = new pg.Pool({ connectionString: PG_ADMIN });
  for (const db of created) await admin.query(`DROP DATABASE IF EXISTS ${db} WITH (FORCE)`);
  await admin.end();
});

const stores: [string, () => Promise<any>][] = [
  ['InMemoryStorage', async () => new InMemoryStorage()],
  ['SqliteStorage', async () => new SqliteStorage()],
  // No pg-mem: it cannot compare rows, and the keyset is a row comparison (run-cursor.ts). The real
  // Postgres below runs in the real-backend CI job (GNL_PG_URL).
  ...(PG_ADMIN ? [['PostgresStorage (real)', async () => {
    const db = `gnl_cursor_${process.pid}_${created.length}_${Date.now()}`;
    const admin = new pg.Pool({ connectionString: PG_ADMIN });
    await admin.query(`CREATE DATABASE ${db}`);
    await admin.end();
    created.push(db);
    return new PostgresStorage({ connectionString: PG_ADMIN.replace(/\/[^/]*$/, `/${db}`) });
  }] as [string, () => Promise<any>]] : []),
];

/** 23 runs covering every status, every filter field, a child run, an input-only and an outcome-only run. */
async function seed(runs: any) {
  for (let i = 0; i < 20; i++) {
    const id = `r${String(i).padStart(2, '0')}`;
    await runs.put(`${id}:input`, {
      _v: 1, prompt: 'x', agent: i % 3 ? 'a' : 'b', resourceId: i % 2 ? 'u1' : 'u2',
      ...(i % 5 === 0 ? { workKey: 'job-5' } : {}), ...(i % 7 === 3 ? { parentRunId: 'r00' } : {}),
    });
    await runs.put(`${id}:model:0`, { text: 'x' });
    if (i % 4 === 1) await runs.put(`${id}:tool:c1`, { status: 'suspended' });
    if (i % 6 === 2) await runs.put(`${id}:outcome`, { status: 'failed', _v: 1 });
    if (i % 9 === 4) await runs.put(`${id}:outcome`, { status: 'running', _v: 1 });
    if (i === 11) await runs.put(`${id}:outcome`, { status: 'canceled', _v: 1 });
  }
  await runs.put('only-input:input', { _v: 1, prompt: 'x', agent: 'a' });
  await runs.put('only-outcome:outcome', { status: 'failed', _v: 1 });
  await runs.put('r20:model:0', { text: 'x' });
}

async function walk(runs: any, q: Record<string, unknown>, limit: number): Promise<RunSummary[]> {
  const out: RunSummary[] = [];
  let cursor: string | undefined;
  for (let guard = 0; guard < 200; guard++) {
    const page = await runs.listRuns({ ...q, limit, ...(cursor ? { cursor } : {}) });
    expect(page.items.length).toBeLessThanOrEqual(limit);
    out.push(...page.items);
    if (!page.nextCursor) return out;
    cursor = page.nextCursor;
  }
  throw new Error('the cursor did not advance');
}

const FILTERS: Record<string, unknown>[] = [
  {}, { status: 'completed' }, { status: 'suspended' }, { status: 'failed' }, { status: 'running' }, { status: 'canceled' },
  { agent: 'a' }, { resourceId: 'u1' }, { workKey: 'job-5' }, { topLevel: true }, { status: 'completed', agent: 'b' },
];

for (const [name, make] of stores) {
  describe(`run cursors — ${name}`, () => {
    it('every page size, either order, every filter: the walk is exactly the full list', async () => {
      const s = await make();
      await seed(s.runs);
      for (const f of FILTERS) {
        const full = (await s.runs.listRuns({ ...f, limit: 1_000_000 })).items as RunSummary[];
        expect(full.length, JSON.stringify(f)).toBeGreaterThan(0);
        for (const limit of [1, 7, 50]) {
          expect(await walk(s.runs, f, limit), `${JSON.stringify(f)} asc limit ${limit}`).toEqual(full);
          expect(await walk(s.runs, { ...f, order: 'desc' }, limit), `${JSON.stringify(f)} desc limit ${limit}`).toEqual([...full].reverse());
        }
      }
      await s.close?.();
    }, 120_000);

    it('runs inserted and deleted between two pages: no surviving run repeats or goes missing', async () => {
      const s = await make();
      await seed(s.runs);
      const before = (await s.runs.listRuns({ limit: 1_000_000 })).items.map((r: RunSummary) => r.runId);
      const p1 = await s.runs.listRuns({ limit: 5 });
      const shown = p1.items.map((r: RunSummary) => r.runId);
      // Delete two runs the reader has already seen, and add three new ones.
      const j = toJournal(s.runs);
      await purgeRun(j, shown[1]!);
      await purgeRun(j, shown[2]!);
      for (const id of ['z1', 'z2', 'z3']) await s.runs.put(`${id}:model:0`, { text: 'x' });
      const rest: string[] = [];
      let cursor: string | undefined = p1.nextCursor;
      while (cursor) {
        const page = await s.runs.listRuns({ limit: 5, cursor });
        rest.push(...page.items.map((r: RunSummary) => r.runId));
        cursor = page.nextCursor;
      }
      const seen = [...shown, ...rest];
      expect(new Set(seen).size, 'a run was shown twice').toBe(seen.length);
      for (const id of before) {
        if (id === shown[1] || id === shown[2]) continue;
        expect(seen, `${id} survived and must be listed`).toContain(id);
      }
      await s.close?.();
    }, 120_000);

    it('a cursor whose run was purged continues from where the list was', async () => {
      const s = await make();
      await seed(s.runs);
      const full = (await s.runs.listRuns({ limit: 1_000_000 })).items.map((r: RunSummary) => r.runId);
      const p1 = await s.runs.listRuns({ limit: 4 });
      await purgeRun(toJournal(s.runs), p1.items[3].runId);
      const p2 = await s.runs.listRuns({ limit: 4, cursor: p1.nextCursor });
      expect(p2.items.map((r: RunSummary) => r.runId)).toEqual(full.slice(4, 8));
      await s.close?.();
    });

    it('an organization\'s view walks a store it shares with others, page by page, and survives a purge', async () => {
      const s = await make();
      const root = toJournal(s.runs);
      const acme = withOrg(root, 'acme') as any;
      // acme's runs interleaved with the root's and another organization's, in creation order.
      for (let i = 0; i < 18; i++) {
        const id = `a${String(i).padStart(2, '0')}`;
        await acme.put(`${id}:model:0`, { text: 'x' });
        await root.put(`root-${i}:model:0`, { text: 'x' });
        if (i % 2) await (withOrg(root, 'globex') as any).put(`g${i}:model:0`, { text: 'x' });
      }
      const full = (await acme.listRunsPaged({ limit: 1_000_000 })).items.map((r: RunSummary) => r.runId);
      expect(full).toHaveLength(18);
      for (const limit of [1, 4, 7]) {
        const got: string[] = [];
        let cursor: string | undefined;
        do {
          const page = await acme.listRunsPaged({ limit, ...(cursor ? { cursor } : {}) });
          got.push(...page.items.map((r: RunSummary) => r.runId));
          cursor = page.nextCursor;
        } while (cursor);
        expect(got, `limit ${limit}`).toEqual(full);
      }
      // The run the cursor names is purged while the page is on screen: the next page starts right after it.
      const p1 = await acme.listRunsPaged({ limit: 4 });
      await purgeRun(acme, p1.items[3].runId);
      const p2 = await acme.listRunsPaged({ limit: 4, cursor: p1.nextCursor });
      expect(p2.items.map((r: RunSummary) => r.runId)).toEqual(full.slice(4, 8));
      await s.close?.();
    }, 120_000);

    it('a row-number cursor from 0.10 is refused, and says so', async () => {
      const s = await make();
      await seed(s.runs);
      await expect(s.runs.listRuns({ limit: 4, cursor: '4' })).rejects.toThrow(/0\.10 and earlier/);
      await expect(s.runs.listRuns({ limit: 4, cursor: 'zzz' })).rejects.toThrow(/not a run-list cursor/);
      await s.close?.();
    });
  });
}
