// "A completed step is replayed, not re-run" (README) — for EVERY output, including `undefined`.
//
// The engine used `journal.get(key) !== undefined` as its only "is there a record?" test. A step whose
// output is `undefined` (a `void` step: send an email, write a row, fire a webhook) was journaled, but
// its record read back exactly like "no record", so:
//   · a plain step re-ran on every resume (the effect fired again), and
//   · a `sideEffect: true` step found its own write-ahead claim, no readable output, and refused with
//     StepRetryBlockedError('in-flight') for claimTtlMs — then went to recover() for a step that had
//     finished.
// The invariant: a step's completion must be readable independently of the VALUE it completed with.
//
// Also here: one step id used twice in one workflow. The journal key is the step id, so the second
// use replayed the first one's output on a FRESH run — a wrong answer with no error. The combinators
// were already made position-unique (combinator-ids.test.ts); user step ids now get refused at build
// time with the one-line way through in the message.
import { describe, it, expect } from 'vitest';
import { workflow, step, retry, asStep, suspendWorkflow, forkWorkflowRun, isVoidStepRecord, type JournalLike } from '../src/index.js';

/** CAS journal whose `get` of a key holding `undefined` returns `undefined` — as every real backend does. */
function casJournal() {
  const m = new Map<string, unknown>();
  const j: JournalLike & { map: Map<string, unknown> } = {
    map: m,
    async get<T>(k: string) {
      return m.has(k) ? (structuredClone(m.get(k)) as T) : undefined;
    },
    async put(k: string, v: unknown) {
      m.set(k, structuredClone(v));
    },
    async putIfAbsent(k: string, v: unknown) {
      if (m.has(k)) return false;
      m.set(k, structuredClone(v));
      return true;
    },
    async putIfMatch(k: string, expected: unknown, v: unknown) {
      if (!m.has(k)) return false;
      if (JSON.stringify(m.get(k)) !== JSON.stringify(expected)) return false;
      m.set(k, structuredClone(v));
      return true;
    },
    async listKeys(p: string) {
      return [...m.keys()].filter((k) => k.startsWith(p)).sort();
    },
  };
  return j;
}

/** A journal without CAS or listKeys — the minimal JournalLike (get/put only). */
function plainJournal(): JournalLike {
  const m = new Map<string, unknown>();
  return {
    get: async <T>(k: string) => m.get(k) as T | undefined,
    put: async (k: string, v: unknown) => { m.set(k, v); },
  };
}

const journals: Array<[string, () => JournalLike]> = [
  ['cas journal', casJournal],
  ['get/put-only journal', plainJournal],
];

/** Runs `wf` once with `after` crashing, then resumes; returns how often `count` ran. */
async function crashThenResume(build: (after: ReturnType<typeof step>) => { run: (i: number, c: any) => Promise<unknown> }, mk: () => JournalLike, runId: string) {
  let crash = true;
  const after = step('after', async () => { if (crash) throw new Error('crash'); return 'ok'; });
  const wf = build(after);
  const journal = mk();
  await expect(wf.run(1, { runId, journal })).rejects.toThrow('crash');
  crash = false;
  return wf.run(1, { runId, journal });
}

describe.each(journals)('a step that completed with `undefined` is replayed, not re-run — %s', (_n, mk) => {
  it('CONTROL: a step returning null runs once across a resume', async () => {
    let sends = 0;
    const send = step('sendEmail', async () => { sends++; return null; });
    const out = await crashThenResume((after) => workflow<number>().then(send).then(after), mk, 'r-null');
    expect({ out, sends }).toEqual({ out: 'ok', sends: 1 });
  });

  it('a step returning undefined runs once across a resume', async () => {
    let sends = 0;
    const send = step('sendEmail', async () => { sends++; });
    const out = await crashThenResume((after) => workflow<number>().then(send).then(after), mk, 'r-void');
    expect({ out, sends }).toEqual({ out: 'ok', sends: 1 });
  });

  it('sideEffect:true + recover: a void step neither re-runs NOR blocks on resume', async () => {
    let sends = 0;
    let recovers = 0;
    const send = step('sendEmail', async () => { sends++; }, {
      sideEffect: true,
      recover: async () => { recovers++; return { done: false }; },
    });
    const out = await crashThenResume((after) => workflow<number>().then(send).then(after), mk, 'r-se');
    expect({ out, sends, recovers }).toEqual({ out: 'ok', sends: 1, recovers: 0 });
  });

  it('sideEffect:true without recover: a void step replays (no StepRetryBlockedError)', async () => {
    let sends = 0;
    const send = step('sendEmail', async () => { sends++; }, { sideEffect: true });
    const out = await crashThenResume((after) => workflow<number>().then(send).then(after), mk, 'r-se2');
    expect({ out, sends }).toEqual({ out: 'ok', sends: 1 });
  });

  it('the replayed value is `undefined` itself, not the record that stands for it', async () => {
    const seen: unknown[] = [];
    let crash = true;
    const wf = workflow<number>()
      .then(step('void', async () => undefined))
      .then(step('peek', async (v: unknown) => { seen.push(v); if (crash) throw new Error('crash'); return v; }));
    const journal = mk();
    await expect(wf.run(1, { runId: 'r-peek', journal })).rejects.toThrow('crash');
    crash = false;
    expect(await wf.run(1, { runId: 'r-peek', journal })).toBeUndefined();
    expect(seen).toEqual([undefined, undefined]);
  });

  it('a void leg of a parallel runs once', async () => {
    let sends = 0;
    const leg = step('notify', async () => { sends++; });
    const other = step('value', async () => 42);
    const out = await crashThenResume((after) => workflow<number>().parallel([leg, other]).then(after), mk, 'r-par');
    expect({ out, sends }).toEqual({ out: 'ok', sends: 1 });
  });

  it('a void arm of a branch runs once', async () => {
    let sends = 0;
    const arm = step('notify', async () => { sends++; });
    const els = step('skip', async () => 'no');
    const out = await crashThenResume((after) => workflow<number>().branch(() => true, arm, els).then(after), mk, 'r-br');
    expect({ out, sends }).toEqual({ out: 'ok', sends: 1 });
  });

  it('a void foreach item runs once per item', async () => {
    let sends = 0;
    const out = await crashThenResume(
      (after) => workflow<number>().foreach([1, 2, 3], async () => { sends++; }).then(after),
      mk,
      'r-fe',
    );
    expect({ out, sends }).toEqual({ out: 'ok', sends: 3 });
  });

  it('a void step inside a nested workflow (asStep) runs once', async () => {
    let sends = 0;
    const inner = workflow<number>().then(step('notify', async () => { sends++; }));
    const out = await crashThenResume((after) => workflow<number>().then(asStep('child', inner)).then(after), mk, 'r-nest');
    expect({ out, sends }).toEqual({ out: 'ok', sends: 1 });
  });

  it('a retried void step runs once after it succeeds', async () => {
    let sends = 0;
    let fail = 1;
    const flaky = retry(step('notify', async () => { sends++; if (fail-- > 0) throw new Error('flaky'); }), { attempts: 3 });
    const out = await crashThenResume((after) => workflow<number>().then(flaky).then(after), mk, 'r-retry');
    expect({ out, sends }).toEqual({ out: 'ok', sends: 2 });
  });

  it('a void step that resumes from a suspend completes once (runResumable)', async () => {
    let sends = 0;
    let wait = true;
    const gate = step('gate', async () => { if (wait) suspendWorkflow('w'); return 'open'; });
    const wf = workflow<number>().then(step('notify', async () => { sends++; })).then(gate);
    const journal = mk();
    expect((await wf.runResumable(1, { runId: 'r-susp', journal })).status).toBe('suspended');
    wait = false;
    expect(await wf.runResumable(1, { runId: 'r-susp', journal })).toEqual({ status: 'completed', output: 'open' });
    expect(sends).toBe(1);
  });
});

describe('readers of a void record', () => {
  it('forkWorkflowRun copies a void step, so the fork replays it instead of re-firing it', async () => {
    const journal = casJournal();
    let sends = 0;
    const wf = workflow<number>()
      .then(step('notify', async () => { sends++; }))
      .then(step('after', async () => 'ok'));
    await wf.run(1, { runId: 'src', journal });
    const { copiedSteps } = await forkWorkflowRun(journal, wf, 'src', 'after', 'dst');
    expect(copiedSteps).toEqual(['notify']);
    expect(await wf.run(1, { runId: 'dst', journal })).toBe('ok');
    expect(sends).toBe(1);
  });

  it('isVoidStepRecord recognises the stored record and nothing else', async () => {
    const journal = casJournal();
    await workflow<number>().then(step('notify', async () => undefined)).run(1, { runId: 'v', journal });
    expect(isVoidStepRecord(await journal.get('v:wf:notify'))).toBe(true);
    for (const other of [undefined, null, 0, '', {}, { __gnlVoid: false }, { __gnlVoid: true, extra: 1 }]) {
      expect(isVoidStepRecord(other)).toBe(false);
    }
  });
});

describe('journals written by 0.9.0 (a void output stored as a raw `undefined`)', () => {
  it('a plain step recorded the old way still reads as "no record" and re-runs once (0.9.0 behaviour, not worse)', async () => {
    const journal = casJournal();
    journal.map.set('old:wf:sendEmail', undefined); // what 0.9.0 wrote for a void step
    let sends = 0;
    const wf = workflow<number>().then(step('sendEmail', async () => { sends++; })).then(step('after', async () => 'ok'));
    expect(await wf.run(1, { runId: 'old', journal })).toBe('ok');
    expect(sends).toBe(1);
  });

  it('a sideEffect void step recorded the old way (claim + raw undefined) replays instead of blocking', async () => {
    const journal = casJournal();
    journal.map.set('old2:wf:sendEmail:_claim', { startedAt: Date.now() }); // 0.9.0: a finished attempt's claim
    journal.map.set('old2:wf:sendEmail', undefined); // 0.9.0: the void output
    let sends = 0;
    let recovers = 0;
    const wf = workflow<number>()
      .then(step('sendEmail', async () => { sends++; }, { sideEffect: true, recover: async () => { recovers++; return { done: false }; } }))
      .then(step('after', async () => 'ok'));
    expect(await wf.run(1, { runId: 'old2', journal })).toBe('ok');
    expect({ sends, recovers }).toEqual({ sends: 0, recovers: 0 });
  });

  it('a non-undefined output written by 0.9.0 replays byte-for-byte (the record shape did not change)', async () => {
    const journal = casJournal();
    journal.map.set('old3:wf:charge', { charged: 10 });
    let runs = 0;
    const wf = workflow<number>().then(step('charge', async () => { runs++; return { charged: 99 }; }));
    expect(await wf.run(1, { runId: 'old3', journal })).toEqual({ charged: 10 });
    expect(runs).toBe(0);
  });
});

describe('one step id used twice in one workflow', () => {
  it('CONTROL: two different step ids compute 0 → 1 → 2', async () => {
    const wf = workflow<number>().then(step('inc1', async (n: number) => n + 1)).then(step('inc2', async (n: number) => n + 1));
    expect(await wf.run(0, { runId: 'c', journal: casJournal() })).toBe(2);
  });

  it('sequential .then(inc).then(inc) is refused at build time, naming the way through', () => {
    const inc = step('inc', async (n: number) => n + 1);
    expect(() => workflow<number>().then(inc).then(inc)).toThrow(/step id 'inc' is used twice.*step\('inc-2', inc\.run\)/s);
  });

  it('the way through named in the error works: a second id for the same body gives 2', async () => {
    const inc = step('inc', async (n: number) => n + 1);
    const wf = workflow<number>().then(inc).then(step('inc-2', inc.run));
    expect(await wf.run(0, { runId: 's', journal: casJournal() })).toBe(2);
  });

  it('two parallel legs sharing an id are refused (their outputs would share one key AND one field)', () => {
    const a = step('leg', async () => 'A');
    const b = step('leg', async () => 'B');
    expect(() => workflow<number>().parallel([a, b])).toThrow(/step id 'leg' is used twice/);
  });

  it('an explicit combinator id equal to an existing step id is refused', () => {
    const s = step('shape', async (n: number) => n);
    expect(() => workflow<number>().then(s).map((n) => n + 1, 'shape')).toThrow(/step id 'shape' is used twice/);
  });

  it('the same step in both arms of a branch stays legal (only one arm runs per input)', async () => {
    const s = step('same', async (n: number) => n + 1);
    const wf = workflow<number>().branch((n) => n > 0, s, s);
    expect(await wf.run(1, { runId: 'b', journal: casJournal() })).toBe(2);
  });

  it('the same step id inside a nested workflow and outside it stays legal (keyPrefix scopes it)', async () => {
    const inc = step('inc', async (n: number) => n + 1);
    const wf = workflow<number>().then(inc).then(asStep('child', workflow<number>().then(inc)));
    expect(await wf.run(0, { runId: 'n', journal: casJournal() })).toBe(2);
  });
});
