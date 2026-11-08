// d25 A2 (stream/KARAR-09, option A): rebuilding a chat after a page reload must bring back what the USER wrote,
// not only the assistant's answer. The user's text lives in the run's `:input` record, which `journal.readRun()`
// does not return, so `toUIMessages(readRun(runId))` alone could never show it. Option A: a reader that takes the
// journal and the runId — `readUIMessages(journal, runId)` — returns the user bubble AND the assistant bubble, with
// ids prefixed by the runId so two runs of one thread never collide as React keys.
//
// Also covered: `toUIMessages` with no runId must not hand two DIFFERENT runs the same ids ("run:msg:0" twice).
// Which way it avoids that — an error asking for a runId, or ids derived from the entries — is left open by the
// decision ("hata ya da entries'ten türetilir"); the test accepts either.
import { describe, it, expect } from 'vitest';
import { InMemoryJournal, createGnl } from '@gnldev/durable';
import * as chatAdapter from '../src/index.js';
import { createChatRoute, toUIMessages } from '../src/index.js';

const usage = { inputTokens: 1, outputTokens: 1, totalTokens: 2 };
const answering = (text: string): any => ({
  specificationVersion: 'v2', provider: 'mock', modelId: 'm', supportedUrls: {},
  doGenerate: async () => ({ content: [{ type: 'text', text }], finishReason: 'stop', usage, warnings: [] }),
  doStream: async () => ({ stream: new ReadableStream({ start(c) { for (const p of [{ type: 'stream-start', warnings: [] }, { type: 'text-start', id: '1' }, { type: 'text-delta', id: '1', delta: text }, { type: 'text-end', id: '1' }, { type: 'finish', finishReason: 'stop', usage }]) c.enqueue(p); c.close(); } }) }),
});

const readUIMessages = (chatAdapter as any).readUIMessages as (journal: unknown, runId: string) => Promise<any[]>;
const textOf = (m: any) => (m?.parts ?? []).filter((p: any) => p.type === 'text').map((p: any) => p.text).join('');

async function chatTurn(journal: InMemoryJournal, chatId: string, msgId: string, text: string) {
  const app = createChatRoute({ journal, agents: { chat: { model: answering(`re: ${text}`) } } } as any, { identify: () => ({ userId: 'u1' }) as any, allowedHosts: ['localhost'] } as any);
  const res = await app.request('http://localhost/agents/chat/chat', { method: 'POST', headers: { 'content-type': 'application/json', host: 'localhost' }, body: JSON.stringify({ id: chatId, messages: [{ id: msgId, role: 'user', parts: [{ type: 'text', text }] }] }) });
  await res.text();
  expect(res.status).toBe(200);
  return `${chatId}:${msgId}`;
}

describe('A2: readUIMessages(journal, runId) restores the conversation after a reload', () => {
  it('is exported by @gnldev/chat-adapter', () => {
    expect(typeof readUIMessages).toBe('function');
  });

  it('chat turn: returns the user bubble and the assistant bubble, in order, with their text', async () => {
    const journal = new InMemoryJournal();
    const runId = await chatTurn(journal, 'c1', 'm1', 'hi there');
    const ui = await readUIMessages(journal, runId);
    expect(ui.map((m) => m.role)).toEqual(['user', 'assistant']);
    expect(textOf(ui[0])).toBe('hi there');
    expect(textOf(ui[1])).toBe('re: hi there');
  });

  it('sibling — a run started with a plain prompt (not the chat door) also gets its user bubble back', async () => {
    const journal = new InMemoryJournal();
    const gnl = createGnl({ journal, agents: { a: { model: answering('pong') } } } as any);
    await gnl.run('a', { runId: 'plain-1', prompt: 'ping' } as any);
    const ui = await readUIMessages(journal, 'plain-1');
    expect(ui.map((m) => m.role)).toEqual(['user', 'assistant']);
    expect(textOf(ui[0])).toBe('ping');
    expect(textOf(ui[1])).toBe('pong');
  });

  it('sibling — two runs of one thread, concatenated: every id is unique and carries its runId', async () => {
    const journal = new InMemoryJournal();
    const r1 = await chatTurn(journal, 'c2', 'm1', 'first');
    const r2 = await chatTurn(journal, 'c2', 'm2', 'second');
    const a = await readUIMessages(journal, r1);
    const b = await readUIMessages(journal, r2);
    const ids = [...a, ...b].map((m) => m.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const m of a) expect(String(m.id)).toContain(r1);
    for (const m of b) expect(String(m.id)).toContain(r2);
  });
});

describe('A2: toUIMessages without a runId does not give two different runs the same ids', () => {
  it('either refuses (naming runId) or produces distinct ids — never "run:msg:0" for both', async () => {
    const journal = new InMemoryJournal();
    const gnl = createGnl({ journal, agents: { a: { model: answering('same answer') } } } as any);
    await gnl.run('a', { runId: 'x-1', prompt: 'q' } as any);
    await gnl.run('a', { runId: 'x-2', prompt: 'q' } as any);
    const e1 = await journal.readRun('x-1');
    const e2 = await journal.readRun('x-2');
    let outcome: { threw: string } | { ids: [string[], string[]] };
    try {
      outcome = { ids: [toUIMessages(e1).map((m) => m.id), toUIMessages(e2).map((m) => m.id)] };
    } catch (e) {
      outcome = { threw: String((e as Error).message) };
    }
    if ('threw' in outcome) {
      expect(outcome.threw).toMatch(/runId/);
    } else {
      const [i1, i2] = outcome.ids;
      expect(i1.length).toBeGreaterThan(0);
      for (const id of i1) expect(i2).not.toContain(id);
    }
  });
});
