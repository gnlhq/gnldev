// A package that keeps a record ABOUT a person — a copy of their conversation — keeps it under
// personRecordKey, and the person's erasure takes it with nothing wired: purgeResource and eraseSubject
// both. The id's length is in the key, so erasing `bob` never reaches `bob:evil`, and an organization's
// `bob` is another person.
import { describe, it, expect } from 'vitest';
import { InMemoryStorage, toJournal, purgeResource, eraseSubject, personRecordKey, personRecordPrefix, withOrg } from '../src/index.js';

describe('a record kept about a person goes with them', () => {
  it('purgeResource erases bob\'s records and keeps bob:evil\'s', async () => {
    const journal = toJournal(new InMemoryStorage().runs);
    await journal.put(personRecordKey('bob', 'lab:scenario:support:1'), { text: 'BOB-COPY' });
    await journal.put(personRecordKey('bob:evil', 'lab:scenario:support:2'), { text: 'EVIL-COPY' });
    await journal.put(personRecordKey('bo', 'b:lab:scenario:support:3'), { text: 'BO-COPY' });
    await purgeResource(journal, 'bob');
    expect(await journal.get(personRecordKey('bob', 'lab:scenario:support:1'))).toBeUndefined();
    expect(await journal.get(personRecordKey('bob:evil', 'lab:scenario:support:2'))).toEqual({ text: 'EVIL-COPY' });
    expect(await journal.get(personRecordKey('bo', 'b:lab:scenario:support:3'))).toEqual({ text: 'BO-COPY' });
  });

  it("eraseSubject in an organization erases that organization's bob only", async () => {
    const storage = new InMemoryStorage();
    const root = toJournal(storage.runs);
    await withOrg(root, 'acme').put(personRecordKey('bob', 'lab:scenario:support:1'), { text: 'ACME-BOB' });
    await withOrg(root, 'globex').put(personRecordKey('bob', 'lab:scenario:support:1'), { text: 'GLOBEX-BOB' });
    await root.put(personRecordKey('bob', 'lab:scenario:support:1'), { text: 'ROOT-BOB' });
    const report = await eraseSubject(storage, 'bob', { orgId: 'acme' });
    expect(report.journalRows).toBeGreaterThanOrEqual(1);
    expect(await withOrg(root, 'acme').get(personRecordKey('bob', 'lab:scenario:support:1'))).toBeUndefined();
    expect(await withOrg(root, 'globex').get(personRecordKey('bob', 'lab:scenario:support:1'))).toEqual({ text: 'GLOBEX-BOB' });
    expect(await root.get(personRecordKey('bob', 'lab:scenario:support:1'))).toEqual({ text: 'ROOT-BOB' });
    await eraseSubject(storage, 'bob');
    expect(await root.get(personRecordKey('bob', 'lab:scenario:support:1'))).toBeUndefined();
    expect(await withOrg(root, 'globex').get(personRecordKey('bob', 'lab:scenario:support:1'))).toEqual({ text: 'GLOBEX-BOB' });
  });

  it('a record needs a person', () => {
    expect(() => personRecordPrefix('')).toThrow(/needs the id of the person/);
  });
});
