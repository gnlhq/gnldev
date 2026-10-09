// A thread moved to a new id (migrateReservedRootThreads) is found under its new id by its owner's
// erasure, and no longer under the old one: copyThreadOwnership copies the owner record through the
// journal, so a store that keeps the owner in a column (Sqlite: `gnl_run_journal.owner`) places the new
// record in the same write — nothing else has to remember to.
import { it, expect } from 'vitest';
import { InMemoryStorage, threadOwnerKey, toJournal, ORG_RECORD_PRE } from '@gnldev/durable';
import { SqliteStorage } from '@gnldev/durable/sqlite';
import { migrateReservedRootThreads } from '../src/index.js';

for (const [name, make] of [['memory', () => new InMemoryStorage()], ['sqlite', () => new SqliteStorage()]] as const) {
  it(`${name}: a moved thread's owner record is listed for its owner under the new id, and no longer under the old one`, async () => {
    const s = make();
    const j = toJournal(s.runs);
    await j.put(ORG_RECORD_PRE + 'acme', { label: 'Acme' });
    await s.memory!.upsertThread({ id: 'org:acme:support', resourceId: 'u1', createdAt: 1, updatedAt: 1 });
    await j.put(threadOwnerKey('org:acme:support'), { resourceId: 'u1', at: 1 });
    await migrateReservedRootThreads(s);
    expect(await j.get(threadOwnerKey('legacy-org:acme:support'))).toMatchObject({ resourceId: 'u1' });
    expect(await j.listOwnerRecords!('u1', { prefix: 'thread:' })).toEqual([threadOwnerKey('legacy-org:acme:support')]);
  });
}
