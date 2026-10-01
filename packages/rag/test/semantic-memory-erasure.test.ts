// Invariant: a SemanticMemory thread goes with its thread — erasing its owner and sweeping it by age
// leave none of its messages in the journal.
//
// Measured before: SemanticMemory keeps its log under `sem:<thread>:log`, and `purgeThread`,
// `sweepThreads` and `eraseSubject` knew only `mem:`/`om:`/`xthr:`. Erasing the owner listed the thread
// in `unreachedThreads` and left every message; the sweep never saw the thread at all. Data written by
// the current code, not only 0.9.0's.
import { describe, it, expect } from 'vitest';
import { InMemoryStorage, InMemoryJournal, createGnl, assignThreadOwner, eraseSubject, sweepThreads, toJournal, semanticLogKey } from '@gnldev/durable';
import { echoModel } from '@gnldev/durable/mock';
import { SemanticMemory } from '../src/index.js';

const embed = async (t: string) => [t.length, 1, 1];

describe('SemanticMemory and the thread lifecycle', () => {
  it("erasing the thread's owner removes its SemanticMemory log, and reports nothing unreached", async () => {
    const storage = new InMemoryStorage();
    const journal = toJournal(storage.runs);
    const sm = new SemanticMemory({ journal, embed });
    await sm.append('t-u1', [{ role: 'user', content: 'U1 secret' }]);
    await sm.append('t-u2', [{ role: 'user', content: 'U2 keeps this' }]);
    await assignThreadOwner(journal, 't-u1', 'u1');
    await assignThreadOwner(journal, 't-u2', 'u2');
    const report = await eraseSubject(storage, 'u1');
    expect(report.unreachedThreads).toEqual([]);
    expect(await journal.get(semanticLogKey('t-u1'))).toBeUndefined();
    expect((await sm.getMessages('t-u2')).map((m) => m.content)).toEqual(['U2 keeps this']);
  });

  it('the retention sweep removes a SemanticMemory log older than the window and keeps a recent one', async () => {
    const journal = toJournal(new InMemoryStorage().runs);
    const sm = new SemanticMemory({ journal, embed });
    const now = Date.UTC(2026, 9, 1);
    await sm.append('old', [{ role: 'user', content: 'old', createdAt: now - 200 * 86_400_000 }]);
    await sm.append('new', [{ role: 'user', content: 'new', createdAt: now - 86_400_000 }]);
    const r = await sweepThreads(journal, { olderThanMs: 90 * 86_400_000, now });
    expect(r.purged).toEqual(['old']);
    expect(await journal.get(semanticLogKey('old'))).toBeUndefined();
    expect((await sm.getMessages('new')).map((m) => m.content)).toEqual(['new']);
  });

  it("a real agent turn's messages (no timestamp of their own) are dated by their append: swept once old, kept while young", async () => {
    // Measured before: the engine stores the AI SDK message as given — no time field — so every agent
    // turn's thread counted as `keptNoTs` and no sweep ever removed one.
    const journal = new InMemoryJournal();
    const sm = new SemanticMemory({ journal, embed });
    const gnl = createGnl({ journal, memory: sm, agents: { a: { model: echoModel() } } } as never);
    await gnl.run('a', { runId: 'r1', prompt: 'hello', threadId: 't1' } as never);
    expect((await sweepThreads(journal, { olderThanMs: 60_000, now: Date.now() })).purged).toEqual([]);
    const r = await sweepThreads(journal, { olderThanMs: 60_000, now: Date.now() + 86_400_000 });
    expect(r).toMatchObject({ purged: ['t1'], keptNoTs: 0 });
    expect(await journal.get(semanticLogKey('t1'))).toBeUndefined();
  });
});
