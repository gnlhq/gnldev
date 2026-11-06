// Each waker resumes only its own test's run: a waker scans every suspended run of the store.
// k3-b2: a suspend point is named by the run's suspend counter, not by a clock. Siblings of the
// same-ms finding (verify-same-ms.test.ts): three suspends in one ms, two wakers in one ms, an
// organization partition in one ms, and a record written before the counter existed.
import { describe, it, expect, afterAll, afterEach, vi } from 'vitest';
import { InMemoryJournal, toJournal, withOrg } from '@gnldev/durable';
import { BACKEND, BASE_URL, newStorage, scopeUrl } from '../../../durable/test/_v/backends.mjs';
import { workflow, step, sleep, waitFor, getWorkflowRunStatus, type JournalLike } from '@gnldev/workflow';
import { createWorkflowWaker } from '../../src/index.js';

const PG_URL = BASE_URL;
const closers: Array<() => Promise<void>> = [];
afterAll(async () => { for (const c of closers) await c(); });
afterEach(() => { vi.restoreAllMocks(); });

const STORES: Array<[string, () => Promise<JournalLike>]> = [['in-memory', async () => new InMemoryJournal() as never]];
if (PG_URL) {
  // Its own store: a waker scans EVERY suspended run of the store, and with the clock frozen it would
  // resume (and mark woken) the runs other test files left in a shared database — and they ours.
  STORES.push([BACKEND, async () => {
    const s = await newStorage(await scopeUrl('k3b2_iso', { isolate: true }));
    await s.init();
    closers.push(() => s.close());
    return toJournal(s) as never;
  }]);
}
const uid = () => `k3b2-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`;
const T0 = 1_800_000_000_000;

describe.each(STORES)('k3-b2 suspend point — %s', (name, make) => {
  it('three suspends in the same ms (waitFor → waitFor → sleep): each one is woken on its own', async () => {
    const journal = await make();
    const runId = uid();
    const ready = { a: false, b: false };
    const calls = { a: 0, b: 0, done: 0 };
    const wf = workflow<Record<string, never>>()
      .then(waitFor('a', async () => (ready.a ? { a: ++calls.a } : null)))
      .then(waitFor('b', async () => (ready.b ? { b: ++calls.b } : null)))
      .then(sleep('s', T0 + 1))
      .then(step('done', async () => { calls.done++; return { ok: true }; }));
    const clock = vi.spyOn(Date, 'now').mockReturnValue(T0);
    expect((await wf.runResumable({}, { runId, journal })).status).toBe('suspended');
    const waker = createWorkflowWaker({ journal, wakeEvented: true, onError: () => {}, resume: async (id) => (id === runId ? wf.runResumable({}, { runId: id, journal }) : undefined) });
    const at: Array<string | undefined> = [];
    ready.a = true;
    await waker.tick(T0);
    at.push((await getWorkflowRunStatus(journal, runId))?.stepId);
    ready.b = true;
    await waker.tick(T0);
    at.push((await getWorkflowRunStatus(journal, runId))?.stepId);
    clock.mockReturnValue(T0 + 2);
    await waker.tick(T0 + 2);
    const st = await getWorkflowRunStatus(journal, runId);
    console.log('[k3-b2 three-same-ms]', name, JSON.stringify({ at, calls, status: st?.status, suspendSeq: st?.suspendSeq }));
    expect(at).toEqual(['b', 's']);
    expect(st?.status).toBe('completed');
    expect(calls).toEqual({ a: 1, b: 1, done: 1 });
  });

  it('two wakers on one run in the same ms: the suspend point is woken once', async () => {
    const journal = await make();
    const runId = uid();
    vi.spyOn(Date, 'now').mockReturnValue(T0);
    const wf = workflow<Record<string, never>>().then(waitFor('evt', async () => null));
    expect((await wf.runResumable({}, { runId, journal })).status).toBe('suspended');
    let resumes = 0;
    const resume = async (id: string) => { if (id !== runId) return; resumes++; return wf.runResumable({}, { runId: id, journal }); };
    // W2 scans and decides the suspend point is not woken yet — then W1 wakes it (the run re-suspends
    // in the same ms) before W2 takes the wake lock. W2 acts on a snapshot that is no longer true.
    let w1Done!: () => void;
    const w1Finished = new Promise<void>((r) => { w1Done = r; });
    let held = false;
    const slow = new Proxy(journal as object, {
      get(target, prop, recv) {
        const v = Reflect.get(target, prop, recv);
        if (typeof v !== 'function') return v;
        if (prop === 'putIfAbsent' || prop === 'putIfMatch') {
          return async (k: string, ...rest: unknown[]) => {
            if (!held && k.includes('wfwake:')) { held = true; await w1Finished; }
            return (v as (...a: unknown[]) => unknown).call(target, k, ...rest);
          };
        }
        return v.bind(target);
      },
    }) as JournalLike;
    const w1 = createWorkflowWaker({ journal, wakeEvented: true, onError: () => {}, resume });
    const w2 = createWorkflowWaker({ journal: slow, wakeEvented: true, onError: () => {}, resume });
    const p2 = w2.tick(T0);
    const r1 = await w1.tick(T0);
    w1Done();
    const r2 = await p2;
    const st = await getWorkflowRunStatus(journal, runId);
    console.log('[k3-b2 two-wakers-same-ms]', name, JSON.stringify({ r1, r2, resumes, suspendSeq: st?.suspendSeq }));
    expect(resumes).toBe(1);
    expect(st?.status).toBe('suspended');
  });

  it('organization partition, same ms: an org run that re-suspends in the same ms is still woken later', async () => {
    const root = await make();
    const org = withOrg(root as never, 'acme') as unknown as JournalLike;
    const runId = uid();
    let ready = false;
    let after = 0;
    const wf = workflow<Record<string, never>>()
      .then(waitFor('evt', async () => (ready ? { got: true } : null)))
      .then(step('after', async () => { after++; return { done: true }; }));
    const clock = vi.spyOn(Date, 'now').mockReturnValue(T0);
    expect((await wf.runResumable({}, { runId, journal: org })).status).toBe('suspended');
    const waker = createWorkflowWaker({
      journal: root, orgs: ['acme'], wakeEvented: true, onError: () => {},
      resume: async (id, _s, where) => (id === runId && where ? wf.runResumable({}, { runId: id, journal: withOrg(root as never, where.orgId) as never }) : undefined),
    });
    await waker.tick(T0); // not ready: re-suspends in the same ms
    clock.mockRestore();
    ready = true;
    for (let i = 0; i < 3; i++) await waker.tick(Date.now() + 60_000);
    const st = await getWorkflowRunStatus(org, runId);
    console.log('[k3-b2 org-same-ms]', name, JSON.stringify({ after, status: st?.status }));
    expect(st?.status).toBe('completed');
    expect(after).toBe(1);
  });

  it('a run suspended before the counter existed (no suspendSeq, an old updatedAt-keyed mark) is woken', async () => {
    const journal = await make();
    const runId = uid();
    let after = 0;
    const wf = workflow<Record<string, never>>()
      .then(sleep('wake', T0 + 1))
      .then(step('after', async () => { after++; return { done: true }; }));
    vi.spyOn(Date, 'now').mockReturnValue(T0);
    expect((await wf.runResumable({}, { runId, journal })).status).toBe('suspended');
    // The record as an earlier version wrote it, and the mark an earlier waker left for that point.
    const { suspendSeq: _drop, ...old } = (await getWorkflowRunStatus(journal, runId))!;
    await journal.put(`wfrun:${runId}`, old);
    await journal.put(`wfwake:${runId}:${old.updatedAt}`, { at: T0 });
    expect((await getWorkflowRunStatus(journal, runId))?.suspendSeq).toBe(0);
    vi.spyOn(Date, 'now').mockReturnValue(T0 + 2);
    const waker = createWorkflowWaker({ journal, onError: () => {}, resume: async (id) => (id === runId ? wf.runResumable({}, { runId: id, journal }) : undefined) });
    const r = await waker.tick(T0 + 2);
    const st = await getWorkflowRunStatus(journal, runId);
    console.log('[k3-b2 legacy-record]', name, JSON.stringify({ r, after, status: st?.status }));
    expect(st?.status).toBe('completed');
    expect(after).toBe(1);
  });
});
