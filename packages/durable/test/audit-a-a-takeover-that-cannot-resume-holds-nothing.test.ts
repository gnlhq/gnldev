// AUDIT A (red): the sweep takes a dead process's run over (compare-and-set to "running, owner: me") and only
// THEN asks how to continue it (`resume`). When `resume` throws — the agent the record names is not in this
// deployment, the run has no readable owner, a background spec is missing — the sweep logs it and moves on:
// the record stays "running" under this LIVE process, which never executes it. No other process may take it
// (its owner is alive), and this one's sweep skips its own runs. A failed launch (`execute`'s catch) parks the
// run with its reason; a failed resume does not.
import { describe, it, expect } from 'vitest';
import { InMemoryJournal, DetachedRuns, inMemoryLiveness } from '../src/index.js';
import { execKey } from '../src/exec-record.js';
import { readRunEvents } from '../src/run-events.js';

describe('a takeover that cannot resume a run does not keep it', () => {
  it('a process that failed to resume a run does not hold it as running', async () => {
    const journal = new InMemoryJournal();
    await journal.put(execKey(undefined, 'r'), { v: 1, runId: 'r', owner: 'a-process-that-died', status: 'running', at: Date.now() - 60_000, from: 0, meta: { agent: 'support' } });
    // (fix/m1) The dead process's run had begun: every attempt writes its 'running' outcome at entry
    // (outcome.ts runStarted). A record with no such past is a run that never began, and its record goes —
    // a-failed-resume-gives-the-run-back.test.ts.
    await journal.put('r:outcome', { status: 'running', at: Date.now() - 60_000 });
    const warn = console.warn; console.warn = () => {};
    // B: a newer deployment that has no agent 'support'.
    const b = new DetachedRuns({ journal, liveness: inMemoryLiveness('process-b'), resume: () => { throw new Error("no agent 'support' here"); }, sweepMs: 0 });
    await b.sweep();
    console.warn = warn;
    const rec = await journal.get<any>(execKey(undefined, 'r'));
    // C: a process that can continue it.
    let continuedByC = false;
    const c = new DetachedRuns({ journal, liveness: inMemoryLiveness('process-c'), sweepMs: 0, resume: () => async () => { continuedByC = true; return { fullStream: (async function* () { /* nothing more */ })() }; } });
    await c.sweep();
    await new Promise((r) => setTimeout(r, 50));
    const after = await journal.get<any>(execKey(undefined, 'r'));
    // Either outcome keeps the run moving or visible: C continued it, or B parked it with its reason
    // (`pending` names it). "running under B, executed by nobody" is neither.
    const parkedWithReason = after?.status === 'parked' && typeof after?.reason === 'string';
    expect(rec?.owner === 'process-b' && rec?.status === 'running', `B left the record ${JSON.stringify(rec)} (C continued: ${continuedByC}; events: ${JSON.stringify(await readRunEvents(journal, 'r'))})`).toBe(false);
    expect(continuedByC || parkedWithReason).toBe(true);
    await b.close(); await c.close();
  });
});
