// Over the real AgentMemory, a recalled row from ANOTHER thread of the same person (resource-scope recall,
// with and without messageRange expansion) is still labelled recall by the layout, and the layout reads present.
import { describe, it, expect, vi, beforeAll } from 'vitest';
import { InMemoryStorage, runDurable, runKeys, readRunMemoryLayout } from '@gnldev/durable';
import { AgentMemory } from '../src/index.js';

beforeAll(() => { vi.spyOn(console, 'warn').mockImplementation(() => {}); });
// Diagnostics, printed with GNL_TEST_VERBOSE=1.
const log = (...a: unknown[]) => void (process.env.GNL_TEST_VERBOSE && process.stdout.write(`AUDIT ${a.map((x) => (typeof x === 'string' ? x : JSON.stringify(x))).join(' ')}\n`));
const DIMS = ['refund', 'shipping', 'weather', 'joke'];
const embed = async (t: string) => DIMS.map((k) => t.toLowerCase().split(k).length - 1);
const u = (content: string) => ({ role: 'user', content });
const a = (content: string) => ({ role: 'assistant', content });
const model: any = {
  specificationVersion: 'v2', provider: 'mock', modelId: 'm', supportedUrls: {},
  doGenerate: async () => ({ content: [{ type: 'text', text: 'ok' }], finishReason: 'stop', usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 }, warnings: [] }),
  doStream: async () => { throw new Error('no'); },
};
const text = (m: any) => (typeof m?.content === 'string' ? m.content : (m?.content ?? []).map((p: any) => p.text ?? '').join(''));

describe('resource-scope recall', () => {
  for (const messageRange of [0, 1]) {
    it(`a recalled row from another thread of the same person (messageRange ${messageRange})`, async () => {
      const storage = new InMemoryStorage();
      const mem = new AgentMemory({ storage, embed, recentN: 2, recall: { topK: 1, scope: 'resource', messageRange } });
      await storage.memory.upsertThread({ id: 'other', resourceId: 'ayse', createdAt: 1, updatedAt: 1 });
      await storage.memory.upsertThread({ id: 'cur', resourceId: 'ayse', createdAt: 2, updatedAt: 2 });
      await mem.append('other', [u('hello'), a('hi'), u('refund for order 7 please'), a('done'), u('bye')]);
      await mem.append('cur', [u('weather today'), a('sunny'), u('joke please'), a('a joke')]);
      await runDurable({ runId: 'rs' + messageRange, journal: storage.runs, memory: mem, threadId: 'cur', resourceId: 'ayse', model, prompt: 'what about my refund?' } as any);
      const rec: any = await storage.runs.get(runKeys.memoryContext('rs' + messageRange));
      const inp: any = await storage.runs.get(runKeys.input('rs' + messageRange));
      const reading = await readRunMemoryLayout(storage.runs, 'rs' + messageRange);
      const L = rec.layout;
      log('resource', messageRange, { input: inp.messages.map(text), layout: L, recalled: rec.recalled.map((r: any) => [r.threadId, r.seq]), recentCount: rec.recentCount, reading: reading.status });
      expect(reading.status).toBe('present');
      expect(['exact', 'changed']).toContain(L.status);
      expect(inp.messages.slice(...L.recall).map(text).join(' ')).toContain('refund for order 7');
    });
  }
});
