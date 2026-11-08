// d25 finding 3 (KVKK): scan EVERYTHING a run persists for the raw PII that was typed in the first message.
// Sibling surfaces: runDurable, streamDurable, with and without a title generator; plus purgeThread.
import { describe, it, expect } from 'vitest';
import { InMemoryStorage, runDurable, streamDurable, purgeThread } from '@gnldev/durable';
import { piiRedactor } from '../../processors/src/index.js';
import { AgentMemory } from '../src/index.js';

const PHONE = '0532 123 45 67';
const EMAIL = 'ali.veli@example.com';
const TEXT = `Merhaba, benim numaram ${PHONE} ve mailim ${EMAIL}, randevu istiyorum`;
const usage = { inputTokens: { total: 1 }, outputTokens: { total: 1 } };
const model: any = {
  specificationVersion: 'v4', provider: 'm', modelId: 'm', supportedUrls: {},
  doGenerate: async () => ({ content: [{ type: 'text', text: 'tamam' }], finishReason: { unified: 'stop', raw: 'stop' }, usage, warnings: [] }),
  doStream: async function () {
    return { stream: new ReadableStream({ start(c) {
      c.enqueue({ type: 'stream-start', warnings: [] });
      c.enqueue({ type: 'text-start', id: '1' }); c.enqueue({ type: 'text-delta', id: '1', delta: 'tamam' }); c.enqueue({ type: 'text-end', id: '1' });
      c.enqueue({ type: 'finish', finishReason: { unified: 'stop', raw: 'stop' }, usage }); c.close();
    } }) };
  },
};

async function dump(storage: InMemoryStorage): Promise<Array<[string, string]>> {
  const out: Array<[string, string]> = [];
  for (const k of await storage.runs.listKeys('')) out.push([`journal:${k}`, String(JSON.stringify(await storage.runs.get(k)))]);
  const m: any = storage.memory;
  for (const t of [await m.getThread('t')].filter(Boolean)) {
    out.push([`thread:${t.id}`, String(JSON.stringify(t))]);
    out.push([`msgs:${t.id}`, String(JSON.stringify(await m.getMessages(t.id)))]);
  }
  return out;
}
const leaks = (rows: Array<[string, string]>) =>
  rows.filter(([, v]) => v.includes('123 45 67') || v.includes(EMAIL)).map(([k]) => k);

for (const [name, withTitleGen, stream] of [
  ['runDurable', false, false], ['runDurable + generateTitle', true, false], ['streamDurable', false, true], ['streamDurable + generateTitle', true, true],
] as const) {
  describe(name, () => {
    it('no persisted field holds the raw phone/email (except documented raw journal records)', async () => {
      const storage = new InMemoryStorage();
      const mem = new AgentMemory({ storage, ...(withTitleGen ? { generateTitle: async (t: string) => t } : {}) });
      const args: any = { runId: 'r1', journal: storage.runs, model, memory: mem, prompt: TEXT, threadId: 't', resourceId: 'u', processors: [piiRedactor()] };
      if (stream) { const r: any = await streamDurable(args); await r.text; } else await runDurable(args);
      await new Promise((r) => setTimeout(r, 50));
      const rows = await dump(storage);
      const th = rows.find(([k]) => k === 'thread:t');
      expect(th?.[1], 'thread title').not.toMatch(/123 45 67|ali\.veli/);
      expect(leaks(rows), 'raw PII found in: ' + leaks(rows).join(', ')).toEqual([]);
    });
  });
}

describe('purgeThread', () => {
  it('with memory, removes the thread row', async () => {
    const storage = new InMemoryStorage();
    const mem = new AgentMemory({ storage });
    await runDurable({ runId: 'r1', journal: storage.runs, model, memory: mem, prompt: TEXT, threadId: 't', resourceId: 'u' } as any);
    await purgeThread(storage.runs as any, 't', { memory: storage.memory as any });
    expect(await (storage.memory as any).getThread('t')).toBeUndefined();
  });
});

// Sanity: the scan can see a leak (no redactor => it must find the raw text), so the greens above mean something.
describe('the scan itself', () => {
  it('finds the raw text when no redactor is configured', async () => {
    const storage = new InMemoryStorage();
    const mem = new AgentMemory({ storage });
    await runDurable({ runId: 'r1', journal: storage.runs, model, memory: mem, prompt: TEXT, threadId: 't', resourceId: 'u' } as any);
    expect(leaks(await dump(storage)).length).toBeGreaterThan(0);
  });
});

// Sibling surface: the configured-agent door (createGnl), where the processor lives on the agent.
import { createGnl } from '@gnldev/durable';
describe('createGnl agent with processors + memory (door used by REST/chat)', () => {
  for (const kind of ['run', 'stream'] as const) {
    it(kind + ': nothing persisted holds the raw text', async () => {
      const storage = new InMemoryStorage();
      const gnl: any = createGnl({ storage, memory: new AgentMemory({ storage }), agents: { a: { model, processors: [piiRedactor()] } } } as any);
      const r: any = kind === 'run'
        ? await gnl.run('a', { runId: 'r1', prompt: TEXT, threadId: 't', resourceId: 'u' })
        : await gnl.stream('a', { runId: 'r1', prompt: TEXT, threadId: 't', resourceId: 'u' });
      if (kind === 'stream') await r.text;
      await new Promise((x) => setTimeout(x, 50));
      const rows = await dump(storage);
      expect(leaks(rows), 'raw PII found in: ' + leaks(rows).join(', ')).toEqual([]);
    });
  }
});
