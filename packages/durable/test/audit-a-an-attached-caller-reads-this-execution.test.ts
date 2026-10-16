// AUDIT A (red): `start()` tells a caller where to read from (`from`: the last event before the execution it
// joins). A caller that attaches to a run executing HERE is told `loc.firstSeq - 1` — and `firstSeq` is 1
// until the execution has read its log (executeBody's first read). A caller that attaches in that window is
// told `from: 0`, and its follow from 0 ends at an EARLIER execution's ending: a retry of a failed run is
// reported to it as failed while the run completes.
import { describe, it, expect } from 'vitest';
import { InMemoryJournal, DetachedRuns, streamDurable, inMemoryLiveness } from '../src/index.js';
import { followedRun } from '../src/followed-run.js';

const usage = { inputTokens: { total: 1, noCache: 1, cacheRead: undefined, cacheWrite: undefined }, outputTokens: { total: 1, text: 1, reasoning: undefined } };
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe('a caller attached to a run executing here reads this execution', () => {
  it('the second caller of a retried run is told the same place as the first', async () => {
    const journal = new InMemoryJournal();
    // A store whose newest-first read takes a round trip (what Postgres or a busy Sqlite does).
    let slow = false;
    const store: any = new Proxy(journal, {
      get(t, p) {
        const v = Reflect.get(t, p, t);
        if (p === 'readRange') return async (prefix: string, o: any) => { if (slow && o?.desc) await sleep(40); return (v as any).call(t, prefix, o); };
        return typeof v === 'function' ? v.bind(t) : v;
      },
    });
    const runs = new DetachedRuns({ journal: store, liveness: inMemoryLiveness(), resume: () => { throw new Error('no'); }, sweepMs: 0, coalesceMs: 5 });
    let calls = 0;
    const model: any = {
      specificationVersion: 'v3', provider: 's', modelId: 's', supportedUrls: {}, doGenerate: async () => { throw new Error('x'); },
      doStream: async () => {
        if (calls++ === 0) throw new Error('provider down');
        return { stream: new ReadableStream({ async start(c) {
          c.enqueue({ type: 'stream-start', warnings: [] }); c.enqueue({ type: 'text-start', id: 't' });
          for (let i = 0; i < 5; i++) { await sleep(10); c.enqueue({ type: 'text-delta', id: 't', delta: `w${i} ` }); }
          c.enqueue({ type: 'text-end', id: 't' }); c.enqueue({ type: 'finish', finishReason: { unified: 'stop', raw: 'stop' }, usage }); c.close();
        } }) };
      },
    };
    const launch = (s: AbortSignal) => streamDurable({ journal: store, runId: 'r', model, prompt: 'p', resourceId: 'u', abortSignal: s } as any);
    const first = await runs.start({ runId: 'r', launch });
    expect((await followedRun(runs, { runId: 'r', journal: store, after: first.from, state: first.state }).ended)?.state).toBe('failed');
    // The first execution is gone (its record and its local state), then: the retry, and the same request
    // retried by its client a moment later.
    while ((runs as any).local.size || (await journal.listKeys('__exec__:')).length) await sleep(10);
    slow = true;
    const retry = await runs.start({ runId: 'r', launch });
    const again = await runs.start({ runId: 'r', launch });
    expect(again.state).toBe('attached');
    // What each caller's stream (a door's SSE) shows: read concurrently, as two requests do.
    const streamOf = async (from: number) => { const parts: string[] = []; for await (const p of followedRun(runs, { runId: 'r', journal: store, after: from, state: 'x' }).fullStream as any) parts.push(p.type === 'text-delta' ? p.text : p.type); return parts; };
    const [byRetry, byAgain] = await Promise.all([streamOf(retry.from), streamOf(again.from)]);
    expect(byRetry).toContain('w0 ');
    expect(byRetry).not.toContain('error');
    expect({ from: again.from, stream: byAgain }, `the attached caller was told from ${again.from} (the retry: ${retry.from})`).toEqual({ from: retry.from, stream: byRetry });
    await runs.close();
  });
});
