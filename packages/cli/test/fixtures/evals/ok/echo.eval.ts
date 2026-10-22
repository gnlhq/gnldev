// A suite that passes: the runner echoes, the scorer looks for the echo.
import { defineEval, contains } from '@gnldev/evals';

const g = globalThis as { __gnlEvalCalls?: number };
export default defineEval({
  dataset: { id: 'echo', cases: [{ id: 'c1', input: 'hello' }, { id: 'c2', input: 'world' }] },
  run: async (input: string) => { g.__gnlEvalCalls = (g.__gnlEvalCalls ?? 0) + 1; return `echo:${input}`; },
  scorers: [contains('echo:')],
  thresholds: { contains: 1 },
});
