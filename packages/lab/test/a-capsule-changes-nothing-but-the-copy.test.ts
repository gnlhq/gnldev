// A recorded run copied into a capsule and played again with a change. The run, its journal and its tools
// are only read; a call the recording never made is listed for someone to answer, and answered it goes on.
import { describe, it, expect } from 'vitest';
import { tool } from 'ai';
import { z } from 'zod';
import { runDurable, gnlTool, InMemoryJournal, runKeys } from '@gnldev/durable';
import { createMockModel } from '../../durable/test/mock.js';
import { runCapsule } from '../src/index.js';

const usage = { inputTokens: 100, outputTokens: 10 };

/** Replaces when the prompt says nothing; refunds when the system prompt says "refund". */
function agentModel(seen: { users: number[] } = { users: [] }) {
  const m = createMockModel(async (o: any) => {
    const system = String(o.prompt.find((p: any) => p.role === 'system')?.content ?? '');
    const done = o.prompt.filter((p: any) => p.role === 'tool').length;
    seen.users.push(o.prompt.filter((p: any) => p.role === 'user').length);
    const plan = [{ toolName: 'findOrder', args: { orderId: '42' } }, system.includes('refund') ? { toolName: 'refund', args: { orderId: '42' } } : { toolName: 'replace', args: { orderId: '42' } }];
    const response = { modelId: 'm' };
    if (done < plan.length) return { content: [{ type: 'tool-call', toolCallId: `c${done}`, toolName: plan[done]!.toolName, input: JSON.stringify(plan[done]!.args) }], finishReason: 'tool-calls', usage, response };
    const last = o.prompt.at(-1).content[0].output;
    return { content: [{ type: 'text', text: `Done: ${JSON.stringify(last.value ?? last)}` }], finishReason: 'stop', usage, response };
  });
  m.modelId = 'm';
  return m;
}

async function recorded() {
  const journal = new InMemoryJournal();
  const ran: string[] = [];
  const def = (name: string, out: unknown) => tool({ description: name, inputSchema: z.object({ orderId: z.string() }), execute: async () => { ran.push(name); return out; } });
  const real = { findOrder: def('findOrder', { status: 'delivered' }), replace: def('replace', { ok: true }), refund: def('refund', { refunded: true }) };
  await runDurable({
    runId: 'r1', journal, model: agentModel(), system: 'Help with orders.',
    messages: [{ role: 'user', content: 'Hi, I ordered a lamp.' }, { role: 'assistant', content: 'How can I help?' }, { role: 'user', content: 'My lamp came broken.' }],
    tools: { findOrder: gnlTool(real.findOrder, { sideEffect: false }), replace: gnlTool(real.replace, { sideEffect: true }), refund: gnlTool(real.refund, { sideEffect: true }) },
  } as any);
  const trap = Object.fromEntries(Object.entries(real).map(([k, v]) => [k, { ...v, execute: async () => { throw new Error(`the capsule ran ${k}`); } }]));
  return { journal, ran, trap };
}

describe('a capsule changes nothing but the copy', () => {
  it('unchanged, every trial makes the recorded calls again', async () => {
    const { journal, trap } = await recorded();
    const r = await runCapsule({ journal, runId: 'r1', model: agentModel(), tools: trap as any, trials: 2 });
    expect(r.recorded.calls).toEqual([{ toolName: 'findOrder', args: { orderId: '42' } }, { toolName: 'replace', args: { orderId: '42' } }]);
    expect(r.sameAsRecorded.value).toBe(1);
    expect(r.paths).toHaveLength(1);
    expect(r.pending).toEqual([]);
  });

  it('a changed prompt asks for a call the run never made: listed to answer; answered, it goes on — and nothing ran or was written', async () => {
    const { journal, ran, trap } = await recorded();
    const keys = (await journal.listKeys('')).sort();
    const before = JSON.stringify(await Promise.all(keys.map((k) => journal.get(k))));
    const system = 'Help with orders. If it came broken, refund it.';
    const stopped = await runCapsule({ journal, runId: 'r1', model: agentModel(), tools: trap as any, system, trials: 2 });
    expect(stopped.sameAsRecorded.value).toBe(0);
    expect(stopped.pending).toEqual([{ toolName: 'refund', args: { orderId: '42' } }]);
    expect(stopped.paths[0]!.calls.map((c) => `${c.toolName}:${c.source}`)).toEqual(['findOrder:recorded', 'refund:none']);
    const answered = await runCapsule({ journal, runId: 'r1', model: agentModel(), tools: trap as any, system, trials: 2, answers: [{ toolName: 'refund', args: { orderId: '42' }, output: { refunded: 250 } }] });
    expect(answered.pending).toEqual([]);
    expect(answered.paths[0]!.calls.map((c) => c.source)).toEqual(['recorded', 'answer']);
    expect(answered.paths[0]!.text).toBe('Done: {"refunded":250}');
    expect(answered.paths[0]!.sameAsRecorded).toBe(false);
    expect(ran).toEqual(['findOrder', 'replace']); // only the recording's own run
    expect((await journal.listKeys('')).sort()).toEqual(keys);
    expect(JSON.stringify(await Promise.all(keys.map((k) => journal.get(k))))).toBe(before);
  });

  it('history off: the model sees the last message alone', async () => {
    const { journal, trap } = await recorded();
    const on = { users: [] as number[] }, off = { users: [] as number[] };
    await runCapsule({ journal, runId: 'r1', model: agentModel(on), tools: trap as any, trials: 1 });
    await runCapsule({ journal, runId: 'r1', model: agentModel(off), tools: trap as any, trials: 1, history: false });
    expect(Math.max(...on.users)).toBe(2);
    expect(Math.max(...off.users)).toBe(1);
  });

  it('memory off: exactly what the run\'s layout proves memory put in is left out — the working memory too', async () => {
    const journal = new InMemoryJournal();
    const memory: any = {
      async getMessages() { return []; }, async append() {},
      async loadContext() {
        return {
          messages: [{ role: 'user', content: 'Hi, I ordered a lamp.' }, { role: 'assistant', content: 'How can I help?' }],
          provenance: { recalled: [], recentCount: 2 }, system: '# Working Memory\nprefers refunds',
        };
      },
    };
    const def = (name: string) => tool({ description: name, inputSchema: z.object({ orderId: z.string() }), execute: async () => ({ ok: name }) });
    const tools = { findOrder: gnlTool(def('findOrder'), { sideEffect: false }), replace: gnlTool(def('replace'), { sideEffect: true }), refund: gnlTool(def('refund'), { sideEffect: true }) };
    await runDurable({ runId: 'remembering', journal, memory, threadId: 't', model: agentModel(), system: 'Help with orders.', prompt: 'My lamp came broken.', tools } as any);
    const { trap } = await recorded();
    const seen = { users: [] as number[] };
    // with memory the working memory says "refund", so the run refunds; without it, it replaces
    const on = await runCapsule({ journal, runId: 'remembering', model: agentModel(), tools: trap as any, trials: 1 });
    expect(on.paths[0]!.calls.map((c) => `${c.toolName}:${c.source}`)).toEqual(['findOrder:recorded', 'refund:recorded']);
    const off = await runCapsule({ journal, runId: 'remembering', model: agentModel(seen), tools: trap as any, trials: 1, memory: false, answers: [{ toolName: 'replace', args: { orderId: '42' }, output: { ok: true } }] });
    expect(Math.max(...seen.users)).toBe(1);
    expect(off.paths[0]!.calls.map((c) => c.toolName)).toEqual(['findOrder', 'replace']);
    expect(off.notes).toEqual([]);
  });

  it('memory off is refused, with the reason, where no layout proves what memory put in — never counted', async () => {
    const { journal, trap } = await recorded();
    // a run with no memory record at all
    await expect(runCapsule({ journal, runId: 'r1', model: agentModel(), tools: trap as any, trials: 1, memory: false })).rejects.toThrow(/no memory record/);
    // a record of the shape written before layouts existed: its counts are not used to guess positions
    await journal.put(runKeys.memoryContext('r1'), { v: 1, threadId: 't', recalled: [], recentCount: 2, incomingCount: 1, echoTrimmed: 0 });
    await expect(runCapsule({ journal, runId: 'r1', model: agentModel(), tools: trap as any, trials: 1, memory: false })).rejects.toThrow(/cannot be diagnosed .* no memory layout/);
    // a layout of a version this release does not read
    await journal.put(runKeys.memoryContext('r1'), { v: 1, threadId: 't', recalled: [], recentCount: 2, incomingCount: 1, echoTrimmed: 0, layout: { v: 2 } });
    await expect(runCapsule({ journal, runId: 'r1', model: agentModel(), tools: trap as any, trials: 1, memory: false })).rejects.toThrow(/version this release does not read/);
  });
});
