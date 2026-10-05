// toJournal(storage) is toJournal(storage.runs): the reader every inspector takes, from the one
// handle a project holds. User code wrote the two-step form 11 times across the examples and docs.
import { describe, it, expect } from 'vitest';
import { InMemoryStorage, toJournal, runDurable } from '../src/index.js';
import { SqliteStorage } from '../src/sqlite-storage.js';

const usage = { inputTokens: 1, outputTokens: 1, totalTokens: 2 };
const model: any = { specificationVersion: 'v2', provider: 'm', modelId: 'm', supportedUrls: {},
  doGenerate: async () => ({ content: [{ type: 'text', text: 'ok' }], finishReason: 'stop', usage, warnings: [] }) };

describe('toJournal takes the Storage or its runs port, alike', () => {
  for (const [name, mk] of [['in-memory', () => new InMemoryStorage()], ['sqlite', () => new SqliteStorage(':memory:')]] as const) {
    it(name, async () => {
      const storage: any = mk();
      await runDurable({ runId: 'r1', journal: toJournal(storage.runs), model, prompt: 'hi' } as any);
      const a = toJournal(storage), b = toJournal(storage.runs);
      expect(await a.readRun('r1')).toEqual(await b.readRun('r1'));
      expect((await a.listRuns()).map((r: any) => r.runId)).toEqual((await b.listRuns()).map((r: any) => r.runId));
      expect(typeof (a as any).applyBatch).toBe(typeof (b as any).applyBatch);
      storage.close?.();
    });
  }
});
