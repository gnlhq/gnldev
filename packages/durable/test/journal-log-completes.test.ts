// Invariant: a journal-log append (`appendToJournalLog`) keeps every entry AND completes, whatever
// the entries hold.
//
// The compare-and-set that keeps a second process from erasing an append compared the stored log
// with `serialize(what we read)`. superjson does not hand an `Error` back byte-for-byte (the second
// pass adds `cause: undefined`), so once a message holding an Error was in the log, every compare
// lost, the loop retried forever, and it never yielded: the process froze. Measured before the fix
// (review panel, f9 "B (sqlite)"): `timeout 40 vitest run -t sqlite` exited 124.
//
// The log is now stored as a list of already-serialised parts, so the compare is between strings and
// cannot depend on how a value round-trips; retries are bounded, yield, and end in a named error.
import { describe, it, expect } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { newDb } from 'pg-mem';
import {
  BasicMemory, InMemoryJournal, InMemoryStorage, appendToJournalLog, readJournalLog, toJournal,
  JournalLogContentionError, type Journal,
} from '../src/index.js';
import { SqliteStorage } from '../src/sqlite-storage.js';
import { PostgresStorage } from '../src/postgres-storage.js';

const journals: [string, () => Journal][] = [
  ['InMemoryJournal', () => new InMemoryJournal()],
  ['InMemoryStorage.runs', () => toJournal(new InMemoryStorage().runs)],
  ['SqliteStorage.runs', () => new SqliteStorage(':memory:').runs as unknown as Journal],
  ['PostgresStorage.runs (pg-mem)', () => toJournal(new PostgresStorage({ pool: new (newDb().adapters.createPg().Pool)() }).runs)],
];

class Money { constructor(public amount: number) {} }
/** Values whose serialised form may not survive a second round trip. Each one used to be a hazard. */
const awkward: [string, unknown][] = [
  ['an Error', new Error('boom')],
  ['an Error with a cause', new Error('outer', { cause: new Error('inner') })],
  ['a TypeError with an extra property', Object.assign(new TypeError('bad'), { code: 'E_BAD' })],
  ['an object with an undefined field', { a: undefined, b: 1 }],
  ['a Date', new Date(0)],
  ['a Map and a Set', { m: new Map([['k', 1]]), s: new Set([1, 2]) }],
  ['a BigInt', 10n ** 20n],
  ['NaN, -0 and Infinity', [Number.NaN, -0, Number.POSITIVE_INFINITY]],
  ['a RegExp', /x+/gi],
  ['a class instance', new Money(5)],
];

describe.each(journals)('a journal-log append completes, whatever it holds (%s)', (_name, make) => {
  it.each(awkward)('after a message holding %s, the next appends complete and keep everything', async (_label, value) => {
    const mem = new BasicMemory(make());
    await mem.append('t', [{ role: 'tool', content: 'x', metadata: { value } }]);
    await mem.append('t', [{ role: 'user', content: 'next' }]);
    await mem.append('t', [{ role: 'user', content: 'and next' }]);
    expect((await mem.getMessages('t')).map((m) => m.content)).toEqual(['x', 'next', 'and next']);
  });

  it('what a message held reads back the way the journal stores it', async () => {
    const mem = new BasicMemory(make());
    await mem.append('t', [{ role: 'tool', content: 'x', metadata: { at: new Date(5), error: new Error('boom') } }]);
    const [m] = await mem.getMessages('t');
    expect(m.metadata.at).toBeInstanceOf(Date);
    expect(m.metadata.at.getTime()).toBe(5);
    expect(m.metadata.error).toBeInstanceOf(Error);
    expect(m.metadata.error.message).toBe('boom');
  });

  it('a 0.9.0 log (a plain array under the key) is read as-is and kept by the next append', async () => {
    const j = make();
    await j.put('mem:t:messages', [{ role: 'user', content: 'old' }]);
    const mem = new BasicMemory(j);
    expect((await mem.getMessages('t')).map((m) => m.content)).toEqual(['old']);
    await mem.append('t', [{ role: 'user', content: 'new' }]);
    expect((await mem.getMessages('t')).map((m) => m.content)).toEqual(['old', 'new']);
  });

  it('a 0.9.0 log that already holds an Error is upgraded, not frozen on', async () => {
    const j = make();
    await j.put('mem:t:messages', [{ role: 'tool', content: 'old', metadata: { error: new Error('boom') } }]);
    const mem = new BasicMemory(j);
    await mem.append('t', [{ role: 'user', content: 'new' }]);
    await mem.append('t', [{ role: 'user', content: 'newer' }]);
    expect((await mem.getMessages('t')).map((m) => m.content)).toEqual(['old', 'new', 'newer']);
  });
});

describe('two SqliteStorage connections on one file (the queue cannot help, only the compare)', () => {
  it('40 concurrent appends from each side keep all 80, with an Error already in the log', async () => {
    const file = join(mkdtempSync(join(tmpdir(), 'gnl-log-')), 'db.sqlite');
    const s1 = new SqliteStorage(file); await s1.init();
    const s2 = new SqliteStorage(file); await s2.init();
    const m1 = new BasicMemory(s1.runs as unknown as Journal);
    const m2 = new BasicMemory(s2.runs as unknown as Journal);
    await m1.append('t', [{ role: 'tool', content: 'e', metadata: { error: new Error('boom') } }]);
    await Promise.all(Array.from({ length: 40 }, (_, i) => [
      m1.append('t', [{ role: 'user', content: `a${i}` }]),
      m2.append('t', [{ role: 'user', content: `b${i}` }]),
    ]).flat());
    expect(await m1.getMessages('t')).toHaveLength(81);
  });
});

describe('a compare that never succeeds ends in a named error, not a frozen process', () => {
  it('retries are bounded, yield to the event loop, and name the key', async () => {
    const inner = new InMemoryJournal();
    // A store whose compare always loses — a broken adapter, or a writer that never stops winning.
    const j: Journal = {
      get: (k) => inner.get(k), put: (k, v) => inner.put(k, v),
      putIfAbsent: (k, v) => inner.putIfAbsent(k, v), putIfMatch: async () => false,
    };
    await appendToJournalLog(j, 'log', [1]);
    let ticks = 0;
    const timer = setInterval(() => { ticks++; }, 0);
    try {
      const err = await appendToJournalLog(j, 'log', [2]).catch((e: unknown) => e);
      expect(err).toBeInstanceOf(JournalLogContentionError);
      expect((err as Error).message).toContain("'log'");
    } finally { clearInterval(timer); }
    expect(ticks).toBeGreaterThan(0); // timers ran while it retried: the loop yielded
    expect(await readJournalLog(j, 'log')).toEqual([1]);
  });
});
