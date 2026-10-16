// A cancel stops a run wherever it executes (detached.ts `cancel` / `obeyCancel`). The record is the cancel;
// every executor obeys it — read before each event and while an answer streams — and a signal only makes
// the holder read it now. The audit's red test (D2) is the server door on one executor; these are the
// rule's siblings: two executors (two processes) on one store, a door that only writes the record, and a
// holder that writes nothing for a while and hears the cancel through the signal. Postgres runs when
// GNL_PG_URL is set.
import { describe, it, expect, vi, beforeAll, afterAll } from 'vitest';
import { InMemoryStorage, DetachedRuns, streamDurable, inMemoryLiveness, cancelAgentRun, readRunOutcome, type Storage, type Journal, type RunSignal } from '../src/index.js';
import { SqliteStorage } from '../src/sqlite-storage.js';
import { PostgresStorage } from '../src/postgres-storage.js';
import { readRunEvents } from '../src/run-events.js';

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
const usage = { inputTokens: { total: 1, noCache: 1, cacheRead: undefined, cacheWrite: undefined }, outputTokens: { total: 1, text: 1, reasoning: undefined } };

/** One answer, `n` deltas `gapMs` apart; records the signal it was called with and the deltas it produced. */
function slowModel(seen: { signal?: AbortSignal; deltas: number }, n: number, gapMs: number): any {
  return {
    specificationVersion: 'v3', provider: 'scripted', modelId: 'slow', supportedUrls: {},
    doGenerate: async () => { throw new Error('stream only'); },
    doStream: async ({ abortSignal }: any) => {
      seen.signal = abortSignal;
      let i = 0;
      return {
        stream: new ReadableStream({
          start(c) { c.enqueue({ type: 'stream-start', warnings: [] }); c.enqueue({ type: 'text-start', id: 't' }); },
          async pull(c) {
            await sleep(gapMs);
            if (abortSignal?.aborted) { c.error(abortSignal.reason ?? new Error('aborted')); return; }
            if (i++ < n) { seen.deltas++; c.enqueue({ type: 'text-delta', id: 't', delta: 'x' }); return; }
            c.enqueue({ type: 'text-end', id: 't' });
            c.enqueue({ type: 'finish', finishReason: { unified: 'stop', raw: 'stop' }, usage });
            c.close();
          },
        }),
      };
    },
  };
}

/** Two processes on one store: A executes, B does not. Neither sweeps; each knows the other is alive. */
function twoProcesses(journal: Journal, signal?: () => RunSignal) {
  const ids = { a: `A-${unique()}`, b: `B-${unique()}` };
  const alive = async (id: string) => id === ids.a || id === ids.b;
  const make = (id: string) => {
    const l = inMemoryLiveness(id);
    return new DetachedRuns({ journal, liveness: { ...l, isAlive: alive }, resume: () => { throw new Error('no resume'); }, sweepMs: 0, ...(signal ? { signal: signal() } : {}) });
  };
  return { a: make(ids.a), b: make(ids.b) };
}

/** One channel every process hears (what Postgres LISTEN/NOTIFY is). */
function bus(): () => RunSignal {
  const subs = new Set<(k: string) => void>();
  return () => ({ notify: async (k) => { for (const f of [...subs]) f(k); }, subscribe: async (f) => { subs.add(f); } });
}

async function endingOf(journal: Journal, runId: string): Promise<string | undefined> {
  const evs = await readRunEvents(journal, runId, 0, 10_000);
  const last = [...evs].reverse().find((e) => e.kind === 'status');
  return (last?.data as { state?: string } | undefined)?.state;
}

describe.each(STORES)('a cancel reaches the run wherever it executes — %s', (_name, make) => {
  it('a cancel in another process stops the run executing here, which ends canceled; that process is told "recorded"', async () => {
    const storage = await make();
    const journal = storage.runs as unknown as Journal;
    const runId = `r-cancel-${unique()}`;
    const { a, b } = twoProcesses(journal);
    const seen = { deltas: 0 } as { signal?: AbortSignal; deltas: number };
    await a.start({ runId, launch: (s) => streamDurable({ journal, runId, model: slowModel(seen, 200, 20), prompt: 'p', resourceId: 'u', abortSignal: s } as any) });
    await vi.waitFor(() => { if (seen.deltas < 3) throw new Error('not yet'); }, { timeout: 5_000 });
    expect(await b.cancel({ runId, reason: 'stop' })).toBe('recorded');
    const atCancel = seen.deltas;
    await vi.waitFor(() => { if (!seen.signal?.aborted) throw new Error('still producing'); }, { timeout: 3_000 });
    // Read before each event and while an answer streams, at most every 250 ms: a handful of deltas, not the answer.
    expect(seen.deltas - atCancel).toBeLessThan(40);
    await vi.waitFor(async () => { if ((await endingOf(journal, runId)) !== 'canceled') throw new Error('not ended'); }, { timeout: 5_000 });
    expect((await readRunOutcome(journal, runId))?.status).toBe('canceled');
    await a.close(); await b.close();
  });

  it('a door that only writes the cancel record stops a run executing in another process', async () => {
    const storage = await make();
    const journal = storage.runs as unknown as Journal;
    const runId = `r-record-${unique()}`;
    const { a, b } = twoProcesses(journal);
    const seen = { deltas: 0 } as { signal?: AbortSignal; deltas: number };
    await a.start({ runId, launch: (s) => streamDurable({ journal, runId, model: slowModel(seen, 200, 20), prompt: 'p', resourceId: 'u', abortSignal: s } as any) });
    await vi.waitFor(() => { if (seen.deltas < 3) throw new Error('not yet'); }, { timeout: 5_000 });
    // What a door that knows no executor does (an A2A cancel, Studio's): the record, nothing else.
    await cancelAgentRun(journal, runId, { reason: 'a door' });
    await vi.waitFor(() => { if (!seen.signal?.aborted) throw new Error('still producing'); }, { timeout: 3_000 });
    await vi.waitFor(async () => { if ((await endingOf(journal, runId)) !== 'canceled') throw new Error('not ended'); }, { timeout: 5_000 });
    await a.close(); await b.close();
  });
});

describe('a cancel reaches a holder that writes nothing for a while', () => {
  it('through the signal, the holder stops at once — not at its next event', async () => {
    const journal = new InMemoryStorage().runs as unknown as Journal;
    const runId = `r-quiet-${unique()}`;
    const { a, b } = twoProcesses(journal, bus());
    const seen = { deltas: 0 } as { signal?: AbortSignal; deltas: number };
    // One delta, then a 4 s silence before the next: nothing would make it read the record until then.
    await a.start({ runId, launch: (s) => streamDurable({ journal, runId, model: slowModel(seen, 3, 4_000), prompt: 'p', resourceId: 'u', abortSignal: s } as any) });
    await vi.waitFor(() => { if (seen.deltas < 1) throw new Error('not yet'); }, { timeout: 6_000 });
    const at = Date.now();
    expect(await b.cancel({ runId })).toBe('recorded');
    await vi.waitFor(() => { if (!seen.signal?.aborted) throw new Error('still producing'); }, { timeout: 2_000, interval: 10 });
    expect(Date.now() - at).toBeLessThan(1_000);
    await a.close(); await b.close();
  }, 15_000);

  it('a cancel in the process executing the run is delivered there, now', async () => {
    const journal = new InMemoryStorage().runs as unknown as Journal;
    const runId = `r-here-${unique()}`;
    const { a, b } = twoProcesses(journal);
    const seen = { deltas: 0 } as { signal?: AbortSignal; deltas: number };
    await a.start({ runId, launch: (s) => streamDurable({ journal, runId, model: slowModel(seen, 3, 4_000), prompt: 'p', resourceId: 'u', abortSignal: s } as any) });
    await vi.waitFor(() => { if (seen.deltas < 1) throw new Error('not yet'); }, { timeout: 6_000 });
    expect(await a.cancel({ runId })).toBe('delivered');
    expect(seen.signal?.aborted).toBe(true);
    await a.close(); await b.close();
  }, 15_000);
});
