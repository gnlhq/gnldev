// U7 — a model step that times out under `createGnl({ timeouts })` is the run's OWN failure: the detached
// executor's end classification (outcome.ts attemptEndOf, changed by D1-D5) must count it as an attempt —
// not release it ("continues elsewhere") and not defer it — and the run's outcome must say so by name.
import { describe, it, expect } from 'vitest';
import { InMemoryJournal, createGnl, attemptEndOf, StepTimeoutError, readRunOutcome } from '../src/index.js';

const frozen: any = { specificationVersion: 'v2', provider: 'mock', modelId: 'm', supportedUrls: {}, doGenerate: async () => new Promise(() => {}), doStream: async () => new Promise(() => {}) };

describe('U7 a model-step timeout through the D1-D5 end classification', () => {
  it('attemptEndOf reads a StepTimeoutError as the unit\'s own attempt', () => {
    expect(attemptEndOf(new StepTimeoutError('x', { label: 'model step 0', timeoutMs: 1 }), 'r1')).toBe('attempt');
    // wrapped one level (a library rethrowing it) — still its own failure
    expect(attemptEndOf(Object.assign(new Error('wrapped'), { cause: new StepTimeoutError('x', { label: 'l', timeoutMs: 1 }) }), 'r1')).toBe('attempt');
  });
  it('a config-timeout run fails and the recorded outcome is a failure named StepTimeoutError', async () => {
    const journal = new InMemoryJournal();
    const gnl = createGnl({ journal, timeouts: { modelStepMs: 150 }, agents: { a: { model: frozen } } } as any);
    const err = await gnl.run('a', { runId: 'u7-class', prompt: 'x' }).then(() => undefined, (e) => e);
    expect(err?.name).toBe('StepTimeoutError');
    expect(attemptEndOf(err, 'u7-class')).toBe('attempt');
    const outcome: any = await readRunOutcome(journal as any, 'u7-class');
    expect(outcome?.status).toBe('failed');
    expect(outcome?.errorName).toBe('StepTimeoutError');
  });
});
