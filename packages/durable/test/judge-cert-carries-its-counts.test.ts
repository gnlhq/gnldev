// A qualification certificate shows how many pairs its rates rest on, and the runtime refuses one that
// does not show enough. A recall of 1.0 over 4 pairs and over 200 used to read the same. Every number in
// it is one a bench run can produce: whole pair counts, rates from 0 to 1.
import { describe, it, expect } from 'vitest';
import { validateJudgeConfig, JUDGE_PROMPT_VERSION, JUDGE_MIN_PAIRS } from '../src/index.js';

const cert = (over: Record<string, unknown> = {}) => ({ v: 1, fixtureSetId: 'f', judgeModelId: 'm', judgePromptVersion: JUDGE_PROMPT_VERSION, paraphraseRecall: 1, nearMissFp: 0, paraphrasePairs: 20, nearMissAnswered: 20, passedAt: Date.now(), ...over });
const cfg = (c: unknown) => ({ complete: async () => '', judgeModelId: 'm', qualification: c }) as any;

describe('a judge certificate carries its counts', () => {
  it('enough pairs → accepted', () => { expect(() => validateJudgeConfig(cfg(cert()))).not.toThrow(); });
  it('a perfect recall over too few pairs → refused, naming the field and the floor', () => {
    expect(() => validateJudgeConfig(cfg(cert({ paraphrasePairs: JUDGE_MIN_PAIRS - 1 })))).toThrow(/paraphrasePairs.*re-run/is);
  });
  it('too few near-miss answers → refused', () => {
    expect(() => validateJudgeConfig(cfg(cert({ nearMissAnswered: 1 })))).toThrow(/nearMissAnswered/);
  });
  it('a count that is not a whole number of pairs (Infinity, 5.5, a string) → refused', () => {
    for (const n of [Infinity, 5.5, '20']) expect(() => validateJudgeConfig(cfg(cert({ paraphrasePairs: n }))), String(n)).toThrow(/paraphrasePairs/);
  });
  it('a rate outside 0..1 or not a number (95 for 95%, Infinity, -1, NaN, a string) → refused, naming the field', () => {
    for (const r of [95, Infinity, 1.01, '0.95', NaN]) expect(() => validateJudgeConfig(cfg(cert({ paraphraseRecall: r }))), String(r)).toThrow(/paraphraseRecall.*0 to 1/s);
    for (const r of [-1, -Infinity, null]) expect(() => validateJudgeConfig(cfg(cert({ nearMissFp: r }))), String(r)).toThrow(/nearMissFp.*0 to 1/s);
  });
  it('the bounds themselves are rates: recall 1 and false alarms 0 → accepted', () => {
    expect(() => validateJudgeConfig(cfg(cert({ paraphraseRecall: 1, nearMissFp: 0 })))).not.toThrow();
  });
  it('a certificate without counts (hand-written, or from before) → refused with the way through', () => {
    const { paraphrasePairs: _a, nearMissAnswered: _b, ...old } = cert();
    expect(() => validateJudgeConfig(cfg(old))).toThrow(/missing.*semantic-qualify/s);
  });
});

describe('nearMissPairs: the count nearMissFp rests on', () => {
  it('a certificate without it (issued before the field) is accepted', () => {
    expect(() => validateJudgeConfig(cfg(cert()))).not.toThrow();
  });
  it('fewer pairs put than answered, or not a whole number → refused', () => {
    for (const v of [19, 5.5, -1]) expect(() => validateJudgeConfig(cfg(cert({ nearMissPairs: v }))), String(v)).toThrow(/nearMissPairs/);
    expect(() => validateJudgeConfig(cfg(cert({ nearMissPairs: 24 })))).not.toThrow();
  });
});
