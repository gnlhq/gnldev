// A reader that leaves in the middle of a delta segment resumes with no gap and no duplicate — in the
// executing process and in another one.
//
// The store gets a run's text in segments (one event per `coalesceMs`, design layout a2, measured in
// raporlar/2026-10-12-olay-olcum); a reader in the executing process gets each delta live, before its
// segment is written. Its cursor is therefore `seq.offset`: the last event, and how much of the next
// event's text it already holds. A reconnect hands that back — here, or to a process that reads the store.
import { describe, it, expect } from 'vitest';
import { InMemoryJournal, DetachedRuns, streamDurable, inMemoryLiveness, formatCursor, parseCursor } from '../src/index.js';
import { streamingModel, textOf } from './detached/models.js';

const words = Array.from({ length: 60 }, (_, i) => `w${i} `);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function leaveMidSegment(runs: DetachedRuns, runId: string) {
  const seen: any[] = [];
  const ac = new AbortController();
  for await (const ev of runs.follow({ runId, signal: ac.signal })) {
    seen.push(ev);
    // Leave while holding part of a segment that is not written yet.
    if (ev.kind === 'text' && ev.offset && seen.filter((e) => e.kind === 'text').length >= 6) { ac.abort(); break; }
  }
  const last = seen[seen.length - 1];
  return { seen, cursor: formatCursor(last.seq, last.offset ?? 0) };
}

describe('a reader resumes mid-segment', () => {
  for (const where of ['the executing process', 'another process (reads the store)'] as const) {
    it(`no gap, no duplicate — reconnecting to ${where}`, async () => {
      const journal = new InMemoryJournal();
      const runs = new DetachedRuns({ journal, liveness: inMemoryLiveness(), resume: () => { throw new Error('no'); }, sweepMs: 0, coalesceMs: 400 });
      const model = streamingModel({ words, gapMs: 15 });
      await runs.start({ runId: 'seg', launch: (s) => streamDurable({ journal, runId: 'seg', model, prompt: 'go', resourceId: 'alice', abortSignal: s } as any) });
      const { seen, cursor } = await leaveMidSegment(runs, 'seg');
      expect(cursor, 'the reader left between two segment writes').toMatch(/^\d+\.\d+$/);
      // Another process: its own executor over the same store, executing nothing of this run.
      const reader = where === 'the executing process' ? runs : new DetachedRuns({ journal, liveness: inMemoryLiveness(), resume: () => { throw new Error('no'); }, sweepMs: 0 });
      const c = parseCursor(cursor)!;
      const rest: any[] = [];
      for await (const ev of reader.follow({ runId: 'seg', after: c.seq, afterOffset: c.offset, idleCheckMs: 200 })) {
        rest.push(ev);
        if (ev.kind === 'status' && ev.data.state === 'completed') break;
      }
      expect(textOf([...seen, ...rest])).toBe(words.join(''));
      await sleep(10);
      await runs.close();
    });
  }
});
