// Erasure completeness: a detached run's event log (user text) is under the run's own prefix, so
// erasing the person erases it — and the execution record holds no content.
import { it, expect } from 'vitest';
import { InMemoryStorage, DetachedRuns, streamDurable, inMemoryLiveness, eraseSubject, readRunEvents } from '../src/index.js';
import { streamingModel } from './detached/models.js';

it('erasing the subject erases its detached run events', async () => {
  const storage = new InMemoryStorage();
  const journal = storage.runs as any;
  const runs = new DetachedRuns({ journal, liveness: inMemoryLiveness(), resume: () => { throw new Error('no'); }, sweepMs: 0 });
  const model = streamingModel({ words: ['secret ', 'text '], gapMs: 1 });
  await runs.start({ runId: 'e1', launch: (signal) => streamDurable({ journal, runId: 'e1', model, prompt: 'my secret', resourceId: 'alice', abortSignal: signal } as any) });
  for await (const _ of runs.follow({ runId: 'e1' })) { /* until completed */ }
  expect((await readRunEvents(journal, 'e1')).length).toBeGreaterThan(3);
  await eraseSubject(storage, 'alice');
  expect(await readRunEvents(journal, 'e1')).toEqual([]);
  expect((await journal.listKeys('')).filter((k: string) => k.includes('secret') || k.startsWith('e1:'))).toEqual([]);
  await runs.close();
});
