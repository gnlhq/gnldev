// Two invariants the round-1 fixes stated but did not hold (review panel, round 2):
//
//   KEYS   — every step USE in one run has its own journal key. Round 1 checked step IDS, but a key is
//            built from more than the id: a nested workflow's steps live at `<outer>:<inner>`, a retry
//            keeps its counter at `<id>:attempts` and its marker at `<id>:_fallback`, the engine keeps
//            `_suspend` / `_canceled` / `_input` / `_resume:*` in the same namespace. A top-level step
//            named `pay:check` and a step `check` inside `asStep('pay')` share one key, so the inner step
//            silently never ran (it replayed the outer one's output).
//
//   REPLAY — replay returns exactly what the fresh run returned, for EVERY output. Round 1 branded a
//            void output as `{ __gnlVoid: true }` and read any value of that shape back as `undefined`,
//            so a step that legitimately returned that object replayed as `undefined`.
//
// K1 = the case the panel reported; K2/K3 = siblings of the same invariant found while fixing it.
import { describe, it, expect } from 'vitest';
import { workflow, step, asStep, retry, isVoidStepRecord, type JournalLike } from '../src/index.js';

function casJournal() {
  const m = new Map<string, unknown>();
  const j: JournalLike & { map: Map<string, unknown> } = {
    map: m,
    async get<T>(k: string) { return m.has(k) ? (structuredClone(m.get(k)) as T) : undefined; },
    async put(k: string, v: unknown) { m.set(k, structuredClone(v)); },
    async putIfAbsent(k: string, v: unknown) { if (m.has(k)) return false; m.set(k, structuredClone(v)); return true; },
    async listKeys(p: string) { return [...m.keys()].filter((k) => k.startsWith(p)).sort(); },
  };
  return j;
}

describe('KEYS — one journal key per step use', () => {
  it("K1: a top-level step 'pay:check' and asStep('pay') with an inner 'check' are refused at build, naming the way through", () => {
    const child = workflow<number>().then(step('check', async (n: number) => n * 10));
    expect(() =>
      workflow<number>()
        .then(step('pay:check', async (n: number) => n + 1))
        .then(asStep('pay', child)),
    ).toThrow(/'pay:check'.*asStep\('pay'\).*asStep\('pay-2'/s);
  });

  it('K1 way through: renaming the nested workflow runs both steps (1 → 2 → 20)', async () => {
    let inner = 0;
    let outer = 0;
    const child = workflow<number>().then(step('check', async (n: number) => { inner++; return n * 10; }));
    const wf = workflow<number>()
      .then(step('pay:check', async (n: number) => { outer++; return n + 1; }))
      .then(asStep('pay-2', child));
    expect(await wf.run(1, { runId: 'r1', journal: casJournal() })).toBe(20);
    expect({ inner, outer }).toEqual({ inner: 1, outer: 1 });
  });

  it("K1: a step named '<id>:attempts' next to retry('<id>') is refused (it is the retry's counter key)", () => {
    expect(() =>
      workflow<number>()
        .then(retry(step('s', async (n: number) => n + 1), { attempts: 2 }))
        .then(step('s:attempts', async (n: number) => n + 100)),
    ).toThrow(/retry\('s'\)'s attempt counter and step 's:attempts' are both journaled at 's:attempts'.*give step 's:attempts' another id/s);
  });

  it("K2: a renamed copy of an asStep (step('sub-2', sub.run)) still writes under 'sub:' — refused, and the message says asStep('sub-2', …)", () => {
    const child = workflow<number>().then(step('inner', async (n: number) => n + 1));
    const sub = asStep('sub', child);
    expect(() => workflow<number>().then(sub).then(step('sub-2', sub.run))).toThrow(/'sub:inner'.*asStep\('sub-2'/s);
  });

  it('K2: the duplicate-id message for an asStep names asStep, not step(…run) — the latter would still collide', () => {
    const sub = asStep('sub', workflow<number>().then(step('inner', async (n: number) => n)));
    expect(() => workflow<number>().then(sub).then(sub)).toThrow(/asStep\('sub-2', /);
  });

  it("K2: a retry's fallback shares the workflow's namespace — a top-level step with the fallback's id is refused", () => {
    const fb = step('fallback-charge', async () => 'B');
    expect(() =>
      workflow<number>()
        .then(retry(step('charge', async () => { throw new Error('x'); }), { attempts: 1, fallback: fb }))
        .then(step('fallback-charge', async () => 'other')),
    ).toThrow(/'fallback-charge'/);
  });

  it("K2: two parallel legs running the same asStep body (under two ids) write the same inner keys — refused", () => {
    const sub = asStep('sub', workflow<number>().then(step('inner', async (n: number) => n)));
    expect(() => workflow<number>().parallel([sub, step('sub-copy', sub.run)])).toThrow(/'sub:inner'/);
  });

  it.each(['_canceled', '_suspend', '_input'])("K3: a step named '%s' is refused — it is an engine record's key", (id) => {
    expect(() => workflow<number>().then(step(id, async (n: number) => n))).toThrow(new RegExp(`'${id}'.*reserved`, 's'));
  });

  it("K3: a step id starting '_resume:' is refused (the resume payloads' namespace)", () => {
    expect(() => workflow<number>().then(step('_resume:approve', async (n: number) => n))).toThrow(/reserved/);
  });

  describe('no false refusals', () => {
    it("a step id containing ':' is still fine on its own (0.9.0 journals keyed that way keep replaying)", async () => {
      const wf = workflow<number>().then(step('pay:check', async (n: number) => n + 1));
      expect(await wf.run(1, { runId: 'ok1', journal: casJournal() })).toBe(2);
    });

    it("a loop 'x' next to a step 'x#y' (not an iteration key) is fine", async () => {
      const wf = workflow<number>()
        .loop(async (n: number) => n + 1, (n) => n < 3, { id: 'x' })
        .then(step('x#y', async (n: number) => n * 2));
      expect(await wf.run(0, { runId: 'ok2', journal: casJournal() })).toBe(6);
    });

    it('the same step in both arms of a branch, and a retried nested workflow, stay legal', async () => {
      const s = step('same', async (n: number) => n + 1);
      let fails = 1;
      const child = workflow<number>()
        .then(step('a', async (n: number) => n + 1))
        .then(step('b', async (n: number) => { if (fails-- > 0) throw new Error('flaky'); return n + 1; }));
      const wf = workflow<number>().branch((n) => n > 0, s, s).then(retry(asStep('child', child), { attempts: 2 }));
      expect(await wf.run(1, { runId: 'ok3', journal: casJournal() })).toBe(4);
    });

    // Round 3: '_private' was accepted here and then hidden by Studio and skipped by the fork sweep,
    // which treat every '_' segment as bookkeeping. One rule now (isEngineRecordKey, key-rules.test.ts):
    // it is refused at build. An underscore anywhere else in a name is still fine.
    it('an underscore that does not start a segment is fine', async () => {
      const wf = workflow<number>().then(step('my_step', async (n: number) => n)).then(step('pay:charge_card', async (n: number) => n));
      expect(await wf.run(5, { runId: 'ok4', journal: casJournal() })).toBe(5);
    });
  });
});

describe('REPLAY — a replayed output equals the fresh one, for every value', () => {
  async function freshThenReplay(value: unknown) {
    let crash = true;
    const wf = workflow<number>()
      .then(step('flag', async () => value))
      .then(step('after', async (x: unknown) => { if (crash) throw new Error('crash'); return x; }));
    const journal = casJournal();
    await expect(wf.run(1, { runId: 'r', journal })).rejects.toThrow('crash');
    crash = false;
    return { replayed: await wf.run(1, { runId: 'r', journal }), journal };
  }

  it('K1: a step that returns { __gnlVoid: true } replays that object', async () => {
    expect((await freshThenReplay({ __gnlVoid: true })).replayed).toEqual({ __gnlVoid: true });
  });

  it.each([
    ['the void record itself', { __gnlStepRecord: 'void' }],
    ['the escape wrapper itself', { __gnlStepRecord: 'value', value: 1 }],
    ['a nested escape wrapper', { __gnlStepRecord: 'value', value: { __gnlStepRecord: 'void' } }],
    ['an object with extra keys', { __gnlStepRecord: 'void', other: 1 }],
  ])('K2: a step that returns %s replays it unchanged', async (_n, value) => {
    expect((await freshThenReplay(value)).replayed).toEqual(value);
  });

  it('K2: isVoidStepRecord is true for what a void step stored, false for every value a step can return', async () => {
    const journal = casJournal();
    await workflow<number>().then(step('v', async () => undefined)).run(1, { runId: 'iv', journal });
    expect(isVoidStepRecord(await journal.get('iv:wf:v'))).toBe(true);
    const stored = casJournal();
    await workflow<number>().then(step('v', async () => ({ __gnlStepRecord: 'void' }))).run(1, { runId: 'iv2', journal: stored });
    expect(isVoidStepRecord(await stored.get('iv2:wf:v'))).toBe(false);
  });

  it('K3: an output written by 0.9.0 (plain value, no wrapper) still replays as itself', async () => {
    const journal = casJournal();
    journal.map.set('old:wf:flag', { __gnlVoid: true });
    let runs = 0;
    const wf = workflow<number>().then(step('flag', async () => { runs++; return 'fresh'; }));
    expect(await wf.run(1, { runId: 'old', journal })).toEqual({ __gnlVoid: true });
    expect(runs).toBe(0);
  });
});
