// Verification round 3 (audit only): hypotheses against the gate-at-birth change (29234fbc).
// Each `it` states the promise it attacks; a red one is a finding (raporlar/2026-10-16-verify/REPORT.md).
import { describe, it, expect } from 'vitest';
import { tool } from 'ai';
import { z } from 'zod';
import { workflow, step } from '@gnldev/workflow';
import { InMemoryJournal } from '../src/journal.js';
import { withOrg } from '../src/organization.js';
import { durableTool } from '../src/durable-tool.js';
import { cancelAgentRun } from '../src/cancel.js';
import { compensateRun } from '../src/compensation.js';
import { runDurable } from '../src/run.js';
import { purgeRun } from '../src/retention.js';
import { runFenceKey } from '../src/erasure-fence.js';
import { runOwnerOf, runIdentity, user } from '../src/run-identity.js';
import { RunNotFoundError } from '../src/errors.js';
import { createMockModel, finalTextResult } from './mock.js';

const text = () => createMockModel(async () => finalTextResult('ok'));
const ownerOf = async (j: InMemoryJournal | any, id: string) => {
  const o = await runOwnerOf(j, id);
  return o.state === 'owned' ? (o.owner.kind === 'user' ? `user:${o.owner.id}` : o.owner.kind) : o.state;
};
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe('V1 — two births racing for one new id, different owners (ownership)', () => {
  it('workflow: the loser of the birth race is refused, not run inside the winner\'s run', async () => {
    const j = new InMemoryJournal();
    const ranAs: string[] = [];
    const wf = workflow<any>().then(step('s', async (_i: any, ctx: any) => { ranAs.push(ctx.identity.id); await sleep(20); return `secret-of-${ctx.identity.id}`; }));
    const a = wf.run({}, { runId: 'race-w', journal: j, identity: { kind: 'user', id: 'ayse', runId: 'race-w' } });
    const b = wf.run({}, { runId: 'race-w', journal: j, identity: { kind: 'user', id: 'bora', runId: 'race-w' } });
    const [ra, rb] = await Promise.allSettled([a, b]);
    const owner = await ownerOf(j, 'race-w');
    // Exactly one of them may have acted in the run, and it must be the recorded owner.
    const fulfilled = [ra, rb].filter((r) => r.status === 'fulfilled').length;
    expect({ owner, fulfilled, ranAs }).toEqual({ owner: 'user:ayse', fulfilled: 1, ranAs: ['ayse'] });
  });

  it('primitive (durableTool, born on first write): the loser is refused, not given the winner\'s result', async () => {
    const j = new InMemoryJournal();
    let calls = 0;
    const t = () => tool({ description: 'd', inputSchema: z.object({ x: z.string() }), execute: async (i) => { calls++; await sleep(20); return i.x; } });
    const ta = durableTool(t() as any, { journal: j, runId: 'race-t', identity: runIdentity(user('ayse'), 'race-t') } as any, 'echo');
    const tb = durableTool(t() as any, { journal: j, runId: 'race-t', identity: runIdentity(user('bora'), 'race-t') } as any, 'echo');
    const [ra, rb] = await Promise.allSettled([
      ta.execute!({ x: 'ayse-secret' } as any, { toolCallId: 'c1' } as any),
      tb.execute!({ x: 'bora' } as any, { toolCallId: 'c1' } as any),
    ]);
    const owner = await ownerOf(j, 'race-t');
    const boraGot = rb.status === 'fulfilled' ? rb.value : 'refused';
    expect({ owner, boraGot }).toEqual({ owner: 'user:ayse', boraGot: 'refused' });
    void ra; void calls;
  });

  it('CONTROL — the agent door holds the loser (run.ts bornAs)', async () => {
    const j = new InMemoryJournal();
    const slow = () => createMockModel(async () => { await sleep(20); return finalTextResult('ok'); });
    const [ra, rb] = await Promise.allSettled([
      runDurable({ runId: 'race-a', journal: j, model: slow(), prompt: 'p', caller: user('ayse') } as any),
      runDurable({ runId: 'race-a', journal: j, model: slow(), prompt: 'p', caller: user('bora') } as any),
    ]);
    expect([ra, rb].filter((r) => r.status === 'fulfilled').length).toBe(1);
  });
});

describe('V2 — the workflow birth contract as documented (JournalLike.beginRun: "a run the identity may not act on is refused")', () => {
  it('a second identity naming an existing workflow run is refused, and does not read its steps', async () => {
    const j = new InMemoryJournal();
    const wf = workflow<any>().then(step('s', async (_i: any, ctx: any) => `secret-of-${ctx.identity.id}`));
    await wf.run({}, { runId: 'w-own', journal: j, identity: { kind: 'user', id: 'ayse', runId: 'w-own' } });
    const r = await wf.run({}, { runId: 'w-own', journal: j, identity: { kind: 'user', id: 'bora', runId: 'w-own' } }).then((v) => v, (e) => `refused: ${e?.name}`);
    expect(r).toMatch(/^refused/);
  });
});

describe('V3 — org scope vs root: one id, two places (org isolation)', () => {
  it('a birth in an organization and a birth at the root of the same id are two runs, two owners', async () => {
    const j = new InMemoryJournal();
    const org = withOrg(j, 'acme') as any;
    await org.beginRun('x-1', { identity: user('ayse') });
    await (j as any).beginRun('x-1', { identity: user('bora') });
    expect([await ownerOf(org, 'x-1'), await ownerOf(j, 'x-1')]).toEqual(['user:ayse', 'user:bora']);
  });

  it('SIBLING — an organization\'s run does not exist for the root (cancel at the root: not found)', async () => {
    const j = new InMemoryJournal();
    const org = withOrg(j, 'acme') as any;
    await org.beginRun('x-2', { identity: user('ayse') });
    await expect(cancelAgentRun(j, 'x-2')).rejects.toBeInstanceOf(RunNotFoundError);
    expect(await j.listKeys('x-2')).toEqual([]);
  });
});

describe('V4 — erasure, then the same id again (erasure completeness, truthful status)', () => {
  it('cancel / compensate on an erased run: not found, nothing written', async () => {
    const j = new InMemoryJournal();
    await runDurable({ runId: 'r-er', journal: j, model: text(), prompt: 'p', caller: user('ayse') } as any);
    await purgeRun(j as any, 'r-er');
    await expect(cancelAgentRun(j, 'r-er')).rejects.toBeInstanceOf(RunNotFoundError);
    await expect(compensateRun('r-er', { journal: j as any })).rejects.toBeInstanceOf(RunNotFoundError);
    expect(await j.listKeys('r-er')).toEqual([]);
  });

  it('a fenced (deleted-under-a-worker) id is refused at birth and leaves no owner record behind', async () => {
    const j = new InMemoryJournal();
    await runDurable({ runId: 'r-fz', journal: j, model: text(), prompt: 'p', caller: user('ayse') } as any);
    await purgeRun(j as any, 'r-fz');
    // Whether this deletion fenced the id (a deletion under a live worker does) — state it, then attack.
    if ((await j.get(runFenceKey('r-fz'))) === undefined) await j.put(runFenceKey('r-fz'), { erased: true, at: Date.now() });
    const r = await runDurable({ runId: 'r-fz', journal: j, model: text(), prompt: 'p', caller: user('bora') } as any).then(() => 'ran', (e) => e?.name);
    expect({ r, left: await j.listKeys('r-fz') }).toEqual({ r: 'RunErasedError', left: [] });
  });

  it('SIBLING — a workflow on a fenced id: refused, nothing written', async () => {
    const j = new InMemoryJournal();
    await j.put(runFenceKey('w-fz'), { erased: true, at: Date.now() });
    const wf = workflow<any>().then(step('s', async () => 1));
    const r = await wf.run({}, { runId: 'w-fz', journal: j, identity: { kind: 'user', id: 'bora', runId: 'w-fz' } }).then(() => 'ran', (e) => e?.name);
    expect({ r, left: await j.listKeys('w-fz') }).toEqual({ r: 'RunErasedError', left: [] });
  });

  it('SIBLING — a primitive on a fenced id: refused, nothing written', async () => {
    const j = new InMemoryJournal();
    await j.put(runFenceKey('t-fz'), { erased: true, at: Date.now() });
    const t = durableTool(tool({ description: 'd', inputSchema: z.object({ x: z.string() }), execute: async (i) => i.x }) as any, { journal: j, runId: 't-fz', identity: runIdentity(user('bora'), 't-fz') } as any, 'echo');
    const r = await t.execute!({ x: 'a' } as any, { toolCallId: 'c1' } as any).then(() => 'ran', (e) => e?.name);
    expect({ r, left: await j.listKeys('t-fz') }).toEqual({ r: 'RunErasedError', left: [] });
  });
});

describe('V5 — controls and siblings for V1/V2/V4', () => {
  it('CONTROL — the registry door (gnl.runWorkflow) refuses a second identity on an existing workflow run', async () => {
    const { createGnl } = await import('../src/registry.js');
    const j = new InMemoryJournal();
    const gnl = createGnl({ journal: j, workflows: { w: workflow<any>().then(step('s', async (_i: any, ctx: any) => `secret-of-${ctx.identity.id}`)) } } as any);
    await gnl.runWorkflow!('w', {}, { runId: 'w-reg', caller: user('ayse') } as any);
    const r = await gnl.runWorkflow!('w', {}, { runId: 'w-reg', caller: user('bora') } as any).then((v: any) => JSON.stringify(v?.output ?? v), (e: any) => `refused: ${e?.name}`);
    expect(r).toMatch(/^refused/);
  });

  it('CONTROL — the registry door holds the loser of a workflow birth race', async () => {
    const { createGnl } = await import('../src/registry.js');
    const j = new InMemoryJournal();
    const ranAs: string[] = [];
    const gnl = createGnl({ journal: j, workflows: { w: workflow<any>().then(step('s', async (_i: any, ctx: any) => { ranAs.push(ctx.identity.id); await sleep(20); return 1; })) } } as any);
    await Promise.allSettled([
      gnl.runWorkflow!('w', {}, { runId: 'w-race', caller: user('ayse') } as any),
      gnl.runWorkflow!('w', {}, { runId: 'w-race', caller: user('bora') } as any),
    ]);
    expect(ranAs.length).toBe(1);
  });

  it('SIBLING of V4 — a workflow run deleted under its live worker is not written back by that worker', async () => {
    const j = new InMemoryJournal();
    let release!: () => void;
    const gate = new Promise<void>((r) => { release = r; });
    const wf = workflow<any>()
      .then(step('a', async () => 'a-out'))
      .then(step('b', async () => { await gate; return 'b-out-with-ayse-data'; }));
    const running = wf.run({}, { runId: 'w-live', journal: j, identity: { kind: 'user', id: 'ayse', runId: 'w-live' } }).then(() => 'completed', (e) => e?.name);
    await sleep(10);
    await purgeRun(j as any, 'w-live');
    const fenced = (await j.get(runFenceKey('w-live'))) !== undefined;
    release();
    const r = await running;
    expect({ fenced, r, left: await j.listKeys('w-live') }).toEqual({ fenced, r: 'RunErasedError', left: [] });
  });
});

describe('V6 — the registry door, same erasure-under-live-worker scenario', () => {
  it('a workflow run (gnl.runWorkflow) erased by eraseSubject while a step is in flight is not written back', async () => {
    const { createGnl } = await import('../src/registry.js');
    const { InMemoryStorage } = await import('../src/in-memory-storage.js');
    const { eraseSubject } = await import('../src/erase.js');
    const { toJournal } = await import('../src/storage.js');
    const storage = new InMemoryStorage();
    const j = toJournal(storage.runs) as any;
    let release!: () => void;
    const gate = new Promise<void>((r) => { release = r; });
    const wf = workflow<any>().then(step('a', async () => 'a')).then(step('b', async () => { await gate; return 'ayse-iban-TR55'; }));
    const gnl = createGnl({ storage, workflows: { w: wf } } as any);
    const running = gnl.runWorkflow!('w', {}, { runId: 'w-reg-live', caller: user('ayse') } as any).then(() => 'completed', (e: any) => e?.name);
    await sleep(15);
    const report = await eraseSubject(storage as any, 'ayse').then((r: any) => r, (e: any) => ({ error: e?.name }));
    release();
    const r = await running;
    const left = (await j.listKeys('w-reg-live')).concat((await j.listKeys('wfrun:w-reg-live')));
    expect({ r, left, erased: (report as any)?.error ?? 'ok' }).toEqual({ r: 'RunErasedError', left: [], erased: 'ok' });
  });
});
