// Concurrent appends to one thread lose nothing in SemanticMemory.
//
// `append` loaded the thread's log, awaited one `embed` per message, then wrote the log back — so
// every turn racing on the thread read the same log and the last write won. Measured before the fix:
// 10 concurrent appends kept 1. The write now goes through @gnldev/durable's `appendToJournalLog` (a
// per-key queue plus compare-and-set), and embedding happens BEFORE it, outside the serialised part.
import { describe, it, expect } from 'vitest';
import { InMemoryJournal, type Journal } from '@gnldev/durable';
import { SqliteStorage } from '../../durable/src/sqlite-storage.js';
import { SemanticMemory } from '../src/semantic-memory.js';

/** An embed that yields, the way a network embedding call does. */
const embed = async (t: string) => { await new Promise((r) => setTimeout(r, 1)); return [(t.length % 7) + 1, 1, 0]; };

const journals: [string, () => Journal][] = [
  ['InMemoryJournal', () => new InMemoryJournal()],
  ['SqliteStorage.runs', () => new SqliteStorage(':memory:').runs as unknown as Journal],
];

for (const [name, make] of journals) {
  describe(`SemanticMemory concurrent appends (${name})`, () => {
    for (const n of [2, 10, 100]) {
      it(`${n} concurrent appends to one thread keep all ${n} messages, each with its embedding`, async () => {
        const mem = new SemanticMemory({ journal: make(), embed, recentN: 1000 });
        await Promise.all(Array.from({ length: n }, (_, i) => mem.append('t1', [{ role: 'user', content: `msg ${i}` }])));
        const got = await mem.getMessages('t1');
        expect(got).toHaveLength(n);
        expect(new Set(got.map((m) => m.content)).size).toBe(n);
      });
    }

    it('mixed appends and query reads: nothing lost', async () => {
      const mem = new SemanticMemory({ journal: make(), embed, recentN: 2, topK: 2 });
      const ops: Promise<unknown>[] = [];
      for (let i = 0; i < 30; i++) {
        ops.push(mem.append('t1', [{ role: 'user', content: `msg ${i}` }]));
        ops.push(mem.getMessages('t1', { query: 'msg 3' }));
      }
      await Promise.all(ops);
      const all = new SemanticMemory({ journal: (mem as unknown as { journal: Journal }).journal, embed, recentN: 1000 });
      expect(await all.getMessages('t1')).toHaveLength(30);
    });

    it('a batch stays contiguous and in order under concurrency', async () => {
      const mem = new SemanticMemory({ journal: make(), embed, recentN: 1000 });
      await Promise.all(Array.from({ length: 10 }, (_, i) => mem.append('t1', [{ role: 'user', content: `q${i}` }, { role: 'assistant', content: `a${i}` }])));
      const got = (await mem.getMessages('t1')).map((m) => m.content as string);
      expect(got).toHaveLength(20);
      for (let k = 0; k < got.length; k += 2) expect(got[k + 1]).toBe(`a${got[k]!.slice(1)}`);
    });
  });
}
