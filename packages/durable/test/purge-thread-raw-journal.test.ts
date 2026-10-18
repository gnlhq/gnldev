// A thread delete handed the storage's own run journal (`purgeThread(storage.runs, …)`, the shape the
// docs show) deletes the thread's runs too. It used to find none: the run listing it asked for
// (`listRunsPaged`) is the reader adapter's (`asReaderJournal`), the raw journal has its `listRuns` —
// and "no listing" read as "no runs", so the messages went and every run of the thread stayed.
import { describe, it, expect } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createGnl, purgeThread, InMemoryJournal } from '../src/index.js';
import { SqliteStorage } from '../src/sqlite-storage.js';
import { createMockStreamAgent } from './mock.js';
import { forwardGuarantees } from './store-guarantees.js';

describe('purgeThread over a raw run journal', () => {
  it('deletes the thread\'s runs (Sqlite storage.runs)', async () => {
    const storage = new SqliteStorage(join(mkdtempSync(join(tmpdir(), 'gnl-purge-raw-')), 'runs.db'));
    try {
      const gnl = createGnl({ storage, agents: { a: { model: createMockStreamAgent() } } } as any);
      await gnl.run('a', { runId: 'raw-r1', threadId: 'raw-t', prompt: 'hi', resourceId: 'alice' } as any);
      const before = (await (storage.runs as any).listKeys('raw-r1')).length;
      expect(before, 'the run wrote records').toBeGreaterThan(0);
      await purgeThread(storage.runs as any, 'raw-t', { memory: storage.memory as any });
      expect(await (storage.runs as any).listKeys('raw-r1'), 'records of a run on the deleted thread').toEqual([]);
    } finally {
      await storage.close();
    }
  });

  it('refuses a journal that cannot list runs at all, deleting nothing', async () => {
    const j = new InMemoryJournal();
    await j.put('mem:raw-t:messages', [{ role: 'user', content: 'x' }]);
    // Every guarantee of a store, and no way to list runs (`listRuns` is a reader's, not a guarantee).
    const bare: any = { ...forwardGuarantees(j), get: j.get.bind(j), put: j.put.bind(j) };
    await expect(purgeThread(bare, 'raw-t')).rejects.toThrow(/list/i);
    expect(await j.get('mem:raw-t:messages'), 'a refused delete deleted the messages').toBeDefined();
  });
});
