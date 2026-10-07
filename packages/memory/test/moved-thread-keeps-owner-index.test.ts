// A thread moved to a new id (migrateReservedRootThreads) keeps its owner's subject-index entry, so an
// erasure through the index still finds it. Before: the owner record was copied with a plain put, and
// the new id had a record naming its owner and no entry (measured: `undefined`).
import { it, expect } from 'vitest';
import { InMemoryStorage, threadOwnerKey, toJournal, ORG_RECORD_PRE } from '@gnldev/durable';
import { subjectKey } from '../../durable/src/subject-index.js';
import { migrateReservedRootThreads } from '../src/index.js';

it('a moved thread is indexed for its owner under the new id, and no longer under the old one', async () => {
  const s = new InMemoryStorage();
  const j = toJournal(s.runs);
  await j.put(ORG_RECORD_PRE + 'acme', { label: 'Acme' });
  await s.memory!.upsertThread({ id: 'org:acme:support', resourceId: 'u1', createdAt: 1, updatedAt: 1 });
  await j.put(threadOwnerKey('org:acme:support'), { resourceId: 'u1', at: 1 });
  await s.upgrade!({ only: ['subject-index'] });
  await migrateReservedRootThreads(s);
  expect(await j.get(threadOwnerKey('legacy-org:acme:support'))).toMatchObject({ resourceId: 'u1' });
  expect(await j.get(subjectKey('thread', 'u1', 'legacy-org:acme:support'))).toBeDefined();
  expect(await j.get(subjectKey('thread', 'u1', 'org:acme:support'))).toBeUndefined();
});
