// K2 (decision 2a) for the scheduler: a fire whose lock was taken while its workflow step ignores the
// signal and runs on past lockTtlMs gets one warning; a step that obeys it, none.
import { describe, it, expect, vi, afterEach } from 'vitest';
import { InMemoryStorage, createGnl } from '@gnldev/durable';
import { workflow, step } from '@gnldev/workflow';
import { scheduleWorkflow, pollScheduler } from '../src/index.js';

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
afterEach(() => vi.restoreAllMocks());
async function until(cond: () => boolean, ms: number) { const end = Date.now() + ms; while (Date.now() < end) { if (cond()) return true; await sleep(10); } return cond(); }
const unheeded = (spy: ReturnType<typeof vi.spyOn>) => spy.mock.calls.map((c) => String(c[0])).filter((m) => /still running/.test(m));

async function lostLock(obey: boolean) {
  const spy = vi.spyOn(console, 'warn').mockImplementation(() => {});
  const storage = new InMemoryStorage();
  const j: any = storage.runs;
  let entered = 0;
  const wf = workflow<{}>().then(step('s1', async (_i: unknown, ctx: any) => {
    if (++entered > 1) return 'ok';
    const signal: AbortSignal | undefined = ctx.signal;
    await new Promise<void>((res) => {
      const t = setTimeout(res, 1_500);
      if (obey) signal?.addEventListener('abort', () => { clearTimeout(t); res(); }, { once: true });
    });
    return 'ok';
  }));
  const gnl = createGnl({ storage, workflows: { wf } } as any);
  await scheduleWorkflow(j, { id: 'w', name: 'wf', at: 0 }, 0);
  const pA = pollScheduler(j, gnl as any, Date.now(), { owner: 'A', lockTtlMs: 300 });
  await until(() => entered === 1, 5_000);
  const key = (await j.listKeys('')).find((k: string) => k.startsWith('sched:w:0:fire') && k.endsWith(':lock'));
  const cur = await j.get(key);
  await j.put(key, { ...cur, owner: 'B', token: 'not-yours', expires: 0 });
  await pA;
  return unheeded(spy);
}

describe('K2 2a: scheduler fire whose workflow ignores the signal', () => {
  it('lock taken, step ignores the signal and runs past lockTtlMs: one warning', async () => {
    const w = await lostLock(false);
    expect(w).toHaveLength(1);
    expect(w[0]).toMatch(/lease was lost/);
    // In the scheduler's words: the workflow and the runner's signal, not a handler's ctx.
    expect(w[0]).toMatch(/the workflow is still running/);
    expect(w[0]).toMatch(/runner's signal/);
    expect(w[0]).not.toMatch(/ctx\./);
  }, 20_000);
  it('lock taken, step obeys the signal: no warning', async () => {
    expect(await lostLock(true)).toHaveLength(0);
  }, 20_000);
});
