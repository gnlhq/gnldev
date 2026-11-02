// The crash window between `:input` and `:memctx`: the attempt that froze the input died before the
// provenance record landed, and the run is entered again. Does the thread get the turn's question?
import { describe, it, expect, vi, beforeAll } from 'vitest';
import { InMemoryJournal, runKeys } from '../src/journal.js';
import { BasicMemory } from '../src/memory.js';
import { runDurable, resumeRun } from '../src/run.js';
import { createMockModel, finalTextResult } from './mock.js';

beforeAll(() => { vi.spyOn(console, 'warn').mockImplementation(() => {}); });
const reply = () => createMockModel(async () => finalTextResult('reply'));
const text = (m: any) => (typeof m?.content === 'string' ? m.content : (m?.content ?? []).map((p: any) => p.text ?? '').join(''));
const upper = { name: 'upper', processInput: async (i: any) => ({ ...i, messages: i.messages.map((m: any) => (typeof m.content === 'string' ? { ...m, content: m.content.toUpperCase() } : m)) }) };

/** A journal whose first write of `runId`'s `:memctx` throws — the process "dies" right after `:input`. */
function crashingAt(j: InMemoryJournal, runId: string): InMemoryJournal {
  let armed = true;
  return new Proxy(j, { get(t, p) {
    if (p === 'put') return async (k: string, v: unknown) => { if (armed && k === runKeys.memoryContext(runId)) { armed = false; throw new Error('SIGKILL'); } return t.put(k, v); };
    const v = Reflect.get(t, p); return typeof v === 'function' ? v.bind(t) : v;
  } }) as InMemoryJournal;
}

describe('crash window between :input and :memctx', () => {
  for (const [label, processors] of [['no processors', undefined], ['an input processor', [upper]]] as const) {
    for (const reentry of ['runDurable (caller retries)', 'resumeRun'] as const) {
      it(`${label}, ${reentry}: the thread keeps the question`, async () => {
        const j = new InMemoryJournal();
        const memory = new BasicMemory(j);
        await runDurable({ runId: 'c0', journal: j, memory, threadId: 't', model: reply(), prompt: 'first' } as any);
        const args = { journal: j, memory, threadId: 't', model: reply(), prompt: 'second', ...(processors ? { processors } : {}) } as any;
        await expect(runDurable({ ...args, runId: 'c1', journal: crashingAt(j, 'c1') })).rejects.toThrow('SIGKILL');
        expect(await j.get(runKeys.input('c1'))).toBeDefined();
        if (reentry === 'resumeRun') await resumeRun('c1', { journal: j, memory, model: reply(), ...(processors ? { processors } : {}) } as any);
        else await runDurable({ ...args, runId: 'c1' });
        const thread = (await memory.getMessages('t')).map(text);
        const rec: any = await j.get(runKeys.memoryContext('c1'));
        // eslint-disable-next-line no-console
        console.log('CRASH', label, '|', reentry, JSON.stringify({ thread, incomingUnrecoverable: rec?.incomingUnrecoverable, layout: rec?.layout?.status }));
        expect(thread.filter((t) => /second/i.test(t))).toHaveLength(1);
        expect(thread.filter((t) => t === 'reply')).toHaveLength(2);
      });
    }
  }
});
