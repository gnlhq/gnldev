// Invariant: erasing a person removes their journal-kept threads (BasicMemory) by the thread's owner
// record, whether or not a run of theirs is left to lead to it — or names the thread as unreached.
// Measured before: a BasicMemory thread owned by u1 with no run kept its log, and the report said
// `unreachedThreads: []`, `journalRows: 0`.
import { describe, it, expect } from 'vitest';
import { BasicMemory, InMemoryStorage, assignThreadOwner, eraseSubject, toJournal } from '../src/index.js';

describe('eraseSubject and a journal-kept thread with no run', () => {
  it("removes the thread's BasicMemory log and keeps another person's", async () => {
    const storage = new InMemoryStorage();
    const journal = toJournal(storage.runs);
    const mem = new BasicMemory(journal);
    await mem.append('t-u1', [{ role: 'user', content: 'U1 secret' }]);
    await mem.append('t-u2', [{ role: 'user', content: 'U2 keeps this' }]);
    await assignThreadOwner(journal, 't-u1', 'u1');
    await assignThreadOwner(journal, 't-u2', 'u2');
    const report = await eraseSubject(storage, 'u1');
    expect(report.unreachedThreads).toEqual([]);
    expect(await mem.getMessages('t-u1')).toEqual([]);
    expect((await mem.getMessages('t-u2')).map((m) => m.content)).toEqual(['U2 keeps this']);
  });
});
