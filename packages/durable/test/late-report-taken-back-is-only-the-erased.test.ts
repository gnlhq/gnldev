// An erased writer takes back ONLY what was erased (call-outcome.ts `keepLateReport`) — siblings of audit
// R2-3 on the other two window families and on the two rows that DO go whole.
import { describe, it, expect } from 'vitest';
import { STORES, unique } from './audit-r2/stores.js';
import { keepLateReport, readCallOutcome, lateReportsOf } from '../src/call-outcome.js';
import { fenceRun } from '../src/erasure-fence.js';
import { runKeys } from '../src/journal.js';

const running = { status: 'running', startedAt: 1, attempts: 2, toolName: 'charge', argsHash: 'h1' };

describe.each(STORES)('late reports an erased writer takes back — %s', (_n, make) => {
  it("a request-window record: run b's report survives run a's erased write (xreq)", async () => {
    const journal = (await make()).runs as any;
    const u = unique();
    const record = runKeys.toolRequest(`req${u}`, 'charge', 'h1');
    await journal.put(record, running);
    expect(await keepLateReport(journal, record, { runId: `b${u}` }, { attempt: 1, output: 'by-b' })).toBe('kept');
    await fenceRun(journal, `a${u}`);
    expect(await keepLateReport(journal, record, { runId: `a${u}` }, { attempt: 2, output: 'by-a' })).toBe('erased');
    expect((await lateReportsOf(journal, record)).map((r) => r.output)).toEqual(['by-b']);
  });

  it('a cross-run window record: the erased writer leaves no report of its own, and the others stay (xrun)', async () => {
    const journal = (await make()).runs as any;
    const u = unique();
    const record = runKeys.toolCrossRun(`charge${u}`, 'h1');
    await journal.put(record, running);
    await keepLateReport(journal, record, { runId: `b${u}` }, { attempt: 1, output: 'by-b' });
    await keepLateReport(journal, record, { runId: `c${u}` }, { attempt: 2, output: 'by-c' });
    await fenceRun(journal, `a${u}`);
    await keepLateReport(journal, record, { runId: `a${u}` }, { attempt: 3, output: 'by-a' });
    expect((await lateReportsOf(journal, record)).map((r) => r.output)).toEqual(['by-b', 'by-c']);
    expect((await readCallOutcome(journal, record)).effect).toEqual({ state: 'happened', output: 'by-b', by: 'late-report' });
  });

  it("the erased run's OWN row goes whole: nothing of the run stays under its id", async () => {
    const journal = (await make()).runs as any;
    const u = unique();
    const record = runKeys.tool(`a${u}`, 'call-1');
    await journal.put(record, running);
    await fenceRun(journal, `a${u}`);
    expect(await keepLateReport(journal, record, { runId: `a${u}` }, { attempt: 2, output: 'late' })).toBe('erased');
    expect(await journal.get(runKeys.lateOf(record))).toBeUndefined();
  });

  it("a record the deletion took: the row goes whole (every report on it reported on what was deleted)", async () => {
    const journal = (await make()).runs as any;
    const u = unique();
    const record = runKeys.toolThread(`T${u}`, 'charge', 'h1'); // never written: the thread's deletion took it
    expect(await keepLateReport(journal, record, { runId: `b${u}` }, { attempt: 1, output: 'late' })).toBe('erased');
    expect(await journal.get(runKeys.lateOf(record))).toBeUndefined();
  });
});
