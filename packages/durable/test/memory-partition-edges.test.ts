// Invariant: an organization's view lists and recalls exactly its own threads — whatever characters its
// id holds, and whatever sits between the view and the store — and the root's erasure says when it
// could not reach a thread of the person's.
//
// Three edges the review panel measured (review2-A m-partition.test.ts):
//   - "outside the BMP": the partition condition wrote the prefix's JS length (UTF-16 code units) into
//     SQL `substring`, which counts code points. For `🚀team` the prefix `org:🚀team:` is 11 units and
//     10 code points, so SQLite and Postgres compared 11 characters against a 10-character prefix and
//     the organization listed and recalled NOTHING of its own;
//   - "pass-through": a wrapper store that rebuilds the options (logging, metrics, RPC) drops the
//     Symbol-keyed `MEMORY_PARTITION`, the store scans the root, and the organization's view comes back
//     empty — no error, no warning;
//   - "0.9 root thread": 0.9 let the root name a thread `org:…`; such a thread is now unreachable from
//     the root, and the root erasure of its owner said nothing about it.
import { describe, it, expect, vi, afterEach } from 'vitest';
import { newDb, DataType } from 'pg-mem';
import { InMemoryStorage, withOrgStorage, eraseSubject, type Storage, type MemoryStore } from '../src/index.js';
import { SqliteStorage } from '../src/sqlite-storage.js';
import { PostgresStorage } from '../src/postgres-storage.js';

const engines: [string, () => Promise<Storage>][] = [
  ['InMemoryStorage', async () => new InMemoryStorage()],
  ['SqliteStorage', async () => new SqliteStorage(':memory:') as unknown as Storage],
  ['PostgresStorage (pg-mem, no-op append lock)', async () => {
    const db = newDb();
    db.public.registerFunction({ name: 'pg_advisory_xact_lock', args: [DataType.integer, DataType.integer], returns: DataType.integer, implementation: () => 0 });
    const s = new PostgresStorage({ pool: new (db.adapters.createPg().Pool)() });
    await s.init();
    (s as unknown as { advisoryLocks: boolean }).advisoryLocks = true;
    return s as unknown as Storage;
  }],
];
if (process.env.GNL_PG_URL) {
  engines.push(['PostgresStorage (real)', async () => {
    const s = new PostgresStorage({ connectionString: process.env.GNL_PG_URL! });
    await s.init();
    return s as unknown as Storage;
  }]);
}

const E = [1, 0, 0];
async function seed(mem: MemoryStore, id: string, resourceId: string, text: string) {
  await mem.upsertThread({ id, resourceId, createdAt: 1, updatedAt: 1 });
  await mem.appendMessages(id, [{ threadId: id, role: 'user', text, message: { role: 'user', content: text }, embedding: E, ts: 1 }]);
}
const RUN = Date.now().toString(36);

afterEach(() => { vi.restoreAllMocks(); });

describe.each(engines)('memory partition edges (%s)', (_n, make) => {
  it('an organization id outside the BMP (or with LIKE wildcards) lists and recalls exactly its own threads', async () => {
    const s = await make();
    // pg-mem is a JS emulation whose `substring` counts UTF-16 code units, unlike every real engine —
    // the characters outside the BMP are covered on SQLite and the real Postgres instead.
    const bases = _n.includes('pg-mem') ? ['acme', 'café', '50%_off'] : ['acme', 'café', '🚀team', '𠀀x', '50%_off'];
    for (const base of bases) {
      const org = `${base}-${RUN}`;
      const v = withOrgStorage(s, org).memory!;
      await seed(v, 't', `u-${RUN}`, `OWN-${org}`);
      const listed = (await v.listThreads({ resourceId: `u-${RUN}` })).items.map((t) => t.id);
      const recalled = (await v.recall('t', E, { scope: 'resource', resourceId: `u-${RUN}`, topK: 10 })).map((m) => m.text);
      expect([org, listed, recalled]).toEqual([org, ['t'], [`OWN-${org}`]]);
    }
  });

  it('deleting a non-ASCII organization\'s memory partition leaves none of its rows, and no other organization\'s', async () => {
    const s = await make();
    if (!s.memory?.deletePartition) return;
    const org = `café-del-${RUN}`;
    const other = `cafe-del-${RUN}`;
    await seed(withOrgStorage(s, org).memory!, 't', `u-${RUN}`, `OWN-${org}`);
    await seed(withOrgStorage(s, other).memory!, 't', `u-${RUN}`, `OWN-${other}`);
    const removed = await s.memory.deletePartition(`org:${org}:`);
    const left = (await withOrgStorage(s, org).memory!.listThreads({ resourceId: `u-${RUN}` })).items.map((t) => t.id);
    const kept = (await withOrgStorage(s, other).memory!.listThreads({ resourceId: `u-${RUN}` })).items.map((t) => t.id);
    expect({ removedSome: removed > 0, left, kept }).toEqual({ removedSome: true, left: [], kept: ['t'] });
  });

  it('a pass-through wrapper that drops MEMORY_PARTITION is reported once, naming the fix', async () => {
    const s = await make();
    await seed(withOrgStorage(s, `wrap-${RUN}`).memory!, 't-a', `u-${RUN}`, 'ACME-OWN');
    const inner = s.memory!;
    const wrapped: MemoryStore = {
      ...Object.fromEntries(['upsertThread', 'getThread', 'deleteThread', 'appendMessages', 'getMessages', 'getWorkingMemory', 'setWorkingMemory', 'deleteWorkingMemory', 'getObservations', 'putObservations']
        .map((k) => [k, (inner as any)[k].bind(inner)])),
      // Rebuilt options: the Symbol-keyed partition does not survive.
      listThreads: (q: any) => inner.listThreads({ resourceId: q.resourceId, limit: q.limit, cursor: q.cursor }),
      recall: (t: string, e: number[], o: any) => inner.recall(t, e, JSON.parse(JSON.stringify(o))),
    } as MemoryStore;
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const v = withOrgStorage({ ...s, memory: wrapped } as Storage, `wrap-${RUN}`).memory!;
    await v.listThreads({ resourceId: `u-${RUN}` });
    await v.recall('t-a', E, { scope: 'resource', resourceId: `u-${RUN}`, topK: 5 });
    await v.listThreads({ resourceId: `u-${RUN}` });
    const said = warn.mock.calls.map((c) => String(c[0])).filter((m) => m.includes('MEMORY_PARTITION'));
    expect(said).toHaveLength(1);
    expect(said[0]).toMatch(/forward/);
  });

  it('CONTROL: a wrapper that forwards the options ({ ...q }) is silent and sees the organization\'s rows', async () => {
    const s = await make();
    await seed(withOrgStorage(s, `fwd-${RUN}`).memory!, 't-a', `u-${RUN}`, 'ACME-OWN');
    const inner = s.memory!;
    const wrapped = Object.assign(Object.create(inner), {
      listThreads: (q: any) => inner.listThreads({ ...q }),
      recall: (t: string, e: number[], o: any) => inner.recall(t, e, { ...o }),
    }) as MemoryStore;
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const v = withOrgStorage({ ...s, memory: wrapped } as Storage, `fwd-${RUN}`).memory!;
    expect((await v.listThreads({ resourceId: `u-${RUN}` })).items.map((t) => t.id)).toEqual(['t-a']);
    expect((await v.recall('t-a', E, { scope: 'resource', resourceId: `u-${RUN}`, topK: 5 })).map((m) => m.text)).toEqual(['ACME-OWN']);
    expect(warn.mock.calls.filter((c) => String(c[0]).includes('MEMORY_PARTITION'))).toEqual([]);
  });

  it('a 0.9 root thread named org:…: the root erasure deletes the certain one and lists the undecided one in unreachedThreads', async () => {
    const s = await make();
    const who = `u09-${RUN}`;
    // What 0.9's root AgentMemory wrote for these ids (no check then). `org:123` is no organization's
    // shape at all; `org:acme:support` is acme's shape.
    await seed(s.memory!, `org:123-${RUN}`, who, 'ROOT-PRIVATE-1');
    await seed(s.memory!, `org:acme-${RUN}:support`, who, 'ROOT-PRIVATE-2');
    await seed(s.memory!, `mine-${RUN}`, who, 'ROOT-OWN');
    const report = await eraseSubject(s, who);
    // `mine` and `org:123` (no organization can produce that id); `support` may be acme's: not deleted, named.
    expect(report.memoryThreads).toBe(2);
    expect(report.unreachedThreads).toEqual([`org:acme-${RUN}:support`]);
    expect(await s.memory!.getThread(`org:123-${RUN}`)).toBeUndefined();
    expect(await s.memory!.getThread(`org:acme-${RUN}:support`)).toBeDefined();
  });
});
