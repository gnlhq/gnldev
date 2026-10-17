// A run of a composed family (`job:`, `sched:`, `batch:`) is also the source of runs its own tools
// derive from it: a fork, a regression replay, a rollover. When the tool picks the new id itself it is
// the composer of that id and begins it; an id a caller hands in is judged like any id a caller names,
// so a caller cannot use a fork to begin someone's `job:`.
import { describe, it, expect } from 'vitest';
import { InMemoryStorage, createGnl, forkRun, replayRun, rolloverRun, claimRunOwner, composerMark, user } from '../src/index.js';
import { createMockModel, finalTextResult } from './mock.js';

describe('a composed run is continued by its own paths', () => {
  const born = async (src: string) => {
    const storage = new InMemoryStorage();
    const model = createMockModel(async () => finalTextResult('done'));
    await claimRunOwner(storage.runs as never, src, user('alice'), composerMark(src));
    await createGnl({ storage, agents: { a: { model } } }).run('a', { runId: src, prompt: 'go', caller: user('alice') });
    return { j: storage.runs as never, model };
  };
  for (const src of ['job:~o~:alice:export', 'sched:~o~:alice:weekly:0', 'batch:B:F-1']) {
    const root = src.split(':')[0];
    const other = (n: number) => `${root}:~o~:bob:other:${n}`;
    it(`${src}: a fork picks its own id and begins it`, async () => {
      const { j } = await born(src);
      expect((await forkRun(j, src, 1)).newRunId.startsWith(src)).toBe(true);
    });
    it(`${src}: a replay picks its own id and begins it`, async () => {
      const { j, model } = await born(src);
      expect((await replayRun({ journal: j, runId: src, model })).newRunId.startsWith(src)).toBe(true);
    });
    it(`${src}: a rollover picks its own id and begins it`, async () => {
      const { j } = await born(src);
      expect((await rolloverRun(j, src)).newRunId.startsWith(src)).toBe(true);
    });
    it(`${src}: a fork into a caller's id of a composed family is refused`, async () => {
      const { j } = await born(src);
      await expect(forkRun(j, src, 1, other(0))).rejects.toThrow(/composed by/);
    });
    it(`${src}: a replay into a caller's id of a composed family is refused`, async () => {
      const { j, model } = await born(src);
      await expect(replayRun({ journal: j, runId: src, model, newRunId: other(1) })).rejects.toThrow(/composed by/);
    });
    it(`${src}: a rollover into a caller's id of a composed family is refused`, async () => {
      const { j } = await born(src);
      await expect(rolloverRun(j, src, { newRunId: other(2) })).rejects.toThrow(/composed by/);
    });
  }
});
