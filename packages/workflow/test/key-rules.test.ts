// Round-3 review of the key check that refuses two step uses sharing one journal key.
//
//   COST     — building a workflow is linear in its step count. The first cut re-checked every pair of
//              steps on every `.then`, so a 1000-step workflow took seconds to build (0.9.0: ~1 ms).
//   ONE RULE — which `<runId>:wf:<rest>` keys are engine records is decided by `isEngineRecordKey`, and
//              a step is refused exactly when its key is one. Before, the builder accepted `_cache`,
//              `load:_x` and `tries:attempts`, which Studio and the fork sweep then treated as
//              bookkeeping: the step ran, and no reader showed or copied it.
//   ONE GATE — a waitId names one gate per run. A nested workflow used twice carried its
//              `waitForResume('approve')` into both uses, and one resume opened both.
//   FORK     — a fork copies what the steps before the fork point wrote, and nothing a later step wrote.
import { describe, it, expect } from 'vitest';
import {
  workflow, step, asStep, retry, waitForResume, forkWorkflowRun, isEngineRecordKey, type JournalLike,
} from '../src/index.js';

function memJournal(): JournalLike & { map: Map<string, unknown> } {
  const m = new Map<string, unknown>();
  return {
    map: m,
    get: async <T,>(k: string) => (m.has(k) ? (structuredClone(m.get(k)) as T) : undefined),
    put: async (k, v) => { m.set(k, structuredClone(v)); },
    putIfAbsent: async (k, v) => (m.has(k) ? false : (m.set(k, structuredClone(v)), true)),
    listKeys: async (p) => [...m.keys()].filter((k) => k.startsWith(p)).sort(),
  };
}
const msg = (f: () => unknown) => { try { f(); return 'built'; } catch (e) { return (e as Error).message; } };

describe('COST — building is linear in the step count', () => {
  it('a 3000-step workflow builds in well under a second (it took minutes when every .then re-checked all pairs)', () => {
    const steps = Array.from({ length: 3000 }, (_, i) => step(`s${i}`, async (x: unknown) => x));
    const t0 = performance.now();
    let wf = workflow<unknown>();
    for (const s of steps) wf = wf.then(s);
    const ms = performance.now() - t0;
    expect(wf.build()).toHaveLength(3000);
    expect(ms).toBeLessThan(1000);
  });

  // The incremental check shares its index with the builder it extends. Two builders extended from one
  // base must not see each other's steps.
  it('two builders extended from one base are checked separately', async () => {
    const base = workflow<number>().then(step('a', async (n: number) => n + 1));
    const left = base.then(step('b', async (n: number) => n * 2));
    const right = base.then(step('b', async (n: number) => n * 3)); // its own 'b' — legal
    expect(await left.run(1, { runId: 'l', journal: memJournal() })).toBe(4);
    expect(await right.run(1, { runId: 'r', journal: memJournal() })).toBe(6);
    // ...and each still refuses its own repeat, including the one it shares with the base.
    expect(() => right.then(step('b', async (n: number) => n))).toThrow(/'b' is used twice/);
    expect(() => left.then(step('a', async (n: number) => n))).toThrow(/'a' is used twice/);
  });

  it('a builder extended after a sibling was refused is unaffected by the refused step', () => {
    const base = workflow<number>().then(step('pay:check', async (n: number) => n));
    expect(() => base.then(asStep('pay', workflow<number>().then(step('check', async (n: number) => n))))).toThrow(/'pay:check'/);
    expect(msg(() => base.then(step('pay', async (n: number) => n)))).toBe('built');
  });

  it('patterns are still checked in both directions on the incremental path (loop, foreach, nested)', () => {
    expect(() => workflow<number>().loop(async (n: number) => n, () => false, { id: 'x' }).then(step('x#2', async (n: number) => n))).toThrow(/'x#2'/);
    expect(() => workflow<number>().then(step('x#2', async (n: number) => n)).loop(async (n: number) => n, () => false, { id: 'x' })).toThrow(/'x#2'/);
    expect(() => workflow<number>().foreach([1], async (i: number) => i, 'f').then(step('f[0]', async (n: unknown) => n))).toThrow(/'f\[0\]'/);
    const inner = workflow<number>().loop(async (n: number) => n, () => false, { id: 'l' });
    expect(() => workflow<number>().then(asStep('o', inner)).then(step('o:l#7', async (n: unknown) => n))).toThrow(/'o:l#7'/);
  });
});

describe('ONE RULE — a step is refused exactly when its key is an engine record', () => {
  it.each(['_cache', 'load:_x', 'tries:attempts'])("'%s' (which Studio and the fork sweep skip as bookkeeping) is refused, naming a legal id", (id) => {
    expect(isEngineRecordKey(id)).toBe(true);
    const m = msg(() => workflow<number>().then(step(id, async (n: number) => n)));
    expect(m).toMatch(/reserved/);
    // The way through is in the message, and it is itself legal.
    const suggested = /e\.g\. '([^']+)'/.exec(m)?.[1];
    expect(suggested).toBeDefined();
    expect(isEngineRecordKey(suggested!)).toBe(false);
    expect(msg(() => workflow<number>().then(step(suggested!, async (n: number) => n)))).toBe('built');
  });

  it("a step named 'attempts' is fine on its own, but inside asStep('pay') its key is 'pay:attempts' — refused, naming the inner step", () => {
    expect(msg(() => workflow<number>().then(step('attempts', async (n: number) => n)))).toBe('built');
    const child = workflow<number>().then(step('attempts', async (n: number) => n));
    expect(() => workflow<number>().then(asStep('pay', child))).toThrow(/step 'attempts' inside asStep\('pay'\).*'pay:attempts'.*rename 'attempts', e\.g\. 'attempt-count'/s);
  });

  it('a loop or a parallel whose id the engine reserves is refused too', () => {
    expect(() => workflow<number>().loop(async (n: number) => n, () => false, { id: '_l' })).toThrow(/reserved/);
    expect(() => workflow<number>().parallel([step('a', async (n: number) => n)], '_p')).toThrow(/reserved/);
  });

  it('every key a legal workflow journals as a step is one isEngineRecordKey calls a step', async () => {
    const journal = memJournal();
    const child = workflow<number>().then(step('check', async (n: number) => n + 1)).then(step('charge_card', async (n: number) => n));
    const wf = workflow<number>()
      .then(step('attempts', async (n: number) => n))
      .then(step('pay:check', async (n: number) => n))
      .then(retry(step('flaky', async (n: number) => n), { attempts: 2 }))
      .then(asStep('pay-2', child))
      .parallel([step('a', async (n: number) => n), step('b', async (n: number) => n)], 'P')
      .map((o) => o.a as number, 'pick')
      .foreach([1, 2], async (i: number) => i, 'items');
    await wf.runResumable(1, { runId: 'leg', journal });
    const rests = [...journal.map.keys()].filter((k) => k.startsWith('leg:wf:')).map((k) => k.slice('leg:wf:'.length));
    const steps = rests.filter((r) => !isEngineRecordKey(r)).sort();
    expect(steps).toEqual(['P', 'P/a', 'P/b', 'attempts', 'flaky', 'items', 'items[0]', 'items[1]', 'pay-2', 'pay-2:charge_card', 'pay-2:check', 'pay:check', 'pick'].sort());
  });
});

describe('ONE GATE — a waitId opens one gate per run', () => {
  const gate = () => workflow<number>().then(waitForResume('approve'));

  it("S-c5: one nested workflow with waitForResume('approve') used as asStep('a') and asStep('b') is refused at build, naming the way through", () => {
    const g = gate();
    const m = msg(() => workflow<number>().then(asStep('a', g)).then(asStep('b', g)));
    expect(m).toMatch(/_resume:approve/);
    expect(m).toMatch(/waitForResume\('approve-2'\)/);
  });

  it('siblings: two parallel legs, a top-level gate beside a nested one, and a renamed copy are refused too', () => {
    const g = gate();
    expect(() => workflow<number>().parallel([asStep('a', g), asStep('b', g)])).toThrow(/_resume:approve/);
    expect(() => workflow<number>().then(waitForResume('approve')).then(asStep('a', g))).toThrow(/_resume:approve/);
    const w = waitForResume('approve');
    expect(() => workflow<number>().then(w).then(step('approve-2', w.run))).toThrow(/_resume:approve/);
    expect(() => workflow<number>().then(w).then(w)).toThrow(/waitForResume\('approve-2'\)/);
  });

  it('the same gate in both arms of a branch stays legal (one arm runs)', () => {
    const w = waitForResume('approve');
    expect(msg(() => workflow<number>().branch((n) => n > 0, w, w))).toBe('built');
  });

  it('the way through: two gates with their own waitIds — one resume opens one gate', async () => {
    const journal = memJournal();
    const wf = workflow<number>()
      .then(asStep('a', workflow<number>().then(waitForResume('approve-a'))))
      .then(asStep('b', workflow<number>().then(waitForResume('approve-b'))));
    expect(await wf.runResumable(1, { runId: 'g', journal })).toMatchObject({ status: 'suspended', waitId: 'approve-a' });
    expect(await wf.runResumable(1, { runId: 'g', journal }, { resume: { 'approve-a': 'yes' } })).toMatchObject({ status: 'suspended', waitId: 'approve-b' });
    expect(await wf.runResumable(1, { runId: 'g', journal }, { resume: { 'approve-b': 'yes-b' } })).toEqual({ status: 'completed', output: 'yes-b' });
  });
});

describe('MESSAGES — the way through a refusal works', () => {
  it("a renamed copy of a retry (step('x-2', rx.run)) is refused naming retry(step('x-2', …)), and that recipe builds", () => {
    const inner = step('x', async (n: number) => n + 1);
    const rx = retry(inner, { attempts: 3 });
    const m = msg(() => workflow<number>().then(rx).then(step('x-2', rx.run)));
    expect(m).toMatch(/retry\(step\('x-2', <the retried step>\.run\), <the same policy>\)/);
    expect(m).not.toMatch(/give step 'x' another id/);
    expect(msg(() => workflow<number>().then(rx).then(retry(step('x-2', inner.run), { attempts: 3 })))).toBe('built');
  });

  it('the same in a parallel', () => {
    const rx = retry(step('x', async (n: number) => n + 1), { attempts: 3 });
    expect(() => workflow<number>().parallel([rx, step('x-2', rx.run)])).toThrow(/retry\(step\('x-2'/);
  });
});

describe("FORK — a fork copies what the steps before the fork point wrote, and only that", () => {
  it("a top-level step 'a:x' after a step 'a' re-runs in the fork (the nested sweep under 'a:' does not copy it)", async () => {
    const journal = memJournal();
    const counts: Record<string, number> = {};
    const bump = (id: string) => (n: number) => { counts[id] = (counts[id] ?? 0) + 1; return Promise.resolve(n + 1); };
    const build = () => workflow<number>().then(step('a', bump('a'))).then(step('a:x', bump('a:x'))).then(step('a:x:y', bump('a:x:y')));
    await build().run(0, { runId: 'src', journal });
    await forkWorkflowRun(journal, build(), 'src', 'a:x', 'dst');
    expect(journal.map.has('dst:wf:a:x')).toBe(false);
    expect(journal.map.has('dst:wf:a:x:y')).toBe(false);
    await build().run(0, { runId: 'dst', journal });
    expect(counts).toEqual({ a: 1, 'a:x': 2, 'a:x:y': 2 });
  });

  it("a nested workflow's keys before the fork point are still copied", async () => {
    const journal = memJournal();
    let inner = 0;
    const build = () => workflow<number>()
      .then(asStep('a', workflow<number>().then(step('x', async (n: number) => { inner++; return n + 1; }))))
      .then(step('b', async (n: number) => n * 10));
    await build().run(1, { runId: 's2', journal });
    await forkWorkflowRun(journal, build(), 's2', 'b', 'd2');
    expect(journal.map.get('d2:wf:a:x')).toBe(2);
    expect(await build().run(1, { runId: 'd2', journal })).toBe(20);
    expect(inner).toBe(1);
  });
});
