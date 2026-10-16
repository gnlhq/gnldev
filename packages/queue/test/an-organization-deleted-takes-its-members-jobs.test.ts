// An organization's deletion takes its own and its members' jobs — the records, their markers and locks.
//
// Owned jobs live in the ROOT work log under their owner's name (`~o~<org>:<user>:…`), outside the
// organization's partition, and what the queue keeps of them (markers, `qown`, lease locks) is in its own
// format. `purgeOrganization` used to reach none of it (c-erasure CE-1); now the plan deletes the owned
// records by the organization's prefix and hands the queue's eraser the organization
// (`jobEraser(storage).eraseOrganization`).
//
// Siblings: on Sqlite as in memory; another organization's (`acme2`, a prefix-sharing id) and the root's
// jobs stay; an eraser that cannot erase an organization is refused before anything is deleted.
import { describe, it, expect } from 'vitest';
import { InMemoryStorage, purgeOrganization, toJournal, type Storage } from '@gnldev/durable';
import { SqliteStorage } from '@gnldev/durable/sqlite';
import { enqueue, createWorker, jobEraser } from '../src/index.js';

/** Every work-store key and log id, and every root journal key, as text. */
async function everything(storage: Storage): Promise<string[]> {
  const out: string[] = [];
  const db = (storage as any).db;
  if (db) {
    for (const r of db.prepare('SELECT ns, id FROM gnl_work_log').all()) out.push(`log ${r.ns} ${r.id}`);
    for (const r of db.prepare('SELECT key FROM gnl_work_kv').all()) out.push(`kv ${r.key}`);
  } else {
    const w = storage.work as any;
    for (const [ns, recs] of w.logs as Map<string, any[]>) for (const r of recs) out.push(`log ${ns} ${r.id}`);
    for (const k of (w.kv as Map<string, unknown>).keys()) out.push(`kv ${k}`);
  }
  for (const k of await toJournal(storage.runs).listKeys!('')) out.push(`j ${k}`);
  return out;
}

const stores: Array<[string, () => Storage]> = [
  ['in-memory', () => new InMemoryStorage()],
  ['sqlite', () => new SqliteStorage(':memory:') as unknown as Storage],
];

describe.each(stores)('purgeOrganization and the queue — %s', (_name, make) => {
  async function seed(storage: Storage) {
    for (const owner of [{ orgId: 'acme', resourceId: 'ayse' }, { orgId: 'acme' }, { orgId: 'acme2', resourceId: 'ayse' }, { resourceId: 'ayse' }]) {
      await enqueue(storage.work!, 't', { who: JSON.stringify(owner) }, owner);
    }
    await createWorker(storage, { t: async () => {} }).drain(); // markers and locks, as a worker leaves them
  }

  it("takes every job owned under acme, its members' too, and leaves acme2's and the root's", async () => {
    const storage = make();
    await seed(storage);
    const before = await everything(storage);
    expect(before.some((x) => x.includes('~o~acme:'))).toBe(true);
    const report = await purgeOrganization(storage, 'acme', { erasers: [jobEraser(storage)] });
    const after = await everything(storage);
    expect(after.filter((x) => x.includes('~o~acme:'))).toEqual([]);
    expect(before.filter((x) => x.includes('~o~acme2:') || x.includes('~o~:ayse:')).filter((x) => !after.includes(x))).toEqual([]);
    expect(report.byEraser.jobs ?? 0).toBeGreaterThan(0);
  });

  it('sibling: an eraser without eraseOrganization is refused, and nothing is deleted', async () => {
    const storage = make();
    await seed(storage);
    const before = await everything(storage);
    const personOnly = { name: 'tickets', erase: async () => 0 };
    await expect(purgeOrganization(storage, 'acme', { erasers: [jobEraser(storage), personOnly] })).rejects.toThrow(/'tickets' cannot erase an organization/);
    expect((await everything(storage)).sort()).toEqual(before.sort());
  });
});
