// d25 U10 — a run that failed before any model step (provider refused the first call) is listed by `runs` yet
// `GET /runs/:id` (and `gnl run`, which reads the same `journal.readRun`) answer "not found".
// Red = claim holds.
import { describe, it, expect, vi } from 'vitest';
import { InMemoryStorage, toJournal } from '@gnldev/durable';
import { createRestApi } from '../src/index.js';

const failing: any = { specificationVersion: 'v2', provider: 'mock', modelId: 'm', supportedUrls: {},
  doGenerate: async () => { throw new Error('403 Forbidden'); }, doStream: async () => { throw new Error('403 Forbidden'); } };

describe('U10 zero-step failed run', () => {
  it('listed, but not readable', async () => {
    const storage = new InMemoryStorage();
    const api = createRestApi({ storage, agents: { a: { model: failing } } } as never, { protectionsBanner: false }) as (r: Request) => Promise<Response>;
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const run = await api(new Request('http://localhost/agents/a/run', { method: 'POST', headers: { 'content-type': 'application/json', host: 'localhost' }, body: JSON.stringify({ runId: 'u10-r1', prompt: 'hi' }) }));
    console.log('POST /agents/a/run ->', run.status);
    const list = await (await api(new Request('http://localhost/runs'))).json() as any[];
    const one = await api(new Request('http://localhost/runs/u10-r1'));
    const j = toJournal(storage.runs);
    const entries = await j.readRun('u10-r1');
    const summary = (await j.listRuns()).find((r: any) => r.runId === 'u10-r1');
    console.log('GET /runs lists it:', list.some((r: any) => r.runId === 'u10-r1'), '| status', summary?.status, '| readRun entries:', entries.length, '| GET /runs/u10-r1 ->', one.status);
    expect(list.some((r: any) => r.runId === 'u10-r1')).toBe(true);
    expect(one.status).toBe(200);   // red => claim holds
    expect(await one.json()).toEqual([]);   // the truthful journal of a run with no steps
    expect((await api(new Request('http://localhost/runs/never-existed'))).status).toBe(404);   // an id with no record is still 404
  });
});
