// Every function that takes "the storage or one of its parts" reads the argument the same way: one
// `isStorage`, one description of a wrong handle. A wrong one is refused with a sentence naming what it is
// and the call that works — never a raw "Cannot read properties of …", and never accepted to do the wrong
// thing.
//
// Measured before, 15 functions × 12 handles: 37 raw JS errors and 4 silent acceptances. The worst:
// `purgeOrganizationWork(storage.runs, 'acme')` deleted organization acme's run-journal rows (it treated
// the run journal as the work store), and `scheduleWorkflow(storage.work)` wrote a trigger the poller
// never reads. "Is this the Storage" was decided by five different checks.
import { describe, it, expect } from 'vitest';
import { InMemoryStorage, toJournal, portOf, storageOf, journalOf, isStorage, purgeOrganizationWork, withOrgStorage } from '../src/index.js';

describe('one reading of the storage or its port', () => {
  const st: any = new InMemoryStorage();

  it('isStorage is the one answer: the storage and an org-scoped storage are, a port or a journal view is not', () => {
    expect(isStorage(st)).toBe(true);
    expect(isStorage(withOrgStorage(st, 'acme'))).toBe(true);
    for (const v of [st.runs, st.work, st.cache, toJournal(st), {}, null, undefined, 'storage']) expect(isStorage(v)).toBe(false);
  });

  it('purgeOrganizationWork refuses the run journal instead of deleting from it', async () => {
    const org = withOrgStorage(st, 'acme') as any;
    await org.runs.put('r1:input', { x: 1 });
    const before = await st.runs.listKeys('');
    await expect(purgeOrganizationWork(st.runs, 'acme')).rejects.toThrow(/it is a run journal \(storage\.runs\), not the work port\. Pass the storage, or storage\.work/);
    expect(await st.runs.listKeys('')).toEqual(before);
  });

  it('each wrong handle is named, and the sentence says which call works', () => {
    expect(() => portOf(st.cache, 'work', 'f')).toThrow(/it is a cache port \(storage\.cache\), not the work port/);
    expect(() => portOf(st.work, 'runs', 'f')).toThrow(/it is a work port \(storage\.work\), not the runs port/);
    expect(() => portOf(null, 'work', 'f')).toThrow(/needs the storage or its work port, got null/);
    expect(() => storageOf(st.work, 'f')).toThrow(/needs the whole storage .* this is a work port \(storage\.work\)\. Pass the storage itself/);
    expect(() => journalOf(st.work, 'f')).toThrow(/a work port \(storage\.work\), not a journal\. Pass the storage, or toJournal\(storage\)/);
    expect(() => journalOf({}, 'f')).toThrow(/has no get\/put — it is not a journal/);
    expect(() => toJournal(null as any)).toThrow(/toJournal needs the storage or its runs port, got null/);
    expect(() => toJournal(st.work)).toThrow(/toJournal: .*it is a work port/);
  });

  it('the right handles are taken as they are', () => {
    expect(portOf(st, 'work', 'f')).toBe(st.work);
    expect(portOf(st.work, 'work', 'f')).toBe(st.work);
    expect(storageOf(st, 'f')).toBe(st);
    expect(typeof journalOf(st, 'f').get).toBe('function');
    expect(journalOf(st.runs, 'f')).toBe(st.runs);
  });
});

describe('the in-memory work store hands out copies, as SQLite does', () => {
  it('what a reader does to a value it got does not change what the next reader gets', async () => {
    const s: any = new InMemoryStorage();
    await s.work.put('k', ['a']);
    const first = await s.work.get('k');
    first.push('W');
    expect(await s.work.get('k')).toEqual(['a']);
    await s.work.append('ns', { list: ['a'] }, 'job-1');
    const [rec] = (await s.work.list('ns')).items;
    rec.payload.list.push('R');
    const [again] = (await s.work.list('ns')).items;
    expect(again.payload.list).toEqual(['a']);
  });
});
