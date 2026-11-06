// A liveness session that is gone for a moment does not fail the call that meets it, and does not leave
// that call's claim behind.
//
// Seen in S5 (4 processes, 200 runs on one Postgres, 2 cores — what CI runs on): the heartbeat of a
// process whose database answered late (a proof not answered within one heartbeat) counted its session as
// lost, and the process took its lock back under the same id a moment later. Every tool call that reached
// its body in between found `confirm()` false in `Attempt.assertHeld` and was marked LOST as if another
// attempt had taken it over: the call was answered "being executed by another executor" (RunBusyError) —
// by its OWN claim, still held by this process — and the run ended `failed` at its ninth event, one
// process's whole share of the 200 (`completed` 150 of 200). The body never started, and the claim was
// left `running`.
//
// A session that is back inside the time the bodies it started may still run (`sessionSignal`: half the
// reconnect grace after the last proof) loses nothing: the others read this process as dead only a whole
// grace after its lock went. So the body waits for it. A session that is not back in that time starts
// nothing — and gives the claim back (the body never started), with the refusal that says why
// (`LivenessUnavailableError`, retryable), not as a call another executor holds.
import { describe, it, expect, afterEach } from 'vitest';
import { durableTool } from '../src/durable-tool.js';
import { SqliteStorage } from '../src/sqlite-storage.js';
import { bindLiveness, unbindLiveness, sessionSignals, LivenessUnavailableError } from '../src/process-liveness.js';
import { runKeys } from '../src/journal.js';
import type { DurableCtx } from '../src/journal.js';

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const GRACE = 600; // reconnect grace of the fake session: bodies are told to stop 300 ms after its last proof

/** A process liveness whose own session can be cut (`cut()`) and taken back (`back()`), as the Postgres one is. */
function session() {
  const signals = sessionSignals(GRACE);
  let healthy = true;
  const l = {
    id: 'p-blip', reconnectGraceMs: GRACE, sessionSignal: signals.signal,
    confirm: async () => healthy,
    isAlive: async () => true,
    close: async () => { signals.close(); },
  };
  return {
    l,
    cut() { healthy = false; },
    back() { healthy = true; signals.proven(); },
    stop() { signals.close(); },
  };
}

let stop: (() => void) | undefined;
afterEach(() => { stop?.(); stop = undefined; });

async function setup() {
  const storage = new SqliteStorage(':memory:');
  const s = session();
  stop = s.stop;
  bindLiveness(storage.runs, s.l as any);
  let executions = 0;
  const tool = { sideEffect: true, execute: async () => { executions++; return { charged: executions }; } };
  const runId = `r-blip-${Date.now().toString(36)}`;
  const key = runKeys.tool(runId, 'c1');
  const call = () => durableTool(tool as any, { journal: storage.runs, runId } as unknown as DurableCtx, 'charge').execute!({ amount: 1 }, { toolCallId: 'c1' } as any);
  return { storage, s, call, key, executions: () => executions };
}

describe('a liveness session that is gone when a call reaches its body', () => {
  it('back within the time the bodies may still run: the body waits for it and runs once', async () => {
    const t = await setup();
    try {
      t.s.cut();
      const out = t.call();
      await sleep(100); // inside half the grace: nothing starts yet
      expect(t.executions()).toBe(0);
      t.s.back();
      expect(await out).toEqual({ charged: 1 });
      expect(t.executions()).toBe(1);
      expect(await t.storage.runs.get(t.key)).toMatchObject({ status: 'succeeded', output: { charged: 1 } });
    } finally { unbindLiveness(t.storage.runs); await t.storage.close(); }
  });

  it('not back in that time: nothing starts, the claim is given back, and the call is refused as retryable', async () => {
    const t = await setup();
    try {
      t.s.cut();
      const err = await t.call().then(() => undefined, (e) => e);
      expect(err, 'a retryable refusal, not a call another executor holds').toBeInstanceOf(LivenessUnavailableError);
      expect(t.executions()).toBe(0);
      const left = (await t.storage.runs.get(t.key)) as { status?: string } | undefined;
      expect(left?.status === 'running', 'no claim left running by a body that never started').toBe(false);
      t.s.back();
      expect(await t.call()).toEqual({ charged: 1 });
      expect(t.executions(), 'a retry runs it once').toBe(1);
    } finally { unbindLiveness(t.storage.runs); await t.storage.close(); }
  });
});
