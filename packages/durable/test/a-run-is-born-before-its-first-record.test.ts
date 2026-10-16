// A run's first record is its birth (run-identity.ts `claimRunOwner`, which holds the run-id gate). Every
// writer that could put a row under an id nobody had begun used to make that id read as a run that exists
// — staff's, `runOwnerOf` — lost to whoever could still begin it (BIRTH.md, B1–B4, red on 926aeca9).
// Each bypass below, and its siblings, now either births the run through the one birth or — when the
// operation continues a run — finds it absent and writes nothing.
import { describe, it, expect } from 'vitest';
import { tool } from 'ai';
import { z } from 'zod';
import { workflow, step, cancelWorkflowRun, forkWorkflowRun, RunNotFoundError as WorkflowRunNotFoundError } from '@gnldev/workflow';
import { InMemoryJournal } from '../src/journal.js';
import { InMemoryStorage } from '../src/in-memory-storage.js';
import { toJournal } from '../src/storage.js';
import { withOrg } from '../src/organization.js';
import { durableTool } from '../src/durable-tool.js';
import { withDurableModel } from '../src/durable-model.js';
import { cancelAgentRun } from '../src/cancel.js';
import { compensateRun } from '../src/compensation.js';
import { runDurable } from '../src/run.js';
import { createGnl } from '../src/registry.js';
import { DetachedRuns } from '../src/detached.js';
import { inMemoryLiveness } from '../src/process-liveness.js';
import { runFailed } from '../src/outcome.js';
import { runOwnerOf, runIdentity, user, STAFF } from '../src/run-identity.js';
import { RunNotFoundError, RunOwnerMismatchError, RunTargetMismatchError } from '../src/errors.js';
import { drainWitness } from '../../../test/birth-witness.setup.js';
import { createMockModel, finalTextResult } from './mock.js';

const text = () => createMockModel(async () => finalTextResult('ok'));
const echo = () => tool({ description: 'd', inputSchema: z.object({ x: z.string() }), execute: async (i) => i.x });
const ownerOf = async (j: InMemoryJournal, id: string) => {
  const o = await runOwnerOf(j, id);
  return o.state === 'owned' ? (o.owner.kind === 'user' ? `user:${o.owner.id}` : o.owner.kind) : o.state;
};

describe('B1 — a primitive handed any id (Studio\'s approve path: durableTool + the request\'s runId)', () => {
  it('an engine-begun id it names is refused before a row is written: the owner\'s sub-agent can still be born there', async () => {
    const j = new InMemoryJournal();
    const t = durableTool(echo() as any, { journal: j, runId: 'agent:victim:c1', identity: runIdentity(STAFF, 'agent:victim:c1'), approvals: { t1: true } } as any, 'echo');
    await expect(t.execute!({ x: 'forged' } as any, { toolCallId: 't1' } as any)).rejects.toThrow(/made by the engine/);
    expect(await j.listKeys('agent:victim:c1')).toEqual([]);
  });

  it('SIBLING — a spelling inside another run\'s records is refused the same way', async () => {
    const j = new InMemoryJournal();
    const t = durableTool(echo() as any, { journal: j, runId: 'p:tool', identity: runIdentity(STAFF, 'p:tool') } as any, 'echo');
    await expect(t.execute!({ x: 'a' } as any, { toolCallId: 't1' } as any)).rejects.toThrow(/record separator/);
    expect(await j.listKeys('p')).toEqual([]);
  });

  it('SIBLING — a fresh id of its own is born for the identity it acts for (not left to read as staff\'s)', async () => {
    const j = new InMemoryJournal();
    const t = durableTool(echo() as any, { journal: j, runId: 'mine-1', identity: runIdentity(user('ayse'), 'mine-1') } as any, 'echo');
    expect(await t.execute!({ x: 'a' } as any, { toolCallId: 't1' } as any)).toBe('a');
    expect(await ownerOf(j, 'mine-1')).toBe('user:ayse');
  });

  it('SIBLING — the model primitive (withDurableModel) refuses an engine-begun id before its first step', async () => {
    const j = new InMemoryJournal();
    const m = withDurableModel(text() as any, { journal: j, runId: 'task:victim:c', identity: runIdentity(STAFF, 'task:victim:c') } as any);
    await expect((m as any).doGenerate({ prompt: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }] })).rejects.toThrow(/made by the engine/);
    expect(await j.listKeys('task:victim:c')).toEqual([]);
  });

  it('SIBLING — a run that exists is continued as it is: its recorded owner stays', async () => {
    const j = new InMemoryJournal();
    await runDurable({ runId: 'r-own', journal: j, model: text(), prompt: 'p', caller: user('ayse') } as any);
    const t = durableTool(echo() as any, { journal: j, runId: 'r-own', identity: runIdentity(STAFF, 'r-own') } as any, 'echo');
    await t.execute!({ x: 'a' } as any, { toolCallId: 't9' } as any);
    expect(await ownerOf(j, 'r-own')).toBe('user:ayse');
  });
});

describe('B2 — @gnldev/workflow, which cannot depend on this package, births through the journal it is handed (beginRun)', () => {
  it('an engine-begun id (Studio\'s runManaged with the request\'s runId) is refused, nothing written', async () => {
    const j = new InMemoryJournal();
    const wf = workflow<any>().then(step('s', async () => 1));
    await expect((wf as any).runResumable({}, { runId: 'agent:victim:c2', journal: j })).rejects.toThrow(/made by the engine/);
    expect(await j.listKeys('agent:victim:c2')).toEqual([]);
    expect(await j.listKeys('wfrun:')).toEqual([]);
  });

  it('SIBLING — a fresh id is born for the identity in the ctx', async () => {
    const j = new InMemoryJournal();
    const wf = workflow<any>().then(step('s', async () => 1));
    await wf.run({}, { runId: 'w-1', journal: j, identity: { kind: 'user', id: 'ayse', runId: 'w-1' } });
    expect(await ownerOf(j, 'w-1')).toBe('user:ayse');
  });

  it('SIBLING — an agent run\'s id is not a workflow\'s to write under (target), nothing new written', async () => {
    const j = new InMemoryJournal();
    await runDurable({ runId: 'a-1', journal: j, model: text(), prompt: 'p', caller: user('ayse') } as any);
    const before = await j.listKeys('a-1');
    const wf = workflow<any>().then(step('s', async () => 1));
    // Asked as the run's owner: the target is what refuses. A stranger is refused as one (below) —
    // a run's target is named only to someone who may act on it (assertRunTarget).
    await expect(wf.run({}, { runId: 'a-1', journal: j, identity: { kind: 'user', id: 'ayse', runId: 'a-1' } })).rejects.toBeInstanceOf(RunTargetMismatchError);
    expect(await j.listKeys('a-1')).toEqual(before);
  });

  it('SIBLING — a stranger naming an agent run\'s id is refused as a stranger, not told its target, nothing new written', async () => {
    const j = new InMemoryJournal();
    await runDurable({ runId: 'a-2', journal: j, model: text(), prompt: 'p', caller: user('ayse') } as any);
    const before = await j.listKeys('a-2');
    const wf = workflow<any>().then(step('s', async () => 1));
    await expect(wf.run({}, { runId: 'a-2', journal: j })).rejects.toBeInstanceOf(RunOwnerMismatchError);
    expect(await j.listKeys('a-2')).toEqual(before);
  });

  it('SIBLING — every durable journal carries the birth: an organization view, the storage bridge', async () => {
    for (const j of [withOrg(new InMemoryJournal(), 'acme'), toJournal(new InMemoryStorage().runs)]) {
      const wf = workflow<any>().then(step('s', async () => 1));
      await expect(wf.run({}, { runId: 'task:p:c', journal: j as any })).rejects.toThrow(/made by the engine/);
    }
  });

  it('SIBLING — a fork is born to its source\'s owner before a row is copied', async () => {
    const j = new InMemoryJournal();
    const wf = workflow<any>().then(step('a', async () => 1)).then(step('b', async () => 2));
    await wf.run({}, { runId: 'src-w', journal: j, identity: { kind: 'user', id: 'ayse', runId: 'src-w' } });
    await forkWorkflowRun(j, wf, 'src-w', 'b', 'dst-w');
    expect(await ownerOf(j, 'dst-w')).toBe('user:ayse');
    await expect(forkWorkflowRun(j, wf, 'src-w', 'b', 'task:p:c')).rejects.toThrow(/made by the engine/);
    expect(await j.listKeys('task:p:c')).toEqual([]);
  });

  it('SIBLING — a plain store without beginRun keeps no owners, as before', async () => {
    const m = new Map<string, unknown>();
    const plain = { get: async (k: string) => m.get(k), put: async (k: string, v: unknown) => { m.set(k, v); } };
    const wf = workflow<any>().then(step('s', async () => 1));
    expect(await wf.run({}, { runId: 'w-plain', journal: plain })).toBe(1);
    expect([...m.keys()].some((k) => k.endsWith(':input'))).toBe(false);
  });

  it('the registry path is unchanged: a workflow run via createGnl is born once, for its caller', async () => {
    const j = new InMemoryJournal();
    const gnl = createGnl({ journal: j, workflows: { w: workflow<any>().then(step('s', async () => 1)) } } as any);
    await gnl.runWorkflow!('w', {}, { runId: 'w-ok', caller: user('ayse') } as any);
    expect(await ownerOf(j, 'w-ok')).toBe('user:ayse');
  });
});

describe('B3/B4 — an operation that continues a run, on a run that does not exist: not found, nothing written', () => {
  it('B3 cancelAgentRun — and the id can still be born by its user', async () => {
    const j = new InMemoryJournal();
    await expect(cancelAgentRun(j, 'r-nope')).rejects.toBeInstanceOf(RunNotFoundError);
    expect(await j.listKeys('r-nope')).toEqual([]);
    await runDurable({ runId: 'r-nope', journal: j, model: text(), prompt: 'p', caller: user('ayse') } as any);
    expect(await ownerOf(j, 'r-nope')).toBe('user:ayse');
  });

  it('B4 compensateRun (dry run too)', async () => {
    const j = new InMemoryJournal();
    await expect(compensateRun('r-nope2', { journal: j as any })).rejects.toBeInstanceOf(RunNotFoundError);
    await expect(compensateRun('r-nope2', { journal: j as any, dryRun: true })).rejects.toBeInstanceOf(RunNotFoundError);
    expect(await j.listKeys('r-nope2')).toEqual([]);
  });

  it('SIBLING — cancelWorkflowRun (the workflow package\'s own answer, same name)', async () => {
    const j = new InMemoryJournal();
    await expect(cancelWorkflowRun(j, 'w-nope')).rejects.toBeInstanceOf(WorkflowRunNotFoundError);
    expect((await j.listKeys('w-nope')).concat(await j.listKeys('wfrun:'))).toEqual([]);
  });

  it('SIBLING — a run that exists is still canceled', async () => {
    const j = new InMemoryJournal();
    await runDurable({ runId: 'r-yes', journal: j, model: text(), prompt: 'p' } as any);
    await expect(cancelAgentRun(j, 'r-yes')).resolves.toBeUndefined();
  });

  it('SIBLING — the executor driven without an admission writes no event log for a launch that began no run', async () => {
    const j = new InMemoryJournal();
    const runs = new DetachedRuns({ journal: j as any, liveness: inMemoryLiveness(), resume: () => { throw new Error('no'); }, sweepMs: 0 });
    try {
      await runs.start({ runId: 'never-began', launch: async () => ({ fullStream: (async function* () { /* nothing */ })() }) });
      await new Promise((r) => setTimeout(r, 20));
    } finally { await runs.close(); }
    expect(await j.listKeys('never-began')).toEqual([]);
  });
});

describe('the birth witness (test/birth-witness.setup.ts) sees a record written under an unborn id', () => {
  it('an engine writer that skips the birth is named; one after the birth is not', async () => {
    const j = new InMemoryJournal();
    drainWitness();
    await runFailed(j, 'unborn-x', new Error('x'), Date.now());
    const seen = drainWitness();
    expect(seen.join('\n')).toMatch(/unborn-x:outcome .*outcome\.ts/);
    await runDurable({ runId: 'born-x', journal: j, model: text(), prompt: 'p' } as any);
    await runFailed(j, 'born-x', new Error('x'), Date.now());
    expect(drainWitness()).toEqual([]);
  });

  it('a refusal by the birth is not mistaken for a write: RunOwnerMismatchError carries no row', async () => {
    const j = new InMemoryJournal();
    await expect(runDurable({ runId: 'cont:p:c', journal: j, model: text(), prompt: 'p' } as any)).rejects.toBeInstanceOf(RunOwnerMismatchError);
    expect(await j.listKeys('cont:p:c')).toEqual([]);
    expect(drainWitness()).toEqual([]);
  });
});
