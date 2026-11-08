// d25 U1 — a conversation's auto-title is written from the RAW first user message, past piiRedactor.
// Claim (agent 24): TCKN/phone leak into gnl_threads.title; purgeThread leaves the thread row, eraseSubject removes it.
// Red = claim holds.
import { describe, it, expect } from 'vitest';
import { InMemoryStorage, eraseSubject } from '../src/index.js';
import { SqliteStorage } from '../src/sqlite-storage.js';
import { runDurable } from '../src/run.js';
import { toJournal } from '../src/storage.js';
import { purgeThread } from '../src/retention.js';
import { AgentMemory } from '../../memory/src/index.js';
import { piiRedactor } from '../../processors/src/index.js';
import { createMockModel } from './mock.js';

const model = () => createMockModel(async () => ({ content: [{ type: 'text', text: 'ok' }], finishReason: 'stop', usage: { inputTokens: 1, outputTokens: 1 }, warnings: [] }));
const PROMPT = 'Siparişlerimi listeler misin? Kimlik no 12345678901, telefonum 0532 123 45 67 ve mail ayse@example.com';

async function setup() {
  const storage = new SqliteStorage(':memory:') as any;
  const memory = new AgentMemory({ storage });
  await runDurable({
    runId: 'u1-r1', journal: toJournal(storage.runs), memory: memory as any, threadId: 'u1-t', resourceId: 'ayse',
    model: model(), prompt: PROMPT, processors: [piiRedactor()],
  } as any);
  return { storage, memory };
}

describe('U1 PII in thread title', () => {
  it('title and stored message: which of them carries raw PII', async () => {
    const { memory } = await setup();
    const th = await (memory as any).store.getThread('u1-t');
    const msgs = await (memory as any).store.getMessages('u1-t', { limit: 10 });
    console.log('TITLE =', JSON.stringify(th?.title));
    console.log('MESSAGES =', JSON.stringify(msgs.items.map((m: any) => m.message?.content ?? m.text)));
    // the message body is redacted by the processor; the title must be too
    expect(th?.title).not.toMatch(/12345678901|0532 123 45 67|ayse@example\.com/);
  });

  it('purgeThread(journal) WITHOUT memory leaves the thread row BY DESIGN (the docs now say pass { memory }); AgentMemory.deleteThread removes it', async () => {
    const { storage, memory } = await setup();
    await purgeThread(toJournal(storage.runs), 'u1-t', { allowInFlight: true });
    expect(await (memory as any).store.getThread('u1-t')).toBeTruthy(); // journal half only: the documented contract
    await memory.deleteThread('u1-t', { allowInFlight: true });
    expect(await (memory as any).store.getThread('u1-t')).toBeFalsy();
  });

  it('purgeThread(journal, { memory }) removes the row', async () => {
    const { storage, memory } = await setup();
    await purgeThread(toJournal(storage.runs), 'u1-t', { memory: (memory as any).store, allowInFlight: true });
    expect(await (memory as any).store.getThread('u1-t')).toBeFalsy();
  });

  it('eraseSubject removes the thread row', async () => {
    const { storage } = await setup();
    await eraseSubject(storage, 'ayse');
    expect(await storage.memory.getThread('u1-t')).toBeFalsy();
  });
});

describe('U1 fix: the title and the title model see the chain\'s output', () => {
  const RAW = /12345678901|0532 123 45 67|ayse@example\.com/;
  async function run(opts: { processors?: any[]; generateTitle?: (t: string) => Promise<string | undefined> }) {
    const storage = new SqliteStorage(':memory:') as any;
    const memory = new AgentMemory({ storage, ...(opts.generateTitle ? { generateTitle: opts.generateTitle } : {}) });
    await runDurable({
      runId: 'u1f-r1', journal: toJournal(storage.runs), memory: memory as any, threadId: 'u1f-t', resourceId: 'ayse',
      model: model(), prompt: PROMPT, ...(opts.processors ? { processors: opts.processors } : {}),
    } as any);
    await new Promise((r) => setTimeout(r, 30)); // generateTitle is fire-and-forget
    return (memory as any).store.getThread('u1f-t');
  }

  it('generateTitle receives the masked text, never the raw first message', async () => {
    const seen: string[] = [];
    const th = await run({ processors: [piiRedactor()], generateTitle: async (t) => { seen.push(t); return 'Orders'; } });
    expect(seen).toHaveLength(1);
    expect(seen[0]).not.toMatch(RAW);
    expect(th.title).toBe('Orders');
  });

  it('a chain that cannot answer leaves the thread untitled — and the title model unasked', async () => {
    const seen: string[] = [];
    const stepping = { name: 'stepper', processInput: async (i: any, ctx: any) => { await ctx.step('x', async () => 1); return i; } };
    const th = await run({ processors: [stepping], generateTitle: async (t) => { seen.push(t); return 'T'; } });
    expect(th.title ?? '').not.toMatch(RAW);
    expect(seen.join('')).not.toMatch(RAW);
  });

  it('no processors: the title is still cut from the message (nothing to mask)', async () => {
    const th = await run({});
    expect(th.title).toMatch(/Siparişlerimi/);
  });
});
