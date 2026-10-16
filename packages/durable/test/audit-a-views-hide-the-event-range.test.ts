// AUDIT A (red): `readRange` (new in this release — how a run's event log is read) is forwarded raw by the
// two reading views that hide rows: the root scope (`withRootScope`, hides every organization's rows) and
// an end user's view (`withSubjectJournal`, hides every run that is not theirs). `get`/`listKeys` of the
// same view return nothing for those rows; `readRange` returns them whole.
import { describe, it, expect } from 'vitest';
import { InMemoryStorage, DetachedRuns, streamDurable, inMemoryLiveness, withOrg, withRootScope, withSubjectJournal, readRunEvents } from '../src/index.js';
import { streamingModel } from './detached/models.js';

async function runOnce(root: any, journal: any, scope: string | undefined, runId: string, who: string, words: string[]) {
  const runs = new DetachedRuns({ journal: root, journalFor: () => journal, liveness: inMemoryLiveness(), resume: () => { throw new Error('no'); }, sweepMs: 0, coalesceMs: 5 });
  await runs.start({ runId, ...(scope ? { scope } : {}), launch: (s) => streamDurable({ journal, runId, model: streamingModel({ words, gapMs: 1 }), prompt: 'p', resourceId: who, abortSignal: s } as any) });
  for await (const _ of runs.follow({ runId, ...(scope ? { scope } : {}) })) { /* to its end */ }
  await runs.close();
}

describe('a view that hides rows hides them from readRange too', () => {
  it('the root scope reads no organization\'s event log', async () => {
    const storage = new InMemoryStorage();
    const root = storage.runs as any;
    await runOnce(root, withOrg(root, 'acme'), 'acme', 'r1', 'u', ['ACME-SECRET ']);
    const view = withRootScope(root) as any;
    expect(await view.get('org:acme:r1:ev:0000000001'), 'get hides it').toBeUndefined();
    expect(await view.listKeys('org:acme:r1:ev:'), 'listKeys hides it').toEqual([]);
    const leaked = (await readRunEvents(view, 'org:acme:r1')).filter((e: any) => e.kind === 'text');
    expect(leaked, 'the root scope read acme\'s event log through readRange').toEqual([]);
  });

  it('an end user\'s view reads no other user\'s event log', async () => {
    const storage = new InMemoryStorage();
    const root = storage.runs as any;
    await runOnce(root, root, undefined, 'alice-run', 'alice', ['ALICE-SECRET ']);
    const mallory = withSubjectJournal(root, 'mallory') as any;
    expect(await mallory.get('alice-run:ev:0000000001'), 'get hides it').toBeUndefined();
    expect(await mallory.listKeys('alice-run:'), 'listKeys hides it').toEqual([]);
    const leaked = (await readRunEvents(mallory, 'alice-run')).filter((e: any) => e.kind === 'text');
    expect(leaked, 'mallory\'s view read alice\'s event log through readRange').toEqual([]);
  });
});
