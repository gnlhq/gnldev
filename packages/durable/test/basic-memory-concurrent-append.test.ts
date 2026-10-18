// Concurrent appends to one thread lose nothing in the journal-kept memory (`BasicMemory`).
//
// `append` read the thread's log, awaited, and wrote the log back: two turns on one thread both read
// the same log and the second write erased the first's messages. Measured before the fix: 10
// concurrent appends kept 1 when any await sat between the read and the write, and the @gnldev/memory
// README promised "concurrent turns on one thread are safe" — true for `AgentMemory`, whose store
// assigns the position inside a write serialised per thread, and not for this class.
//
// The fix is the journal's equivalent of that serialised write: `appendToJournalLog` — a per-key
// in-process queue, and a compare-and-set (`putIfAbsent`/`putIfMatch`) so a second PROCESS cannot
// erase a write either (the cross-process proof is in multi-process-race.test.ts).
import { describe, it, expect } from 'vitest';
import { BasicMemory, InMemoryJournal, appendToJournalLog, readJournalLog, withOrg, type Journal } from '../src/index.js';
import { SqliteStorage } from '../src/sqlite-storage.js';

const journals: [string, () => Journal][] = [
  ['InMemoryJournal', () => new InMemoryJournal()],
  ['SqliteStorage.runs', () => new SqliteStorage(':memory:').runs as unknown as Journal],
];
const tick = () => new Promise((r) => setTimeout(r, 1));

/** A journal whose `get` yields before answering, the way a network store does. */
function slowGet(j: Journal): Journal {
  return new Proxy(j, {
    get(t, p) {
      const v = Reflect.get(t, p, t);
      if (p === 'get') return async (k: string) => { const r = await (v as Journal['get']).call(t, k); await tick(); return r; };
      return typeof v === 'function' ? v.bind(t) : v;
    },
  });
}

for (const [name, make] of journals) {
  describe(`BasicMemory concurrent appends (${name})`, () => {
    for (const n of [2, 10, 100]) {
      it(`${n} concurrent appends to one thread keep all ${n} messages`, async () => {
        const mem = new BasicMemory(slowGet(make()));
        await Promise.all(Array.from({ length: n }, (_, i) => mem.append('t1', [{ role: 'user', content: `m${i}` }])));
        const got = await mem.getMessages('t1');
        expect(got).toHaveLength(n);
        expect(new Set(got.map((m) => m.content)).size).toBe(n);
      });
    }

    it('mixed appends and reads: nothing lost', async () => {
      const mem = new BasicMemory(slowGet(make()));
      const seen: number[] = [];
      const ops: Promise<unknown>[] = [];
      for (let i = 0; i < 50; i++) {
        ops.push(mem.append('t1', [{ role: 'user', content: `m${i}` }]));
        ops.push(mem.getMessages('t1').then((r) => seen.push(r.length)));
      }
      await Promise.all(ops);
      expect(await mem.getMessages('t1')).toHaveLength(50);
      expect(seen).toHaveLength(50); // reads are not queued behind appends, and none failed
    });

    it('two memory instances over one journal (two request handlers) lose nothing', async () => {
      const j = slowGet(make());
      const a = new BasicMemory(j);
      const b = new BasicMemory(j);
      await Promise.all(Array.from({ length: 20 }, (_, i) => (i % 2 ? a : b).append('t1', [{ role: 'user', content: `m${i}` }])));
      expect(await a.getMessages('t1')).toHaveLength(20);
    });

    it('through an organization-scoped journal (a new wrapper per request) nothing is lost', async () => {
      const root = make();
      await Promise.all(Array.from({ length: 20 }, (_, i) => new BasicMemory(slowGet(withOrg(root, 'acme'))).append('t1', [{ role: 'user', content: `m${i}` }])));
      expect(await new BasicMemory(withOrg(root, 'acme')).getMessages('t1')).toHaveLength(20);
    });
  });
}

