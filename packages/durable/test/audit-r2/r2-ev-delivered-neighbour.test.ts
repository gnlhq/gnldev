// AUDIT ROUND 2 (red): the ':ev' gate (assertRunIdSafe) refuses `x:ev:…`, but the executor's cleanup of an
// erased running run also deletes the prefix `<runId>:ev-delivered` (detached.ts erasedRun). A run id
// `x:ev-delivered…` passes the gate, so another person's run under that id is deleted with alice's.
import { describe, it, expect } from 'vitest';
import { DetachedRuns, streamDurable, admitAgentRun, inMemoryLiveness, eraseSubject } from '../../src/index.js';
import { streamingModel } from '../detached/models.js';
import { STORES, unique } from './stores.js';

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe.each(STORES)('erasing a running detached run deletes only that run (sibling of A2) — %s', (_n, make) => {
  it("mallory's run x:ev-delivered-zzz survives the erasure of alice's running run x", async () => {
    const storage = await make(); const x = `x${unique()}`; const m = `${x}:ev-delivered-zzz`; const alice = `alice${unique()}`;
    const journal = storage.runs as any;
    const runs = new DetachedRuns({ journal, liveness: inMemoryLiveness(), resume: () => { throw new Error('no'); }, sweepMs: 0, coalesceMs: 10 });
    const argsAs = (runId: string, who: string, words: string[], gapMs: number) => ({ journal, runId, model: streamingModel({ words, gapMs }), prompt: 'p', resourceId: who }) as any;
    const startAs = (runId: string, who: string, words: string[], gapMs: number) => runs.start({
      runId, launch: (s) => streamDurable({ ...argsAs(runId, who, words, gapMs), abortSignal: s }), admit: () => admitAgentRun(argsAs(runId, who, words, gapMs)),
    });
    await startAs(x, alice, Array.from({ length: 200 }, (_, i) => `a${i} `), 10);
    await startAs(m, 'mallory', ['mallory-answer '], 1);
    for await (const _ of runs.follow({ runId: m })) { /* to its end */ }
    expect(await journal.get(`${m}:input`), "mallory's run exists").toBeDefined();
    await eraseSubject(storage, alice);
    await sleep(1_500);
    const left = await journal.listKeys(m);
    expect(await journal.get(`${m}:input`), `mallory's run was deleted by alice's erasure; left: ${JSON.stringify(left)}`).toBeDefined();
    await runs.close();
  });
  it("control: the same erasure after alice's run x ended spares it (the engine's purge alone)", async () => {
    const storage = await make(); const x = `x${unique()}`; const m = `${x}:ev-delivered-zzz`; const alice = `alice${unique()}`;
    const journal = storage.runs as any;
    const runs = new DetachedRuns({ journal, liveness: inMemoryLiveness(), resume: () => { throw new Error('no'); }, sweepMs: 0, coalesceMs: 10 });
    const argsAs = (runId: string, who: string, words: string[]) => ({ journal, runId, model: streamingModel({ words, gapMs: 1 }), prompt: 'p', resourceId: who }) as any;
    const startAs = (runId: string, who: string, words: string[]) => runs.start({
      runId, launch: (s) => streamDurable({ ...argsAs(runId, who, words), abortSignal: s }), admit: () => admitAgentRun(argsAs(runId, who, words)),
    });
    await startAs(x, alice, ['a ']);
    for await (const _ of runs.follow({ runId: x })) { /* to its end */ }
    await startAs(m, 'mallory', ['mallory-answer ']);
    for await (const _ of runs.follow({ runId: m })) { /* to its end */ }
    await eraseSubject(storage, alice);
    expect(await journal.get(`${m}:input`)).toBeDefined();
    expect(await journal.get(`${x}:input`)).toBeUndefined();
    await runs.close();
  });
});
