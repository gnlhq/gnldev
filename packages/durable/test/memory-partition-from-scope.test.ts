// Invariant (ADR-0001): in the root scope, every organization's rows are hidden — and WHICH scope a
// memory read is in comes from the store object the caller holds, never from a string it passes.
//
// The first fix took the partition of a resource-scoped recall from the anchor thread id
// (`recallPartition(threadId)`): an id under `org:acme:` ranked acme's threads. A thread id is chosen
// by the client, so a root caller who named its thread `org:acme:fresh` recalled acme's rows
// (measured through REST: acme's secret in the root user's prompt), and the root store's
// `listThreads({ resourceId })` listed `org:acme:*` threads outright.
//
// Now the root store's scans — resource recall and thread listing — cover the root's rows only, and an
// organization's view asks for its own partition through a code-only option (a Symbol key, which no
// request body can carry).
import { describe, it, expect } from 'vitest';
import { newDb, DataType } from 'pg-mem';
import { InMemoryStorage, withOrgStorage, type Storage, type MemoryStore } from '../src/index.js';
import { SqliteStorage } from '../src/sqlite-storage.js';
import { PostgresStorage } from '../src/postgres-storage.js';

const engines: [string, () => Promise<Storage>][] = [
  ['InMemoryStorage', async () => new InMemoryStorage()],
  ['SqliteStorage', async () => new SqliteStorage(':memory:') as unknown as Storage],
  // pg-mem has no advisory locks, so the adapter withdraws its memory port there. These tests append
  // one message at a time, so a no-op lock is enough to run the adapter's SQL for listing and recall.
  ['PostgresStorage (pg-mem, no-op append lock)', async () => {
    const db = newDb();
    db.public.registerFunction({ name: 'pg_advisory_xact_lock', args: [DataType.integer, DataType.integer], returns: DataType.integer, implementation: () => 0 });
    const s = new PostgresStorage({ pool: new (db.adapters.createPg().Pool)() });
    await s.init();
    (s as unknown as { advisoryLocks: boolean }).advisoryLocks = true;
    return s as unknown as Storage;
  }],
];

const E = [1, 0, 0];
async function seed(mem: MemoryStore, id: string, resourceId: string, text: string) {
  await mem.upsertThread({ id, resourceId, createdAt: 1, updatedAt: 1 });
  await mem.appendMessages(id, [{ threadId: id, role: 'user', text, message: { role: 'user', content: text }, embedding: E, ts: 1 }]);
}
const texts = (rows: { text?: string }[]) => rows.map((r) => String(r.text)).sort();
const ids = (rows: { id: string }[]) => rows.map((r) => r.id).sort();

describe.each(engines)('the memory partition comes from the scope (%s)', (_n, make) => {
  it('the root store lists no organization thread, with or without a resource id', async () => {
    const storage = await make();
    await seed(withOrgStorage(storage, 'acme').memory!, 't-acme', 'u-shared', 'ACME');
    await seed(storage.memory!, 't-root', 'u-shared', 'ROOT');
    expect(ids((await storage.memory!.listThreads({ resourceId: 'u-shared' })).items)).toEqual(['t-root']);
    expect(ids((await storage.memory!.listThreads({})).items)).toEqual(['t-root']);
  });

  it("a root recall anchored on an id that LOOKS like acme's ('org:acme:fresh') ranks only root rows", async () => {
    const storage = await make();
    await seed(withOrgStorage(storage, 'acme').memory!, 't-acme', 'u-shared', 'ACME');
    await seed(storage.memory!, 't-root', 'u-shared', 'ROOT');
    for (const anchor of ['org:acme:fresh', 'org:acme:t-acme', 'org:', 'org:x', 't-root']) {
      const got = await storage.memory!.recall(anchor, E, { scope: 'resource', resourceId: 'u-shared', topK: 10 });
      expect(texts(got)).toEqual(['ROOT']);
    }
  });

  it('an organization lists and recalls its own threads, and neither the root\'s nor another organization\'s', async () => {
    const storage = await make();
    const acme = withOrgStorage(storage, 'acme').memory!;
    const globex = withOrgStorage(storage, 'globex').memory!;
    await seed(acme, 't-1', 'u-shared', 'ACME');
    await seed(globex, 't-1', 'u-shared', 'GLOBEX');
    await seed(storage.memory!, 't-1', 'u-shared', 'ROOT');
    expect(ids((await acme.listThreads({ resourceId: 'u-shared' })).items)).toEqual(['t-1']);
    expect(texts(await acme.recall('t-1', E, { scope: 'resource', resourceId: 'u-shared', topK: 10 }))).toEqual(['ACME']);
    expect(texts(await globex.recall('anything', E, { scope: 'resource', resourceId: 'u-shared', topK: 10 }))).toEqual(['GLOBEX']);
  });

  it('an organization whose id is a prefix of another\'s (acme / acme2) does not reach it', async () => {
    const storage = await make();
    await seed(withOrgStorage(storage, 'acme2').memory!, 't-1', 'u', 'ACME2');
    const acme = withOrgStorage(storage, 'acme').memory!;
    await seed(acme, 't-1', 'u', 'ACME');
    expect(ids((await acme.listThreads({})).items)).toEqual(['t-1']);
    expect(texts(await acme.recall('t-1', E, { scope: 'resource', resourceId: 'u', topK: 10 }))).toEqual(['ACME']);
  });

  it('an organization\'s thread list pages cleanly when other scopes hold many more threads', async () => {
    const storage = await make();
    for (let i = 0; i < 12; i++) await seed(storage.memory!, `r-${i}`, 'u', 'ROOT');
    const acme = withOrgStorage(storage, 'acme').memory!;
    for (let i = 0; i < 5; i++) await seed(acme, `a-${i}`, 'u', 'ACME');
    const seen: string[] = [];
    let cursor: string | undefined;
    do {
      const page = await acme.listThreads({ limit: 2, ...(cursor !== undefined ? { cursor } : {}) });
      seen.push(...page.items.map((t) => t.id));
      cursor = page.nextCursor;
    } while (cursor !== undefined);
    expect(seen.sort()).toEqual(['a-0', 'a-1', 'a-2', 'a-3', 'a-4']);
  });
});
