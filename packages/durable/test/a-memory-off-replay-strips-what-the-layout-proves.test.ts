// A memory-off replay (`replayRun({ stripMemoryContext })`) leaves out what the run's own layout proves
// memory put in — the history rows AND the working memory in the system text — keeps a row an input
// processor added, and refuses, with the reason, a run whose layout does not prove it. Never from counts.
import { describe, it, expect, vi, beforeAll } from 'vitest';
import { runDurable, replayRun, InMemoryJournal, runKeys, memoryRowsOf, readRunMemoryLayout, cutWorkingMemory } from '../src/index.js';
import { createMockModel, finalTextResult } from './mock.js';

beforeAll(() => { vi.spyOn(console, 'warn').mockImplementation(() => {}); });

const memory = (system?: string): any => ({
  async getMessages() { return []; }, async append() {},
  async loadContext() {
    return { messages: [{ role: 'user', content: 'old question' }, { role: 'assistant', content: 'old answer' }], provenance: { recalled: [], recentCount: 2 }, ...(system ? { system } : {}) };
  },
});
function probe() {
  const seen: any[] = [];
  const model = createMockModel(async (o: any) => { seen.push(o.prompt); return finalTextResult('ok'); });
  return { model, seen };
}
const text = (prompt: any[]) => JSON.stringify(prompt);

describe('a memory-off replay strips what the layout proves', () => {
  it('the recent window and the working memory go; the caller\'s system and the turn stay', async () => {
    const journal = new InMemoryJournal();
    await runDurable({ runId: 'src1', journal, memory: memory('# Working Memory\nname: Ayse'), threadId: 't', system: 'Be brief.', prompt: 'new question', model: createMockModel(async () => finalTextResult('a')) } as any);
    const { model, seen } = probe();
    await replayRun({ journal, runId: 'src1', model, stripMemoryContext: true });
    expect(text(seen[0])).toContain('new question');
    expect(text(seen[0])).toContain('Be brief.');
    expect(text(seen[0])).not.toContain('old question');
    expect(text(seen[0])).not.toContain('Working Memory');
  });

  it('a row an input processor put in is not memory\'s: it stays', async () => {
    const journal = new InMemoryJournal();
    const inject = { name: 'note', processInput: async (i: any) => ({ ...i, messages: [{ role: 'user', content: 'processor note' }, ...i.messages] }) };
    await runDurable({ runId: 'src2', journal, memory: memory(), threadId: 't2', prompt: 'new question', processors: [inject], model: createMockModel(async () => finalTextResult('a')) } as any);
    const rows = memoryRowsOf(await readRunMemoryLayout(journal, 'src2'));
    expect(rows).toMatchObject({ known: true, positions: [1, 2], foreign: [0] });
    const { model, seen } = probe();
    await replayRun({ journal, runId: 'src2', model, stripMemoryContext: true });
    expect(text(seen[0])).toContain('processor note');
    expect(text(seen[0])).not.toContain('old answer');
  });

  it('refused with the reason where the layout does not prove it: none recorded, or a working memory with no known place', async () => {
    const journal = new InMemoryJournal();
    await runDurable({ runId: 'src3', journal, memory: memory('# Working Memory\nname: Ayse'), threadId: 't3', prompt: 'q', model: createMockModel(async () => finalTextResult('a')) } as any);
    const rec: any = await journal.get(runKeys.memoryContext('src3'));
    const { model } = probe();
    await journal.put(runKeys.memoryContext('src3'), { ...rec, systemSpans: { workingMemory: { chars: 10, status: 'lost' } } });
    await expect(replayRun({ journal, runId: 'src3', model, stripMemoryContext: true })).rejects.toThrow(/working memory's place in the system text is not known \('lost'\)/);
    const { layout: _l, systemSpans: _s, ...legacy } = rec;
    await journal.put(runKeys.memoryContext('src3'), legacy);
    await expect(replayRun({ journal, runId: 'src3', model, stripMemoryContext: true })).rejects.toThrow(/no memory layout/);
  });

  it('cutting the working memory takes the blank line that joined it', () => {
    expect(cutWorkingMemory('A\n\nWM', [3, 5])).toBe('A');
    expect(cutWorkingMemory('WM\n\nB', [0, 2])).toBe('B');
    expect(cutWorkingMemory('A\n\nWM\n\nB', [3, 5])).toBe('A\n\nB');
    expect(cutWorkingMemory('WM', [0, 2])).toBe('');
  });
});
