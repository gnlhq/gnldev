// A `template` describes the shape working memory should take; it never replaces what was saved.
// Measured on main before this: with a template set, the system message carried the template text only,
// so the model never saw the values it had saved (and a readOnly reader saw nothing at all).
import { describe, it, expect } from 'vitest';
import { z } from 'zod';
import { InMemoryStorage, runDurable, workingMemoryScope } from '@gnldev/durable';
import { AgentMemory } from '../src/index.js';

const template = '# User\n- name:\n- city:';

function saveThenAnswer(captureSystem?: (s: string) => void): any {
  return {
    specificationVersion: 'v2', provider: 'mock', modelId: 'm', supportedUrls: {},
    doGenerate: async ({ prompt }: any) => {
      if (captureSystem) {
        captureSystem((prompt ?? []).filter((m: any) => m.role === 'system').map((m: any) => (typeof m.content === 'string' ? m.content : '')).join('\n'));
      }
      const done = (prompt ?? []).filter((m: any) => m.role === 'tool').length;
      const usage = { inputTokens: 1, outputTokens: 1, totalTokens: 2 };
      if (done === 0) return { content: [{ type: 'tool-call', toolCallId: 'wm1', toolName: 'updateWorkingMemory', input: JSON.stringify({ memory: { name: 'Ada', city: 'Izmir' } }) }], finishReason: 'tool-calls', usage, warnings: [] };
      return { content: [{ type: 'text', text: 'ok' }], finishReason: 'stop', usage, warnings: [] };
    },
    doStream: async () => { throw new Error('no'); },
  };
}

describe('working memory with a template shows what was saved', () => {
  it('a value saved through the tool is in the next turn\'s system message', async () => {
    const storage = new InMemoryStorage();
    const mem = new AgentMemory({ storage, workingMemory: { template } });
    await runDurable({ runId: 'r1', journal: storage.runs, model: saveThenAnswer(), memory: mem, threadId: 'th', prompt: 'save' });
    expect(await storage.memory.getWorkingMemory(workingMemoryScope.thread('th'))).toEqual({ name: 'Ada', city: 'Izmir' });

    let seen = '';
    await runDurable({ runId: 'r2', journal: storage.runs, model: saveThenAnswer((s) => (seen = s)), memory: mem, threadId: 'th', prompt: 'again' });
    expect(seen).toContain('Ada');
    expect(seen).toContain('Izmir');
  });

  it('readOnly with a template: the reader sees the saved values', async () => {
    const storage = new InMemoryStorage();
    const mem = new AgentMemory({ storage, workingMemory: { template, readOnly: true } });
    await mem.applyWorkingMemoryUpdate('th', { name: 'Eve' });
    expect((await mem.loadContext('th', {})).system).toContain('Eve');
  });

  it('resource scope with a template: another thread of the person sees the values', async () => {
    const storage = new InMemoryStorage();
    const mem = new AgentMemory({ storage, workingMemory: { template, scope: 'resource' } });
    await mem.applyWorkingMemoryUpdate('th-1', { city: 'Izmir' }, 'alice');
    expect((await mem.loadContext('th-2', { resourceId: 'alice' })).system).toContain('Izmir');
  });

  it('template and schema together: values and field list are both there', async () => {
    const storage = new InMemoryStorage();
    const schema = z.object({ name: z.string().optional() });
    const mem = new AgentMemory({ storage, workingMemory: { template, schema } });
    await mem.applyWorkingMemoryUpdate('th', { name: 'Ada' });
    const system = (await mem.loadContext('th', {})).system ?? '';
    expect(system).toContain('Ada');
    expect(system).toContain('Fields: name');
  });

  it('the template stays as the shape to follow — empty memory and filled memory alike', async () => {
    const storage = new InMemoryStorage();
    const mem = new AgentMemory({ storage, workingMemory: { template } });
    expect((await mem.loadContext('th', {})).system).toContain(template);
    await mem.applyWorkingMemoryUpdate('th', { name: 'Ada' });
    expect((await mem.loadContext('th', {})).system).toContain(template);
  });
});
