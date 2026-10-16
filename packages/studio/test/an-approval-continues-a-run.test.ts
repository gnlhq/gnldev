// Two Studio paths took a run id from the request body and wrote under it without a birth (BIRTH.md B1,
// B2): the tool test-run's approve (`runTool` with `approve: { runId }`) ran the tool under any id, and a
// managed workflow ran under any `runId`. Their rows made the id read as a run that exists (staff's) —
// an engine-begun id included, which then could never be born by the engine for its owner.
import { describe, it, expect } from 'vitest';
import { InMemoryJournal, createGnl, runOwnerOf, user } from '@gnldev/durable';
import { createStudioRunner } from '../src/runner.js';
import { createStudioApi, type WorkflowDef } from '../src/server.js';
import { compileManagedWorkflow } from '../src/managed-workflow.js';
import { call } from './call.js';

function runnerOn(journal: InMemoryJournal) {
  const pay = { description: 'pay', execute: async (i: { n?: number }) => ({ paid: i?.n ?? 0 }) };
  const config = { journal, agents: { a: { model: { specificationVersion: 'v4', provider: 'm', modelId: 'm', supportedUrls: {}, doGenerate: async () => ({}) }, tools: { pay } } } } as any;
  return createStudioRunner(createGnl(config) as never, config, { toolExec: true }) as any;
}

describe("the tool test-run's approve continues a run; it does not begin one", () => {
  it.each(['agent:victim:c1', 'r-absent'])('an approve naming %s (no such run) is not found, and nothing is written under it', async (runId) => {
    const journal = new InMemoryJournal();
    const r = await runnerOn(journal).runTool('pay', { n: 1 }, { approve: { runId, toolCallId: 't1', approved: true } }, { caller: { kind: 'staff' } });
    expect(r).toEqual({ error: 'run not found' });
    expect(await journal.listKeys(runId)).toEqual([]);
  });

  it('SIBLING — a run that exists is reached, and its tool acts for the run\'s recorded owner', async () => {
    const journal = new InMemoryJournal();
    const runner = runnerOn(journal);
    const first = await runner.runTool('pay', { n: 1 }, { durable: true }, { caller: user('u-ayse') });
    expect(first.runId).toMatch(/^tooltest-pay-/);
    expect((await runOwnerOf(journal, first.runId)).state, 'the durable test-run is born for its caller').toBe('owned');
    const again = await runner.runTool('pay', { n: 1 }, { approve: { runId: first.runId, toolCallId: 't2', approved: true } }, { caller: { kind: 'staff' } });
    expect(again.error).toBeUndefined();
  });

  it('SIBLING — a user may not approve under another user\'s run (not found, not "forbidden")', async () => {
    const journal = new InMemoryJournal();
    const runner = runnerOn(journal);
    const first = await runner.runTool('pay', { n: 1 }, { durable: true }, { caller: user('u-ayse') });
    const before = await journal.listKeys(first.runId);
    expect(await runner.runTool('pay', { n: 1 }, { approve: { runId: first.runId, toolCallId: 't3', approved: true } }, { caller: user('u-mallory') })).toEqual({ error: 'run not found' });
    expect(await journal.listKeys(first.runId)).toEqual(before);
  });
});

describe('a managed workflow is born through the journal it runs on', () => {
  const app = (journal: InMemoryJournal) => {
    const defs = new Map<string, WorkflowDef>([['m1', { name: 'm1', steps: [{ id: 's1', agentName: 'writer', prompt: 'Topic: {{input}}' }] }]]);
    return createStudioApi({
      reader: journal,
      gnl: { listAgents: () => [], run: async () => ({ text: 'ok' }), listWorkflows: () => [], runWorkflow: async () => ({ runId: 'r', steps: [] }) },
      compileWorkflow: compileManagedWorkflow,
      workflowStore: { list: () => [...defs.values()], get: (n) => defs.get(n), set: (d) => { defs.set(d.name, d); }, delete: (n) => { defs.delete(n); } },
    });
  };
  const post = (a: any, body: unknown) => call(a, '/workflows/m1/run', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });

  it('a request runId of an engine-begun family is refused, nothing written under it', async () => {
    const journal = new InMemoryJournal();
    const res = await post(app(journal), { input: 'x', runId: 'agent:victim:c2' });
    expect(res.status).toBe(400);
    expect(await journal.listKeys('agent:victim:c2')).toEqual([]);
  });

  it('SIBLING — an ordinary runId is born (owned), its steps written after', async () => {
    const journal = new InMemoryJournal();
    const res = await post(app(journal), { input: 'x', runId: 'm-1' });
    expect(res.status, await res.clone().text()).toBe(200);
    expect((await runOwnerOf(journal, 'm-1')).state).toBe('owned');
  });
});
