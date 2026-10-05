// A person's run list should show their requests, not every sub-agent each request started (measured on
// a ward round list: 56 of 68 rows were sub-agents). A child's summary carries `parentRunId`, and
// `topLevel` leaves the children out — the same filter-before-slice contract on every adapter.
import { describe, it, expect } from 'vitest';
import { InMemoryStorage, createGnl, STAFF } from '../src/index.js';
import { SqliteStorage } from '../src/sqlite-storage.js';
import { createMockModel, toolCallResult, finalTextResult } from './mock.js';

describe.each([['InMemory', () => new InMemoryStorage()], ['Sqlite', () => new SqliteStorage(':memory:')]])('run list, %s', (_n, make) => {
  it('children carry parentRunId; topLevel shows the request only', async () => {
    const storage = make() as any;
    const parent = createMockModel(async ({ prompt }: any) => (prompt.filter((m: any) => m.role === 'tool').length >= 2 ? finalTextResult('ok')
      : toolCallResult('agent_helper', `p${prompt.filter((m: any) => m.role === 'tool').length}`, { task: 'x' })));
    const helper = createMockModel(async () => finalTextResult('done'));
    await createGnl({ storage, agents: { parent: { model: parent, agents: ['helper'] }, helper: { model: helper } } } as any)
      .run('parent', { runId: 'req', prompt: 'go', caller: STAFF } as any);
    const j = storage.runs;
    const all = (await j.listRuns()).items;
    expect(all.filter((r: any) => r.parentRunId === 'req').map((r: any) => r.runId).sort()).toEqual(['agent:req:p0', 'agent:req:p1']);
    expect((await j.listRuns({ topLevel: true })).items.map((r: any) => r.runId)).toEqual(['req']);
    // the same filter combined with another one takes the other list path in the SQL adapters
    expect((await j.listRuns({ topLevel: true, agent: 'parent' })).items.map((r: any) => r.runId)).toEqual(['req']);
  });
});
