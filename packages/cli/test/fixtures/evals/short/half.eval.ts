// A suite that falls short: one case of two answers without the marker.
import { defineEval, contains } from '@gnldev/evals';

export default defineEval({
  dataset: { id: 'half', cases: [{ id: 'good', input: 'x' }, { id: 'bad', input: 'y' }] },
  run: async (input: string) => (input === 'x' ? 'ok:x' : 'nope'),
  scorers: [contains('ok:')],
  thresholds: { contains: { mean: 0.9, every: 1 } },
});
