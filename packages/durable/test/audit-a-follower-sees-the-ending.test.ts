// AUDIT A (red): a follower in a process that does not execute the run ends its follow when a read finds no
// new event and the execution record is gone (detached.ts follow). The two are separate reads: the run can
// write its last events AND delete its record between them (a store round trip apart in another process).
// The follower then returns without the run's last events — no `finish`, no ending status: a gap.
import { describe, it, expect } from 'vitest';
import { InMemoryJournal, DetachedRuns, streamDurable, inMemoryLiveness } from '../src/index.js';
import { lastRunEvent } from '../src/run-events.js';
import { streamingModel } from './detached/models.js';

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe('a follower in another process receives the run\'s ending', () => {
  it('the events read just before the run ends are not the follower\'s last word', async () => {
    const journal = new InMemoryJournal();
    const a = new DetachedRuns({ journal, liveness: inMemoryLiveness(), resume: () => { throw new Error('no'); }, sweepMs: 0, coalesceMs: 5 });
    // Process B's view of the same store: its event reads are answered from the moment they were asked,
    // and arrive after the run in A ended (what a slow round trip does).
    let delayed = true;
    const slow: any = new Proxy(journal, {
      get(t, p) {
        const v = Reflect.get(t, p, t);
        if (p === 'readRange' && delayed) {
          return async (...args: any[]) => {
            const snapshot = await (v as any).apply(t, args);
            delayed = false;
            while ((await journal.listKeys('__exec__:')).length) await sleep(5);
            return snapshot;
          };
        }
        return typeof v === 'function' ? v.bind(t) : v;
      },
    });
    const b = new DetachedRuns({ journal: slow, liveness: inMemoryLiveness(), resume: () => { throw new Error('no'); }, sweepMs: 0, pollMs: 20 });
    await a.start({ runId: 'r', launch: (s) => streamDurable({ journal, runId: 'r', model: streamingModel({ words: Array.from({ length: 20 }, (_, i) => `w${i} `), gapMs: 10 }), prompt: 'p', resourceId: 'u', abortSignal: s } as any) });
    await sleep(60);
    const from = (await lastRunEvent(journal, 'r'))!.seq;
    const got: any[] = [];
    for await (const ev of b.follow({ runId: 'r', after: from })) got.push(ev);
    const endedWith = got.filter((e) => e.kind === 'status').map((e) => e.data.state);
    expect(endedWith, `B's follow from ${from} ended with: ${JSON.stringify(got.map((e) => [e.seq, e.kind]))}`).toContain('completed');
    await a.close();
  });
});
