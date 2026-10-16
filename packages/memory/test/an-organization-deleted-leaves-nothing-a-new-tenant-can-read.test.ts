// What an ORGANIZATION owns, and its deletion takes exactly that — on every store.
//
// Measured before this existed (raporlar/2026-10-11-surum-denetimi/c-erasure, CE-1): the documented
// deletion (`purgeOrganization(journal)` + `purgeOrganizationWork(work)`, and Studio's
// DELETE /organizations/:id, which called only the first) took the organization's journal partition and
// its work namespaces, and left its threads, messages, working memory, observations, batch markers, its
// documents and observation vectors, and its members' owned jobs in the root work log. A NEW organization
// registered under the same id then listed `t-a/ayse`, read her messages, her working memory and her
// documents — on InMemory, Sqlite and Postgres alike.
//
// The promises held here:
//  O1 after `purgeOrganization(storage, 'acme')` the store is the store of a world in which acme never
//     existed — every port, every table — but for the one documented remainder, the purge marker;
//  O2 nothing outside acme changes: the root's and acme2's data (the same ids, the same people) stay;
//  O3 an organization registered again under the same id reads nothing of the old one, through any port.
import { describe, it, expect, afterEach } from 'vitest';
import { purgeOrganization, withOrgStorage, toJournal, ORG_RECORD_PRE, workingMemoryScope, VECTOR_ALL_PARTITIONS } from '@gnldev/durable';
import { KINDS, makeBackend, closeBackends, world, dump, portable } from './dependents-world.js';

// Each test's stores are closed when it ends: a Postgres store holds a pool and its own liveness session
// (one per database), and a file of 27 open databases measured 98 of the server's 100 connections.
afterEach(closeBackends);

/** The one thing an organization's deletion leaves on purpose: when it happened (`orgPurgedKey`), no data of anyone. */
const documentedRemainder = (x: string) => x === 'j __org_purged__:acme';

/** What only the cache and meta ports hold for acme — neither is in `dump`, so they are read through the ports. */
async function cacheAndMeta(storage: Parameters<typeof withOrgStorage>[0], org: string): Promise<void> {
  const v = withOrgStorage(storage, org);
  await v.cache!.set('answer:1', { text: `${org.toUpperCase()}-CACHED` });
  await v.meta.set('setting', `${org.toUpperCase()}-META`);
}

for (const kind of KINDS) {
  describe(`organization deletion — ${kind}`, () => {
    it('O1/O2: the store is the store of a world without acme, the root and acme2 untouched', async () => {
      const b = await makeBackend(kind);
      await world(b.storage); await world(b.storage, 'acme'); await world(b.storage, 'acme2');
      await cacheAndMeta(b.storage, 'acme'); await cacheAndMeta(b.storage, 'acme2');
      const ref = await makeBackend(kind);
      await world(ref.storage); await world(ref.storage, 'acme2');
      await cacheAndMeta(ref.storage, 'acme2');

      await purgeOrganization(b.storage, 'acme');

      const got = portable(await dump(b)).filter((x) => !documentedRemainder(x));
      const want = portable(await dump(ref));
      expect(got.filter((x) => !want.includes(x))).toEqual([]); // nothing of acme stays
      expect(want.filter((x) => !got.includes(x))).toEqual([]); // nothing of anyone else went
      expect(portable(await dump(b)).filter(documentedRemainder)).toEqual(['j __org_purged__:acme']);
      // acme2 still reads its own cache and meta.
      const acme2 = withOrgStorage(b.storage, 'acme2');
      expect(await acme2.cache!.get('answer:1')).toEqual({ text: 'ACME2-CACHED' });
      expect(await acme2.meta.get('setting')).toBe('ACME2-META');
    }, 180_000);

    it('O3: a new organization under the same id reads nothing of the old one', async () => {
      const b = await makeBackend(kind);
      await world(b.storage, 'acme');
      await cacheAndMeta(b.storage, 'acme');
      await purgeOrganization(b.storage, 'acme');
      await toJournal(b.storage.runs).put(`${ORG_RECORD_PRE}acme`, { id: 'acme' }); // a new tenant gets the id
      const v = withOrgStorage(b.storage, 'acme');
      expect((await v.memory!.listThreads({ limit: 100 })).items).toEqual([]);
      for (const t of ['t-a', 't-b']) {
        expect(await v.memory!.getThread(t)).toBeUndefined();
        expect((await v.memory!.getMessages(t, { limit: 100 })).items).toEqual([]);
        expect(await v.memory!.getObservations(t)).toEqual([]);
        expect(await v.memory!.getWorkingMemory(workingMemoryScope.thread(t))).toBeUndefined();
      }
      expect(await v.memory!.getWorkingMemory(workingMemoryScope.resource('ayse'))).toBeUndefined();
      expect(await v.vectors!.query([1, 0, 0], 10)).toEqual([]);
      expect((await b.storage.vectors!.query([1, 0, 0], 100, { [VECTOR_ALL_PARTITIONS]: true } as never)).filter((d) => d.namespace === 'org:acme')).toEqual([]);
      expect((await toJournal(v.runs).listRunsPaged!({ limit: 100 })).items).toEqual([]);
      expect(await v.cache!.get('answer:1')).toBeUndefined();
      expect(await v.meta.get('setting')).toBeUndefined();
      // The members' owned jobs in the ROOT work log (`~o~acme:<user>:…`) went too.
      expect((await b.storage.work!.list('jobs', { limit: 100 })).items.map((r) => r.id)).toEqual([]);
    }, 180_000);
  });
}
