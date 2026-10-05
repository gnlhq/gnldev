// qualifyJudge refuses a name it does not take (@gnldev/options), naming the option it is closest to.
import { it, expect } from 'vitest';
import { qualifyJudge } from '../src/index.js';

it('qualifyJudge refuses a misspelled option', async () => {
  await expect(qualifyJudge({ complete: async () => '', judgeModelId: 'm', fixture: [] } as any)).rejects.toThrow(/qualifyJudge: `fixture` .* did you mean `fixtures`\?/);
});
