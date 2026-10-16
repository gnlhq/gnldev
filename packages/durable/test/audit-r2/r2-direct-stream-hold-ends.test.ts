// AUDIT ROUND 2 (red probe): d4924273 holds a direct streamDurable until onFinish/onError/onAbort fires.
// Paths where none of the three fires keep the run "in hand" for the life of the process: a drain cannot
// finish and `pendingWork` (gnl pending / gnl upgrade) reads "the run is executing" for a run that is not.
import { describe, it, expect, afterEach } from 'vitest';
import { InMemoryStorage, toJournal, streamDurable, drainProcess, endDrain, pendingWork } from '../../src/index.js';

const usage = { inputTokens: { total: 1, noCache: 1, cacheRead: undefined, cacheWrite: undefined }, outputTokens: { total: 1, text: 1, reasoning: undefined } };
const parts = (arr: any[]) => new ReadableStream({ start(c) { for (const p of arr) c.enqueue(p); c.close(); } });
const textModel = (words: string[], gapMs = 0): any => ({
  specificationVersion: 'v3', provider: 'probe', modelId: 'm', supportedUrls: {},
  doGenerate: async () => { throw new Error('stream only'); },
  doStream: async () => ({
    stream: new ReadableStream({
      async start(c) {
        c.enqueue({ type: 'stream-start', warnings: [] }); c.enqueue({ type: 'text-start', id: 't' });
        for (const w of words) { if (gapMs) await new Promise((r) => setTimeout(r, gapMs)); c.enqueue({ type: 'text-delta', id: 't', delta: w }); }
        c.enqueue({ type: 'text-end', id: 't' }); c.enqueue({ type: 'finish', finishReason: { unified: 'stop', raw: 'stop' }, usage }); c.close();
      },
    }),
  }),
});
afterEach(() => endDrain());
const held = async (journal: any, runId: string) => (await pendingWork(journal)).running.some((r: any) => r.runId === runId);

describe('a direct streamDurable is released from the work in hand on every ending', () => {
  it('replaying a completed run holds nothing once its stream is read', async () => {
    const journal = toJournal(new InMemoryStorage().runs);
    const first = await streamDurable({ runId: 'r-replay', journal, model: textModel(['a ', 'b']), prompt: 'go', resourceId: 'u' } as any);
    await first.consumeStream(); await first.text;
    const again = await streamDurable({ runId: 'r-replay', journal, model: textModel(['a ', 'b']), prompt: 'go', resourceId: 'u' } as any);
    await again.consumeStream(); await again.text;
    await new Promise((r) => setTimeout(r, 50));
    expect({ listed: await held(journal, 'r-replay'), drain: await drainProcess({ deadlineMs: 300 }) }).toEqual({ listed: false, drain: { drained: true } });
  });

  it('a reader that cancels the stream midway does not leave the run in hand', async () => {
    const journal = toJournal(new InMemoryStorage().runs);
    const r = await streamDurable({ runId: 'r-cancel', journal, model: textModel(Array.from({ length: 50 }, (_, i) => `w${i} `), 10), prompt: 'go', resourceId: 'u' } as any);
    const reader = (r.textStream as ReadableStream<string>).getReader();
    await reader.read(); await reader.read();
    await reader.cancel();
    await new Promise((r) => setTimeout(r, 1_000));
    expect({ listed: await held(journal, 'r-cancel'), drain: await drainProcess({ deadlineMs: 300 }) }).toEqual({ listed: false, drain: { drained: true } });
  });

  it('a stream nobody reads does not hold the process forever', async () => {
    const journal = toJournal(new InMemoryStorage().runs);
    await streamDurable({ runId: 'r-unread', journal, model: textModel(['x']), prompt: 'go', resourceId: 'u' } as any);
    await new Promise((r) => setTimeout(r, 1_000));
    expect({ listed: await held(journal, 'r-unread'), drain: await drainProcess({ deadlineMs: 300 }) }).toEqual({ listed: false, drain: { drained: true } });
  });
});
