// d25 item 23: ONE rule for what a prompt window may hold, applied to every path that builds one.
//
//   A window never OPENS on a tool result whose call is outside it, and never CONTAINS a tool call
//   whose result is outside it. Providers answer 400 (MissingToolResultsError) to the second as
//   they do to the first.
//
// Measured on release/0.17.1: the plain `recentN` window repairs the first half (windowFromTurnBoundary)
// and ignores the second; the recall path repairs the second (pairRecalledToolCalls) for what recall
// brought in, but not for the recent part it appends. The sibling tests below hit the rule through
// DIFFERENT entry points (getMessages with and without a query, loadContext, every recentN), so a
// fix that patches one of them is red here. They assert the RULE, never which row is dropped.
import { describe, it, expect } from 'vitest';
import { InMemoryStorage } from '@gnldev/durable';
import { AgentMemory } from '../src/index.js';

const user = (c: string) => ({ role: 'user', content: c });
const calls = (...ids: string[]) => ({ role: 'assistant', content: ids.map((id) => ({ type: 'tool-call', toolCallId: id, toolName: 'x', input: {} })) });
const answer = (id: string) => ({ role: 'tool', content: [{ type: 'tool-result', toolCallId: id, toolName: 'x', output: { type: 'json', value: 1 } }] });
const final = (t: string) => ({ role: 'assistant', content: [{ type: 'text', text: t }] });
const embed = async (t: string) => (/aurora/i.test(t) ? [1, 0] : [0, 1]);

function ids(messages: any[]) {
  const called = new Set<string>(), answered = new Set<string>();
  for (const m of messages) for (const p of Array.isArray(m?.content) ? m.content : []) {
    if (p?.type === 'tool-call') called.add(p.toolCallId);
    if (p?.type === 'tool-result') answered.add(p.toolCallId);
  }
  return { called, answered };
}
/** The rule: no result without its call, no call without its result, and the window does not open on a tool message. */
function violations(messages: any[]): string[] {
  const { called, answered } = ids(messages);
  const v: string[] = [];
  for (const a of answered) if (!called.has(a)) v.push(`result without call: ${a}`);
  for (const c of called) if (!answered.has(c)) v.push(`call without result: ${c}`);
  if (messages[0]?.role === 'tool') v.push('window opens on a tool message');
  return v;
}
const texts = (messages: any[]) => messages.flatMap((m) => (typeof m.content === 'string' ? [m.content] : (m.content ?? []).filter((p: any) => p.type === 'text').map((p: any) => p.text)));

async function seeded(recentN: number, history: any[], extra: Partial<ConstructorParameters<typeof AgentMemory>[0]> = {}) {
  const storage = new InMemoryStorage();
  const mem = new AgentMemory({ storage, recentN, ...extra } as any);
  await storage.memory.upsertThread({ id: 't', resourceId: 'u', createdAt: 1, updatedAt: 1 });
  await mem.append('t', history);
  return mem;
}

describe('a call nobody answered, in the middle of the history', () => {
  const history = [user('q1'), final('r1'), user('book me'), calls('p'), user('are you there?'), final('yes'), user('and now?'), final('here')];
  for (const recentN of [2, 3, 4, 5, 6, 7, 8, 20]) {
    it(`recentN=${recentN}: getMessages (no query) holds no unpaired call/result`, async () => {
      const mem = await seeded(recentN, history);
      expect(violations(await mem.getMessages('t'))).toEqual([]);
    });
    it(`recentN=${recentN}: loadContext holds no unpaired call/result`, async () => {
      const mem = await seeded(recentN, history);
      const ctx: any = await (mem as any).loadContext('t', { resourceId: 'u' });
      expect(violations(ctx.messages ?? ctx.recent ?? [])).toEqual([]);
    });
  }

  it('the rule does not eat the conversation: the user turns after the broken call are still there', async () => {
    const mem = await seeded(20, history);
    const t = texts(await mem.getMessages('t'));
    for (const keep of ['are you there?', 'and now?', 'here']) expect(t).toContain(keep);
  });

  it('parallel calls, only one answered: the window is still paired', async () => {
    const mem = await seeded(20, [user('q'), calls('a', 'b'), answer('a'), user('next'), final('ok')]);
    expect(violations(await mem.getMessages('t'))).toEqual([]);
  });

  it('a healthy thread is untouched: every complete pair survives a large window', async () => {
    const mem = await seeded(20, [user('q1'), calls('a'), answer('a'), final('r1'), user('q2'), calls('b', 'c'), answer('b'), answer('c'), final('r2')]);
    const { called, answered } = ids(await mem.getMessages('t'));
    expect([...called].sort()).toEqual(['a', 'b', 'c']);
    expect([...answered].sort()).toEqual(['a', 'b', 'c']);
  });
});

describe('the recall path applies the same rule to the recent part it appends', () => {
  it('query + embed: an unanswered call inside the recent window is not sent', async () => {
    // recentN 4 over a longer thread, so the recall branch runs (not the "fits in window" shortcut);
    // the call has no text, so recall can never elect it — it can only arrive through the recent window.
    const storage = new InMemoryStorage();
    const mem = new AgentMemory({ storage, embed, recentN: 4, recall: { topK: 1, threshold: 0, scope: 'thread' } } as any);
    await storage.memory.upsertThread({ id: 't', resourceId: 'u', createdAt: 1, updatedAt: 1 });
    await mem.append('t', [user('aurora is the project name'), final('noted')]);
    for (let i = 0; i < 6; i++) await mem.append('t', [user(`filler ${i}`)]);
    await mem.append('t', [user('book me'), calls('p'), user('are you there?'), final('yes')]);
    const msgs = await mem.getMessages('t', { query: 'tell me about aurora' });
    expect(violations(msgs)).toEqual([]);
  });

  it('query + embed: a window that would open on a tool result is repaired too', async () => {
    const storage = new InMemoryStorage();
    const mem = new AgentMemory({ storage, embed, recentN: 3, recall: { topK: 1, threshold: 0, scope: 'thread' } } as any);
    await storage.memory.upsertThread({ id: 't', resourceId: 'u', createdAt: 1, updatedAt: 1 });
    await mem.append('t', [user('aurora is the project name'), final('noted')]);
    for (let i = 0; i < 4; i++) await mem.append('t', [user(`filler ${i}`)]);
    await mem.append('t', [user('q'), calls('a'), answer('a'), final('r')]);
    const msgs = await mem.getMessages('t', { query: 'aurora?' });
    expect(violations(msgs).filter((x) => /opens on a tool|result without call/.test(x))).toEqual([]);
  });

  it('the two paths agree: with and without a query, the recent part obeys the same rule on the same thread', async () => {
    const storage = new InMemoryStorage();
    const mem = new AgentMemory({ storage, embed, recentN: 4, recall: { topK: 1, threshold: 0, scope: 'thread' } } as any);
    await storage.memory.upsertThread({ id: 't', resourceId: 'u', createdAt: 1, updatedAt: 1 });
    await mem.append('t', [user('aurora is the project name'), final('noted')]);
    for (let i = 0; i < 6; i++) await mem.append('t', [user(`filler ${i}`)]);
    await mem.append('t', [user('book me'), calls('p'), user('are you there?'), final('yes')]);
    const plain = violations(await mem.getMessages('t'));
    const recalled = violations(await mem.getMessages('t', { query: 'aurora' }));
    expect({ plain, recalled }).toEqual({ plain: [], recalled: [] });
  });
});
