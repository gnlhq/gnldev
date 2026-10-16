// Extension experiment: a new event kind ("tool-progress 40%") reaches a detached run's followers.
import { it, expect } from 'vitest';
import { tool } from 'ai';
import { z } from 'zod';
import { InMemoryJournal, DetachedRuns, streamDurable, inMemoryLiveness } from '../src/index.js';
import { streamingModel } from './detached/models.js';

it('a streaming tool\'s progress is an event a follower sees', async () => {
  const journal = new InMemoryJournal();
  const runs = new DetachedRuns({ journal, liveness: inMemoryLiveness(), resume: () => { throw new Error('no'); }, sweepMs: 0 });
  const effect = tool({
    description: 'long', inputSchema: z.object({ order: z.string() }),
    execute: async function* () { yield { progress: 0.4 }; yield 'done'; },
  });
  Object.assign(effect, { idempotent: true });
  const model = streamingModel({ words: ['ok '], gapMs: 1, tool: { name: 'effect', input: { order: 'o' } } });
  await runs.start({ runId: 'p1', launch: (signal) => streamDurable({ journal, runId: 'p1', model, tools: { effect }, prompt: 'go', resourceId: 'alice', abortSignal: signal } as any) });
  const evs: any[] = [];
  for await (const ev of runs.follow({ runId: 'p1' })) evs.push(ev);
  // In the log (v1) progress is a preliminary tool result; a door's encoder shows it as `tool-progress`.
  expect(evs.find((e) => e.kind === 'tool-result' && e.data.preliminary)?.data).toMatchObject({ toolName: 'effect', output: { progress: 0.4 } });
  await runs.close();
});
