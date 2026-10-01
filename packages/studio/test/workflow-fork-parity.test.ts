// ONE RULE — which `<runId>:wf:` keys a workflow fork copies is @gnldev/workflow's `forkedStepKeys`.
// The studio core keeps a pinned copy (`forkedWorkflowStepKeys`) because it does not import the
// optional peer; this file holds the copy to the owner, and the Studio fork door to the engine's
// `forkWorkflowRun`, on real workflows.
//
// Before: the door decided ownership itself — the FIRST step id the key started with — so a fork
// keeping `a` took `a:x` (a step of its own) and replayed it, it copied retry counters and side-effect
// claims the engine leaves behind, and a key under a '/'-carrying id belonged to no step at all.
import { describe, it, expect } from 'vitest';
import { InMemoryJournal, claimRunOwner, STAFF } from '@gnldev/durable';
import { workflow, step, retry, asStep, forkWorkflowRun, forkedStepKeys } from '@gnldev/workflow';
import { createStudioApi, forkedWorkflowStepKeys } from '../src/server.js';
import { call } from './call.js';

type Wf = { build(): { id: string }[]; run(input: number, opts: never): Promise<unknown> };

async function forkBoth(journal: InMemoryJournal, wf: Wf, src: string, upto: number) {
  const ids = wf.build().map((s) => s.id);
  const app = createStudioApi({
    reader: journal,
    gnl: { listAgents: () => [], run: async () => ({}), listWorkflows: () => [{ name: 'w', steps: ids.map((id) => ({ id })) }] },
  } as never);
  const res = await call(app, `/workflows/w/runs/${src}/fork`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ upto, newRunId: `${src}-studio` }),
  });
  expect(res.status).toBe(200);
  await forkWorkflowRun(journal, wf, src, ids[upto]!, `${src}-engine`);
  const tails = async (p: string) => (await journal.listKeys(`${p}:wf:`)).map((k) => k.slice(`${p}:wf:`.length)).sort();
  return { studio: await tails(`${src}-studio`), engine: await tails(`${src}-engine`) };
}

describe('the pinned copy answers what @gnldev/workflow answers', () => {
  const ids = ['a', 'a:x', 'p', 'loop', 'f', 'pay', 'n/b', 'tail'];
  const keys = [
    'a', 'a:x', 'a:x:inner', 'a:y', 'a:_claim', 'a:attempts', 'a:_fallback', 'a:x:_fallback',
    'p', 'p/leg1', 'p/leg2', 'p/leg1:_claim', 'loop', 'loop#0', 'loop#1', 'f', 'f[0]', 'f[1]',
    'pay', 'pay:c', 'pay:c:_fallback', 'pay:c:attempts', 'pay:v:_claim', 'pay:_fallback',
    'n', 'n/b', 'n/b:z', 'tail', 'tail:_fallback', 'fb', '_suspend', '_canceled', '_input', '_resume:ok',
    'orphan:_fallback', 'ab', ':', '',
  ];
  for (let upto = 0; upto <= ids.length; upto++) {
    it(`keep ${upto}`, () => {
      const kept = ids.slice(0, upto);
      expect(forkedWorkflowStepKeys(keys, ids, kept).sort()).toEqual(forkedStepKeys(keys, ids, kept).sort());
    });
  }
});

describe('Studio fork door = forkWorkflowRun on real workflows', () => {
  it("'a' then 'a:x': a fork keeping 'a' runs 'a:x' again (the engine's answer)", async () => {
    const journal = new InMemoryJournal();
    const runs = { ax: 0 };
    const wf = workflow<number>()
      .then(step('a', async (n: number) => n + 1))
      .then(step('a:x', async (n: number) => { runs.ax++; return n * 10; }))
      .then(step('tail', async (n: number) => n));
    await claimRunOwner(journal, 'src', STAFF, { workflow: 'w' });
    await wf.run(1, { journal, runId: 'src' } as never);
    const { studio, engine } = await forkBoth(journal, wf, 'src', 1);
    expect(studio).toEqual(['a']);
    expect(studio).toEqual(engine);
    const before = runs.ax;
    await wf.run(1, { journal, runId: 'src-studio' } as never);
    expect(runs.ax - before).toBe(1);
  });

  it('a kept step leaves its retry counter and side-effect claim behind (fresh budget, fresh claim)', async () => {
    const journal = new InMemoryJournal();
    let flaky = 0;
    const wf = workflow<number>()
      .then(retry(step('pay', async (n: number) => { if (++flaky < 2) throw new Error('blip'); return n; }), { attempts: 3 }))
      .then(step('charge', async (n: number) => n, { sideEffect: true }))
      .then(step('after', async (n: number) => n));
    await claimRunOwner(journal, 'src2', STAFF, { workflow: 'w' });
    for (let i = 0; i < 4; i++) { try { await wf.run(1, { journal, runId: 'src2' } as never); break; } catch { /* retry */ } }
    const { studio, engine } = await forkBoth(journal, wf, 'src2', 2);
    expect(studio).toEqual(['charge', 'pay']);
    expect(studio).toEqual(engine);
  });

  // Sibling: composite keys of a kept step that never finished in the source — loop rounds and
  // foreach items travel with it on BOTH doors (before, the engine left them and Studio took them),
  // so the fork resumes the composite from the rounds that already ran.
  it('a loop that crashed mid-way: the finished rounds travel, the fork runs only the rest', async () => {
    const journal = new InMemoryJournal();
    let rounds = 0; let crash = true;
    const wf = workflow<number>()
      .then(step('a', async (n: number) => n))
      .foreach([1, 2], async (x: number) => x * 2, 'f')
      .loop(async (n: unknown, iter: number) => { rounds++; if (iter === 2 && crash) { crash = false; throw new Error('crash'); } return iter as never; }, (_o, iter) => iter < 3, { id: 'loop' })
      .then(step('tail', async (n: number) => n));
    await claimRunOwner(journal, 'src3', STAFF, { workflow: 'w' });
    await wf.run(1, { journal, runId: 'src3' } as never).catch(() => undefined);
    const { studio, engine } = await forkBoth(journal, wf as never, 'src3', 3);
    expect(studio).toEqual(['a', 'f', 'f[0]', 'f[1]', 'loop#0', 'loop#1']);
    expect(studio).toEqual(engine);
    const before = rounds;
    await wf.run(1, { journal, runId: 'src3-studio' } as never);
    expect(rounds - before).toBe(2); // rounds 2 and 3, not 0..3
  });

  // Sibling: a nested retry that fell back — the inner marker travels with the inner output it
  // describes; the nested side-effect claim stays behind. And an id carrying '/' is a step of its own.
  it("inside an asStep: 'pay:c:_fallback' travels with 'pay:c', 'pay:v:_claim' does not; 'n/b' is its own step", async () => {
    const journal = new InMemoryJournal();
    const inner = workflow<number>()
      .then(step('v', async (n: number) => n, { sideEffect: true }))
      .then(retry(step('c', async () => { throw new Error('down'); }), { attempts: 2, fallback: step('fb', async () => 7) }));
    const wf = workflow<number>()
      .then(asStep('pay', inner))
      .then(step('n', async (n: number) => n))
      .then(step('n/b', async (n: number) => n + 1))
      .then(step('tail', async (n: number) => n));
    await claimRunOwner(journal, 'src4', STAFF, { workflow: 'w' });
    await wf.run(1, { journal, runId: 'src4' } as never);
    const all = (await journal.listKeys('src4:wf:')).map((k) => k.slice('src4:wf:'.length));
    expect(all).toContain('pay:c:_fallback');
    expect(all).toContain('pay:v:_claim');
    const two = await forkBoth(journal, wf as never, 'src4', 2);
    expect(two.studio).toEqual(two.engine);
    expect(two.studio).toContain('pay:c:_fallback');
    expect(two.studio).not.toContain('pay:v:_claim');
    expect(two.studio).not.toContain('n/b');
    const journal2 = new InMemoryJournal();
    for (const k of await journal.listKeys('src4:wf:')) await journal2.put(k, await journal.get(k));
    await claimRunOwner(journal2, 'src4', STAFF, { workflow: 'w' });
    const three = await forkBoth(journal2, wf as never, 'src4', 3);
    expect(three.studio).toEqual(three.engine);
    expect(three.studio).toContain('n/b');
  });

  // Sibling: the source crashed between writing a fallback marker and the output it describes. A
  // listed key holding nothing is not a record, so the marker stays behind on both doors.
  it('a fallback marker whose output is gone is copied by neither door', async () => {
    const journal = new InMemoryJournal();
    const wf = workflow<number>()
      .then(retry(step('charge', async () => { throw new Error('down'); }), { attempts: 2, fallback: step('viaB', async () => 2) }))
      .then(step('ship', async (n: number) => n));
    await claimRunOwner(journal, 'src5', STAFF, { workflow: 'w' });
    await wf.run(1, { journal, runId: 'src5' } as never);
    await journal.put('src5:wf:charge', undefined as never);
    expect(await journal.get('src5:wf:charge:_fallback')).toBeTruthy();
    const { studio, engine } = await forkBoth(journal, wf as never, 'src5', 1);
    expect(studio).toEqual(engine);
    expect(studio).not.toContain('charge:_fallback');
  });
});
