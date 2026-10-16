// AUDIT ROUND 2 (red): keepLateReport (call-outcome.ts) takes back a report written for an erased owner
// with `deleteExactKey(lateOf(record))` — the WHOLE late-report row, which on a window record (`xthr:`,
// `xreq:`, `xrun:`) also holds the reports of OTHER runs. Erasing one run of a thread then deletes another
// live run's proof that the call's effect happened: the call reads 'in-doubt' instead of 'happened'.
import { describe, it, expect } from 'vitest';
import { STORES, unique } from './stores.js';
import { keepLateReport, readCallOutcome } from '../../src/call-outcome.js';
import { fenceRun } from '../../src/erasure-fence.js';

describe.each(STORES)("an erased writer's late report takes back only its own report — %s", (_n, make) => {
  it("run b's late report on a shared thread-window record survives run a's erased write", async () => {
    const journal = (await make()).runs;
    const u = unique();
    const record = `xthr:T${u}:args-charge-h1`;
    await journal.put(record, { status: 'running', startedAt: Date.now(), attempts: 2, toolName: 'charge', argsHash: 'h1' });
    expect(await keepLateReport(journal as any, record, { runId: `b${u}` }, { attempt: 1, output: 'charged-by-b' })).toBe('kept');
    expect((await readCallOutcome(journal as any, record)).effect).toEqual({ state: 'happened', output: 'charged-by-b', by: 'late-report' });
    await fenceRun(journal as any, `a${u}`); // run a (another run of thread T) is erased; the thread lives on
    expect(await keepLateReport(journal as any, record, { runId: `a${u}` }, { attempt: 2, output: 'charged-by-a' })).toBe('erased');
    expect((await readCallOutcome(journal as any, record)).effect, "run b's proof of the effect is gone").toEqual({ state: 'happened', output: 'charged-by-b', by: 'late-report' });
  });
});
