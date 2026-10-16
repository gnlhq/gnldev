// Every write of a job's state goes through the job's erasure fence (`putJobMarker`: written, then the
// fence read last; the eraser deletes the fence first). Siblings of audit Q2 (a late report left `qlate`
// under an erased person's id): the worker that HOLDS the job is past its ownership check when the
// erasure runs —
//   · before it writes the job's result (`qdone`);
//   · before it counts the attempt it is starting (`qtry`): the handler does not run at all.
// Either way nothing of the person's job is left.
import { describe, it, expect } from 'vitest';
import { InMemoryStorage } from '@gnldev/durable';
import { enqueue, createWorker, jobEraser } from '../../src/index.js';

const MARKERS = ['qdone', 'qfail', 'qcancel', 'qatt', 'qtry', 'qlate', 'qown'];

async function erasedBefore(marker: 'qdone' | 'qtry') {
  const storage = new InMemoryStorage();
  const work: any = storage.work!;
  const id = await enqueue(work, 't', {}, { id: 'x', resourceId: 'alice' });
  const origPut = work.put.bind(work);
  let erased = false;
  // The erasure lands after the holder's ownership check, before this write of its.
  work.put = async (key: string, value: unknown) => {
    if (!erased && key === `${marker}:${id}`) { erased = true; await jobEraser(storage).erase({ resourceId: 'alice' }); }
    return origPut(key, value);
  };
  let ran = 0;
  await createWorker(storage, { t: async () => { ran++; } }, { maxAttempts: 3 }).runOnce();
  const left: string[] = [];
  for (const m of MARKERS) if ((await work.get(`${m}:${id}`)) !== undefined) left.push(m);
  return { erased, left, ran };
}

describe("a worker's write racing its job owner's erasure", () => {
  it('the result (`qdone`): taken back, nothing left', async () => {
    expect(await erasedBefore('qdone')).toEqual({ erased: true, left: [], ran: 1 });
  });

  it('the attempt it starts (`qtry`): taken back, and the handler does not run', async () => {
    expect(await erasedBefore('qtry')).toEqual({ erased: true, left: [], ran: 0 });
  });
});
