// A tool body stopped because its process's liveness session is gone (durable-tool passes the session signal
// in `abortSignal`) is RELEASED like a body that rethrows the signal's reason — however the body says it
// stopped.
//
// Measured (framework-s0/liveness-audit, scenarios body-a-timers / body-a-generic): a body that waits
// with node:timers/promises rejects with an `AbortError` whose `cause` is the LivenessUnavailableError, and
// `attemptEndOf` reads one `cause` deep to find it — but the run's tool-error event carries `errorData(...)`,
// which keeps name and message and drops `cause`. So the detached executor read 'attempt', the model was told
// "AbortError: The operation was aborted", answered, and the run ended `completed` with the effect run ZERO
// times — 10 of 10 trials, the same as a body that throws an error of its own. A body that rethrows the reason
// (`signal.throwIfAborted()`) is released and waits for a person (SideEffectRetryBlockedError), 10 of 10.
import { describe, it, expect, afterEach } from 'vitest';
import { setTimeout as sleepAbortable } from 'node:timers/promises';
import { tool } from 'ai';
import { z } from 'zod';
import { DetachedRuns, streamDurable } from '../src/index.js';
import { SqliteStorage } from '../src/sqlite-storage.js';
import { bindLiveness, unbindLiveness, sessionSignals } from '../src/process-liveness.js';
import { execKey } from '../src/exec-record.js';
import { streamingModel } from './detached/models.js';

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
let cleanup: Array<() => Promise<unknown> | unknown> = [];
afterEach(async () => { for (const c of cleanup.reverse()) await c(); cleanup = []; });

/** How the body stops when its signal aborts: the three shapes the measurement saw. */
const stops = {
  'rethrows the reason': async (o: any) => { await new Promise<void>((_r, reject) => o.abortSignal.addEventListener('abort', () => reject(o.abortSignal.reason))); },
  'waits with node:timers/promises (AbortError, reason as its cause)': async (o: any) => { await sleepAbortable(60_000, undefined, { signal: o.abortSignal }); },
  'throws an error of its own': async (o: any) => { await new Promise<void>((_r, reject) => o.abortSignal.addEventListener('abort', () => reject(new Error('the work was interrupted')))); },
} as const;

describe('a body stopped by its lost session', () => {
  for (const [how, wait] of Object.entries(stops)) {
    it(`${how}: the run is released, never completed without its call`, async () => {
      const GRACE = 600;
      const signals = sessionSignals(GRACE);
      let healthy = true;
      const l: any = { id: 'p-gone', reconnectGraceMs: GRACE, sessionSignal: signals.signal, confirm: async () => healthy, isAlive: async () => true, close: async () => undefined };
      const storage = new SqliteStorage(':memory:');
      const journal = storage.runs as any;
      bindLiveness(journal, l);
      cleanup.push(() => { signals.close(); unbindLiveness(journal); return storage.close(); });
      let started = 0;
      const effect = tool({
        description: 'x', inputSchema: z.object({ order: z.string() }),
        execute: async (_: unknown, o: any) => {
          started++;
          healthy = false; // the session goes under the body and stays gone past half its grace
          await wait(o);
          return 'done';
        },
      });
      Object.assign(effect, { sideEffect: true });
      const model = streamingModel({ words: ['ok '], gapMs: 5, tool: { name: 'effect', input: { order: 'o-1' } } });
      const args = (runId: string) => ({ journal, runId, model, tools: { effect }, prompt: 'do it', resourceId: 'alice', timeouts: { claimTtlMs: 30_000 } }) as any;
      const runs = new DetachedRuns({ journal, liveness: l, sweepMs: 0, pollMs: 25, resume: (rec: any) => (s: AbortSignal) => streamDurable({ ...args(rec.runId), abortSignal: s }) });
      cleanup.push(() => runs.close?.());
      await runs.start({ runId: 'r1', launch: (s: AbortSignal) => streamDurable({ ...args('r1'), abortSignal: s }) } as any);

      const rec = async () => (await journal.get(execKey(undefined, 'r1'))) as { status?: string } | undefined;
      for (let i = 0; i < 200 && (await rec())?.status === 'running'; i++) await sleep(25);
      const evs: any[] = [];
      const ac = new AbortController(); setTimeout(() => ac.abort(), 300);
      for await (const e of runs.follow({ runId: 'r1', signal: ac.signal })) evs.push(e);
      const states = evs.filter((e) => e.kind === 'status').map((e) => e.data.state);
      expect(started).toBe(1);
      expect(states, 'not finished without its call').not.toContain('completed');
      expect(evs.some((e) => e.kind === 'tool-error'), 'the stop is not told to the model as the tool failing').toBe(false);
      expect((await rec())?.status, 'the execution is released').toBe('released');
    }, 30_000);
  }
});
