// K2 sibling scenarios (scheduler → workflow): a poller that loses its fire lock stops its workflow, and
// the workflow reads WHY — a lost lock is not a cancel: the run is continued by the poller that took it.
//   C1  the fire lock taken from under poller A while its step obeys ctx.signal → A's step is aborted with
//       a lock reason; poller B fires the same run id and the run completes; nothing is canceled.
//   C2  same, but the step IGNORES ctx.signal and returns → the next step boundary must not turn the lost
//       lock into a durable cancel; B completes the run.
import { describe, it, expect } from 'vitest';
import { InMemoryStorage, createGnl } from '@gnldev/durable';
import { workflow, step } from '@gnldev/workflow';
import { scheduleWorkflow, pollScheduler } from '../src/index.js';

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function until(cond: () => boolean, ms: number) { const end = Date.now() + ms; while (Date.now() < end) { if (cond()) return true; await sleep(10); } return cond(); }

async function scenario(obey: boolean) {
  const storage = new InMemoryStorage();
  const j: any = storage.runs;
  const seen: Array<{ who: number; aborted: boolean; reason: string }> = [];
  let entered = 0;
  let open!: () => void;
  const gate = new Promise<void>((r) => (open = r));
  let s2 = 0;
  const wf = workflow<{}>()
    .then(step('s1', async (_i: unknown, ctx: any) => {
      const who = ++entered;
      const signal: AbortSignal | undefined = ctx.signal;
      const rec = () => seen.push({ who, aborted: !!signal?.aborted, reason: String(signal?.reason?.message ?? signal?.reason) });
      if (who > 1) return 'ok';
      if (obey && signal) {
        await Promise.race([gate, new Promise((_, rej) => signal.addEventListener('abort', () => { rec(); rej(signal.reason); }, { once: true }))]);
      } else {
        await gate;
        rec();
      }
      return 'ok';
    }))
    .then(step('s2', async () => { s2++; return 'done'; }));
  const gnl = createGnl({ storage, workflows: { wf } } as any);
  await scheduleWorkflow(j, { id: 'w', name: 'wf', at: 0 }, 0);
  const pA = pollScheduler(j, gnl as any, Date.now(), { owner: 'A', lockTtlMs: 300 });
  await until(() => entered === 1, 5_000);
  // Another poller's takeover of the fire lock: the record now carries a token that is not A's.
  const key = (await j.listKeys('')).find((k: string) => k.startsWith('sched:w:0:fire') && k.endsWith(':lock'));
  const cur = await j.get(key);
  await j.put(key, { ...cur, owner: 'B', token: 'not-yours', expires: 0 });
  await sleep(400); // A's heartbeat ticks (every 100 ms) and finds the lock gone
  open();
  const rA = await pA;
  const rB = await pollScheduler(j, gnl as any, Date.now(), { owner: 'B', lockTtlMs: 300 });
  const canceled = await j.get('sched:w:0:wf:_canceled');
  const status = await j.get('wfrun:sched:w:0') ?? (await j.listKeys('')).filter((k: string) => k.includes('wfrun') || k.includes('_status'));
  return { seen, rA, rB, canceled, s2, status, aSawAbort: seen.find((x) => x.who === 1) };
}

describe('K2 siblings: a lost fire lock reaches the workflow, and is not a cancel', () => {
  it('C1 step obeys ctx.signal: aborted with a lock reason; B completes the run; nothing canceled', async () => {
    const o = await scenario(true);
    console.log('[K2-C1]', JSON.stringify(o));
    expect(o.aSawAbort?.aborted, "A's step heard the lost lock").toBe(true);
    expect(o.aSawAbort?.reason).toMatch(/lease|lock/i);
    expect(o.canceled, 'a lost lock is not a cancel').toBeUndefined();
    expect(o.rB.fired).toBe(1);
    expect(o.s2).toBe(1);
  }, 20_000);

  it('C2 step ignores ctx.signal: the next boundary does not cancel the run; B completes it', async () => {
    const o = await scenario(false);
    console.log('[K2-C2]', JSON.stringify(o));
    expect(o.aSawAbort?.aborted, "A's step was told").toBe(true);
    expect(o.canceled, 'a lost lock is not a cancel').toBeUndefined();
    expect(o.rB.fired).toBe(1);
    expect(o.s2).toBe(1);
  }, 20_000);
});
