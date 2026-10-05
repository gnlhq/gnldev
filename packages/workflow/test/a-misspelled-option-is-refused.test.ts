// Every options object @gnldev/workflow reads refuses a name it does not take (@gnldev/options), naming
// the option it is closest to. Measured before: `step(id, fn, { sideEfect: true })` built a step that
// declared no side effect, so a retry after a crash ran it again instead of asking.
import { describe, it, expect } from 'vitest';
import { step, waitForResume, cancelWorkflowRun, listWorkflowRuns, workflow } from '../src/index.js';

const journal: any = { get: async () => undefined, put: async () => undefined, listKeys: async () => [] };

describe('@gnldev/workflow: a misspelled option is refused', () => {
  it.each([
    ['step', () => step('s', async () => 1, { sideEfect: true } as any), /step: `sideEfect` .* did you mean `sideEffect`\?/],
    ['waitForResume', () => waitForResume('w', { validte: (v: unknown) => v } as any), /waitForResume: `validte` .* did you mean `validate`\?/],
    ['cancelWorkflowRun', () => cancelWorkflowRun(journal, 'r', { reasons: 'x' } as any), /cancelWorkflowRun: `reasons` .* did you mean `reason`\?/],
    ['loop', () => workflow().loop(step('s', async (x: number) => x), () => false, { maxIter: 3 } as any), /loop: `maxIter` .* did you mean `maxIters`\?/],
    ['dowhile', () => workflow().dowhile(step('s', async (x: number) => x), () => false, { maxIter: 3 } as any), /dowhile: `maxIter`/],
    ['dountil', () => workflow().dountil(step('s', async (x: number) => x), () => true, { maxIter: 3 } as any), /dountil: `maxIter`/],
    ['runResumable', () => workflow().then(step('s', async (x: number) => x)).runResumable(1, { runId: 'r', journal } as any, { maxStep: 2 } as any), /runResumable: `maxStep` .* did you mean `maxSteps`\?/],
    ['listWorkflowRuns', () => listWorkflowRuns(journal, { state: 'done' } as any), /listWorkflowRuns: `state` .* did you mean `status`\?/],
  ])('%s', async (_n, build, message) => {
    await expect((async () => build())()).rejects.toThrow(message);
  });
});
