// MOD3 k4 — idle cost: journal calls per second with N triggers that are not due (none fire).
// H: C (one loop per trigger + a discovery loop) costs about what A and B cost (listKeys + 2 gets per
// trigger per pollMs) — refuted if C's calls/s exceed A's by more than 20 %. Timers alive: A/B 1, C N+1.
import { it } from 'vitest';
import { InMemoryJournal } from '@gnldev/durable';
import { scheduleWorkflow, createScheduler, type WorkflowRunner } from '../../src/index.js';
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
for (const n of [10, 100]) {
  it(`idle cost, ${n} triggers`, async () => {
    const j = new InMemoryJournal();
    for (let i = 0; i < n; i++) await scheduleWorkflow(j, { id: `t${i}`, name: 'wf', every: 3_600_000 }, Date.now());
    const counts: Record<string, number> = {};
    const pj = new Proxy(j, { get(t, p, r) { const v = Reflect.get(t, p, r); if (typeof v !== 'function') return v; return (...a: unknown[]) => { counts[String(p)] = (counts[String(p)] ?? 0) + 1; return (v as Function).apply(t, a); }; } });
    const runner: WorkflowRunner = { async runWorkflow(_n, _i, o) { return { runId: o!.runId! }; } };
    const s = createScheduler(pj as never, runner, { pollMs: 100 });
    s.start();
    await sleep(500); // settle (C discovers its loops)
    for (const k of Object.keys(counts)) delete counts[k];
    const t0 = Date.now();
    await sleep(3000);
    s.stop();
    const secs = (Date.now() - t0) / 1000;
    const total = Object.values(counts).reduce((a, b) => a + b, 0);
    console.log(`[k4 IDLE] n=${n} calls/s=${(total / secs).toFixed(0)} ${JSON.stringify(Object.fromEntries(Object.entries(counts).map(([k, v]) => [k, Math.round(v / secs)])))}`);
  }, 20_000);
}
