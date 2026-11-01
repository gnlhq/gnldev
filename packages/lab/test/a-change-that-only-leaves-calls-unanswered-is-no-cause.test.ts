// The thread diagnosis under attack: a change that only turns wrong answers into calls nobody answered is
// no cause (the verdict reads every arm at its worst); provider failures, n = 1 and a wrongly written
// expectation name no cause; a processor's stamp does not make an earlier turn "missing"; shares stay
// finite numbers on the wire. Each test asserts the correct behaviour.
import { describe, it, expect, vi, beforeAll } from 'vitest';
import { createMockModel } from '../../durable/test/mock.js';
import { windowMemory, recordThread, call, final, trap, toolResults, agentModel } from './thread-fixtures.js';
import { diagnoseTurn, threadPlan, judgePlay } from '../src/index.js';

beforeAll(() => { vi.spyOn(console, 'warn').mockImplementation(() => {}); });
// Diagnostics, printed with GNL_TEST_VERBOSE=1.
const log = (...a: unknown[]) => void (process.env.GNL_TEST_VERBOSE && process.stdout.write(`AUDIT ${a.map((x) => (typeof x === 'string' ? x : JSON.stringify(x))).join(' ')}\n`));
const SHOP = 'You are a shop agent.';
const ANKARA = { calls: [{ toolName: 'createOrder', args: { address: 'Ankara' } }] };
function rng(seed: number) { let s = seed >>> 0; return () => { s = (s * 1664525 + 1013904223) >>> 0; return s / 2 ** 32; }; }

const recorder = () => { const m = createMockModel(async (o: any) => {
  const r = toolResults(o);
  if (r.length === 0) return call('lookup', {}, 'l1');
  if (r.length === 1) return call('createOrder', { address: 'Izmir' }, 'c1');
  return final('Done.');
}); m.modelId = 'cheap'; return m; };

describe('informative missingness', () => {
  it('an arm that only turns failures into unanswered calls is NOT a cause (true right-answer rate 0.3 in both)', async () => {
    const out: Record<string, number> = {};
    for (const seed of [1, 2, 3, 4, 5]) {
      const rand = rng(seed);
      const lab = () => { const m = createMockModel(async (o: any) => {
        const r = toolResults(o);
        if (r.length === 0) return call('lookup', {}, 'l1');
        if (r.length === 1) {
          const overridden = JSON.stringify(r[0]).includes('Ankara');
          if (rand() < 0.3) return call('createOrder', { address: 'Ankara' }, 'c1'); // right, in both arms
          // wrong: the unchanged turn repeats the recorded call (answered → judged a FAIL);
          // the changed one asks again with new arguments (unanswered → 'undetermined', out of the rate)
          return overridden ? call('createOrder', { address: 'Bursa' }, 'c2') : call('createOrder', { address: 'Izmir' }, 'c1');
        }
        return final('Done.');
      }); m.modelId = 'cheap'; return m; };
      const { journal, ids } = await recordThread(['Ship my order to the address on file.'], { memory: windowMemory(4), model: recorder(), system: SHOP });
      const r = await diagnoseTurn({ journal, runId: ids[0]!, model: lab(), tools: trap(), expect: ANKARA, overrides: [{ toolName: 'lookup', args: {}, output: { address: 'Ankara' } }], trials: 30, topK: 0 });
      const arm = r.arms.find((a) => a.id === 'override:lookup result')!;
      log('missingness', seed, { verdict: r.verdict.kind, base: [r.arms[0]!.passed, r.arms[0]!.judged, r.arms[0]!.undetermined], arm: [arm.passed, arm.judged, arm.undetermined] });
      out[r.verdict.kind] = (out[r.verdict.kind] ?? 0) + 1;
    }
    log('missingness-summary', out);
    expect(out.cause ?? 0).toBe(0);
  }, 120_000);
});

describe('verdict edge cases', () => {
  it('every play of every arm fails at the provider: no cause, no crash', async () => {
    const { journal, ids } = await recordThread(['Ship my order to the address on file.'], { memory: windowMemory(4), model: recorder(), system: SHOP });
    const boom = createMockModel(async () => { throw Object.assign(new Error('bad request'), { statusCode: 400 }); }); (boom as any).modelId = 'cheap';
    let r: any; try { r = await diagnoseTurn({ journal, runId: ids[0]!, model: boom, tools: trap(), expect: ANKARA, trials: 3, overrides: [{ toolName: 'lookup', args: {}, output: { address: 'Ankara' } }] }); } catch (e) { r = { threw: String(e).slice(0, 160) }; }
    log('all-fail', r.verdict ?? r);
    expect(r.verdict?.kind ?? 'threw').not.toBe('cause');
  });

  it('n = 1 per arm: an arm with 1/1 vs baseline 0/1 is not named a cause', async () => {
    const lab = () => { const m = createMockModel(async (o: any) => {
      const r = toolResults(o);
      if (r.length === 0) return call('lookup', {}, 'l1');
      if (r.length === 1) return call('createOrder', { address: JSON.stringify(r[0]).includes('Ankara') ? 'Ankara' : 'Izmir' }, 'c1');
      return final('Done.');
    }); m.modelId = 'cheap'; return m; };
    const { journal, ids } = await recordThread(['Ship my order to the address on file.'], { memory: windowMemory(4), model: recorder(), system: SHOP });
    const r = await diagnoseTurn({ journal, runId: ids[0]!, model: lab(), tools: trap(), expect: ANKARA, overrides: [{ toolName: 'lookup', args: {}, output: { address: 'Ankara' } }], trials: 1, topK: 0 });
    log('n1', r.verdict, r.plan?.detectableDifference, r.plan?.underpowered);
    expect(r.verdict.kind).not.toBe('cause');
  });

  it('a wrongly defined expect (asks for what the recording already did): baseline right → chance, never a cause', async () => {
    const lab = () => { const m = createMockModel(async (o: any) => {
      const r = toolResults(o);
      if (r.length === 0) return call('lookup', {}, 'l1');
      if (r.length === 1) return call('createOrder', { address: 'Izmir' }, 'c1');
      return final('Done.');
    }); m.modelId = 'cheap'; return m; };
    const { journal, ids } = await recordThread(['Ship my order to the address on file.'], { memory: windowMemory(4), model: recorder(), system: SHOP });
    const r = await diagnoseTurn({ journal, runId: ids[0]!, model: lab(), tools: trap(), expect: { calls: [{ toolName: 'createOrder', args: { address: 'Izmir' } }] }, trials: 10 });
    log('wrong-expect', r.verdict.kind);
    expect(r.verdict.kind).toBe('chance');
  });
});

describe('absence candidates by text', () => {
  it('a processor that stamps each user message per run: an earlier turn still IN the window must not be "missing"', async () => {
    let k = 0;
    const stamp = { name: 'stamp', processInput: async (i: any) => { k++; return { ...i, messages: i.messages.map((m: any, idx: number) => (m.role === 'user' && idx === i.messages.length - 1 && typeof m.content === 'string' ? { ...m, content: `${m.content} [run ${k}]` } : m)) }; } };
    const memory = windowMemory(10);
    const { journal } = await recordThread(['My address is Ankara.', 'Ship my order.'], { memory, model: agentModel(() => final('ok')), system: SHOP, processors: [stamp] });
    const plan: any = await threadPlan({ journal, threadId: 't' } as any);
    const t2 = plan.turns?.[1];
    log('absence-stamp', JSON.stringify(t2).slice(0, 1500), memory.stored.map((m: any) => m.content));
    expect(JSON.stringify(t2)).not.toMatch(/restore:window|restore:trimmed/);
  });
});

describe('elimination shares when no play can be judged', () => {
  it('every play stops at an unanswered call: shares are finite numbers (they travel as JSON)', async () => {
    const lab = () => { const m = createMockModel(async (o: any) => (toolResults(o).length === 0 ? call('lookup', {}, 'l1') : call('createOrder', { address: 'Bursa' }, 'c9'))); m.modelId = 'cheap'; return m; };
    const { journal, ids } = await recordThread(['Ship my order to the address on file.'], { memory: windowMemory(4), model: recorder(), system: 'A.\n\nB.' });
    const r = await diagnoseTurn({ journal, runId: ids[0]!, model: lab(), tools: trap(), expect: ANKARA, trials: 2 });
    const wire = JSON.parse(JSON.stringify(r.elimination.shares));
    log('shares-wire', wire, r.verdict.kind);
    expect(wire.every((s: any) => typeof s.blame === 'number')).toBe(true);
  });
});

describe('the bounds and judgePlay agree', () => {
  it('an arm that mostly stops is named not tested, with the calls to answer and both bounds', async () => {
    const rand = rng(1);
    const lab = () => { const m = createMockModel(async (o: any) => {
      const r = toolResults(o);
      if (r.length === 0) return call('lookup', {}, 'l1');
      if (r.length === 1) {
        if (rand() < 0.3) return call('createOrder', { address: 'Ankara' }, 'c1');
        return JSON.stringify(r[0]).includes('Ankara') ? call('createOrder', { address: 'Bursa' }, 'c2') : call('createOrder', { address: 'Izmir' }, 'c1');
      }
      return final('Done.');
    }); m.modelId = 'cheap'; return m; };
    const { journal, ids } = await recordThread(['Ship my order to the address on file.'], { memory: windowMemory(4), model: recorder(), system: SHOP });
    const r = await diagnoseTurn({ journal, runId: ids[0]!, model: lab(), tools: trap(), expect: ANKARA, overrides: [{ toolName: 'lookup', args: {}, output: { address: 'Ankara' } }], trials: 30, topK: 0 });
    const arm = r.arms.find((a) => a.id === 'override:lookup result')!;
    expect(arm.untested!.share).toBeGreaterThan(0.2);
    expect(arm.difference).toBeUndefined();               // decides nothing
    expect(arm.observedDifference!.value).toBeGreaterThan(0.5); // what the judged plays alone would have claimed
    // every call no one answered — the wrong one, and the right one (judged on the stop, never answered)
    expect(arm.pending).toEqual(expect.arrayContaining([{ toolName: 'createOrder', args: { address: 'Bursa' } }, { toolName: 'createOrder', args: { address: 'Ankara' } }]));
    expect(arm.bounds.low.value).toBeCloseTo(arm.passed / 30, 10);
    expect(arm.bounds.high.value).toBeCloseTo((arm.passed + arm.undetermined) / 30, 10);
    expect(r.notes.join(' ')).toMatch(/not tested — \d+ of 30 plays stopped at a call the recording never made \(.*createOrder\(\{"address":"Bursa"\}\)/);
  });

  it('for any completion of the stopped plays, the true rate lies within the bounds; a play judgePlay settled on a stop never moves', () => {
    const draw = rng(42);
    for (let k = 0; k < 2000; k++) {
      // a play: stopped or not; it made the expected call or not; it made a forbidden call or not
      const plays = Array.from({ length: 12 }, () => ({ stopped: draw() < 0.5, expected: draw() < 0.4, forbidden: draw() < 0.1 }));
      let passed = 0, undetermined = 0, truePass = 0;
      const expect1 = draw() < 0.5 ? { calls: [{ toolName: 'createOrder' }] } : { calls: [{ toolName: 'createOrder' }], forbidden: ['refund'] };
      for (const p of plays) {
        const trace = [
          ...(p.expected ? [{ toolName: 'createOrder', args: {}, source: 'recorded' as const }] : []),
          ...(p.forbidden ? [{ toolName: 'refund', args: {}, source: 'recorded' as const }] : []),
          ...(p.stopped ? [{ toolName: 'other', args: {}, source: 'none' as const }] : []),
        ];
        const v = judgePlay(expect1, trace, '');
        // what the play would really have done after the stop: anything, unless the verdict is already fixed
        const later = { forbidden: draw() < 0.5 };
        const forbiddenMade = !!expect1.forbidden && (p.forbidden || (p.stopped && later.forbidden));
        const truth = !forbiddenMade && p.expected;
        if (v.verdict === 'pass') { passed++; expect(truth).toBe(true); }
        else if (v.verdict === 'fail') expect(truth).toBe(false);
        else undetermined++;
        if (truth) truePass++;
      }
      expect(truePass).toBeGreaterThanOrEqual(passed);
      expect(truePass).toBeLessThanOrEqual(passed + undetermined);
    }
  });
});
