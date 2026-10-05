// What a JavaScript caller (no type checker) meets when it hands queue/events the wrong part of a
// storage: the storage itself is taken, a different part is refused naming what it is and what to
// pass. It met "work.append is not a function" and "Cannot read properties of undefined (reading
// 'work')". One reading for every package: @gnldev/durable portOf / storageOf.
import { describe, it, expect } from 'vitest';
import { InMemoryStorage } from '@gnldev/durable';
import { enqueue, listJobs, createWorker } from '../src/index.js';
import { emit } from '../../events/src/index.js';

describe('the right handle, or a sentence that names it', () => {
  it('enqueue(storage) takes the storage itself', async () => {
    const st: any = new InMemoryStorage();
    const id = await (enqueue as any)(st, 'send', { to: 'a' });
    expect((await listJobs(st.work)).map((j) => j.id)).toContain(id);
  });
  it('enqueue(storage.runs) → refused, naming the run journal and storage.work', async () => {
    const st: any = new InMemoryStorage();
    await expect((enqueue as any)(st.runs, 'send', {})).rejects.toThrow(/enqueue: .*run journal \(storage\.runs\).*storage\.work/s);
  });
  it('enqueue(undefined) → refused, naming the two calls that work', async () => {
    await expect((enqueue as any)(undefined, 'send', {})).rejects.toThrow(/enqueue needs the storage or its work port, got undefined/);
  });
  it('createWorker(storage.work) → refused, naming it as the work port', () => {
    const st: any = new InMemoryStorage();
    expect(() => (createWorker as any)(st.work, {})).toThrow(/createWorker needs the whole storage.*work port \(storage\.work\)/s);
  });
  it('emit(storage.runs) → refused the same way', async () => {
    const st: any = new InMemoryStorage();
    await expect((emit as any)(st.runs, 'topic', {})).rejects.toThrow(/emit: .*run journal \(storage\.runs\)/s);
  });
});
