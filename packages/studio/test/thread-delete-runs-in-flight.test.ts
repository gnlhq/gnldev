// DELETE /threads/:id deletes the thread WITH ITS RUNS (C+ step C: `AgentMemory.deleteThread` runs
// @gnldev/durable's one thread plan). While a run on the thread is still writing, the memory refuses
// with `ThreadRunsInFlightError` and deletes nothing — and the route answers that as 409
// `thread_runs_in_flight` naming the runs, not as the generic 400 a host could not tell from a typo.
// (What the delete takes is proven against real stores in @gnldev/memory's dependents-model.test.ts.)
import { describe, it, expect } from 'vitest';
import { InMemoryJournal, ThreadRunsInFlightError } from '@gnldev/durable';
import { createStudioApi } from '../src/server.js';
import { call } from './call.js';

describe('DELETE /threads/:id', () => {
  it('a run on the thread in flight: 409 thread_runs_in_flight with the runs, and no audit of a delete that did not happen', async () => {
    const calls: string[] = [];
    const memory = {
      listThreads: () => [], getMessages: () => [],
      deleteThread: async (id: string) => { calls.push(id); throw new ThreadRunsInFlightError(id, ['r-busy']); },
    };
    const app = createStudioApi({ reader: new InMemoryJournal(), memory });
    const res = await call(app, '/threads/t-1', { method: 'DELETE' });
    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({ code: 'thread_runs_in_flight', runs: ['r-busy'] });
    expect(calls).toEqual(['t-1']);
    const audit = await (await call(app, '/audit?action=thread.delete')).json();
    expect(audit.items).toHaveLength(0);
  });

  it('otherwise the memory deletes it and the delete is audited', async () => {
    const calls: string[] = [];
    const memory = { listThreads: () => [], getMessages: () => [], deleteThread: async (id: string) => { calls.push(id); } };
    const app = createStudioApi({ reader: new InMemoryJournal(), memory });
    const res = await call(app, '/threads/t-1', { method: 'DELETE' });
    expect(res.status).toBe(200);
    expect(calls).toEqual(['t-1']);
    expect((await (await call(app, '/audit?action=thread.delete')).json()).items).toHaveLength(1);
  });
});
