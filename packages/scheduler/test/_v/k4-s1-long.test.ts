// MOD3 k4 S1-long (B'/C wiring; D's copy is in audit-a3a5-d.test.ts): a hung trigger every 200 ms over 4 s.
import { it, expect } from 'vitest';
import { InMemoryJournal } from '@gnldev/durable';
import { scheduleWorkflow, createScheduler, type WorkflowRunner } from '../../src/index.js';
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
it('S1-long: a hung trigger over 4 s — the other triggers keep their schedule', async () => {
  const j = new InMemoryJournal();
  const t0 = Date.now();
  const fires: Record<string, number[]> = {};
  const runner: WorkflowRunner = { async runWorkflow(name, _i, o) { (fires[name] ??= []).push(Date.now() - t0); if (name === 'hang') await new Promise(() => {}); return { runId: o!.runId! }; } };
  await scheduleWorkflow(j, { id: 'b-hang', name: 'hang', every: 200 }, t0 - 150);
  await scheduleWorkflow(j, { id: 'a-x', name: 'x', every: 200 }, t0);
  const s = createScheduler(j, runner, { pollMs: 20 });
  s.start();
  await sleep(4000);
  s.stop();
  const xFirst2 = (fires.x ?? []).filter((t) => t <= 2000).length, xLast2 = (fires.x ?? []).filter((t) => t > 2000 && t <= 4000).length;
  console.log(`[S1-long] hang runs=${fires.hang?.length} x in 0-2s=${xFirst2} x in 2-4s=${xLast2}`);
  expect(xLast2).toBeGreaterThanOrEqual(9);
}, 20_000);
