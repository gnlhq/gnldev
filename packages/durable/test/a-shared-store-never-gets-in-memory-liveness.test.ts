// T1 — a process that is given no liveness must not judge the OTHER processes of a shared store dead.
//
// `DetachedRuns` defaulted to `inMemoryLiveness()` when the app passed none. Its `isAlive(other)` is
// "is this one of MY ids": every other process reads as dead. With two app processes on one Sqlite file
// or one Postgres, the second process's sweep took the first one's LIVE run over within a sweep tick
// and ran the side effect beside it — worse than today's claim-by-age, which at least waits claimTtl.
// On a store other processes can reach, the only correct answers are a real liveness or a refusal.
import { describe, it, expect, afterEach } from 'vitest';
import { newStore, startNode, post, effectCount, waitFor, stopNode, sleep, PG_BASE, type Node, type Store } from './detached/harness.js';

const kinds: Array<'sqlite' | 'postgres'> = PG_BASE ? ['sqlite', 'postgres'] : ['sqlite'];
const live: Node[] = [];
const stores: Store[] = [];
afterEach(async () => {
  await Promise.all(live.splice(0).map(stopNode));
  stores.splice(0).forEach((s) => s.drop());
});

describe.each(kinds)('T1 on %s: no liveness given', (kind) => {
  it(`T1 ${kind}: refuses to start, or a live run is never taken over (one execution)`, { timeout: 60_000 }, async () => {
    const s = newStore(kind);
    stores.push(s);
    const env = { DN_NO_LIVENESS: '1', DN_TOOL_MS: '2500', DN_SWEEP_MS: '200', DN_CLAIM_TTL: process.env.T1_TTL ?? '30000' };
    let a: Node;
    try {
      a = await startNode(s, env);
    } catch (e) {
      // The fix: a shared store with no liveness is a startup error that names the remedy.
      expect(String(e)).toMatch(/liveness/i);
      return;
    }
    live.push(a);
    const b = await startNode(s, env);
    live.push(b);
    expect((await (await post(a, '/start', { runId: 'r-t1' })).json()).state).toBe('started');
    await waitFor(() => effectCount(s) >= 1, 20_000, 'the effect');
    await sleep(3_000); // a takeover by B would run its own copy of the 2.5 s body in this window
    const { linesOf } = await import('./detached/harness.js');
    const statsB = await (await fetch(b.url("/stats"))).json();
    const evs: any[] = await (await fetch(a.url("/stats"))).json().then((x) => [x]);
    console.log(`[T1 ${kind}] statsB=${JSON.stringify(statsB)} statsA=${JSON.stringify(evs)}`);
    console.log(`[T1 ${kind}] started=${JSON.stringify(linesOf(`${s.effects}.started`))} effects=${JSON.stringify(linesOf(s.effects))} stderrB=${b.stderr().split("\n").filter((l) => /gnldev|Error/.test(l)).slice(0, 8).join(" | ")}`);
    expect(statsB.execWrites, 'B took over the live run of A (a second executor: model calls, events)').toBe(0);
    expect(effectCount(s), 'the live run on A was taken over by B and ran again').toBe(1);
  });
});
