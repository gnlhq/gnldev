// Audit B (queue): a late report (`qlate`) of a job whose owner is erased while the report is being
// recorded must not leave anything of the job behind (`recordLateSuccess` reads `qtry`, then writes
// `qlate` — an erasure in between).
import { describe, it, expect } from 'vitest';
import { InMemoryStorage } from '@gnldev/durable';
import { enqueue, createWorker, jobEraser } from '../../src/index.js';

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe('a late report racing the owner\'s erasure', () => {
  it('leaves no qlate record of an erased person\'s job', async () => {
    const warn = console.warn; console.warn = () => undefined;
    try {
      const storage = new InMemoryStorage();
      const work: any = storage.work!;
      const id = await enqueue(work, 't', {}, { id: 'late', resourceId: 'alice' });
      let starts = 0;
      let firstDone = false;
      let releaseFirst!: () => void;
      const handlers = {
        t: async () => {
          starts++;
          if (starts === 1) { await new Promise<void>((r) => { releaseFirst = r; }); firstDone = true; return; }
          await sleep(300);
        },
      };
      // The erasure lands between the late report's read of `qtry` and its write of `qlate`.
      const origGet = work.get.bind(work);
      let erasedInBetween = false;
      work.get = async (key: string) => {
        const v = await origGet(key);
        if (firstDone && !erasedInBetween && key === `qtry:${id}`) { erasedInBetween = true; await jobEraser(storage).erase({ resourceId: 'alice' }); }
        return v;
      };
      void createWorker(storage, handlers, { ttlMs: 60, heartbeat: false, maxAttempts: 3 }).runOnce();
      await sleep(150);
      const second = createWorker(storage, handlers, { ttlMs: 60, heartbeat: false, maxAttempts: 3 }).runOnce();
      await sleep(15);
      releaseFirst();
      await second;
      await sleep(100);
      const left: string[] = [];
      for (const m of ['qdone', 'qfail', 'qcancel', 'qatt', 'qtry', 'qlate', 'qown']) if ((await origGet(`${m}:${id}`)) !== undefined) left.push(`${m}:${id}`);
      expect({ erasedInBetween, left }).toEqual({ erasedInBetween: true, left: [] });
    } finally {
      console.warn = warn;
    }
  });
});
