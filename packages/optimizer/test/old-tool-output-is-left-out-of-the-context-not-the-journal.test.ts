// An old tool output is left out of what the model is sent — and kept in the journal.
import { describe, it, expect } from 'vitest';
import { tool } from 'ai';
import { z } from 'zod';
import { runDurable, gnlTool, InMemoryJournal, reconstructState } from '@gnldev/durable';
import { createMockModel } from '../../durable/test/mock.js';
import { maskMessages, maskOldToolOutputs, replayCounterfactual } from '../src/index.js';

const BIG = 'x'.repeat(4000);
const result = (id: string, toolName: string, value: unknown) => ({ role: 'tool', content: [{ type: 'tool-result', toolCallId: id, toolName, output: { type: 'json', value } }] });
const call = (id: string, toolName: string) => ({ role: 'assistant', content: [{ type: 'tool-call', toolCallId: id, toolName, input: {} }] });

describe('old tool output is left out of the context, not the journal', () => {
  it('a result produced more than keepLast steps before the asked step is replaced by a note; the call and the result part stay', () => {
    const msgs = [{ role: 'user', content: 'go' }, call('a', 'lookup'), result('a', 'lookup', BIG), call('b', 'search'), result('b', 'search', BIG), call('c', 'tiny'), result('c', 'tiny', 'ok')];
    // Asking for step 3: lookup is 3 steps back (left out), search 2 (kept), tiny 1 (kept, and short anyway).
    const out = maskMessages(msgs as any, { keepLast: 2 })!;
    expect(out).toHaveLength(msgs.length);
    expect((out[2] as any).content[0]).toMatchObject({ type: 'tool-result', toolCallId: 'a', output: { type: 'text' } });
    expect((out[2] as any).content[0].output.value).toMatch(/^\[lookup output from 3 steps ago, \d+ characters, left out/);
    expect(out[4]).toBe(msgs[4]);
    expect(out[6]).toBe(msgs[6]);
    expect((msgs[2] as any).content[0].output.value).toBe(BIG); // not mutated
  });

  it('nothing old enough: no change is proposed', () => {
    expect(maskMessages([{ role: 'user', content: 'go' }, call('a', 'lookup'), result('a', 'lookup', BIG)] as any, { keepLast: 2 })).toBeUndefined();
  });

  it('in a real run as a processor: the model is sent the note, the journal keeps the full output, each tool ran once', async () => {
    const journal = new InMemoryJournal();
    const ran = { lookup: 0, refund: 0 };
    const seen: string[] = [];
    let step = 0;
    const model = createMockModel(async (o: any) => {
      seen.push(JSON.stringify(o.prompt));
      step++;
      if (step === 1) return { content: [{ type: 'tool-call', toolCallId: 'l1', toolName: 'lookup', input: '{"id":"a"}' }], finishReason: 'tool-calls', usage: { inputTokens: 10, outputTokens: 1 } };
      if (step === 2) return { content: [{ type: 'tool-call', toolCallId: 'r1', toolName: 'refund', input: '{"id":"a"}' }], finishReason: 'tool-calls', usage: { inputTokens: 10, outputTokens: 1 } };
      return { content: [{ type: 'text', text: 'done' }], finishReason: 'stop', usage: { inputTokens: 10, outputTokens: 1 } };
    });
    const tools = {
      lookup: gnlTool(tool({ description: 'Look up', inputSchema: z.object({ id: z.string() }), execute: async () => { ran.lookup++; return BIG; } }), { sideEffect: false }),
      refund: gnlTool(tool({ description: 'Refund', inputSchema: z.object({ id: z.string() }), execute: async () => { ran.refund++; return 'ok'; } }), { sideEffect: true }),
    };
    await runDurable({ runId: 'm1', journal, prompt: 'refund a', model, tools, processors: [maskOldToolOutputs({ keepLast: 1 })] } as any);
    expect(ran).toEqual({ lookup: 1, refund: 1 });
    expect(seen[1]).toContain(BIG);                       // step 2: the lookup is 1 step back — kept
    expect(seen[2]).not.toContain(BIG);                   // step 3: 2 steps back — left out
    expect(seen[2]).toMatch(/lookup output from 2 steps ago/);
    const { messages } = reconstructState(await journal.readRun('m1'), undefined, { prompt: 'refund a' });
    expect(JSON.stringify(messages)).toContain(BIG);      // the journal keeps what the tool returned
  });

  it('tried in a replay: the candidate is sent the note, nothing is executed', async () => {
    const journal = new InMemoryJournal();
    let step = 0;
    const script = (o: any, seen?: string[]) => {
      seen?.push(JSON.stringify(o.prompt));
      step++;
      if (step % 3 === 1) return { content: [{ type: 'tool-call', toolCallId: `l${step}`, toolName: 'lookup', input: '{"id":"a"}' }], finishReason: 'tool-calls', usage: { inputTokens: 10, outputTokens: 1 } };
      if (step % 3 === 2) return { content: [{ type: 'tool-call', toolCallId: `r${step}`, toolName: 'refund', input: '{"id":"a"}' }], finishReason: 'tool-calls', usage: { inputTokens: 10, outputTokens: 1 } };
      return { content: [{ type: 'text', text: 'done' }], finishReason: 'stop', usage: { inputTokens: 10, outputTokens: 1 } };
    };
    const lookup = tool({ description: 'Look up', inputSchema: z.object({ id: z.string() }), execute: async () => BIG });
    const refund = tool({ description: 'Refund', inputSchema: z.object({ id: z.string() }), execute: async () => 'ok' });
    await runDurable({ runId: 'm2', journal, prompt: 'refund a', model: createMockModel(async (o: any) => script(o)), tools: { lookup: gnlTool(lookup, { sideEffect: false }), refund: gnlTool(refund, { sideEffect: true }) } } as any);
    const seen: string[] = [];
    const trap = { lookup: { ...lookup, execute: async () => { throw new Error('ran'); } }, refund: { ...refund, execute: async () => { throw new Error('ran'); } } };
    const r = await replayCounterfactual({
      journal, runId: 'm2', tools: trap as any, model: createMockModel(async (o: any) => script(o, seen)),
      prepareStep: maskOldToolOutputs({ keepLast: 1 }).prepareStep as any,
    });
    expect(r.divergence).toBeUndefined();
    expect(seen[2]).not.toContain(BIG);
    expect(seen[2]).toMatch(/lookup output from 2 steps ago/);
  });

  it('a misspelled option is refused', () => {
    expect(() => maskOldToolOutputs({ keeplast: 1 } as any)).toThrow(/keeplast/);
  });
});
