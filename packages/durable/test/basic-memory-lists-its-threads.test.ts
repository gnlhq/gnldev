// BasicMemory keeps a thread's messages in the runs journal; Studio's thread list asks the memory for
// its threads. Without a listing every BasicMemory deployment showed Studio no conversations at all.
import { describe, it, expect } from 'vitest';
import { InMemoryJournal, BasicMemory, runDurable, withOrg } from '../src/index.js';
import { createMockModel, finalTextResult } from './mock.js';

const model = () => createMockModel(async () => finalTextResult('ok'));

describe('BasicMemory lists its threads', () => {
  it('every thread with a message log, its owner, newest first; one resource\'s alone', async () => {
    const j = new InMemoryJournal();
    const memory = new BasicMemory(j);
    await runDurable({ runId: 'a', journal: j, memory, threadId: 'older', resourceId: 'ayse', model: model(), prompt: 'hi' } as any);
    await new Promise((s) => setTimeout(s, 5));
    await runDurable({ runId: 'b', journal: j, memory, threadId: 'newer', resourceId: 'bora', model: model(), prompt: 'hi' } as any);
    await memory.setWorkingMemory('older', 'address: Ankara'); // another leaf of the same thread is not another thread
    const all = await memory.listAllThreads();
    expect(all.map((t) => t.id)).toEqual(['newer', 'older']);
    expect(all.map((t) => t.resourceId)).toEqual(['bora', 'ayse']);
    expect(all[0]!.createdAt).toBeGreaterThan(all[1]!.createdAt);
    expect((await memory.listThreads({ resourceId: 'ayse' })).map((t) => t.id)).toEqual(['older']);
    expect(await memory.listThreads({ resourceId: '' })).toEqual([]);
  });

  it('a thread with no owner record is listed, its start unknown (0); another organization\'s is not', async () => {
    const j = new InMemoryJournal();
    await new BasicMemory(j).append('loose', [{ role: 'user', content: 'x' }]);
    await new BasicMemory(withOrg(j as any, 'globex') as any).append('theirs', [{ role: 'user', content: 'y' }]);
    expect(await new BasicMemory(withOrg(j as any, 'acme') as any).listAllThreads()).toEqual([]);
    expect((await new BasicMemory(j).listAllThreads()).find((t) => t.id === 'loose')).toEqual({ id: 'loose', createdAt: 0 });
  });
});
