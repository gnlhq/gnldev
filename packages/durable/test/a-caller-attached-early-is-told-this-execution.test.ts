// Where an execution starts in its run's log is what its record says (`from`, detached.ts execute): every
// caller of that execution is told the same place, however early it attaches. The audit's red test (A5) is
// a retry of a failed run; these are the rule's siblings: an execution that took over a dead process's run
// (the sweep), and one that continues a run that waited on a human (an approval).
import { describe, it, expect, vi, beforeAll } from 'vitest';
import { tool } from 'ai';
import { z } from 'zod';
import { InMemoryJournal, DetachedRuns, streamDurable, inMemoryLiveness, claimRunOwner, user, type Journal } from '../src/index.js';
import { appendRunEvent } from '../src/run-events.js';
import { execKey } from '../src/exec-record.js';
import { streamingModel } from './detached/models.js';

beforeAll(() => { vi.spyOn(console, 'warn').mockImplementation(() => {}); });
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** A store whose newest-first read takes a round trip (Postgres, a busy Sqlite) once `slow.on`. */
function slowNewestFirst(journal: InMemoryJournal) {
  const slow = { on: false };
  const store = new Proxy(journal, {
    get(t, p) {
      const v = Reflect.get(t, p, t);
      if (p === 'readRange') return async (prefix: string, o: any) => { if (slow.on && o?.desc) await sleep(40); return (v as any).call(t, prefix, o); };
      return typeof v === 'function' ? v.bind(t) : v;
    },
  }) as unknown as Journal;
  return { store, slow };
}

describe('a caller attached early is told where this execution starts', () => {
  it('an execution that took over a dead process\'s run', async () => {
    const journal = new InMemoryJournal();
    const { store, slow } = slowNewestFirst(journal);
    const launch = (s: AbortSignal) => streamDurable({ journal: store, runId: 'r', model: streamingModel({ words: ['a ', 'b ', 'c '], gapMs: 10 }), prompt: 'p', resourceId: 'u', abortSignal: s } as any);
    // A first process ran the run to three events and died executing it.
    const at = Date.now();
    await claimRunOwner(store as any, 'r', user('u'));
    await journal.put('r:outcome', { status: 'running', at });
    await appendRunEvent(store, 'r', { v: 1, seq: 1, kind: 'status', data: { state: 'running' }, step: -1, at });
    await appendRunEvent(store, 'r', { v: 1, seq: 2, kind: 'text', data: { text: 'x ' }, step: 0, at });
    await appendRunEvent(store, 'r', { v: 1, seq: 3, kind: 'text', data: { text: 'y ' }, step: 0, at });
    await journal.put(execKey(undefined, 'r'), { v: 1, runId: 'r', owner: 'a-process-that-died', status: 'running', at: at - 60_000, from: 0 });
    const before = 3;
    // B takes it over; a caller of the run reaches B while the takeover has not read the log yet.
    const b = new DetachedRuns({ journal: store, liveness: inMemoryLiveness('b'), resume: () => launch, sweepMs: 0, coalesceMs: 5 });
    slow.on = true;
    const swept = b.sweep();
    await vi.waitFor(() => { if (!(b as any).local.size) throw new Error('not taken yet'); }, { interval: 1 });
    const attached = await b.start({ runId: 'r', launch });
    await swept;
    const rec = await journal.get<any>(execKey(undefined, 'r'));
    expect({ state: attached.state, from: attached.from }).toEqual({ state: 'attached', from: before });
    expect(rec === undefined || rec.from === before).toBe(true);
    await b.close();
  });

  it('an execution that continues a run that waited on a human', async () => {
    const journal = new InMemoryJournal();
    const { store, slow } = slowNewestFirst(journal);
    const pay = tool({ description: 'pay', inputSchema: z.object({ amount: z.number() }), execute: async () => ({ ok: true }) });
    const model = streamingModel({ words: ['paid ', 'and ', 'done '], gapMs: 10, tool: { name: 'pay', input: { amount: 1 } } });
    const args = { journal: store, runId: 'r', model, prompt: 'p', resourceId: 'u', tools: { pay } };
    const runs = new DetachedRuns({ journal: store, liveness: inMemoryLiveness('one'), resume: () => { throw new Error('no'); }, sweepMs: 0, coalesceMs: 5 });
    await runs.start({ runId: 'r', launch: (s) => streamDurable({ ...args, guard: () => ({ action: 'require-approval', reason: 'a human' }), abortSignal: s } as any) });
    await vi.waitFor(async () => { if ((await journal.get<any>(execKey(undefined, 'r')))?.status !== 'parked') throw new Error('not parked'); });
    // The approval arrives; the same request, retried by its client, arrives a moment later.
    slow.on = true;
    const approve = (s: AbortSignal) => streamDurable({ ...args, approvals: { 'call-1': true }, abortSignal: s } as any);
    const resumed = await runs.start({ runId: 'r', launch: approve, resumeIntent: true });
    const again = await runs.start({ runId: 'r', launch: approve });
    expect(resumed.state).toBe('resumed');
    expect({ state: again.state, from: again.from }).toEqual({ state: 'attached', from: resumed.from });
    await runs.close();
  });
});
