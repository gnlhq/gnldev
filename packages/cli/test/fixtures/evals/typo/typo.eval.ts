// A threshold naming a scorer the suite does not have (contians): the gate must close, not pass unchecked.
import { defineEval, contains } from '@gnldev/evals';

export default defineEval({
  dataset: { id: 'typo', cases: [{ id: 'c1', input: 'x' }] },
  run: async () => 'ok:x',
  scorers: [contains('ok:')],
  thresholds: { contians: 0.5 },
});
