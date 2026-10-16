// S6 — the smallest app that uses detached runs with @gnldev/durable ALONE (no door package, no worker
// process). The code between the markers is what a user writes; the test proves it runs.
import { it, expect } from 'vitest';
import { streamingModel } from './detached/models.js';

it('S6 durable alone: start detached, stream, leave, re-attach from a cursor', async () => {
  const model = streamingModel({ words: ['hello ', 'world '], gapMs: 5 });
  // ── minimal app ──────────────────────────────────────────────────────────────────────────────
  const { DetachedRuns, InMemoryJournal, streamDurable } = await import('../src/index.js');
  const journal = new InMemoryJournal();
  const runs = new DetachedRuns({
    journal,
    resume: (rec) => (signal) => streamDurable({ journal, runId: rec.runId, model, resourceId: 'alice', abortSignal: signal } as any),
  });
  await runs.start({ runId: 'r1', launch: (signal) => streamDurable({ journal, runId: 'r1', model, prompt: 'hi', resourceId: 'alice', abortSignal: signal } as any) });
  let last = 0;
  for await (const ev of runs.follow({ runId: 'r1' })) { last = ev.seq; if (ev.kind === 'text') break; } // the client leaves
  const rest = [];
  for await (const ev of runs.follow({ runId: 'r1', after: last })) rest.push(ev);                         // and comes back
  // ── end ──────────────────────────────────────────────────────────────────────────────────────
  expect(rest.at(-1)).toMatchObject({ kind: 'status', data: { state: 'completed' } });
  await runs.close();
});
