// A thread's owner record goes EXACTLY with it. Thread ids may contain ':' (memory.ts keeps it legal), so
// `thread:x:owner` — thread x's record — is a key prefix of thread `x:owner:y`'s (`thread:x:owner:y:owner`).
// Measured on 35b70348: `purgeThread('x')` deleted it by prefix and took y's owner record with x's,
// leaving y ungated — the next caller to name it became its owner, with y's history in it.
import { describe, it, expect } from 'vitest';
import { InMemoryStorage, toJournal, threadOwnerKey, threadSeenKey, admitThreadRun, user, type Storage } from '../src/index.js';
import { SqliteStorage } from '../src/sqlite-storage.js';
import { purgeThread } from '../src/retention.js';

for (const [name, make] of [['InMemory', () => new InMemoryStorage()], ['Sqlite', () => new SqliteStorage(':memory:') as unknown as Storage]] as const) {
  describe(`a thread's records go exactly with it — ${name}`, () => {
    it("deleting thread x leaves thread x:owner:y's owner record and mark, and y stays its owner's", async () => {
      const j = toJournal((make as () => Storage)().runs);
      await admitThreadRun(j, undefined, 'x', user('ayse'));
      await admitThreadRun(j, undefined, 'x:owner:y', user('bob'));
      await j.put(threadSeenKey('x:seen:z'), { at: 1, ownerKind: 'unknown' });
      await purgeThread(j, 'x');
      expect(await j.get(threadOwnerKey('x'))).toBeUndefined();
      expect(await j.get(threadOwnerKey('x:owner:y'))).toMatchObject({ resourceId: 'bob' });
      expect(await j.get(threadSeenKey('x:seen:z'))).toBeDefined();
      await expect(admitThreadRun(j, undefined, 'x:owner:y', user('mallory'))).rejects.toThrow(/belongs to/);
    });
  });
}
