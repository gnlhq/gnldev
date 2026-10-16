// A follower's last word is the run's LOG (detached.ts follow, `settled`): once the execution record says
// nobody executes the run, the log is read again, and the follow ends on the first read that brings nothing.
// The audit's red test (A4) is a completed run on an in-memory store; these are its siblings: the same race
// on Sqlite and Postgres, a run that pauses for a human (`untilPause`, the parked record — the audit's
// hypothesis 1), and a run that fails. Postgres runs when GNL_PG_URL is set.
import { describe, it, expect, vi, beforeAll, afterAll } from 'vitest';
import { tool } from 'ai';
import { z } from 'zod';
import { InMemoryStorage, DetachedRuns, streamDurable, inMemoryLiveness, type Storage, type Journal } from '../src/index.js';
import { SqliteStorage } from '../src/sqlite-storage.js';
import { PostgresStorage } from '../src/postgres-storage.js';
import { lastRunEvent } from '../src/run-events.js';
import { execKey } from '../src/exec-record.js';
import { streamingModel } from './detached/models.js';

beforeAll(() => { vi.spyOn(console, 'warn').mockImplementation(() => {}); });
const ends: Array<() => Promise<unknown>> = [];
afterAll(async () => { for (const e of ends.reverse()) await e(); });

const PG_URL = process.env.GNL_PG_URL;
const STORES: Array<[string, () => Promise<Storage>]> = [
  ['in-memory', async () => new InMemoryStorage()],
  ['sqlite', async () => new SqliteStorage(':memory:')],
];
if (PG_URL) {
  STORES.push(['postgres (real)', async () => {
    const s = new PostgresStorage({ connectionString: PG_URL });
    ends.push(() => s.close());
    return s;
  }]);
}
const unique = () => `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * Process B's view of the store: its first event read is answered from the moment it was asked and arrives
 * once nobody executes the run (`settledWhen`) — what a slow round trip does.
 */
function slowFirstRead(journal: Journal, settledWhen: () => Promise<boolean>): Journal {
  let delayed = true;
  return new Proxy(journal, {
    get(t, p) {
      const v = Reflect.get(t, p, t);
      if (p === 'readRange' && delayed) {
        return async (...args: any[]) => {
          const snapshot = await (v as any).apply(t, args);
          delayed = false;
          while (!(await settledWhen())) await sleep(5);
          return snapshot;
        };
      }
      return typeof v === 'function' ? v.bind(t) : v;
    },
  }) as Journal;
}

const pair = (journal: Journal, slow: Journal) => ({
  a: new DetachedRuns({ journal, liveness: inMemoryLiveness(`A-${unique()}`), resume: () => { throw new Error('no'); }, sweepMs: 0, coalesceMs: 5 }),
  b: new DetachedRuns({ journal: slow, liveness: inMemoryLiveness(`B-${unique()}`), resume: () => { throw new Error('no'); }, sweepMs: 0, pollMs: 20 }),
});
const statesOf = (evs: any[]) => evs.filter((e) => e.kind === 'status').map((e) => e.data.state);

describe.each(STORES)('a follow ends on the log\'s last word — %s', (_name, make) => {
  it('a completed run: the follower a round trip away still receives the ending', async () => {
    const storage = await make();
    const journal = storage.runs as unknown as Journal;
    const runId = `r-end-${unique()}`;
    const { a, b } = pair(journal, slowFirstRead(journal, async () => (await journal.get(execKey(undefined, runId))) === undefined));
    await a.start({ runId, launch: (s) => streamDurable({ journal, runId, model: streamingModel({ words: Array.from({ length: 20 }, (_, i) => `w${i} `), gapMs: 10 }), prompt: 'p', resourceId: 'u', abortSignal: s } as any) });
    await sleep(60);
    const from = (await lastRunEvent(journal, runId))!.seq;
    const got: any[] = [];
    for await (const ev of b.follow({ runId, after: from })) got.push(ev);
    expect(statesOf(got)).toContain('completed');
    await a.close(); await b.close();
  });

  it('a run that pauses for a human: the follower until the pause receives waiting-approval', async () => {
    const storage = await make();
    const journal = storage.runs as unknown as Journal;
    const runId = `r-pause-${unique()}`;
    const { a, b } = pair(journal, slowFirstRead(journal, async () => (await journal.get<any>(execKey(undefined, runId)))?.status === 'parked'));
    const pay = tool({ description: 'pay', inputSchema: z.object({ amount: z.number() }), execute: async () => ({ ok: true }) });
    await a.start({ runId, launch: (s) => streamDurable({
      journal, runId, prompt: 'p', resourceId: 'u', abortSignal: s, tools: { pay },
      model: streamingModel({ words: ['done'], gapMs: 1, tool: { name: 'pay', input: { amount: 1 } } }),
      guard: async () => { await sleep(80); return { action: 'require-approval', reason: 'a human decides' }; },
    } as any) });
    await vi.waitFor(async () => { if (!(await lastRunEvent(journal, runId))) throw new Error('nothing yet'); });
    const from = (await lastRunEvent(journal, runId))!.seq;
    const got: any[] = [];
    for await (const ev of b.follow({ runId, after: from, untilPause: true })) got.push(ev);
    expect(statesOf(got)).toContain('waiting-approval');
    await a.close(); await b.close();
  });

  it('a failed run: the follower receives failed, not a silent end', async () => {
    const storage = await make();
    const journal = storage.runs as unknown as Journal;
    const runId = `r-fail-${unique()}`;
    const { a, b } = pair(journal, slowFirstRead(journal, async () => (await journal.get(execKey(undefined, runId))) === undefined));
    const failing: any = {
      specificationVersion: 'v3', provider: 's', modelId: 's', supportedUrls: {}, doGenerate: async () => { throw new Error('x'); },
      doStream: async () => ({ stream: new ReadableStream({ async start(c) {
        c.enqueue({ type: 'stream-start', warnings: [] }); c.enqueue({ type: 'text-start', id: 't' });
        for (let i = 0; i < 6; i++) { await sleep(10); c.enqueue({ type: 'text-delta', id: 't', delta: `w${i} ` }); }
        c.error(new Error('provider fell over'));
      } }) }),
    };
    await a.start({ runId, launch: (s) => streamDurable({ journal, runId, model: failing, prompt: 'p', resourceId: 'u', abortSignal: s } as any) });
    await vi.waitFor(async () => { if (!(await lastRunEvent(journal, runId))) throw new Error('nothing yet'); });
    const from = (await lastRunEvent(journal, runId))!.seq;
    const got: any[] = [];
    for await (const ev of b.follow({ runId, after: from })) got.push(ev);
    expect(statesOf(got)).toContain('failed');
    await a.close(); await b.close();
  });
});
