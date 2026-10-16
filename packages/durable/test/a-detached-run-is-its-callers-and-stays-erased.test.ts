// A detached run belongs to the caller who started it, and an erased run stays erased — while it runs.
//
// T4  A second caller naming the same runId was ATTACHED to the first caller's live run: the door asked
//     whose run it was before `start`, when the run did not exist yet, and `start` never asked again.
//     The executor now asks the engine's admission (`admit`) every time — one rule, the engine's.
// T6  A follower kept receiving a run after the run was erased (the executing process streams from
//     memory and never looked at the erasure fence).
// T3  The executor kept writing events — and a completion notice — after the erasure deleted them.
// T5  The execution record (`__exec__:…`) is not in the erasure model and outlived the erasure.
import { describe, it, expect } from 'vitest';
import { InMemoryStorage, DetachedRuns, streamDurable, admitAgentRun, inMemoryLiveness, eraseSubject, readRunEvents } from '../src/index.js';
import { streamingModel } from './detached/models.js';

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const words = Array.from({ length: 80 }, (_, i) => `secret${i} `);

function setup() {
  const storage = new InMemoryStorage();
  const journal = storage.runs as any;
  const hooks: string[] = [];
  const runs = new DetachedRuns({
    journal, liveness: inMemoryLiveness(), resume: () => { throw new Error('no takeover here'); }, sweepMs: 0,
    onComplete: async (c) => { hooks.push(`${c.runId} ${c.state}`); },
  });
  const model = streamingModel({ words, gapMs: 20 });
  const argsAs = (runId: string, who: string) => ({ journal, runId, model, prompt: 'my secret', resourceId: who }) as any;
  const launchAs = (runId: string, who: string) => (signal: AbortSignal) => streamDurable({ ...argsAs(runId, who), abortSignal: signal });
  // Whose run it is: the engine's own admission, asked by the executor before it executes or attaches.
  const startAs = (runId: string, who: string) => runs.start({ runId, launch: launchAs(runId, who), admit: () => admitAgentRun(argsAs(runId, who)) });
  return { storage, journal, runs, hooks, launchAs, startAs };
}

describe('a detached run is its caller\'s', () => {
  it('T4: another caller naming the same runId is refused, not attached', async () => {
    const { runs, startAs } = setup();
    expect((await startAs('r-own', 'alice')).state).toBe('started');
    let state: string | undefined;
    let refused: unknown;
    try {
      state = (await startAs('r-own', 'mallory')).state;
    } catch (e) { refused = e; }
    expect(state, 'mallory was attached to alice\'s live run').not.toBe('attached');
    expect(refused).toBeDefined();
    // The owner still attaches.
    expect((await startAs('r-own', 'alice')).state).toBe('attached');
    for await (const _ of runs.follow({ runId: 'r-own' })) { /* to the end */ }
    await runs.close();
  });
});

describe('an erased run stays erased while it runs', () => {
  it('T6/T3/T5: erasure mid-run ends followers, writes nothing back, sends no completion, leaves no record', async () => {
    const { storage, journal, runs, hooks, startAs } = setup();
    await startAs('r-er', 'alice');
    const got: any[] = [];
    let erasedAt = 0;
    const follower = (async () => {
      for await (const ev of runs.follow({ runId: 'r-er' })) {
        got.push({ ...ev, t: Date.now() });
        if (!erasedAt && got.filter((e) => e.kind === 'text').length >= 5) {
          erasedAt = Date.now();
          await eraseSubject(storage, 'alice');
        }
      }
    })();
    const ended = await Promise.race([follower.then(() => true), sleep(4_000).then(() => false)]);
    // T6: the follower ends soon after the erasure, and receives no text written after it (+1 s grace).
    expect(ended, 'the follower of an erased run never ended').toBe(true);
    const late = got.filter((e) => e.kind === 'text' && e.t > erasedAt + 1_000);
    expect(late.length, 'text kept streaming from an erased run').toBe(0);
    await sleep(2_500); // whatever the executor still does, it does now
    // T3: nothing of the run is written back, and no completion notice goes out for it.
    expect(await readRunEvents(journal, 'r-er'), 'events written back after the erasure').toEqual([]);
    const back = (await journal.listKeys('')).filter((k: string) => k.startsWith('r-er:') || k.includes('secret'));
    expect(back, 'run keys written back').toEqual([]);
    expect(hooks.filter((h) => h.startsWith('r-er ')), 'a completion notice for an erased run').toEqual([]);
    // T5: the execution record goes with the run.
    expect((await journal.listKeys('__exec__:')).filter((k: string) => k.includes('r-er')), 'the execution record outlived the erasure').toEqual([]);
    await runs.close();
  });
});
