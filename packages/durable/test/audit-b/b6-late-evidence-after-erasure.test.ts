// B6: a late success that finds its call already settled is kept as evidence (`<run>:proc:late-<call>`,
// attempt.ts keepLate). When the run is erased between the attempt's read of the call and that write,
// nothing of the run may come back — the queue's sibling (`qlate`) has the same shape.
import { describe, it, expect } from 'vitest';
import { InMemoryStorage, runKeys, claimRunOwner, user, purgeRun, type Journal } from '../../src/index.js';
import { SqliteStorage } from '../../src/sqlite-storage.js';
import { Attempt, compareAndSet } from '../../src/attempt.js';
import { stampFormat } from '../../src/format.js';

const STORES: Array<[string, () => any]> = [['in-memory', () => new InMemoryStorage()], ['sqlite', () => new SqliteStorage(':memory:')]];

describe.each(STORES)('B6 late evidence racing an erasure (%s)', (_n, make) => {
  it('an erasure between the late attempt\'s read and its evidence write leaves nothing of the run', async () => {
    const warn = console.warn; console.warn = () => undefined;
    try {
      const storage = make();
      const journal = storage.runs as Journal & Record<string, any>;
      const runId = 'r-late-erase';
      await claimRunOwner(journal as any, runId, user('alice'));
      const key = runKeys.tool(runId, 'call-1');
      const lateKey = runKeys.proc(runId, 'late-call-1');
      const at = journal.now ? await journal.now() : Date.now();
      // Settled by another attempt.
      await journal.put(key, stampFormat({ status: 'succeeded', output: 'by B', toolName: 'effect' }));
      // The erasure lands when the late attempt reads its evidence key.
      const origGet = journal.get.bind(journal);
      let erased = false;
      (journal as any).get = async (k: string) => {
        if (k === lateKey && !erased) { erased = true; await purgeRun(journal as any, runId); }
        return origGet(k);
      };
      const stamp = stampFormat({ status: 'running', startedAt: at, attempts: 1, claimTtlMs: 60_000, idempotencyKey: `${runId}:call-1`, proc: 'A' }) as any;
      const write = (rec: any, expected: unknown) => compareAndSet(journal, key, expected, stampFormat(rec));
      // The attempt names its run (whose erasure fences the report); the report's key is derived from the record's.
      const attempt = new Attempt(journal, key, undefined, stamp, performance.now(), 'effect', write, { runId });
      await attempt.succeed({ status: 'succeeded', output: 'by A', toolName: 'effect' } as any);
      (journal as any).get = origGet;
      const left = ((await journal.listKeys!(`${runId}:`)) as string[]);
      expect({ erased, left }).toEqual({ erased: true, left: [] });
    } finally {
      console.warn = warn;
    }
  });
});
