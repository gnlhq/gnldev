// A unit of work held by a process is written down (its shadow) BEFORE its work starts, so another
// process's `pendingWork` never reads "nothing blocks" while the unit already runs. Seen in CI under
// load: the shadow's write lost the race to a check made right after a job's handler started. Here
// the write is made slow on purpose, and the work looks for its own shadow the moment it starts.
import { describe, it, expect } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SqliteStorage } from '../src/sqlite-storage.js';
import { toJournal } from '../src/storage.js';
import { holdWhile, HAND_PREFIX, storeLiveness } from '../src/process-liveness.js';

describe('a held unit is listed before it starts', () => {
  for (const delayMs of [0, 50]) {
    it(`its shadow exists when the work begins (shadow write takes ${delayMs} ms)`, async () => {
      // A store other processes reach, with its own liveness: the only kind a shadow is written for.
      const dir = mkdtempSync(join(tmpdir(), 'gnl-hold-'));
      const storage = new SqliteStorage(join(dir, 'h.db'));
      await storage.init?.();
      const journal = toJournal(storage.runs) as any;
      await storeLiveness(journal, { own: () => (storage as any).processLiveness?.() });
      const put = journal.put.bind(journal);
      (journal as any).put = async (k: string, v: unknown) => { if (k.startsWith(HAND_PREFIX)) await new Promise((r) => setTimeout(r, delayMs)); return put(k, v); };
      let seen: string[] | undefined;
      await holdWhile(async () => { seen = (await journal.listKeys(HAND_PREFIX)); }, { journal, name: 'run-1', what: 'the run is executing' });
      expect(seen?.length, 'the shadow was written before the work began').toBe(1);
      expect(await journal.listKeys(HAND_PREFIX), 'and removed once it settled').toEqual([]);
      await storage.close?.();
      rmSync(dir, { recursive: true, force: true });
    });
  }
});
