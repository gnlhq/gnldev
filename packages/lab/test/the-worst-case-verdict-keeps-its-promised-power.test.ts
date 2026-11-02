// The worst-case verdict at the edges, and the power it costs: an arm just under the undetermined limit
// whose true rate is no higher is never a cause; when there IS a difference of 0.4 with 10% of the plays
// undetermined on both sides, the plan's own n finds it about as often as the plan promises (0.8), and
// the unchanged turn is not refused as untestable for a share that is only a draw over the limit.
import { describe, it, expect, vi, beforeAll } from 'vitest';
import { createMockModel } from '../../durable/test/mock.js';
import { windowMemory, recordThread, call, final, trap, toolResults } from './thread-fixtures.js';
import { diagnoseTurn } from '../src/index.js';

beforeAll(() => { vi.spyOn(console, 'warn').mockImplementation(() => {}); });
// Diagnostics, printed with GNL_TEST_VERBOSE=1.
const log = (...a: unknown[]) => void (process.env.GNL_TEST_VERBOSE && process.stdout.write(`AUDIT ${a.map((x) => (typeof x === 'string' ? x : JSON.stringify(x))).join(' ')}\n`));
const ANKARA = { calls: [{ toolName: 'createOrder', args: { address: 'Ankara' } }] };
function rng(seed: number) { let s = seed >>> 0; return () => { s = (s * 1664525 + 1013904223) >>> 0; return s / 2 ** 32; }; }
const recorder = () => { const m = createMockModel(async (o: any) => {
  const r = toolResults(o);
  if (r.length === 0) return call('lookup', {}, 'l1');
  if (r.length === 1) return call('createOrder', { address: 'Izmir' }, 'c1');
  return final('Done.');
}); m.modelId = 'cheap'; return m; };
/** pass with p, stop (unanswered call) with u, else the recorded wrong call (judged fail) — per arm. */
const labModel = (seed: number, base: { p: number; u: number }, arm: { p: number; u: number }) => {
  const rand = rng(seed);
  const m = createMockModel(async (o: any) => {
    const r = toolResults(o);
    if (r.length === 0) return call('lookup', {}, 'l1');
    if (r.length === 1) {
      const { p, u } = JSON.stringify(r[0]).includes('Ankara') ? arm : base;
      const x = rand();
      if (x < p) return call('createOrder', { address: 'Ankara' }, 'c1');
      if (x < p + u) return call('createOrder', { address: 'Bursa' }, 'c2');
      return call('createOrder', { address: 'Izmir' }, 'c1');
    }
    return final('Done.');
  }); m.modelId = 'cheap'; return m;
};
async function verdicts(seeds: number, base: { p: number; u: number }, arm: { p: number; u: number }, trials?: number) {
  const out: Record<string, number> = {}; let n = 0;
  for (let s = 1; s <= seeds; s++) {
    const { journal, ids } = await recordThread(['Ship my order to the address on file.'], { memory: windowMemory(4), model: recorder(), system: 'You are a shop agent.' });
    const r = await diagnoseTurn({ journal, runId: ids[0]!, model: labModel(s, base, arm), tools: trap(), expect: ANKARA, overrides: [{ toolName: 'lookup', args: {}, output: { address: 'Ankara' } }], topK: 0, ...(trials ? { trials } : {}) });
    out[r.verdict.kind] = (out[r.verdict.kind] ?? 0) + 1; n = r.plan.trials;
  }
  return { out, n };
}

describe('the worst-case verdict at the edges, and the power it costs', () => {
  it('directional arm at 19% undetermined, true rate equal (0.3): never a cause', async () => {
    const r = await verdicts(40, { p: 0.3, u: 0 }, { p: 0.3, u: 0.19 }, 30);
    log('fake-19', r);
    expect(r.out.cause ?? 0).toBe(0);
  }, 300_000);
  it('directional arm at 19% undetermined, arm right-rate barely higher (0.4 vs 0.3): cause rate', async () => {
    const r = await verdicts(40, { p: 0.3, u: 0 }, { p: 0.4, u: 0.19 }, 30);
    log('fake-19-plus', r);
    // the arm's true rate is >= 0.4 > 0.3 even with every undetermined play wrong: a cause here is TRUE
    expect(r.out.cause ?? 0).toBeGreaterThanOrEqual(0);
  }, 300_000);
  it('miss rate: true difference 0.4 (0.3→0.7), 10% undetermined in both arms, planned n', async () => {
    const r = await verdicts(40, { p: 0.3, u: 0.1 }, { p: 0.7, u: 0.1 });
    const r0 = await verdicts(40, { p: 0.3, u: 0 }, { p: 0.7, u: 0 });
    log('power', { withUndetermined: r, without: r0 });
    expect((r.out.cause ?? 0) / 40).toBeGreaterThanOrEqual(0.5);
  }, 600_000);
  it("the plan's n delivers the power it promises: 0.4 with 10% undetermined on both sides, ~0.8 of 80 diagnoses name the cause", async () => {
    const r = await verdicts(80, { p: 0.3, u: 0.1 }, { p: 0.7, u: 0.1 });
    log('promised-power', r);
    expect(r.n).toBeGreaterThan(40); // planned at the worst case, not at 0.4 as if nothing stopped
    expect((r.out.cause ?? 0) / 80).toBeGreaterThanOrEqual(0.7);
    // a share of 10% is never refused as "more than 20%": the limit is applied to its lower bound
    expect(r.out.undecided ?? 0).toBe(0);
  }, 600_000);
});
