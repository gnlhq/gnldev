// An agent's `scorers` in createGnl — the THIRD runner, beside @gnldev/evals' evalDataset and scoreRun.
//
// Invariant (K1): every runner gives scorers the sample fields they read, and one name = one score.
// The two evals runners were fixed in round 1 with their own copies of "build the sample" and
// "distinct names"; this runner kept the old ones: it keyed scores by name with no duplicate check
// (two scorers named 'judge' → the second replayed the first one's memo), and it set `sample.input`
// only from a STRING prompt — a run started with `messages` gave `answerRelevancy` no question (0).
// Both rules now live once, in this package (`scoring.ts`), and all three runners call them.
//
// Invariant (K2): a memoized score is replayed only for the sample it was computed on. 0.9.0 memoized
// `answerRelevancy = 0` ("input required") for runs whose input it never passed; after the upgrade
// that 0 was replayed forever. The memo now carries a basis (a hash of the sample); a memo without
// one, or with another, is recomputed.
import { describe, it, expect } from 'vitest';
import { InMemoryJournal } from '../src/journal.js';
import { createGnl } from '../src/registry.js';
import { claimRunOwner, STAFF } from '../src/run-identity.js';
import { scoreSample, assertDistinctScorerNames, memoizeScoring } from '../src/scoring.js';
import { createMockModel, finalTextResult } from './mock.js';

const model = () => createMockModel(async () => finalTextResult('Paris'));

describe('createGnl agent scorers', () => {
  it('two scorers with one name are refused at construction, before any run or model call', () => {
    expect(() => createGnl({ journal: new InMemoryJournal(), agents: { a: { model: model(), scorers: [
      { name: 'judge', score: () => ({ score: 0.1 }) },
      { name: 'judge', score: () => ({ score: 0.9 }) },
    ] } } })).toThrow(/agent 'a'.*scorers\[0\] and scorers\[1\] are both named 'judge'/s);
  });

  it('a run started with `messages` hands the scorer its question (the last user turn)', async () => {
    let seen: unknown = 'not called';
    const gnl = createGnl({ journal: new InMemoryJournal(), agents: { a: { model: model(), scorers: [
      { name: 'rel', score: (s) => { seen = s.input; return { score: 1 }; } },
    ] } } });
    await gnl.run('a', { runId: 'm1', messages: [
      { role: 'user', content: 'first question' },
      { role: 'assistant', content: 'an answer' },
      { role: 'user', content: [{ type: 'text', text: 'what is the capital of France?' }] },
    ] } as any);
    expect(seen).toBe('what is the capital of France?');
  });

  it('a string prompt is still the question', async () => {
    let seen: unknown;
    const gnl = createGnl({ journal: new InMemoryJournal(), agents: { a: { model: model(), scorers: [
      { name: 'rel', score: (s) => { seen = s.input; return { score: 1 }; } },
    ] } } });
    await gnl.run('a', { runId: 'p1', prompt: 'capital of France?' });
    expect(seen).toBe('capital of France?');
  });

  it('a score memoized by 0.9.0 (no basis) is recomputed, then replayed exactly once', async () => {
    const journal = new InMemoryJournal();
    let calls = 0;
    const gnl = createGnl({ journal, agents: { a: { model: model(), scorers: [
      { name: 'rel', score: (s) => { calls++; return { score: s.input ? 0.9 : 0 }; } },
    ] } } });
    const run = () => gnl.run('a', { runId: 'old-1', messages: [{ role: 'user', content: 'capital of France?' }] } as any);
    await run();
    // What 0.9.0 left behind for this run: the judge saw no input, said 0, and it was memoized by name.
    await journal.put('old-1:proc:eval:rel', { v: { score: 0, reason: 'input required' } });
    calls = 0;
    expect(((await run()) as any).scores.rel.score).toBe(0.9);
    expect(((await run()) as any).scores.rel.score).toBe(0.9);
    expect(calls).toBe(1);
    // The record keeps the `{ v }` shape the Studio scores route and rebuildMetrics read.
    expect(await journal.get('old-1:proc:eval:rel')).toEqual({ v: { score: 0.9 }, basis: expect.any(String) });
  });
});

describe('scoring.ts — the one owner of the sample and the name rule', () => {
  it('scoreSample: input as text from a string, a {prompt}, {messages} or a message list; undefined fields omitted', () => {
    expect(scoreSample({ output: 'o', input: 'q' })).toEqual({ output: 'o', input: 'q' });
    expect(scoreSample({ output: 'o', input: { messages: [{ role: 'user', content: 'q2' }] } })).toEqual({ output: 'o', input: 'q2' });
    expect(scoreSample({ output: 'o', input: [{ role: 'user', content: 'q3' }] })).toEqual({ output: 'o', input: 'q3' });
    expect(scoreSample({ output: 'o', input: undefined, expected: undefined, context: ['c'], runId: 'r' })).toEqual({ output: 'o', context: ['c'], runId: 'r' });
  });

  it('assertDistinctScorerNames names the runner and both positions', () => {
    expect(() => assertDistinctScorerNames([{ name: 'x' }, { name: 'y' }, { name: 'x' }], 'myRunner'))
      .toThrow(/myRunner: scorers\[0\] and scorers\[2\] are both named 'x'/);
  });

  it('memoizeScoring: same basis → replayed; another basis → recomputed', async () => {
    const j = new InMemoryJournal();
    await claimRunOwner(j, 'r', STAFF); // a score's memo is the run's record: the run exists
    let n = 0;
    const step = (basis: unknown) => memoizeScoring(j, 'r', 'eval:s', basis, () => ++n);
    expect(await step({ a: 1 })).toBe(1);
    expect(await step({ a: 1 })).toBe(1);
    expect(await step({ a: 2 })).toBe(2);
  });
});
