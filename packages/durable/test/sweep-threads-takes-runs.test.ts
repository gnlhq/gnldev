// A thread delete takes its runs (C+ step C, model.ts) — and the age-based thread sweep deletes through
// it, so a swept BasicMemory thread goes with its runs. A thread with a run still in flight is not
// pulled out from under it: it is kept for a later round and named (`keptInFlight`).
import { describe, it, expect } from 'vitest';
import { InMemoryStorage, BasicMemory, toJournal, type Storage } from '../src/index.js';
import { SqliteStorage } from '../src/sqlite-storage.js';
import { runDurable } from '../src/run.js';
import { sweepThreads } from '../src/retention.js';
import { createMockModel, finalTextResult } from './mock.js';

const FAR_FUTURE = () => Date.now() + 10_000_000;
const model = () => createMockModel(async () => finalTextResult('ok'));

for (const [name, make] of [['InMemory', () => new InMemoryStorage()], ['Sqlite', () => new SqliteStorage(':memory:') as unknown as Storage]] as const) {
  describe(`sweepThreads takes a swept thread's runs — ${name}`, () => {
    it('an idle thread goes with its runs; one with a run in flight is kept, named, and whole', async () => {
      const storage = (make as () => Storage)();
      const journal = toJournal(storage.runs);
      const memory = new BasicMemory(journal);
      for (const [runId, threadId] of [['r1', 'th-old'], ['r2', 'th-old'], ['r3', 'th-busy'], ['r4', 'th-new']] as const) {
        await runDurable({ runId, journal, memory, model: model(), prompt: 'hi', threadId, resourceId: 'ayse' } as any);
      }
      // r3 back in flight: the write-ahead outcome of a turn that is still executing.
      await journal.put('r3:outcome', { status: 'running', at: 1 });
      const res = await sweepThreads(journal, { olderThanMs: 1_000, now: FAR_FUTURE() });
      expect(res.purged.sort()).toEqual(['th-new', 'th-old']);
      expect(res.keptInFlight).toEqual(['th-busy']);
      for (const r of ['r1', 'r2', 'r4']) expect(await journal.get(`${r}:input`), r).toBeUndefined();
      expect(await journal.get('r3:input')).toBeDefined();
      expect(await journal.get('mem:th-busy:messages')).toBeDefined();
    });
  });
}
