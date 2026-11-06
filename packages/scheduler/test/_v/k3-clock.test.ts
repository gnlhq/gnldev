// k3 (Mod 3): whose clock decides a lock. The audit's A4 (in-process) and Y1 (born-expired) repros with
// the assertion turned to the invariant, plus sibling S5 (the holder's clock is BEHIND).
// No liveness is bound in this process on purpose: the lock record carries no `proc` and is judged by its age.
import { describe, it, expect, afterAll, beforeAll } from 'vitest';
import { BASE_URL, newStorage, scopeUrl } from '../../../durable/test/_v/backends.mjs';
import { scheduleWorkflow, pollScheduler, type WorkflowRunner } from '../../src/index.js';

const PG_URL = BASE_URL!;
let storage: Awaited<ReturnType<typeof newStorage>>;
beforeAll(async () => { storage = await newStorage(await scopeUrl('clock', { isolate: true })); await storage.runs.get('warm'); });
afterAll(async () => { await storage.close(); });

const realNow = Date.now;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const uid = () => `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;

describe.skipIf(!PG_URL)('k3 clock: one clock decides the scheduler fire lock', () => {
  it('R3-a4: B with a process clock +5 s polls while A\'s fire is in flight → the run is started ONCE', async () => {
    const j = storage.runs;
    const id = `skew-${uid()}`;
    const starts: string[] = [];
    let open!: () => void;
    const gate = new Promise<void>((r) => (open = r));
    const runnerA: WorkflowRunner = { async runWorkflow(_n, _i, o) { starts.push(`A ${o!.runId}`); await gate; return { runId: o!.runId! }; } };
    const runnerB: WorkflowRunner = { async runWorkflow(_n, _i, o) { starts.push(`B ${o!.runId}`); return { runId: o!.runId! }; } };
    const t = realNow();
    await scheduleWorkflow(j, { id, name: 'wf', at: t }, t);
    const pA = pollScheduler(j, runnerA, realNow(), { owner: 'A', lockTtlMs: 2000 });
    while (starts.length === 0) await sleep(10);
    Date.now = () => realNow() + 5000; // B's process clock
    let rB;
    try { rB = await pollScheduler(j, runnerB, Date.now(), { owner: 'B', lockTtlMs: 2000 }); } finally { Date.now = realNow; }
    open();
    await pA;
    console.log(`[k3 R3-a4] starts=${JSON.stringify(starts)} B=${JSON.stringify(rB)}`);
    expect(starts.filter((s) => s.endsWith(`sched:${id}:0`)).length).toBe(1);
  });

  it('R3-y1: a trigger fired after a long one in the same poll does not get a lock born expired', async () => {
    const j = storage.runs;
    const long = `hol-long-${uid()}`;
    const short = `hol-short-${uid()}`;
    const starts: string[] = [];
    let open!: () => void;
    const gate = new Promise<void>((r) => (open = r));
    const runnerA: WorkflowRunner = {
      async runWorkflow(name, _i, o) {
        starts.push(`A ${o!.runId}`);
        if (name === 'long') await sleep(3000); else await gate;
        return { runId: o!.runId! };
      },
    };
    const runnerB: WorkflowRunner = { async runWorkflow(_n, _i, o) { starts.push(`B ${o!.runId}`); return { runId: o!.runId! }; } };
    const t = realNow();
    await scheduleWorkflow(j, { id: long, name: 'long', at: t }, t);
    await scheduleWorkflow(j, { id: short, name: 'short', at: t }, t);
    const pA = pollScheduler(j, runnerA, realNow(), { owner: 'A', lockTtlMs: 2000 });
    while (!starts.some((s) => s.includes(short))) await sleep(5);
    await pollScheduler(j, runnerB, realNow(), { owner: 'B', lockTtlMs: 2000 }); // B's clock is CORRECT
    open();
    await pA;
    console.log(`[k3 R3-y1] ${JSON.stringify(starts)}`);
    expect(starts.filter((s) => s.includes(`sched:${short}:0`)).length).toBe(1);
  });

  it('S5: the HOLDER\'s clock is 5 s BEHIND — a correct-clock B does not start the same run again', async () => {
    const j = storage.runs;
    const id = `behind-${uid()}`;
    const starts: string[] = [];
    let open!: () => void;
    const gate = new Promise<void>((r) => (open = r));
    const runnerA: WorkflowRunner = { async runWorkflow(_n, _i, o) { starts.push(`A ${o!.runId}`); await gate; return { runId: o!.runId! }; } };
    const runnerB: WorkflowRunner = { async runWorkflow(_n, _i, o) { starts.push(`B ${o!.runId}`); return { runId: o!.runId! }; } };
    const t = realNow() - 10_000;
    await scheduleWorkflow(j, { id, name: 'wf', at: t }, t);
    Date.now = () => realNow() - 5000; // A's process clock
    let pA;
    try { pA = pollScheduler(j, runnerA, Date.now(), { owner: 'A', lockTtlMs: 2000 }); while (starts.length === 0) await sleep(10); } finally { Date.now = realNow; }
    await pollScheduler(j, runnerB, realNow(), { owner: 'B', lockTtlMs: 2000 });
    open();
    await pA;
    console.log(`[k3 S5] starts=${JSON.stringify(starts)}`);
    expect(starts.filter((s) => s.endsWith(`sched:${id}:0`)).length).toBe(1);
  });
});
