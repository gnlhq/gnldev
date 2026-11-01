// "Not found" claims changes were tried and none helped. When none was tried — elimination did not finish
// and no arm played, or every arm stopped too often at calls nobody answered — the verdict says the
// changes were not tested, and says nothing about the cause. Elimination that finished and blamed no
// part did try every removal: that is "not found".
import { describe, it, expect } from 'vitest';
import { wilson } from '@gnldev/experiment';
import { verdictOf, type ArmResult } from '../src/thread-diagnose.js';

const arm = (id: string, passed: number, judged: number, undetermined = 0): ArmResult => ({
  id, intervention: id === 'baseline' ? 'baseline' : 'remove', label: id, targets: id === 'baseline' ? [] : [id],
  passed, judged, undetermined, failed: 0, rate: wilson(passed, judged),
  bounds: { low: wilson(passed, judged + undetermined), high: wilson(passed + undetermined, judged + undetermined) },
  pending: [], paths: [],
});
const z = 2.5;

describe('a diagnosis that tested nothing says so', () => {
  it('elimination did not finish and no arm was played: untested, not "not found"', () => {
    const v = verdictOf(arm('baseline', 2, 20), [], undefined, z, false);
    expect(v).toMatchObject({ kind: 'untested', untested: [] });
    expect(v.sentence).toMatch(/elimination could not finish/);
    expect(v.sentence).not.toMatch(/not among the candidates/);
  });

  it('elimination finished and blamed no part: every removal was tried — not found', () => {
    expect(verdictOf(arm('baseline', 2, 20), [], undefined, z, true).kind).toBe('not-found');
  });

  it('every arm played stopped too often at unanswered calls: untested, and the arms are named', () => {
    const v = verdictOf(arm('baseline', 2, 20), [arm('turn 1', 1, 4, 16), arm('turn 2', 0, 2, 18)], undefined, z);
    expect(v).toMatchObject({ kind: 'untested', untested: ['turn 1', 'turn 2'] });
    expect(v.sentence).toMatch(/turn 1; turn 2/);
  });

  it('one arm tested and no help, one untested: not found — the untested one is still listed', () => {
    const v = verdictOf(arm('baseline', 2, 20), [arm('turn 1', 3, 20), arm('turn 2', 0, 2, 18)], undefined, z);
    expect(v.kind).toBe('not-found');
    expect(v.sentence).toMatch(/Not tested .*turn 2/);
  });

  it('the same part left out and corrected, both helping: one cause, never "cannot be told apart"', () => {
    const left = { ...arm('remove:system 2', 20, 20), targets: ['system 2'] };
    const fixed = { ...arm('correct:system 2', 20, 20), targets: ['system 2'] };
    const v = verdictOf(arm('baseline', 0, 20), [left, fixed], undefined, z);
    expect(v).toMatchObject({ kind: 'cause', arm: 'remove:system 2', also: [] });
  });
});
