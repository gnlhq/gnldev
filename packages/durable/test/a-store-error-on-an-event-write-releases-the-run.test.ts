// A store error on one of a detached run's event writes releases the run; it does not kill the process.
//
// The executor writes a run's events through one ordered chain, started with `void write(...)` from the
// stream loop. An append that THREW (a connection cut mid-query: a failover, a restart, a stalled network)
// rejected that chain, and the voided promise had no handler: an unhandled rejection, which Node turns into
// a process exit. Measured on a real Postgres under CI-like load (framework-s0/ci-0171-flake,
// liveness-unavailable-postgres "after D3"): process A died with `Connection terminated unexpectedly`
// from `DetachedRuns.emit` inside its body's success wait, the others read it dead, and the call it had
// already made was parked for a person — 5 of 16 trials with the connection budget off, 10 of 16 with it.
//
// Now the failed write stops this execution's writes and is thrown where the execution is awaited: the
// executor's own failure path says so and gives the run back (`giveBackRecord`), and the next sweep
// continues it from its journal, as for any execution that ended without its ending.
import { describe, it, expect } from 'vitest';
import { InMemoryJournal, DetachedRuns, streamDurable, inMemoryLiveness } from '../src/index.js';
import { streamingModel, textOf } from './detached/models.js';

const words = ['a ', 'b ', 'c ', 'd '];

/** An in-memory journal whose append of one event kind throws, once — the store cut mid-query. */
class OnceFailingEventJournal extends InMemoryJournal {
  failed = 0;
  constructor(private readonly failKind: string) { super(); }
  override async putIfAbsent<T>(key: string, value: T): Promise<boolean> {
    if (!this.failed && key.includes(':ev:') && (value as { kind?: string })?.kind === this.failKind) {
      this.failed++;
      throw new Error('Connection terminated unexpectedly');
    }
    return super.putIfAbsent(key, value);
  }
}

describe('a store error on an event write', () => {
  for (const kind of ['start', 'text']) {
    it(`the '${kind}' event's write throws: no unhandled rejection, the run is continued and completes`, async () => {
      const unhandled: unknown[] = [];
      const onUnhandled = (e: unknown) => { unhandled.push(e); };
      process.on('unhandledRejection', onUnhandled);
      const warn = console.warn;
      console.warn = () => {};
      const journal = new OnceFailingEventJournal(kind);
      const model = streamingModel({ words, gapMs: 5 });
      const launch = (signal: AbortSignal) => streamDurable({ journal, runId: 'r-1', model, prompt: 'hi', resourceId: 'alice', abortSignal: signal } as any);
      const runs = new DetachedRuns({ journal, liveness: inMemoryLiveness(), resume: () => launch, sweepMs: 50 });
      try {
        await runs.start({ runId: 'r-1', launch });
        // Until the run's log ends it (the continued execution's `completed`).
        const until = Date.now() + 10_000;
        let events: any[] = [];
        while (Date.now() < until) {
          events = [];
          for await (const ev of runs.follow({ runId: 'r-1' })) events.push(ev);
          if (events.at(-1)?.kind === 'status' && events.at(-1)?.data.state === 'completed') break;
          await new Promise((r) => setTimeout(r, 50));
        }
        await new Promise((r) => setTimeout(r, 100));
        expect(journal.failed, 'the write really failed').toBe(1);
        expect(unhandled.map((e) => String((e as Error)?.message ?? e))).toEqual([]);
        expect(events.at(-1)).toMatchObject({ kind: 'status', data: { state: 'completed' } });
        expect(textOf(events)).toBe(words.join(''));
      } finally {
        await runs.close();
        console.warn = warn;
        process.off('unhandledRejection', onUnhandled);
      }
    });
  }
});
