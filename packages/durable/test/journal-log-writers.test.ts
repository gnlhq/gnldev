// Invariant: every append to a journal log is kept, however many writers there are and whatever the
// log held when it was first written by 0.9.0 — and an append that cannot be written says why and
// names the way through.
//
// Measured before this file:
//  · two SQLite connections first-appending to a 0.9.0 log holding an Error lost one of the two
//    appends in 20 of 20 rounds: the stored array cannot be compared (superjson hands an Error back with
//    `cause: undefined`), so the upgrade was a plain `put` after a re-read, and both writers took it.
//  · 100 concurrent writers on one thread: 64 kept, 36 threw JournalLogContentionError — the retry
//    bound was a fixed attempt count, and every lost round is another writer's WIN, so the bound was a
//    ceiling on the number of writers, not a guard against a stuck compare.
import { describe, it, expect, vi } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { InMemoryJournal, appendToJournalLog, readJournalLog, JournalLogContentionError, type Journal } from '../src/index.js';
import { SqliteStorage } from '../src/sqlite-storage.js';

/** A separate journal OBJECT over the same store: its own in-process queue, so only the compare orders it. */
const view = (inner: Journal, delayMs = 0): Journal => ({
  get: async (k) => { const v = await inner.get(k); if (delayMs) await new Promise((r) => setTimeout(r, delayMs)); return v; },
  put: (k, v) => inner.put(k, v),
  putIfAbsent: (k, v) => inner.putIfAbsent!(k, v),
  putIfMatch: (k, e, v) => inner.putIfMatch!(k, e, v),
});

const legacyWithError = () => [{ role: 'tool', content: 'x', metadata: { e: new Error('boom') } }];

describe('the first append to a 0.9.0 log is a compare, not a plain put', () => {
  it('J1b: two SQLite connections, first appends to a 0.9.0 log holding an Error — both kept, 20 rounds', async () => {
    const file = join(mkdtempSync(join(tmpdir(), 'jl-')), 'db.sqlite');
    const s1 = new SqliteStorage(file); await s1.init();
    const s2 = new SqliteStorage(file); await s2.init();
    const j1 = s1.runs as unknown as Journal;
    const j2 = s2.runs as unknown as Journal;
    const lost: string[] = [];
    for (let round = 0; round < 20; round++) {
      const key = `mem:r${round}:messages`;
      await j1.put(key, legacyWithError());
      await Promise.all([
        appendToJournalLog(view(j1, 3), key, [{ role: 'user', content: 'A' }]),
        appendToJournalLog(view(j2, 3), key, [{ role: 'user', content: 'B' }]),
      ]);
      const got = (await readJournalLog<any>(j1, key)).map((m) => m.content).sort().join(',');
      if (got !== 'A,B,x') lost.push(`r${round}:${got}`);
    }
    expect(lost).toEqual([]);
  });

  it('SIBLING: the same on one in-memory store through two journal objects', async () => {
    const inner = new InMemoryJournal();
    for (let round = 0; round < 20; round++) {
      const key = `mem:m${round}:messages`;
      await inner.put(key, legacyWithError());
      await Promise.all([
        appendToJournalLog(view(inner, 2), key, [{ role: 'user', content: 'A' }]),
        appendToJournalLog(view(inner, 2), key, [{ role: 'user', content: 'B' }]),
      ]);
      expect((await readJournalLog<any>(inner, key)).map((m) => m.content).sort()).toEqual(['A', 'B', 'x']);
    }
  });

  it('SIBLING: an Error with a cause, nested in a Map — still compared, both kept', async () => {
    const file = join(mkdtempSync(join(tmpdir(), 'jl-')), 'db.sqlite');
    const s1 = new SqliteStorage(file); await s1.init();
    const s2 = new SqliteStorage(file); await s2.init();
    const key = 'mem:nested:messages';
    await (s1.runs as unknown as Journal).put(key, [{ role: 'tool', content: 'x', metadata: { m: new Map([['k', new Error('outer', { cause: new Error('inner') })]]) } }]);
    await Promise.all([
      appendToJournalLog(view(s1.runs as unknown as Journal, 3), key, [{ role: 'user', content: 'A' }]),
      appendToJournalLog(view(s2.runs as unknown as Journal, 3), key, [{ role: 'user', content: 'B' }]),
    ]);
    expect((await readJournalLog<any>(s1.runs as unknown as Journal, key)).map((m) => m.content).sort()).toEqual(['A', 'B', 'x']);
  });
});

describe('the number of concurrent writers is not bounded', () => {
  for (const n of [100, 500]) {
    it(`${n} concurrent writers on one in-memory store: all kept, none thrown`, async () => {
      const inner = new InMemoryJournal();
      const t0 = Date.now();
      const results = await Promise.allSettled(Array.from({ length: n }, (_, i) => appendToJournalLog(view(inner, 1), 'log', [i])));
      const elapsed = Date.now() - t0;
      console.log(`in-memory ${n} writers: ${elapsed}ms`);
      expect(results.filter((r) => r.status === 'rejected')).toEqual([]);
      expect((await readJournalLog<number>(inner, 'log')).sort((a, b) => a - b)).toEqual(Array.from({ length: n }, (_, i) => i));
    }, 120_000);

    it(`${n} concurrent writers on one SQLite file (two connections): all kept, none thrown`, async () => {
      const file = join(mkdtempSync(join(tmpdir(), 'jl-')), 'db.sqlite');
      const s1 = new SqliteStorage(file); await s1.init();
      const s2 = new SqliteStorage(file); await s2.init();
      const sides = [s1.runs as unknown as Journal, s2.runs as unknown as Journal];
      const t0 = Date.now();
      const results = await Promise.allSettled(Array.from({ length: n }, (_, i) => appendToJournalLog(view(sides[i % 2]!, 1), 'log', [i])));
      const elapsed = Date.now() - t0;
      console.log(`sqlite ${n} writers: ${elapsed}ms`);
      expect(results.filter((r) => r.status === 'rejected')).toEqual([]);
      expect((await readJournalLog<number>(sides[0]!, 'log')).length).toBe(n);
    }, 300_000);
  }
});

describe('a compare that can never succeed is named, with the way through', () => {
  it('a custom journal whose putIfMatch compares by reference: the error says so and names the way through', async () => {
    const store = new Map<string, unknown>();
    const bad: Journal = {
      get: async (k) => (store.has(k) ? structuredClone(store.get(k)) : undefined) as any,
      put: async (k, v) => { store.set(k, v); },
      putIfAbsent: async (k, v) => (store.has(k) ? false : (store.set(k, v), true)),
      putIfMatch: async (k, e, v) => (store.get(k) === e ? (store.set(k, v), true) : false),
    };
    await appendToJournalLog(bad, 'log', [1]);
    const t0 = Date.now();
    const err = await appendToJournalLog(bad, 'log', [2]).catch((e: unknown) => e);
    expect(Date.now() - t0).toBeLessThan(5_000); // fails promptly: nobody else wrote, so retrying cannot help
    expect(err).toBeInstanceOf(JournalLogContentionError);
    expect((err as Error).message).toMatch(/putIfMatch/);
    expect((err as Error).message).toMatch(/conformance kit/);
    // The way through it names works: a putIfMatch that compares the serialized value.
    const fixed: Journal = { ...bad, putIfMatch: async (k, e, v) => (JSON.stringify(store.get(k)) === JSON.stringify(e) ? (store.set(k, v), true) : false) };
    await appendToJournalLog(fixed, 'log', [2]);
    expect(await readJournalLog(fixed, 'log')).toEqual([1, 2]);
  });

  it('SIBLING: a 0.9.0 log the store can never compare is still appended to (warned), not refused for good', async () => {
    const inner = new InMemoryJournal();
    const j: Journal = { ...view(inner), putIfMatch: async () => false };
    await inner.put('mem:t:messages', [{ role: 'user', content: 'old' }]);
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      await appendToJournalLog(j, 'mem:t:messages', [{ role: 'user', content: 'new' }]);
      expect(warn.mock.calls.join(' ')).toMatch(/cannot compare/);
    } finally { warn.mockRestore(); }
    expect((await readJournalLog<any>(inner, 'mem:t:messages')).map((m) => m.content)).toEqual(['old', 'new']);
  });
});
