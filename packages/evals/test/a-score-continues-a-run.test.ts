// A score's memo is written under the run it scores. On a run that does not exist it used to be the run's
// first row — the id then read as a run that exists (staff's). A score continues a run; it begins none.
import { describe, it, expect } from 'vitest';
import { InMemoryJournal, RunNotFoundError, runDurable } from '@gnldev/durable';
import { scoreRun, contains } from '../src/index.js';

const model: any = {
  specificationVersion: 'v4', provider: 'm', modelId: 'm', supportedUrls: {},
  doGenerate: async () => ({ content: [{ type: 'text', text: 'correct' }], finishReason: { unified: 'stop', raw: 'stop' }, usage: { inputTokens: { total: 1 }, outputTokens: { total: 1 } }, warnings: [] }),
};

describe('scoreRun on a run that does not exist', () => {
  it('is not found, and writes nothing under the id', async () => {
    const j = new InMemoryJournal();
    await expect(scoreRun(j, 'r-none', [contains('correct')])).rejects.toBeInstanceOf(RunNotFoundError);
    expect(await j.listKeys('r-none')).toEqual([]);
  });

  it('SIBLING — a run that exists is scored and memoized as before', async () => {
    const j = new InMemoryJournal();
    await runDurable({ runId: 'r-yes', journal: j, model, prompt: 'q' } as any);
    const r = await scoreRun(j, 'r-yes', [contains('correct')]);
    expect(r.scores.contains?.score ?? Object.values(r.scores)[0]!.score).toBe(1);
  });

  it('SIBLING — without a memo (nothing written) it is read-only, as before', async () => {
    const j = new InMemoryJournal();
    await expect(scoreRun(j, 'r-none2', [contains('correct')], { memo: false })).resolves.toBeDefined();
    expect(await j.listKeys('r-none2')).toEqual([]);
  });
});
