// A body never starts once its process's session went unproven long enough for another process to take its
// call over — even when the session is back by then.
//
// Measured (framework-s0/liveness-audit D4, scenarios prebody-a-droplive*): the server dropped only
// process A's liveness session while A's claim waited for its answer. Past the grace another process read A
// as dead and took the run over. At the thaw A's session came back at once, so `sessionBack` said yes, and
// A's stamp was younger than half its TTL, so `assertHeld` did not prove it by compare-and-set: A started
// the body ~4 s after the takeover, in 6 of 20 trials. A double body was not seen there (the taker's claim
// waited behind A's open transaction); a different timing makes it one.
//
// Here the takeover is written by hand while the claim waits (in `lookup`, the last gate between the claim
// and the body): the session goes, stays gone past half its grace (its signal aborts), comes back, and the
// call's record is now another live process's claim. The body must not start; the run is released, the model
// is not told the tool failed, and the other process's claim stands.
import { describe, it, expect, afterEach } from 'vitest';
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

describe('a body after its session was lost past half the grace', () => {
  for (const takenOver of [true, false]) {
    it(takenOver ? 'its call taken over meanwhile: the body never starts, the other claim stands' : 'nobody took it over: the body does not start now, the run is released and continues once', async () => {
      const GRACE = 600;
      const signals = sessionSignals(GRACE);
      let healthy = true;
      // The heartbeat: a healthy session is proven every 100 ms (a lost one is not).
      const beat = setInterval(() => { if (healthy) signals.proven(); }, 100);
      cleanup.push(() => clearInterval(beat));
      const l: any = { id: 'p-a', reconnectGraceMs: GRACE, sessionSignal: signals.signal, confirm: async () => healthy, isAlive: async () => true, close: async () => undefined };
      const storage = new SqliteStorage(':memory:');
      const journal = storage.runs as any;
      bindLiveness(journal, l);
      cleanup.push(() => { signals.close(); unbindLiveness(journal); return storage.close(); });
      let started = 0;
      let lookups = 0;
      const effect = tool({
        description: 'x', inputSchema: z.object({ order: z.string() }),
        execute: async () => { started++; return 'done'; },
      });
      Object.assign(effect, {
        sideEffect: true,
        // Between the claim and the body: the session is lost past half its grace, then proven again.
        lookup: async () => {
          if (lookups++ > 0) return { exists: false };
          healthy = false;
          await sleep(GRACE / 2 + 150);
          expect(signals.signal().aborted, 'the session signal is aborted').toBe(true);
          if (takenOver) {
            // Another process judged this one dead and claimed the call (its stamp, its process).
            const key = (await journal.listKeys('r1:tool:'))[0];
            const mine = await journal.get(key);
            await journal.put(key, { ...mine, proc: 'p-b', hold: undefined, startedAt: Date.now() });
          }
          signals.proven();
          healthy = true;
          return { exists: false };
        },
      });
      const model = streamingModel({ words: ['ok '], gapMs: 5, tool: { name: 'effect', input: { order: 'o-1' } } });
      const args = (runId: string) => ({ journal, runId, model, tools: { effect }, prompt: 'do it', resourceId: 'alice', timeouts: { claimTtlMs: 30_000 } }) as any;
      const runs = new DetachedRuns({ journal, liveness: l, sweepMs: 0, pollMs: 25, resume: (rec: any) => (s: AbortSignal) => streamDurable({ ...args(rec.runId), abortSignal: s }) });
      cleanup.push(() => runs.close?.());
      await runs.start({ runId: 'r1', launch: (s: AbortSignal) => streamDurable({ ...args('r1'), abortSignal: s }) } as any);

      const rec = async () => (await journal.get(execKey(undefined, 'r1'))) as { status?: string } | undefined;
      for (let i = 0; i < 200 && (await rec())?.status === 'running'; i++) await sleep(25);
      const states = async () => {
        const evs: any[] = [];
        const ac = new AbortController(); setTimeout(() => ac.abort(), 300);
        for await (const e of runs.follow({ runId: 'r1', signal: ac.signal })) evs.push(e);
        return { evs, states: evs.filter((e) => e.kind === 'status').map((e) => e.data.state) };
      };
      const first = await states();
      expect(started, 'the body did not start').toBe(0);
      expect(first.states).not.toContain('completed');
      expect(first.evs.some((e) => e.kind === 'tool-error'), 'the refusal is not told to the model').toBe(false);
      expect((await rec())?.status, 'the execution is released').toBe('released');
      const call = await journal.get((await journal.listKeys('r1:tool:'))[0]);
      if (takenOver) {
        expect(call?.proc, 'the other process\'s claim stands').toBe('p-b');
        return;
      }
      expect(call?.status, 'the claim was given back').toBe('released');
      // The next sweep continues the run: the body runs then, once.
      const taken = await runs.sweep();
      expect(taken).toBe(1);
      for (let i = 0; i < 200 && (await rec()) !== undefined; i++) await sleep(25);
      const after = await states();
      expect(started).toBe(1);
      expect(after.states.at(-1)).toBe('completed');
    }, 30_000);
  }
});
