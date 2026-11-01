// The arithmetic every experiment rests on: Shapley shares that add up, intervals that do not claim
// more than k trials can, and a distance between outcome distributions.
import { describe, it, expect } from 'vitest';
import { coalitions, coalitionKey, shapley, meanInterval, wilson, distribution, tvd } from '../src/index.js';

describe('shares add up and intervals are honest', () => {
  it('three parts, worked by hand: M2 two thirds, S1 and T1 a sixth each — and they sum to v(all) − v(∅)', () => {
    const v = { '∅': 0, S1: 0, M2: 1 / 3, T1: 0, 'M2+S1': 2 / 3, 'S1+T1': 0, 'M2+T1': 2 / 3, 'M2+S1+T1': 1 };
    const phi = shapley(['S1', 'M2', 'T1'], v);
    expect(phi.M2).toBeCloseTo(2 / 3, 12);
    expect(phi.S1).toBeCloseTo(1 / 6, 12);
    expect(phi.T1).toBeCloseTo(1 / 6, 12);
    expect(phi.M2! + phi.S1! + phi.T1!).toBeCloseTo(v['M2+S1+T1'] - v['∅'], 12);
  });

  it('a part that changes nothing gets nothing; two parts that do the same get the same', () => {
    const players = ['a', 'b', 'c'];
    const value = (s: Set<string>) => (s.has('a') || s.has('b') ? 1 : 0); // c never matters; a and b are interchangeable
    const v = Object.fromEntries(coalitions(players).map((s) => [coalitionKey(s), value(s)]));
    const phi = shapley(players, v);
    expect(phi.c).toBe(0);
    expect(phi.a).toBeCloseTo(phi.b!, 12);
    expect(phi.a! + phi.b!).toBeCloseTo(1, 12);
  });

  it('when the outcome does not depend on the parts the shares sum to zero — and can still be large and opposite', () => {
    // Measured on a real run: a misleading earlier message (H4) and the turn that corrected it (H3).
    const v = { '∅': 1, H3: 1, H4: 0.25, 'H3+H4': 1 };
    const phi = shapley(['H3', 'H4'], v);
    expect(phi.H3! + phi.H4!).toBeCloseTo(0, 12);
    expect(phi.H4).toBeCloseTo(-0.375, 12);
    expect(phi.H3).toBeCloseTo(0.375, 12);
  });

  it('a subset with no value is an error, not a zero', () => {
    expect(() => shapley(['a', 'b'], { '∅': 0, a: 1, b: 1 })).toThrow(/no value for \{a\+b\}/);
  });

  it('coalitions: every subset once, the empty one first, and a refusal past 12 players', () => {
    const cs = coalitions(['x', 'y', 'z']);
    expect(cs).toHaveLength(8);
    expect(new Set(cs.map(coalitionKey)).size).toBe(8);
    expect(coalitionKey(cs[0]!)).toBe('∅');
    expect(() => coalitions(Array.from({ length: 13 }, (_, i) => `p${i}`))).toThrow(/at most 12/);
    expect(() => coalitions(['a', 'a'])).toThrow(/unique/);
  });

  it('a mean of a few numbers is given with Student\'s t, not the normal interval', () => {
    const r = meanInterval([0, -0.078, 0.058, -0.011, 0.083]);
    expect(r.value).toBeCloseTo(0.0104, 4);
    // t(4) = 2.776, sd = 0.0631: half-width 0.0783 — the normal 1.96 would claim 0.0553.
    expect(r.high - r.value).toBeCloseTo(0.0783, 3);
    expect(Number.isNaN(meanInterval([0.5]).low)).toBe(true);
  });

  it('twenty successes in twenty is not certainty: Wilson keeps an interval', () => {
    const r = wilson(20, 20);
    expect(r.value).toBe(1);
    expect(r.high).toBeCloseTo(1, 12);
    expect(r.low).toBeLessThan(0.85);
    expect(r.low).toBeGreaterThan(0.8);
  });

  it('tvd: 0 for the same distribution, 1 for nothing in common, and the share of what moved otherwise', () => {
    const a = distribution(['search>replace', 'search>replace', 'search>replace', '(none)']);
    expect(tvd(a, a)).toBe(0);
    expect(tvd(distribution(['x']), distribution(['y']))).toBe(1);
    expect(tvd(a, distribution(['search>replace', '(none)']))).toBeCloseTo(0.25, 12);
  });
});
