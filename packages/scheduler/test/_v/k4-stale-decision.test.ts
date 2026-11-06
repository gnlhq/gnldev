// MOD3 k4 — S5b, the deterministic form of S5's double start: poller B reads the trigger's state, and
// before B takes the fire lock, poller A fires the same occurrence, commits and releases. Does B then
// start the occurrence A already ran? (Found by S5 on candidate C, where per-trigger loops widen the window.)
import { describe, it, expect } from 'vitest';
import { InMemoryJournal } from '@gnldev/durable';
import { scheduleWorkflow, pollScheduler, type WorkflowRunner } from '../../src/index.js';

describe('k4 S5b stale decision', () => {
  it('a poller whose read went stale before it took the lock does not start an occurrence that already ran', async () => {
    const j = new InMemoryJournal();
    let open!: () => void;
    const gate = new Promise<void>((r) => (open = r));
    let gated = false;
    let reached!: () => void;
    const atLock = new Promise<void>((r) => (reached = r));
    // B's view of the same journal: its fire-lock claim waits until A is done.
    const jB = new Proxy(j, {
      get(t, p, r) {
        const v = Reflect.get(t, p, r);
        if (p === 'putIfAbsent') return async (k: string, val: unknown) => { if (!gated && k.endsWith(':fire:lock')) { gated = true; reached(); await gate; } return (v as Function).call(t, k, val); };
        return typeof v === 'function' ? v.bind(t) : v;
      },
    });
    const starts: string[] = [];
    const runner = (who: string): WorkflowRunner => ({ async runWorkflow(_n, _i, o) { starts.push(`${who} ${o!.runId}`); return { runId: o!.runId! }; } });
    await scheduleWorkflow(j, { id: 'r', name: 'wf', every: 1000 }, 0);
    const pB = pollScheduler(jB as never, runner('B'), 1000, { owner: 'B' });
    await atLock; // B has read fireCount 0 and is about to lock
    await pollScheduler(j, runner('A'), 1000, { owner: 'A' }); // A fires sched:r:0, commits, releases
    open();
    await pB;
    console.log(`[k4 S5b] ${JSON.stringify(starts)}`);
    expect(starts.filter((s) => s.endsWith('sched:r:0'))).toHaveLength(1);
  });

  it('the same, when B read the state WHILE A was firing (after A froze the occurrence, before A committed)', async () => {
    const j = new InMemoryJournal();
    let openB!: () => void;
    const gateB = new Promise<void>((r) => (openB = r));
    let gated = false;
    let reached!: () => void;
    const atLock = new Promise<void>((r) => (reached = r));
    const jB = new Proxy(j, {
      get(t, p, r) {
        const v = Reflect.get(t, p, r);
        if (p === 'putIfAbsent') return async (k: string, val: unknown) => { if (!gated && k.endsWith(':fire:lock')) { gated = true; reached(); await gateB; } return (v as Function).call(t, k, val); };
        return typeof v === 'function' ? v.bind(t) : v;
      },
    });
    const starts: string[] = [];
    let openA!: () => void;
    const gateA = new Promise<void>((r) => (openA = r));
    let startedA!: () => void;
    const aIn = new Promise<void>((r) => (startedA = r));
    const runnerA: WorkflowRunner = { async runWorkflow(_n, _i, o) { starts.push(`A ${o!.runId}`); startedA(); await gateA; return { runId: o!.runId! }; } };
    const runnerB: WorkflowRunner = { async runWorkflow(_n, _i, o) { starts.push(`B ${o!.runId}`); return { runId: o!.runId! }; } };
    await scheduleWorkflow(j, { id: 'r', name: 'wf', every: 1000 }, 0);
    const pA = pollScheduler(j, runnerA, 1000, { owner: 'A' });
    await aIn; // A holds the lock and runs sched:r:0
    const pB = pollScheduler(jB as never, runnerB, 1000, { owner: 'B' });
    await atLock; // B has read the state as it is during A's fire
    openA(); await pA; // A commits fireCount 1 and releases
    openB(); await pB;
    console.log(`[k4 S5c] ${JSON.stringify(starts)}`);
    expect(starts.filter((s) => s.endsWith('sched:r:0'))).toHaveLength(1);
  });
});
