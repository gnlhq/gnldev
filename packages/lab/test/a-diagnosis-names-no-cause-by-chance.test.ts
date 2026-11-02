// A diagnosis names a cause only beyond chance: a model that errs at random, whatever its input, is
// never "explained" by a part of it more often than the 5% the level allows — over many seeds — and a
// model that is mostly right is reported as having failed by chance. The Bonferroni level is what
// holds the family of comparisons to 5%: without it, six arms of pure noise name a cause far more often.
import { describe, it, expect } from 'vitest';
import { wilson, newcombe, normalQuantile } from '@gnldev/experiment';
import { windowMemory, agentModel, recordThread, call, trap } from './thread-fixtures.js';
import { diagnoseTurn, verdictOf, planDiagnosis, type ArmResult } from '../src/thread-diagnose.js';

/** mulberry32: a seeded generator, so every run of this test draws the same numbers. */
function rng(seed: number) {
  let a = seed >>> 0;
  return () => { a = (a + 0x6d2b79f5) >>> 0; let t = a; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}
const ANKARA = { calls: [{ toolName: 'createOrder', args: { address: 'Ankara' } }] };
const NAMES_A_CAUSE = new Set(['cause', 'indistinct', 'joint']);
// The measured rates, printed with GNL_TEST_VERBOSE=1.
const log = (...a: unknown[]) => void (process.env.GNL_TEST_VERBOSE && process.stdout.write(`AUDIT ${a.map((x) => (typeof x === 'string' ? x : JSON.stringify(x))).join(' ')}\n`));

describe('a diagnosis names no cause by chance', () => {
  it('a model that errs 30% of the time whatever it is shown: over 200 seeds, a cause is named in at most 5%', async () => {
    const { journal, ids } = await recordThread(['Ship my order.'], {
      memory: windowMemory(4, () => '# Working Memory\nname: Ayse'), model: agentModel(() => call('createOrder', { address: 'Izmir' })), system: 'You are a shop agent.',
    });
    const kinds: Record<string, number> = {};
    for (let seed = 1; seed <= 200; seed++) {
      const draw = rng(seed);
      const model = agentModel(() => call('createOrder', { address: draw() < 0.3 ? 'Izmir' : 'Ankara' }));
      const r = await diagnoseTurn({ journal, runId: ids[0]!, model, tools: trap(), expect: ANKARA, trials: 12, concurrency: 1 });
      kinds[r.verdict.kind] = (kinds[r.verdict.kind] ?? 0) + 1;
    }
    const named = Object.entries(kinds).filter(([k]) => NAMES_A_CAUSE.has(k)).reduce((a, [, v]) => a + v, 0);
    log('random-30%', kinds);
    expect(named / 200).toBeLessThanOrEqual(0.05);
    expect(Object.keys(kinds).every((k) => ['not-found', 'chance', ...NAMES_A_CAUSE].includes(k))).toBe(true);
  }, 120_000);

  it('a model right 95% of the time: the recorded failure is reported as chance, and no cause is named', async () => {
    const { journal, ids } = await recordThread(['Ship my order.'], { memory: windowMemory(4), model: agentModel(() => call('createOrder', { address: 'Izmir' })), system: 'You are a shop agent.' });
    const draw = rng(7);
    const model = agentModel(() => call('createOrder', { address: draw() < 0.05 ? 'Izmir' : 'Ankara' }));
    const r = await diagnoseTurn({ journal, runId: ids[0]!, model, tools: trap(), expect: ANKARA, trials: 30, concurrency: 1 });
    expect(r.verdict.kind).toBe('chance');
    expect(r.verdict.sentence).toMatch(/not representative/);
    expect(r.joint).toBeUndefined();
  });

  /** An arm of `n` plays drawn at rate `p`. */
  const arm = (id: string, draw: () => number, p: number, n: number): ArmResult => {
    let passed = 0;
    for (let i = 0; i < n; i++) if (draw() < p) passed++;
    return { id, intervention: 'remove', label: id, targets: [id], passed, judged: n, undetermined: 0, failed: 0, rate: wilson(passed, n), paths: [] };
  };
  const claims = (z: number, seeds: number) => {
    let named = 0;
    for (let seed = 1; seed <= seeds; seed++) {
      const draw = rng(seed * 7919);
      const base = arm('baseline', draw, 0.5, 30);
      const arms = Array.from({ length: 6 }, (_, i) => arm(`a${i}`, draw, 0.5, 30)).map((a) => ({ ...a, difference: newcombe({ successes: a.passed, n: a.judged }, { successes: base.passed, n: base.judged }, z) }));
      if (NAMES_A_CAUSE.has(verdictOf(base, arms, undefined, z).kind)) named++;
    }
    return named / seeds;
  };

  it('six arms of pure noise (every rate 0.5): at the Bonferroni level a cause is named in at most 5% — without it, far more often', () => {
    const m = 6 + 1; // the six arms and the joint arm the level is kept for
    const bonferroni = claims(normalQuantile(1 - 0.05 / (2 * m)), 2000);
    const uncorrected = claims(1.96, 2000);
    log('six-noise-arms', { bonferroni, uncorrected });
    expect(bonferroni).toBeLessThanOrEqual(0.05);
    expect(uncorrected).toBeGreaterThan(bonferroni * 2);
  });

  it('the planner says how many plays a difference needs, and what a smaller n can still see', () => {
    const p = planDiagnosis({ arms: 3, eliminationPlays: 32, tokensPerPlay: 1000 });
    expect(p).toMatchObject({ comparisons: 4, alpha: 0.0125, targetDifference: 0.4, power: 0.8, trials: p.plannedTrials, underpowered: false });
    expect(p.plannedTrials).toBeGreaterThan(25);
    expect(p.verificationPlays).toBe(4 * p.trials);
    expect(p.totalPlays).toBe(32 + 4 * p.trials + p.trials);
    expect(p.tokens).toBe(p.totalPlays * 1000);
    const small = planDiagnosis({ arms: 3, eliminationPlays: 32, tokensPerPlay: 1000, trials: 10, price: { inputPer1M: 1, outputPer1M: 4, inputTokens: 900, outputTokens: 100 } });
    expect(small.underpowered).toBe(true);
    expect(small.detectableDifference).toBeGreaterThan(0.6);
    expect(small.estimatedCostUsd).toBeCloseTo(small.totalPlays * (900 / 1e6 + 400 / 1e6), 12);
    expect(normalQuantile(0.975)).toBeCloseTo(1.959964, 5);
    expect(() => planDiagnosis({ arms: 1, eliminationPlays: 0, tokensPerPlay: 1, targetDifference: 1.2 })).toThrow(RangeError);
  });

  it("Newcombe's interval of a difference: wide at small n, honest at the edges", () => {
    const d = newcombe({ successes: 10, n: 10 }, { successes: 0, n: 10 });
    expect(d.value).toBe(1);
    expect(d.low).toBeGreaterThan(0.5);
    expect(d.high).toBe(1);
    const same = newcombe({ successes: 5, n: 10 }, { successes: 5, n: 10 });
    expect(same.low).toBeLessThan(0);
    expect(same.high).toBeGreaterThan(0);
    expect(newcombe({ successes: 1, n: 0 }, { successes: 1, n: 3 }).value).toBeNaN();
  });
});
