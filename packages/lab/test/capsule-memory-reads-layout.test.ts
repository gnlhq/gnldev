// Leaving memory out reads the run's own layout, never its counts: a record written before layouts existed
// is refused with the reason, and a row an input processor put ahead of memory's is not counted as memory's.
import { describe, it, expect, vi, beforeAll } from 'vitest';
import { runDurable, InMemoryJournal, runKeys, readRunMemoryLayout } from '@gnldev/durable';
import { createMockModel, finalTextResult } from '../../durable/test/mock.js';
import { memoryInjected } from '../src/capsule.js';

beforeAll(() => { vi.spyOn(console, 'warn').mockImplementation(() => {}); });
// Diagnostics, printed with GNL_TEST_VERBOSE=1.
const log = (...a: unknown[]) => void (process.env.GNL_TEST_VERBOSE && process.stdout.write(`AUDIT ${a.map((x) => (typeof x === 'string' ? x : JSON.stringify(x))).join(' ')}\n`));
const reply = () => createMockModel(async () => finalTextResult('reply'));
const memory: any = {
  async getMessages() { return []; }, async append() {},
  async loadContext() { return { messages: [{ role: 'user', content: 'old' }, { role: 'assistant', content: 'old answer' }], provenance: { recalled: [], recentCount: 2 } }; },
};

describe('memoryInjected vs layout', () => {
  it('a record WITHOUT layout (old shape): the Lab must refuse, not count', async () => {
    const j = new InMemoryJournal();
    await runDurable({ runId: 'm1', journal: j, memory, threadId: 't', model: reply(), prompt: 'q' } as any);
    const rec: any = await j.get(runKeys.memoryContext('m1'));
    const { layout, systemSpans, ...legacy } = rec;
    await j.put(runKeys.memoryContext('m1'), legacy);
    expect((await readRunMemoryLayout(j, 'm1')).status).toBe('absent');
    let got: unknown;
    try { got = await memoryInjected(j as any, 'm1', 3); } catch (e) { got = 'refused: ' + String(e).slice(0, 80); }
    log('legacy', got);
    expect(String(got)).toMatch(/^refused/);
  });

  it('a processor injected a row AHEAD of memory (foreign [0]): "memory\'s rows" must not include it', async () => {
    const j = new InMemoryJournal();
    const injectAhead = { name: 'jit', processInput: async (i: any) => ({ ...i, messages: [{ role: 'system', content: 'retrieved doc' }, ...i.messages] }) };
    await runDurable({ runId: 'm2', journal: j, memory, threadId: 't2', model: reply(), prompt: 'q', processors: [injectAhead] } as any);
    const rec: any = await j.get(runKeys.memoryContext('m2'));
    const inp: any = await j.get(runKeys.input('m2'));
    const n = await memoryInjected(j as any, 'm2', inp.messages.length);
    log('foreign', { layout: rec.layout, memoryInjected: n });
    expect(n).toBe(2); // memory put 2 rows; the 'retrieved doc' row is the processor's
  });
});
