// An organization's run list reads its own slice of the run id's index, not the whole store.
//
// `withOrg` answered by walking the store's run pages and keeping its own: an organization with few
// runs on a large store paid for reading everyone else's. Measured on Sqlite: an empty organization's
// first page read 400 pages of 20 000 root runs (81 ms) and 4 000 pages of 200 000 (661 ms) — linear in
// the store, on every new thread's first-contact probe and every unfiltered organization list. It now
// passes `runIdPrefix` (`org:<id>:`), which Sqlite and Postgres read as a range of the run id.
import { describe, it, expect, afterAll } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import pg from 'pg';
import { SqliteStorage } from '../src/sqlite-storage.js';
import { PostgresStorage } from '../src/postgres-storage.js';
import { mysqlStores, mongoStores } from './real-backends.js';
import { InMemoryStorage, toJournal, withOrg, ORG_RECORD_PRE, stampFormat, type Storage } from '../src/index.js';

const PG_URL = process.env.GNL_PG_URL;
const ends: Array<() => Promise<unknown> | unknown> = [];
afterAll(async () => { for (const e of ends.reverse()) await e(); });

const STORES: Array<[string, () => Promise<Storage>]> = [
  ['InMemory', async () => new InMemoryStorage()],
  ['Sqlite', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'gnl-org-range-'));
    const s = new SqliteStorage(join(dir, 's.db'));
    ends.push(() => { s.close?.(); rmSync(dir, { recursive: true, force: true }); });
    return s;
  }],
];
if (PG_URL) {
  STORES.push(['Postgres (real)', async () => {
    const admin = new pg.Pool({ connectionString: PG_URL, max: 1 });
    const db = `gnl_org_range_${process.pid}_${Date.now().toString(36)}`;
    await admin.query(`CREATE DATABASE ${db}`);
    const u = new URL(PG_URL); u.pathname = `/${db}`;
    const s = new PostgresStorage({ connectionString: u.toString() });
    ends.push(async () => { await s.close(); await admin.query(`DROP DATABASE IF EXISTS ${db} WITH (FORCE)`); await admin.end(); });
    return s;
  }]);
}

for (const [name, make] of [...mysqlStores(' (real)'), ...mongoStores(' (real)')]) STORES.push([name, async () => { const s = await make(); ends.push(() => s.close()); return s; }]);

describe.each(STORES)('an organization\'s run list on a large store — %s', (name, make) => {
  it('reads a bounded number of the store\'s pages, and answers exactly', async () => {
    const s = await make();
    const j = toJournal(s.runs);
    for (let i = 0; i < 5000; i++) await j.put(`root-${String(i).padStart(5, '0')}:input`, stampFormat({ at: i, resourceId: 'u' }));
    await j.put(ORG_RECORD_PRE + 'beta', { label: 'beta' });
    const beta = withOrg(j, 'beta') as ReturnType<typeof withOrg> & { listRunsPaged: NonNullable<ReturnType<typeof withOrg>['listRunsPaged']> };
    let reads = 0;
    const inner = s.runs as unknown as { listRuns: (q: unknown) => Promise<unknown> };
    const listRuns = inner.listRuns.bind(s.runs);
    inner.listRuns = (q) => { reads++; return listRuns(q); };

    expect((await beta.listRunsPaged({ limit: 1 })).items).toEqual([]);
    const emptyReads = reads;
    await beta.put('b1:input', stampFormat({ at: 1, resourceId: 'x' }));
    reads = 0;
    expect((await beta.listRunsPaged({ limit: 5 })).items.map((r) => r.runId)).toEqual(['b1']);
    const oneReads = reads;
    if (name !== 'InMemory') {                       // InMemory filters in memory: its "pages" are not reads
      expect(emptyReads).toBeLessThanOrEqual(2);
      expect(oneReads).toBeLessThanOrEqual(2);
    }
    // The root sees no organization run; the organization sees none of the root's.
    reads = 0;
    expect((await beta.listRunsPaged({ limit: 50, resourceId: 'u' })).items).toEqual([]);
  }, 120_000);
});
