// Upgrade from 0.9.0, @gnldev/evals: a run 0.9.0 scored with `scoreRun`, whose memoized scores have no
// basis — `answer-relevancy` stored 0 ("input required", the judge never called) and `contains` 1.
import { describe, expect, it } from 'vitest';
import { toJournal } from '@gnldev/durable';
import { answerRelevancy, contains, scoreRun } from '@gnldev/evals';
import * as S from '../../generate/shapes.mjs';
import { itMigrates, notes090, openFixture } from '../support.js';

describe('upgrade from 0.9.0 — evals', () => {
  itMigrates('evals.db');

  it('the fixture is what it claims: 0.9.0 memoized a 0 without calling the judge', () => {
    expect(notes090.evals.scoresOn090['answer-relevancy'].score).toBe(0);
    expect(notes090.evals.judgeCallsOn090).toBe(0);
    expect(notes090.evals.keys).toEqual(expect.arrayContaining([`${S.EVAL.runId}:proc:eval:answer-relevancy`]));
  });

  it("a 0.9.0 memo is computed again once, and the new score is replayed from then on", async () => {
    const { storage } = openFixture('evals.db');
    const j = toJournal(storage.runs);
    const calls = { n: 0 };
    const scorers = () => [answerRelevancy({ model: S.textModel(S.EVAL.judgeText, calls) as any }), contains('France')];
    const first = await scoreRun(j, S.EVAL.runId, scorers());
    expect(first.scores['answer-relevancy']?.score).toBeCloseTo(0.9);
    expect(first.scores.contains?.score).toBe(1);
    expect(calls.n).toBe(1);
    const second = await scoreRun(j, S.EVAL.runId, scorers());
    expect(second.scores['answer-relevancy']?.score).toBeCloseTo(0.9);
    expect(calls.n).toBe(1);
  });

  it('a restarted process replays the recomputed score too', async () => {
    const f = openFixture('evals.db');
    const calls = { n: 0 };
    const judge = () => [answerRelevancy({ model: S.textModel(S.EVAL.judgeText, calls) as any })];
    await scoreRun(toJournal(f.storage.runs), S.EVAL.runId, judge());
    await scoreRun(toJournal(f.reopen().runs), S.EVAL.runId, judge());
    expect(calls.n).toBe(1);
  });
});
