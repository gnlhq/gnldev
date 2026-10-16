// Every run listing resumes right after the last run it handed out, keyed on (created_at, run_id) —
// the CHANGELOG's promise "on every store". Sqlite and Postgres kept it; the listings that page an
// ARRAY did not (audit AR-3): the in-memory store, an organization's view (it walks its source page
// by page), a legacy array reader bridged by `asReaderJournal`, and the Studio and server lists built
// from `listRuns()`. They placed the cursor by its run, then by the run after it, and when both were
// gone by a COUNT of runs handed out so far — so purging the cursor's run, the next one and one already
// shown skipped survivors, and new runs arriving made a run repeat.
//
// An array has no position to seek without each run's creation time. Every first-party summary now
// carries it (`RunSummary.createdAt`), and an array reader pages by the same key the tables do.
// Stores: InMemory, Sqlite; with GNL_PG_URL also a real Postgres (pg-mem cannot compare rows), one
// schema per store in that database, dropped at the end.
import { describe, it, expect, afterAll } from 'vitest';
import pg from 'pg';
import {
  InMemoryStorage, InMemoryJournal, toJournal, withOrg, purgeRun, asReaderJournal, pageRunsFromArray, type RunSummary,
} from '../src/index.js';
import { SqliteStorage } from '../src/sqlite-storage.js';
import { PostgresStorage } from '../src/postgres-storage.js';

const PG_URL = process.env.GNL_PG_URL;
const ends: Array<() => Promise<void> | void> = [];
afterAll(async () => { for (const e of ends.reverse()) await e(); });

/**
 * A listing under test: `list` pages it, `journal` writes and purges in the same scope, and `others`
 * (an organization's view only) writes a run of another scope beside each of its own.
 */
interface Listing { list(q: Record<string, unknown>): Promise<{ items: RunSummary[]; nextCursor?: string }>; journal: any; others?: any }

let seq = 0;
async function realPg(): Promise<PostgresStorage> {
  const schema = `arraycursor_${process.pid}_${Date.now().toString(36)}_${seq++}`;
  const admin = new pg.Pool({ connectionString: PG_URL, max: 1 });
  const pool = new pg.Pool({ connectionString: PG_URL, max: 4, options: `-c search_path=${schema}` });
  for (const p of [admin, pool]) p.on('error', () => {});
  await admin.query(`CREATE SCHEMA ${schema}`);
  ends.push(async () => { await pool.end().catch(() => {}); await admin.query(`DROP SCHEMA ${schema} CASCADE`); await admin.end(); });
  return new PostgresStorage({ pool });
}

/** An organization's view over a store it shares: acme's runs interleaved with the root's. */
function orgView(storage: { runs: unknown }): Listing {
  const root = toJournal(storage.runs as never);
  const acme = withOrg(root, 'acme') as any;
  return { journal: acme, others: root, list: (q) => acme.listRunsPaged(q) };
}

const LISTINGS: Array<[string, () => Promise<Listing>]> = [
  ['InMemoryStorage', async () => {
    const s = new InMemoryStorage();
    return { journal: toJournal(s.runs), list: (q) => s.runs.listRuns(q) };
  }],
  ['InMemoryJournal', async () => {
    const j = new InMemoryJournal();
    return { journal: j, list: (q) => j.listRunsPaged(q) };
  }],
  ['an array reader bridged by asReaderJournal', async () => {
    const j = new InMemoryJournal();
    const legacy = asReaderJournal({ listRuns: () => j.listRuns() }) as any;
    return { journal: j, list: (q) => legacy.listRunsPaged(q) };
  }],
  ['the Studio list (pageRunsFromArray over listRuns, as studio/src/server.ts calls it)', async () => {
    const j = new InMemoryJournal();
    return { journal: j, list: async (q) => pageRunsFromArray(await j.listRuns(), q) };
  }],
  ['withOrg over InMemory', async () => orgView(new InMemoryStorage())],
  ['withOrg over Sqlite', async () => orgView(new SqliteStorage(':memory:'))],
  ...(PG_URL ? [['withOrg over Postgres (real)', async () => orgView(await realPg())] as [string, () => Promise<Listing>]] : []),
];

async function seed(l: Listing, ids: string[]): Promise<void> {
  for (const id of ids) {
    await l.journal.put(`${id}:model:0`, { text: 'x' });
    // A root run after each of the view's own, so an organization's view walks a mixed source.
    await l.others?.put(`root-${id}:model:0`, { text: 'x' });
  }
}

async function rest(l: Listing, q: Record<string, unknown>, cursor: string | undefined): Promise<string[]> {
  const out: string[] = [];
  for (let guard = 0; cursor && guard < 100; guard++) {
    const page = await l.list({ ...q, cursor });
    out.push(...page.items.map((r) => r.runId));
    cursor = page.nextCursor;
  }
  return out;
}

const IDS = ['d0', 'd1', 'd2', 'd3', 'd4', 'd5', 'd6', 'd7', 'd8', 'd9'];

for (const [name, make] of LISTINGS) {
  describe(`an array run list resumes after its last run — ${name}`, () => {
    for (const order of ['asc', 'desc'] as const) {
      it(`${order}: the cursor's run, the next one and one already shown are purged — no survivor is skipped`, async () => {
        const l = await make();
        await seed(l, IDS);
        const q = { order, limit: 4 };
        const before = (await l.list({ order, limit: 1000 })).items.map((r) => r.runId);
        const p1 = await l.list(q);
        const shown = p1.items.map((r) => r.runId);
        const gone = [shown[3]!, before[4]!, shown[0]!];
        for (const id of gone) await purgeRun(l.journal, id);
        expect(await rest(l, q, p1.nextCursor)).toEqual(before.slice(5));
      });

      it(`${order}: the cursor's run and the next one are purged while new runs arrive — no run repeats, none is skipped`, async () => {
        const l = await make();
        await seed(l, IDS);
        const q = { order, limit: 4 };
        const before = (await l.list({ order, limit: 1000 })).items.map((r) => r.runId);
        const p1 = await l.list(q);
        const shown = p1.items.map((r) => r.runId);
        for (const id of [shown[3]!, before[4]!]) await purgeRun(l.journal, id);
        await seed(l, ['n1', 'n2']);
        const after = await rest(l, q, p1.nextCursor);
        const seen = [...shown, ...after];
        expect(seen.filter((id, i) => seen.indexOf(id) !== i), 'repeated').toEqual([]);
        expect(after.filter((id) => IDS.includes(id))).toEqual(before.slice(5));
        // New runs are created after every run listed: an ascending walk ends with them, a descending one
        // started past them.
        expect(after.filter((id) => !IDS.includes(id))).toEqual(order === 'asc' ? ['n1', 'n2'] : []);
      });
    }

    it('every summary says when its run was created, and the list is in that order', async () => {
      const l = await make();
      await seed(l, IDS);
      const items = (await l.list({ limit: 1000 })).items;
      expect(items.map((r) => r.runId)).toEqual(IDS);
      for (const r of items) expect(typeof r.createdAt, r.runId).toBe('number');
      for (let i = 1; i < items.length; i++) expect(items[i]!.createdAt!).toBeGreaterThanOrEqual(items[i - 1]!.createdAt!);
    });
  });
}

describe('an array reader whose summaries carry no creation time', () => {
  // A custom reader may not keep one. It is placed by the cursor's run, then by the next one, as before —
  // the most an array without a position can do — and pages through an unchanged list exactly.
  it('still pages an unchanged list exactly, both orders', async () => {
    const all: RunSummary[] = IDS.map((runId) => ({ runId, status: 'completed', modelSteps: 1, toolCalls: 0 }));
    for (const order of ['asc', 'desc'] as const) {
      const got: string[] = [];
      let cursor: string | undefined;
      do {
        const page = pageRunsFromArray(all, { order, limit: 3, ...(cursor ? { cursor } : {}) });
        got.push(...page.items.map((r) => r.runId));
        cursor = page.nextCursor;
      } while (cursor);
      expect(got).toEqual(order === 'asc' ? IDS : [...IDS].reverse());
    }
  });
});
