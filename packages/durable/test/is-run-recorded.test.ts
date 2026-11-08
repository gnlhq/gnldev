// isRunRecorded: the existence question `readRun` cannot answer for a run with no steps (it lists model/tool
// records only), asked through whatever view the caller has — another user's run is "not recorded" to them.
import { describe, it, expect } from 'vitest';
import { InMemoryJournal, runDurable, isRunRecorded, withSubjectJournal } from '../src/index.js';

const refused: any = { specificationVersion: 'v2', provider: 'mock', modelId: 'm', supportedUrls: {}, doGenerate: async () => { throw new Error('403 Forbidden'); } };

describe('isRunRecorded', () => {
  it('true for a stepless failed run, false for an id that was never written', async () => {
    const journal = new InMemoryJournal();
    await runDurable({ runId: 'z1', journal, model: refused, prompt: 'go', resourceId: 'alice' } as any).catch(() => {});
    expect(await journal.readRun('z1')).toHaveLength(0);
    expect(await isRunRecorded(journal, 'z1')).toBe(true);
    expect(await isRunRecorded(journal, 'ghost')).toBe(false);
  });
  it('through a subject view: the owner sees it, another user does not', async () => {
    const journal = new InMemoryJournal();
    await runDurable({ runId: 'z2', journal, model: refused, prompt: 'go', resourceId: 'alice' } as any).catch(() => {});
    expect(await isRunRecorded(withSubjectJournal(journal, 'alice'), 'z2')).toBe(true);
    expect(await isRunRecorded(withSubjectJournal(journal, 'bob'), 'z2')).toBe(false);
  });
});
