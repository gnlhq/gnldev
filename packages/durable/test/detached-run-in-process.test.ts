// A detached run in one process (InMemory): the caller streams it live, leaves, comes back from its
// cursor and gets the rest with no gap and no duplicate; a retry follows instead of executing again.
import { describe, it, expect } from 'vitest';
import { InMemoryJournal, DetachedRuns, streamDurable, inMemoryLiveness } from '../src/index.js';
import { streamingModel, textOf } from './detached/models.js';

const words = Array.from({ length: 20 }, (_, i) => `w${i} `);

describe('S1 chat (InMemory): live, disconnect, reconnect from the cursor', () => {
  it('S1 the rest arrives with no gap and no duplicate; after completion the whole answer', async () => {
    const journal = new InMemoryJournal();
    const runs = new DetachedRuns({ journal, liveness: inMemoryLiveness(), resume: () => { throw new Error('no takeover here'); }, sweepMs: 0 });
    const model = streamingModel({ words, gapMs: 15 });
    const launch = (signal: AbortSignal) => streamDurable({ journal, runId: 'chat-1', model, prompt: 'hi', resourceId: 'alice', abortSignal: signal } as any);
    const started = await runs.start({ runId: 'chat-1', launch });
    expect(started.state).toBe('started');
    // The same call streams live: read until a few deltas arrived, then "close the tab".
    const ac = new AbortController();
    const seen: any[] = [];
    for await (const ev of runs.follow({ runId: 'chat-1', signal: ac.signal })) {
      seen.push(ev);
      if (seen.filter((e) => e.kind === 'text').length >= 3) { ac.abort(); break; }
    }
    // A retry of the same run while it executes follows it.
    expect((await runs.start({ runId: 'chat-1', launch })).state).toBe('attached');
    // Reconnect from the last seq held.
    // The cursor is the last event's seq plus, mid-segment, how much of the next event's text the reader
    // holds (a reader here receives deltas live, before their segment is written).
    const last = seen[seen.length - 1];
    const rest: any[] = [];
    for await (const ev of runs.follow({ runId: 'chat-1', after: last.seq, ...(last.offset ? { afterOffset: last.offset } : {}) })) rest.push(ev);
    const all = [...seen, ...rest];
    const seqs = all.map((e) => e.seq);
    expect(seqs).toEqual([...seqs].sort((a, b) => a - b)); // in order
    expect(textOf(all)).toBe(words.join(''));
    expect(all[all.length - 1]).toMatchObject({ kind: 'status', data: { state: 'completed' } });
    // A reader that comes after completion gets the whole answer.
    const late: any[] = [];
    for await (const ev of runs.follow({ runId: 'chat-1' })) late.push(ev);
    expect(textOf(late)).toBe(words.join(''));
    expect((await runs.start({ runId: 'chat-1', launch })).state).toBe('finished');
    await runs.close();
  });
});

describe('S1-ttft (InMemory): time to first text, detached+followed vs streamDurable in the caller', () => {
  it('S1-ttft inmemory median of 30', async () => {
    const journal = new InMemoryJournal();
    const runs = new DetachedRuns({ journal, liveness: inMemoryLiveness(), resume: () => { throw new Error('no'); }, sweepMs: 0 });
    const model = streamingModel({ words: ['a ', 'b ', 'c '], gapMs: 1 });
    const direct = async (runId: string) => {
      const t0 = performance.now();
      const r: any = await streamDurable({ journal, runId, model, prompt: 'hi', resourceId: 'alice' } as any);
      let at = -1;
      for await (const p of r.fullStream) if (p.type === 'text-delta' && at < 0) at = performance.now() - t0;
      return at;
    };
    const detached = async (runId: string) => {
      const t0 = performance.now();
      await runs.start({ runId, launch: (signal) => streamDurable({ journal, runId, model, prompt: 'hi', resourceId: 'alice', abortSignal: signal } as any) });
      let at = -1;
      for await (const ev of runs.follow({ runId })) if (ev.kind === 'text' && at < 0) at = performance.now() - t0;
      return at;
    };
    for (let i = 0; i < 3; i++) { await direct(`wd${i}`); await detached(`ws${i}`); }
    const a: number[] = []; const b: number[] = [];
    for (let i = 0; i < 30; i++) { a.push(await direct(`d${i}`)); b.push(await detached(`s${i}`)); }
    const med = (xs: number[]) => [...xs].sort((x, y) => x - y)[15]!;
    console.log(`[S1-ttft inmemory] baseline median=${med(a).toFixed(1)}ms | detached median=${med(b).toFixed(1)}ms | delta=${(med(b) - med(a)).toFixed(1)}ms`);
    expect(b.every((x) => x > 0)).toBe(true);
    await runs.close();
  });
});
