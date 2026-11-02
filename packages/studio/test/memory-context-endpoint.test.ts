// GET /runs/:id/memory-context — the ':memctx' provenance record durable freezes next to ':input'
// (see run.ts persistMemoryContext): recall hits with similarity, recent-window count, WM/OM, and
// the echo-trim counters. Contract: `null` (not an error) for runs without a record — old runs,
// memory-less runs, read-only journals. Beside it, durable's own reading of the record's layout: present,
// or absent with the reason — never a crash, whatever shape the record has.
import { describe, it, expect } from 'vitest';
import { InMemoryJournal, runKeys, runDurable } from '@gnldev/durable';
import { createMockModel, finalTextResult } from '../../durable/test/mock.js';
import { createStudioApi } from '../src/server.js';
import { call } from './call.js';

describe('GET /runs/:id/memory-context', () => {
  it('serves the frozen provenance record', async () => {
    const journal = new InMemoryJournal();
    const rec = {
      v: 1, threadId: 'th-1',
      recalled: [{ threadId: 'th-1', seq: 4, role: 'user', preview: 'refund policy…', score: 0.87 }],
      recentCount: 6, workingMemoryChars: 42, incomingCount: 1, echoTrimmed: 2,
    };
    await journal.put(runKeys.memoryContext('r1'), rec);

    const app = createStudioApi({ reader: journal });
    const res = await call(app, '/runs/r1/memory-context');
    expect(res.status).toBe(200);
    expect((await res.json()).context).toEqual(rec);
  });

  it('no record → { context: null }, still 200', async () => {
    const app = createStudioApi({ reader: new InMemoryJournal() });
    const res = await call(app, '/runs/unknown/memory-context');
    expect(res.status).toBe(200);
    expect((await res.json()).context).toBeNull();
  });

  it('a run with a layout reads present; a record without one reads absent with the reason', async () => {
    const journal = new InMemoryJournal();
    const memory: any = {
      async getMessages() { return []; }, async append() {},
      async loadContext() { return { messages: [{ role: 'user', content: 'old' }, { role: 'assistant', content: 'old answer' }], provenance: { recalled: [], recentCount: 2 } }; },
    };
    await runDurable({ runId: 'r2', journal, memory, threadId: 't', prompt: 'q', model: createMockModel(async () => finalTextResult('a')) } as any);
    const app = createStudioApi({ reader: journal });
    const present = await (await call(app, '/runs/r2/memory-context')).json();
    expect(present.layout).toMatchObject({ status: 'present', layout: { v: 1, n: 3, status: 'exact', recent: [0, 2], incoming: [2, 3] } });
    expect((await (await call(app, '/runs/r1/memory-context')).json()).layout).toEqual({ status: 'absent', reason: 'no-record' });
    await journal.put(runKeys.memoryContext('r3'), { v: 1, threadId: 't', recalled: [], recentCount: 2, incomingCount: 1, echoTrimmed: 0 });
    expect((await (await call(app, '/runs/r3/memory-context')).json()).layout).toEqual({ status: 'absent', reason: 'no-layout' });
    await journal.put(runKeys.memoryContext('r4'), 'not a record');
    expect((await (await call(app, '/runs/r4/memory-context')).json()).layout).toEqual({ status: 'absent', reason: 'malformed' });
  });
});
