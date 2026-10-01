// FLOW-10: AgentMemory.truncateMessagesAfter — index→seq conversion on top of the (optional)
// MemoryStore.deleteMessagesAfter port method (see storage.ts's JSDoc for the port contract).
import { describe, it, expect } from 'vitest';
import { InMemoryStorage } from '@gnldev/durable';
import { AgentMemory } from '../src/index.js';

const u = (content: string) => ({ role: 'user', content });

describe('FLOW-10 AgentMemory.truncateMessagesAfter', () => {
  it('afterIndex=1 on a 5-message thread: removes 3, keeps the first 2, getMessages reflects it', async () => {
    const mem = new AgentMemory({ storage: new InMemoryStorage() });
    await mem.append('t', [u('m0'), u('m1'), u('m2'), u('m3'), u('m4')]);

    const removed = await mem.truncateMessagesAfter('t', 1);
    expect(removed).toBe(3);

    const left = await mem.getMessages('t');
    expect(left).toEqual([u('m0'), u('m1')]);
  });

  it('afterIndex=-1: clears the entire thread history', async () => {
    const mem = new AgentMemory({ storage: new InMemoryStorage() });
    await mem.append('t', [u('m0'), u('m1'), u('m2')]);

    const removed = await mem.truncateMessagesAfter('t', -1);
    expect(removed).toBe(3);
    expect(await mem.getMessages('t')).toEqual([]);
  });

  it('afterIndex out of range (>= displayed length) is a no-op: returns 0, nothing removed', async () => {
    const mem = new AgentMemory({ storage: new InMemoryStorage() });
    await mem.append('t', [u('m0'), u('m1')]);

    expect(await mem.truncateMessagesAfter('t', 5)).toBe(0);
    expect(await mem.getMessages('t')).toEqual([u('m0'), u('m1')]);
  });

  it('afterIndex < -1 is a no-op: returns 0, nothing removed', async () => {
    const mem = new AgentMemory({ storage: new InMemoryStorage() });
    await mem.append('t', [u('m0'), u('m1')]);

    expect(await mem.truncateMessagesAfter('t', -2)).toBe(0);
    expect(await mem.getMessages('t')).toEqual([u('m0'), u('m1')]);
  });

  it('index base matches getMessages(threadId) (no opts) exactly, including the recentN window', async () => {
    // recentN=2 → getMessages(threadId) with no opts returns only the LAST 2 messages (see agent-memory.ts).
    // afterIndex must be relative to THAT windowed list, not the full underlying history.
    const mem = new AgentMemory({ storage: new InMemoryStorage(), recentN: 2 });
    await mem.append('t', [u('m0'), u('m1'), u('m2'), u('m3')]);
    expect(await mem.getMessages('t')).toEqual([u('m2'), u('m3')]); // the windowed list Studio would show

    // afterIndex=0 → keep displayed[0] ('m2', real seq 2), drop everything after it (only 'm3', seq 3).
    // 3 messages remain (m0, m1, m2); with recentN=2, getMessages(threadId) again returns only the last 2.
    const removed = await mem.truncateMessagesAfter('t', 0);
    expect(removed).toBe(1);
    expect(await mem.getMessages('t')).toEqual([u('m1'), u('m2')]);
  });

  it('capability gap: a store without deleteMessagesAfter returns null (distinct from 0)', async () => {
    const storage = new InMemoryStorage();
    // Strip the capability post-construction to simulate an adapter that never implemented it.
    (storage.memory as any).deleteMessagesAfter = undefined;
    const mem = new AgentMemory({ storage });
    await mem.append('t', [u('m0'), u('m1')]);

    const result = await mem.truncateMessagesAfter('t', 0);
    expect(result).toBeNull();
    expect(await mem.getMessages('t')).toEqual([u('m0'), u('m1')]); // untouched
  });
});

// Observational memory after a truncation. The cursor used to stay past the cut; the store hands the
// next messages the freed positions, so the next turn sat BELOW the cursor and never reached the model.
describe('truncateMessagesAfter brings observational memory back in line', () => {
  const om = { enabled: true, observerModel: {} };
  const ctxTexts = async (mem: AgentMemory) =>
    ((await mem.loadContext('t', {})).messages ?? []).map((m: any) => (typeof m.content === 'string' ? m.content : ''));

  it('a turn written after the cut reaches the context, and a summary of deleted messages does not', async () => {
    const storage = new InMemoryStorage();
    const mem = new AgentMemory({ storage, observationalMemory: om });
    await mem.append('t', [u('m0'), u('m1'), u('m2'), u('m3')]);
    await storage.runs.put('om:t:observedSeq', 3);
    await storage.memory!.putObservations('t', [{ id: 'o1', text: 'SUMMARY-0-3', createdAt: 0, sourceIds: [], level: 0, fromSeq: 0, toSeq: 3 } as any]);

    expect(await mem.truncateMessagesAfter('t', 0)).toBe(3);
    await mem.append('t', [u('NEW')]);

    const texts = await ctxTexts(mem);
    expect(texts).toContain('NEW');
    expect(texts).toContain('m0'); // covered by the dropped observation, so shown raw again
    expect(texts.join('\n')).not.toContain('SUMMARY-0-3');
  });

  it('an observation wholly before the cut is kept, and so is the cursor', async () => {
    const storage = new InMemoryStorage();
    const mem = new AgentMemory({ storage, observationalMemory: om });
    await mem.append('t', [u('m0'), u('m1'), u('m2'), u('m3')]);
    await storage.runs.put('om:t:observedSeq', 1);
    await storage.memory!.putObservations('t', [{ id: 'o1', text: 'SUMMARY-0-1', createdAt: 0, sourceIds: [], level: 0, fromSeq: 0, toSeq: 1 } as any]);

    await mem.truncateMessagesAfter('t', 2); // displayed = all 4 (recentN 6) → cut at seq 2
    expect(await storage.runs.get('om:t:observedSeq')).toBe(1);
    const texts = await ctxTexts(mem);
    expect(texts[0]).toContain('SUMMARY-0-1');
    expect(texts.slice(1)).toEqual(['m2']);
  });

  it('a dropped reflection gives back the observations it condensed that survive the cut', async () => {
    const storage = new InMemoryStorage();
    const mem = new AgentMemory({ storage, observationalMemory: om });
    await mem.append('t', [u('m0'), u('m1'), u('m2'), u('m3')]);
    await storage.runs.put('om:t:observedSeq', 3);
    await storage.memory!.putObservations('t', [
      { id: 'a', text: 'A-0-1', createdAt: 0, sourceIds: [], level: 0, fromSeq: 0, toSeq: 1, condensed: true },
      { id: 'b', text: 'B-2-3', createdAt: 0, sourceIds: [], level: 0, fromSeq: 2, toSeq: 3, condensed: true },
      { id: 'r', text: 'R-0-3', createdAt: 0, sourceIds: ['a', 'b'], level: 1, fromSeq: 0, toSeq: 3 },
    ] as any);

    await mem.truncateMessagesAfter('t', 1); // cut at seq 1: b and r go, a comes back
    const texts = (await ctxTexts(mem)).join('\n');
    expect(texts).toContain('A-0-1');
    expect(texts).not.toContain('B-2-3');
    expect(texts).not.toContain('R-0-3');
    expect(await storage.runs.get('om:t:observedSeq')).toBe(1);
  });
});
