// A deleted thread leaves no record naming its owner.
//
// `MemoryStore.deleteThread` soft-deleted the thread record: it kept the row with `resource_id` and the
// thread's id, and a `deleted_at`. Nothing read it — `getThread`, `listThreads` and `recall` all skip a
// deleted row — so after `eraseSubject('ayse')` the one thing left of her in the store was that row,
// naming her (measured on InMemory, Sqlite and Postgres — c-erasure CE-3). The record now goes with the
// rest of the thread.
//
// Siblings: the same through `eraseSubject` (the erasure door), and a thread id reused after the delete
// starts empty — no batch marker of the old thread answers the new one's append.
//
// Postgres runs when GNL_PG_URL is set.
import { describe, it, expect, afterAll } from 'vitest';
import { InMemoryStorage, eraseSubject, purgeThread, toJournal, type Storage } from '../src/index.js';
import { SqliteStorage } from '../src/sqlite-storage.js';
import { PostgresStorage } from '../src/postgres-storage.js';

const PG_URL = process.env.GNL_PG_URL;
const ends: Array<() => Promise<unknown>> = [];
afterAll(async () => { for (const e of ends.reverse()) await e(); });

/** Every thread row the store holds, deleted or not, as `id/resource`. */
type Rows = () => Promise<string[]>;
const STORES: Array<[string, () => Promise<{ s: Storage; threadRows: Rows }>]> = [
  ['in-memory', async () => {
    const s = new InMemoryStorage();
    return { s, threadRows: async () => [...((s.memory as any).threads as Map<string, any>).values()].map((t) => `${t.id}/${t.resourceId}`) };
  }],
  ['sqlite', async () => {
    const s = new SqliteStorage(':memory:');
    return { s: s as unknown as Storage, threadRows: async () => ((s as any).db.prepare('SELECT id, resource_id FROM gnl_threads').all() as any[]).map((r) => `${r.id}/${r.resource_id}`) };
  }],
];
if (PG_URL) {
  STORES.push(['postgres (real)', async () => {
    const s = new PostgresStorage({ connectionString: PG_URL });
    await s.init();
    ends.push(() => s.close());
    return { s: s as unknown as Storage, threadRows: async () => ((await (s as any).pool.query('SELECT id, resource_id FROM gnl_threads')).rows as any[]).map((r) => `${r.id}/${r.resource_id}`) };
  }]);
}
const unique = () => `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;

async function threadOf(s: Storage, id: string, who: string): Promise<void> {
  await s.memory!.upsertThread({ id, resourceId: who, title: `ayse's first message`, createdAt: 1, updatedAt: 1 });
  await s.memory!.appendMessagesOnce!(id, [{ threadId: id, role: 'user', text: 'hi', ts: 1, message: { role: 'user', content: 'hi' } }], `b-${id}`);
}

describe.each(STORES)('a deleted thread keeps no record naming its owner — %s', (_name, make) => {
  it('MemoryStore.deleteThread through purgeThread: no row of the thread, no row naming her', async () => {
    const { s, threadRows } = await make();
    const id = unique();
    const who = `ayse-${id}`;
    await threadOf(s, `T-${id}`, who);
    await purgeThread(toJournal(s.runs), `T-${id}`, { memory: s.memory! });
    expect((await threadRows()).filter((r) => r.includes(id))).toEqual([]);
    expect(await s.memory!.getThread(`T-${id}`)).toBeUndefined();
  });

  it('sibling: eraseSubject leaves no thread row naming her', async () => {
    const { s, threadRows } = await make();
    const id = unique();
    const who = `ayse-${id}`;
    await threadOf(s, `T-${id}`, who);
    await toJournal(s.runs).put(`thread:T-${id}:owner`, { resourceId: who });
    await eraseSubject(s, who);
    expect((await threadRows()).filter((r) => r.includes(id))).toEqual([]);
  });

  it('sibling: the id reused after the delete starts empty, and its first batch is not answered as already applied', async () => {
    const { s } = await make();
    const id = unique();
    await threadOf(s, `T-${id}`, `ayse-${id}`);
    await s.memory!.deleteThread(`T-${id}`);
    await s.memory!.upsertThread({ id: `T-${id}`, resourceId: `bob-${id}`, createdAt: 2, updatedAt: 2 });
    expect(await s.memory!.getThread(`T-${id}`)).toMatchObject({ resourceId: `bob-${id}` });
    expect((await s.memory!.getMessages(`T-${id}`)).items).toEqual([]);
    expect(await s.memory!.appendMessagesOnce!(`T-${id}`, [{ threadId: `T-${id}`, role: 'user', text: 'x', ts: 2, message: { role: 'user', content: 'x' } }], `b-T-${id}`)).toBe(true);
  });
});
