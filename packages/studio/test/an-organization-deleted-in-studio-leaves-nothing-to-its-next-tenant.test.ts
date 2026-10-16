// DELETE /organizations/:id erases the organization from every store, and its next tenant reads nothing.
//
// Measured before (c-erasure CE-1): the route swept the run journal alone. The organization's threads,
// messages, working memory and documents stayed in their stores, and its members' jobs in the root work
// log; a new organization registered under the same id listed the old threads and read them.
//
// Siblings: on Sqlite as well as in memory; and a Studio given no storage to erase from refuses (409)
// rather than report a partial deletion as done.
import { describe, it, expect } from 'vitest';
import { InMemoryStorage, toJournal, withOrgStorage, workingMemoryScope, ownedPrefix, ORG_RECORD_PRE, type Storage } from '@gnldev/durable';
import { SqliteStorage } from '@gnldev/durable/sqlite';
import { createStudioApi } from '../src/server.js';
import { call } from './call.js';

async function seedTenant(storage: Storage, org: string): Promise<void> {
  await toJournal(storage.runs).put(`${ORG_RECORD_PRE}${org}`, { id: org });
  const v = withOrgStorage(storage, org);
  await toJournal(v.runs).put('r1:model:0', { content: [{ type: 'text', text: 'AYSE-ANSWER' }], finishReason: 'stop' });
  await v.memory!.upsertThread({ id: 't-a', resourceId: 'ayse', title: 'AYSE-TITLE', createdAt: 1, updatedAt: 1 });
  await v.memory!.appendMessages('t-a', [{ threadId: 't-a', role: 'user', text: 'AYSE-SECRET', ts: 1, message: { role: 'user', content: 'AYSE-SECRET' } }]);
  await v.memory!.setWorkingMemory(workingMemoryScope.resource('ayse'), { wm: 'AYSE-WM' });
  await v.vectors!.upsert([{ id: 'doc-a', text: 'AYSE-DOC', embedding: [1, 0, 0], owner: 'ayse' }]);
  await storage.work!.append('jobs', { job: 'AYSE-JOB' }, `${ownedPrefix({ orgId: org, resourceId: 'ayse' })}j1`);
}

async function whatTheNextTenantReads(storage: Storage, org: string): Promise<unknown[]> {
  await toJournal(storage.runs).put(`${ORG_RECORD_PRE}${org}`, { id: org });
  const v = withOrgStorage(storage, org);
  return [
    ...(await v.memory!.listThreads({ limit: 10 })).items,
    ...(await v.memory!.getMessages('t-a', { limit: 10 })).items,
    ...[await v.memory!.getWorkingMemory(workingMemoryScope.resource('ayse'))].filter((x) => x !== undefined),
    ...(await v.vectors!.query([1, 0, 0], 10)),
    ...[await toJournal(v.runs).get('r1:model:0')].filter((x) => x !== undefined),
    ...(await storage.work!.list('jobs', { limit: 10 })).items,
  ];
}

const STORES: Array<[string, () => Storage]> = [
  ['in-memory', () => new InMemoryStorage()],
  ['sqlite', () => new SqliteStorage(':memory:') as unknown as Storage],
];

describe.each(STORES)('DELETE /organizations/:id — %s', (_name, make) => {
  it('erases the organization from every store: its next tenant reads nothing', async () => {
    const storage = make();
    await seedTenant(storage, 'acme');
    const app = createStudioApi({ reader: toJournal(storage.runs), org: {}, userErasure: { storage } });
    const del = await call(app, '/organizations/acme', { method: 'DELETE' });
    expect(del.status).toBe(200);
    expect(await whatTheNextTenantReads(storage, 'acme')).toEqual([]);
  });

  it('sibling: with no storage to erase from it refuses (409) and deletes nothing', async () => {
    const storage = make();
    await seedTenant(storage, 'acme');
    const app = createStudioApi({ reader: toJournal(storage.runs), org: {} });
    const del = await call(app, '/organizations/acme', { method: 'DELETE' });
    expect(del.status).toBe(409);
    expect(await toJournal(storage.runs).get(`${ORG_RECORD_PRE}acme`)).toEqual({ id: 'acme' });
    expect((await whatTheNextTenantReads(storage, 'acme')).length).toBeGreaterThan(0);
  });
});
