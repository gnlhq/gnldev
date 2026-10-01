// Invariant: "this id is in an organization's space" is ONE rule with ONE owner (@gnldev/durable's
// `isOrganizationKey` / `orgSpaceSql`, and `orgPrefix` for every `org:<id>:` built), and the root
// scope's run reader hides every organization's runs (ADR-0001), as its memory reader already did.
//
// Before: the rule was restated in eight places (`startsWith('org:')`, `LIKE 'org:%'`, two local
// `'org:'` constants) and the prefix was built by hand in seven. Two of the restatements had drifted:
//   - SQLite's adopt counted `ORG:x` as already scoped (LIKE ignores case) and never moved it;
//   - `purgeOrganization(journal, '')` swept `org::` and reported success — the id check lived in
//     `orgPrefix`, which the hand-built prefix skipped.
// And the root run reader (`listRuns`, `readRun`) returned `org:acme:r1` (inventory k1-runs-org.ts).
import { describe, it, expect } from 'vitest';
import * as durable from '../src/index.js';
import { InMemoryJournal, InMemoryStorage, withOrg, purgeOrganization, purgeOrganizationWork, type Storage } from '../src/index.js';
import { SqliteStorage } from '../src/sqlite-storage.js';

const withRootScope = (j: unknown) => (durable as unknown as { withRootScope: (j: unknown) => any }).withRootScope(j);

describe('the root scope\'s run reader hides every organization\'s runs', () => {
  async function seeded() {
    const root = new InMemoryJournal();
    const acme = withOrg(root as never, 'acme') as any;
    await acme.put('r1:input', { secret: 'ACME' });
    await acme.put('r1:model:0', { text: 'acme secret' });
    await root.put('r2:model:0', { text: 'root' });
    return root;
  }

  it('listRuns, listRunsPaged, readRun, readRunStats, get, getMany and listKeys answer as if acme\'s rows were not there', async () => {
    const view = withRootScope(await seeded());
    expect((await view.listRuns()).map((r: { runId: string }) => r.runId)).toEqual(['r2']);
    expect((await view.listRunsPaged({ limit: 10 })).items.map((r: { runId: string }) => r.runId)).toEqual(['r2']);
    expect(await view.readRun('org:acme:r1')).toEqual([]);
    expect(await view.readRunStats('org:acme:r1')).toEqual({ entries: 0, bytes: 0 });
    expect(await view.get('org:acme:r1:input')).toBeUndefined();
    expect(await view.getMany(['org:acme:r1:input', 'r2:model:0'])).toEqual([undefined, { text: 'root' }]);
    expect(await view.listKeys('')).toEqual(['r2:model:0']);
    expect(await view.listKeys('org:')).toEqual([]);
    // The store's count covers acme's run too, so the view does not answer with it.
    expect(await view.countRunsByStatus()).toBeUndefined();
  });

  it('CONTROL: with no organization rows, the store\'s cheap count is the root\'s and is kept', async () => {
    const root = new InMemoryJournal();
    await root.put('r2:model:0', { text: 'root' });
    expect(await withRootScope(root).countRunsByStatus()).toEqual(await root.countRunsByStatus());
  });

  it('a page is filled from past other organizations\' runs (no short page, no skipped run)', async () => {
    const root = new InMemoryJournal();
    for (let i = 0; i < 120; i++) await (withOrg(root as never, 'acme') as any).put(`a${String(i).padStart(3, '0')}:model:0`, { i });
    for (let i = 0; i < 5; i++) await root.put(`z${i}:model:0`, { i });
    const view = withRootScope(root);
    const seen: string[] = [];
    let cursor: string | undefined;
    do {
      const page = await view.listRunsPaged({ limit: 2, ...(cursor ? { cursor } : {}) });
      seen.push(...page.items.map((r: { runId: string }) => r.runId));
      cursor = page.nextCursor;
    } while (cursor);
    expect(seen.sort()).toEqual(['z0', 'z1', 'z2', 'z3', 'z4']);
  });

  it('WAY THROUGH: withOrg over the root view is acme\'s view (it scopes the journal underneath)', async () => {
    const view = withRootScope(await seeded());
    const acme = withOrg(view, 'acme') as any;
    expect((await acme.listRuns()).map((r: { runId: string }) => r.runId)).toEqual(['r1']);
    expect(await acme.get('r1:input')).toEqual({ secret: 'ACME' });
  });

  it('writes pass through unchanged — the view hides, it does not refuse', async () => {
    const root = await seeded();
    const view = withRootScope(root);
    await view.put('r3:model:0', { ok: 1 });
    expect(await root.get('r3:model:0')).toEqual({ ok: 1 });
  });
});

describe('one owner for the organization-space rule', () => {
  it('isOrganizationKey and orgSpaceSql are exported, and agree with each other on SQLite', async () => {
    const { isOrganizationKey, orgSpaceSql } = durable as unknown as {
      isOrganizationKey: (id: string) => boolean;
      orgSpaceSql: (col: string, ph: () => string, o?: { orgId?: string; outside?: boolean }) => { cond: string; params: unknown[] };
    };
    const s = new SqliteStorage(':memory:');
    const db = (s as unknown as { db: { prepare(sql: string): { all(...a: unknown[]): Array<{ k: string }> } ; exec(sql: string): void } }).db;
    db.exec('CREATE TABLE t (k TEXT)');
    const keys = ['org:acme:x', 'ORG:acme:x', 'org:🚀team:x', 'orgnotes', 'org', 'Org:y', 'org:'];
    for (const k of keys) (db.prepare('INSERT INTO t (k) VALUES (?)') as unknown as { run(k: string): void }).run(k);
    const inside = orgSpaceSql('k', () => '?');
    const sqlInside = db.prepare(`SELECT k FROM t WHERE ${inside.cond} ORDER BY k`).all(...inside.params).map((r) => r.k);
    expect(sqlInside).toEqual(keys.filter(isOrganizationKey).sort());
    const outside = orgSpaceSql('k', () => '?', { outside: true });
    const sqlOutside = db.prepare(`SELECT k FROM t WHERE ${outside.cond} ORDER BY k`).all(...outside.params).map((r) => r.k);
    expect(sqlOutside).toEqual(keys.filter((k) => !isOrganizationKey(k)).sort());
    const astral = orgSpaceSql('k', () => '?', { orgId: '🚀team' });
    expect(db.prepare(`SELECT k FROM t WHERE ${astral.cond}`).all(...astral.params).map((r) => r.k)).toEqual(['org:🚀team:x']);
  });

  it('SQLite adoptIntoOrg moves a root key spelled ORG:… (LIKE ignored case and counted it as already scoped)', async () => {
    const s = new SqliteStorage(':memory:');
    await s.runs.put('ORG:legacy:model:0', { v: 1 });
    await s.runs.put('plain:model:0', { v: 2 });
    const r = await s.adoptIntoOrg!('acme', { allowUnregistered: true });
    expect(await s.runs.get('org:acme:ORG:legacy:model:0')).toEqual({ v: 1 });
    expect(await s.runs.get('ORG:legacy:model:0')).toBeUndefined();
    expect(r.alreadyScoped).toBe(0);
  });

  it.each([
    ['purgeOrganization', (s: Storage, id: string) => purgeOrganization(durable.toJournal(s.runs), id)],
    ['purgeOrganizationWork', (s: Storage, id: string) => purgeOrganizationWork(s.work!, id)],
  ])("%s(store, '') is refused instead of sweeping 'org::'", async (_n, purge) => {
    const s = new InMemoryStorage();
    await expect(purge(s, '')).rejects.toThrow(/invalid orgId ''/);
  });
});
