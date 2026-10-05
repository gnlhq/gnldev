// Studio shows a workflow step's output as the step returned it — on every surface that reads step
// records: the playground run (POST /workflows/:name/run on a managed workflow), the run view
// (GET /workflows/run/:runId). The playground read the raw record, so a void step showed the engine's
// internal record instead of `undefined`, and the run view read `{ __gnlVoid: true }` (a value a step
// may legitimately return) as `undefined`. Both now read through @gnldev/durable's `decodeStepRecord`.
import { describe, it, expect } from 'vitest';
import { InMemoryJournal } from '@gnldev/durable';
import { workflow, step } from '@gnldev/workflow';
import { createStudioApi, type WorkflowDef } from '../src/server.js';
import { call } from './call.js';

function makeApp(journal: InMemoryJournal) {
  const defs = new Map<string, WorkflowDef>([['m', { name: 'm', steps: [{ id: 'x', agentName: 'a', prompt: 'p' }] }]]);
  return createStudioApi({
    reader: journal,
    gnl: { listAgents: () => [], run: async () => ({ text: 'x' }), listWorkflows: () => [], runWorkflow: async () => ({ runId: 'r', steps: [] }) },
    // A compiled workflow whose steps return a void and a record-shaped value.
    compileWorkflow: (() =>
      workflow()
        .then(step('notify', async () => undefined))
        .then(step('flag', async () => ({ __gnlVoid: true })))
        .then(step('wrapped', async () => ({ __gnlStepRecord: 'void' })))) as any,
    workflowStore: { list: () => [...defs.values()], get: (n) => defs.get(n), set: (d) => { defs.set(d.name, d); }, delete: (n) => { defs.delete(n); } },
  } as any);
}

const EXPECTED = { notify: undefined, flag: { __gnlVoid: true }, wrapped: { __gnlStepRecord: 'void' } };

describe('Studio reports each workflow step as it returned', () => {
  it('the playground run (managed workflow)', async () => {
    const journal = new InMemoryJournal();
    const app = makeApp(journal);
    const res = await (await call(app, '/workflows/m/run', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ input: 1, runId: 'pg-1' }) })).json();
    expect(res.ok).toBe(true);
    const byId = Object.fromEntries(res.steps.map((s: any) => [s.id, s.output]));
    expect(byId).toEqual(EXPECTED);
  });

  it('the run view of the same run', async () => {
    const journal = new InMemoryJournal();
    const app = makeApp(journal);
    await call(app, '/workflows/m/run', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ input: 1, runId: 'pg-2' }) });
    const view = await (await call(app, '/workflows/run/pg-2')).json();
    const byId = Object.fromEntries(view.steps.map((s: any) => [s.stepId, s.output]));
    expect(byId).toEqual(EXPECTED);
  });
});
