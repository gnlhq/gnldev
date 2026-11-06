// k3 (Mod 3): a wake is never lost. The audit's A1 repro (a1, a2, b) plus siblings S1 (evented/HITL),
// S2 (organization partition), S6 (two wakers on one due run — exactly-once must hold).
import { describe, it, expect, afterAll } from 'vitest';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { InMemoryJournal, toJournal, withOrg } from '@gnldev/durable';
import { BACKEND, BASE_URL, newStorage, scopeUrl } from '../../../durable/test/_v/backends.mjs';
import { workflow, step, sleep, waitFor, getWorkflowRunStatus, type JournalLike } from '@gnldev/workflow';
import { createWorkflowWaker } from '../../src/index.js';

const PG_URL = BASE_URL;
const closers: Array<() => Promise<void>> = [];
afterAll(async () => { for (const c of closers) await c(); });

const STORES: Array<[string, () => Promise<JournalLike>]> = [['in-memory', async () => new InMemoryJournal() as never]];
if (PG_URL) {
  STORES.push([BACKEND, async () => {
    const s = await newStorage(await scopeUrl('waker', { isolate: true }));
    await s.init();
    closers.push(() => s.close());
    return toJournal(s) as never;
  }]);
}
const uid = () => `k3-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`;
const pause = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe.each(STORES)('k3 waker — %s', (name, make) => {
  it('R1-a1: a post-sleep step that throws ONCE is retried by a later tick and the run completes', async () => {
    const journal = await make();
    const runId = uid();
    let afterCalls = 0;
    const wf = workflow<Record<string, never>>()
      .then(sleep('wake', Date.now() + 400))
      .then(step('after', async () => { afterCalls++; if (afterCalls === 1) throw new Error('transient'); return { done: true }; }));
    await wf.runResumable({}, { runId, journal });
    await pause(450);
    const waker = createWorkflowWaker({ journal, onError: () => {}, resume: (id) => wf.runResumable({}, { runId: id, journal }) });
    const ticks = [];
    for (let i = 0; i < 5; i++) { ticks.push(await waker.tick(Date.now() + 60_000)); await pause(5); }
    const st = await getWorkflowRunStatus(journal, runId);
    console.log('[k3 R1-a1]', name, JSON.stringify({ ticks, afterCalls, status: st?.status }));
    expect(st?.status).toBe('completed');
    expect(afterCalls).toBe(2);
  });

  it('R1-a2: a host resume() that throws once before touching the run is retried (same waker, and a fresh one)', async () => {
    const journal = await make();
    const runId = uid();
    let afterCalls = 0;
    const wf = workflow<Record<string, never>>()
      .then(sleep('wake', Date.now() + 400))
      .then(step('after', async () => { afterCalls++; return { done: true }; }));
    await wf.runResumable({}, { runId, journal });
    await pause(450);
    let resumeCalls = 0;
    const resume = async (id: string) => { resumeCalls++; if (resumeCalls === 1) throw new Error('registry not ready'); return wf.runResumable({}, { runId: id, journal }); };
    const waker = createWorkflowWaker({ journal, onError: () => {}, resume });
    const ticks = [];
    for (let i = 0; i < 4; i++) ticks.push(await waker.tick(Date.now() + 60_000));
    const st = await getWorkflowRunStatus(journal, runId);
    console.log('[k3 R1-a2]', name, JSON.stringify({ ticks, resumeCalls, afterCalls, status: st?.status }));
    expect(afterCalls).toBe(1);
    expect(st?.status).toBe('completed');
  });

  it('S1 (evented, wakeEvented): the step after a met waitFor throws once — a later tick retries it', async () => {
    const journal = await make();
    const runId = uid();
    let ready = false;
    let afterCalls = 0;
    const wf = workflow<Record<string, never>>()
      .then(waitFor('evt', async () => (ready ? { got: true } : null)))
      .then(step('after', async () => { afterCalls++; if (afterCalls === 1) throw new Error('transient'); return { done: true }; }));
    expect((await wf.runResumable({}, { runId, journal })).status).toBe('suspended');
    const waker = createWorkflowWaker({ journal, wakeEvented: true, onError: () => {}, resume: (id) => wf.runResumable({}, { runId: id, journal }) });
    await waker.tick(); // not ready: re-suspends
    ready = true;
    const ticks = [];
    for (let i = 0; i < 5; i++) { ticks.push(await waker.tick(Date.now() + 60_000)); await pause(5); }
    const st = await getWorkflowRunStatus(journal, runId);
    console.log('[k3 S1]', name, JSON.stringify({ ticks, afterCalls, status: st?.status }));
    expect(st?.status).toBe('completed');
  });

  it('S2 (organization partition): a woken org run whose step throws once is retried', async () => {
    const root = await make();
    const org = withOrg(root as never, 'acme') as unknown as JournalLike;
    const runId = uid();
    let afterCalls = 0;
    const wf = workflow<Record<string, never>>()
      .then(sleep('wake', Date.now() + 400))
      .then(step('after', async () => { afterCalls++; if (afterCalls === 1) throw new Error('transient'); return { done: true }; }));
    await wf.runResumable({}, { runId, journal: org });
    await pause(450);
    const waker = createWorkflowWaker({ journal: root, orgs: ['acme'], onError: () => {}, resume: (id, _s, where) => wf.runResumable({}, { runId: id, journal: withOrg(root as never, where!.orgId) as never }) });
    const ticks = [];
    for (let i = 0; i < 5; i++) { ticks.push(await waker.tick(Date.now() + 60_000)); await pause(5); }
    const st = await getWorkflowRunStatus(org, runId);
    console.log('[k3 S2]', name, JSON.stringify({ ticks, afterCalls, status: st?.status }));
    expect(st?.status).toBe('completed');
  });

  it('S6 (promise): two wakers ticking the same due run at once — the post-sleep step runs exactly once', async () => {
    const journal = await make();
    const runId = uid();
    let afterCalls = 0;
    const wf = workflow<Record<string, never>>()
      .then(sleep('wake', Date.now() + 400))
      .then(step('after', async () => { afterCalls++; await pause(200); return { done: true }; }));
    await wf.runResumable({}, { runId, journal });
    await pause(450);
    const mk = () => createWorkflowWaker({ journal, onError: () => {}, resume: (id) => wf.runResumable({}, { runId: id, journal }) });
    const [w1, w2] = [mk(), mk()];
    const r = await Promise.all([w1.tick(Date.now() + 60_000), w2.tick(Date.now() + 60_000)]);
    for (let i = 0; i < 3; i++) { await w1.tick(Date.now() + 60_000); await w2.tick(Date.now() + 60_000); }
    const st = await getWorkflowRunStatus(journal, runId);
    console.log('[k3 S6]', name, JSON.stringify({ r, afterCalls, status: st?.status }));
    expect(afterCalls).toBe(1);
    expect(st?.status).toBe('completed');
  });
});

describe.skipIf(!PG_URL)(`k3 waker — SIGKILL after the wake was taken (real ${BACKEND}, separate process)`, () => {
  it('R1-b: a process killed inside resume(): a new process\'s waker wakes the run', async () => {
    const runId = uid();
    const child = spawn(process.execPath, [fileURLToPath(new URL('./k3-a1-child.mjs', import.meta.url)), await scopeUrl('waker', { isolate: true }), runId], { stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    let err = '';
    child.stderr.on('data', (d) => { err += d; });
    await new Promise<void>((resolve, reject) => {
      const t = setTimeout(() => reject(new Error(`child never reached IN_AFTER; out=${out} err=${err}`)), 20_000);
      child.stdout.on('data', (d) => { out += d; if (out.includes('IN_AFTER')) { clearTimeout(t); resolve(); } });
    });
    const exited = new Promise((r) => child.on('exit', (code, sig) => r({ code, sig })));
    child.kill('SIGKILL');
    await exited;

    const pgs = await newStorage(await scopeUrl('waker', { isolate: true }));
    await pgs.init();
    closers.push(() => pgs.close());
    const journal = toJournal(pgs);
    let afterCalls = 0;
    const wf = workflow<Record<string, never>>()
      .then(sleep('wake', 0))
      .then(step('after', async () => { afterCalls++; return { done: true }; }));
    const waker = createWorkflowWaker({ journal: journal as never, onError: () => {}, resume: (id) => (id === runId ? wf.runResumable({}, { runId: id, journal: journal as never }) : undefined) });
    const ticks = [];
    // A dead holder is judged dead after the liveness reconnect grace (5 s), or its lock's TTL.
    const t0 = Date.now();
    for (let i = 0; i < 40 && (await getWorkflowRunStatus(journal as never, runId))?.status !== 'completed'; i++) { ticks.push(await waker.tick(Date.now() + 60_000)); await pause(250); }
    const after = await getWorkflowRunStatus(journal as never, runId);
    console.log('[k3 R1-b]', JSON.stringify({ ms: Date.now() - t0, ticks: ticks.length, afterCalls, after: after?.status }));
    expect(after?.status).toBe('completed');
  }, 40_000);
});
