// A cut model stream is no answer: nothing complete is recorded for it, and the same runId calls the
// model again.
//
// The AI SDK does not report a cut as a failure. A provider's body that closes early reaches the caller as
// a finished step (`finishReason: 'other'`, 200, half a text), and the recorder wrote it as the step's
// complete answer: the claim said `succeeded`, and every re-drive of the run replayed the half answer.
//
// The shapes below are what real adapters send when the body closes, measured over a local server with
// real SSE (@ai-sdk/openai 4.0.46 and 4.0.109, @ai-sdk/anthropic 4.0.71 and 4.0.97,
// @ai-sdk/openai-compatible 3.0.62, @ai-sdk/openai 2.0.140). No provider package is needed to replay them.
import { describe, it, expect, vi, beforeAll } from 'vitest';
import { tool, wrapLanguageModel, jsonSchema } from 'ai';
import { streamDurable, InMemoryStorage, RunUnfinishedError, runKeys } from '../src/index.js';

beforeAll(() => { vi.spyOn(console, 'warn').mockImplementation(() => {}); });

const usage = { inputTokens: { total: 5, noCache: 5, cacheRead: 0, cacheWrite: 0 }, outputTokens: { total: 7, text: 7, reasoning: 0 } };
const noUsage = { inputTokens: { total: undefined }, outputTokens: { total: undefined } };
const text = (t: string) => [{ type: 'stream-start', warnings: [] }, { type: 'text-start', id: 't' }, { type: 'text-delta', id: 't', delta: t }, { type: 'text-end', id: 't' }];
const finish = (unified: string, raw: string | undefined, u: unknown = usage) => ({ type: 'finish', finishReason: { unified, raw }, usage: u });
const whole = [...text('whole answer'), finish('stop', 'stop')];
const toolCall = (toolCallId: string) => ({ type: 'tool-call', toolCallId, toolName: 'charge', input: '{"amount":5}' });

const streamOf = (parts: unknown[], failure?: unknown) => new ReadableStream({
  start(c) { for (const p of parts) c.enqueue(p); if (failure !== undefined) c.error(failure); else c.close(); },
});

/** A model that answers each call with the next script, and says how many times it was called. */
function scripted(scripts: Array<{ parts: unknown[]; failure?: unknown }>, specificationVersion = 'v4') {
  const model = {
    specificationVersion, provider: 'scripted', modelId: 'm', supportedUrls: {}, calls: 0,
    doGenerate: async () => { throw new Error('stream only'); },
    doStream: async () => {
      const s = scripts[Math.min(model.calls++, scripts.length - 1)]!;
      return { stream: streamOf(s.parts, s.failure) };
    },
  };
  return model;
}

async function drive(args: Record<string, unknown>) {
  const res: any = await streamDurable(args as any);
  const errors: any[] = [];
  let out = '';
  try {
    for await (const part of res.fullStream) {
      if (part.type === 'error') errors.push(part.error);
      if (part.type === 'text-delta') out += part.text ?? part.delta ?? '';
    }
  } catch (e) { errors.push(e); } // a failed model stream fails the reader's, as `AttemptLost` does
  return { errors, text: out };
}

const claimOf = (journal: any, runId: string) => journal.get(runKeys.proc(runId, '__gnl_model_claim:0'));

describe('a cut stream ends run_unfinished, and the same runId answers', () => {
  const cuts: Array<[string, unknown[]]> = [
    ['no finish part (Anthropic)', text('half an ans')],
    ["the adapter's default finish (OpenAI)", [...text('half an ans'), finish('other', undefined, noUsage)]],
    ['the SDK\'s own word for it (newer adapters): interrupted, usage or not', [...text('half an ans'), finish('interrupted', undefined)]],
  ];

  it.each(cuts)('%s', async (_name, parts) => {
    const journal = new InMemoryStorage().runs;
    const model = scripted([{ parts }, { parts: whole }]);
    const runId = 'cut';

    const first = await drive({ runId, journal, model, prompt: 'hi' });
    expect(first.errors[0]).toBeInstanceOf(RunUnfinishedError);
    expect(first.errors[0].code).toBe('run_unfinished');
    expect(await journal.get(runKeys.model(runId, 0)), 'half an answer is not the step').toBeUndefined();
    expect((await claimOf(journal, runId))?.status).toBe('failed');

    const second = await drive({ runId, journal, model, prompt: 'hi' });
    expect(second.errors).toEqual([]);
    expect(second.text).toBe('whole answer');
    expect(model.calls).toBe(2);
  });

  it('a stream that breaks, a socket reset, is the same cut — and its claim does not stay running', async () => {
    const journal = new InMemoryStorage().runs;
    const reset = new TypeError('terminated');
    const model = scripted([{ parts: text('half'), failure: reset }, { parts: whole }]);
    const first = await drive({ runId: 'reset', journal, model, prompt: 'hi', exclusiveModelStep: {} });
    expect(first.errors[0]).toBeInstanceOf(RunUnfinishedError);
    expect(first.errors[0].cause).toBe(reset);
    expect((await claimOf(journal, 'reset'))?.status).toBe('failed');
    const second = await drive({ runId: 'reset', journal, model, prompt: 'hi', exclusiveModelStep: {} });
    expect(second.text).toBe('whole answer');
  });

  it('a failure with a name keeps it: a 429 mid-stream is a 429, an adapter wrapping the broken body is a cut', async () => {
    const limited = Object.assign(new Error('Too Many Requests'), { name: 'AI_APICallError', statusCode: 429 });
    const a = await drive({ runId: 'r429', journal: new InMemoryStorage().runs, model: scripted([{ parts: text('half'), failure: limited }]), prompt: 'hi' });
    expect(a.errors[0]).toBe(limited);
    const wrapped = Object.assign(new Error('Failed to process successful response'), { name: 'AI_APICallError', statusCode: 200 });
    const b = await drive({ runId: 'r200', journal: new InMemoryStorage().runs, model: scripted([{ parts: text('half'), failure: wrapped }]), prompt: 'hi' });
    expect(b.errors[0]).toBeInstanceOf(RunUnfinishedError);
  });

  it("an adapter's report of the cut (openai-compatible) is the same cut", async () => {
    const journal = new InMemoryStorage().runs;
    const report = Object.assign(new Error('Response stream ended without a finish reason.'), { name: 'AI_InvalidResponseDataError' });
    const model = scripted([{ parts: [...text('half'), { type: 'error', error: report }, finish('error', undefined, noUsage)] }, { parts: whole }]);
    const first = await drive({ runId: 'compat', journal, model, prompt: 'hi' });
    expect(first.errors).toHaveLength(1);
    expect(first.errors[0]).toBeInstanceOf(RunUnfinishedError);
    expect((await drive({ runId: 'compat', journal, model, prompt: 'hi' })).text).toBe('whole answer');
  });

  it('an error the stream carried stays the run\'s failure, and is not replayed as its answer', async () => {
    // Before: the record held the error part and the claim said succeeded, so every re-drive failed again
    // without calling the model.
    const journal = new InMemoryStorage().runs;
    const overloaded = Object.assign(new Error('Overloaded'), { name: 'AI_APICallError', statusCode: 529 });
    const model = scripted([{ parts: [...text('half'), { type: 'error', error: overloaded }] }, { parts: whole }]);
    const first = await drive({ runId: 'carried', journal, model, prompt: 'hi' });
    expect(first.errors).toEqual([overloaded]);
    expect(await journal.get(runKeys.model('carried', 0))).toBeUndefined();
    expect((await drive({ runId: 'carried', journal, model, prompt: 'hi' })).text).toBe('whole answer');
  });
});

describe('an ending is left alone', () => {
  const endings: Array<[string, unknown]> = [
    ['stop', finish('stop', 'stop')],
    ['stop with no raw (OpenAI Responses)', finish('stop', undefined)],
    ['length', finish('length', 'length')],
    ['a reason the adapter did not recognize: raw says the provider named it', finish('other', 'weird_reason')],
    ['a reason the adapter did not recognize and reported nothing of, with usage', finish('other', undefined)],
  ];

  it.each(endings)('%s', async (_name, end) => {
    const journal = new InMemoryStorage().runs;
    const model = scripted([{ parts: [...text('the answer'), end] }, { parts: whole }]);
    const first = await drive({ runId: 'end', journal, model, prompt: 'hi' });
    expect(first.errors).toEqual([]);
    expect(first.text).toBe('the answer');
    expect((await journal.get<{ partial?: boolean; parts?: unknown[] }>(runKeys.model('end', 0)))?.parts).toBeDefined();
    expect((await claimOf(journal, 'end'))?.status).toBe('succeeded');
    await drive({ runId: 'end', journal, model, prompt: 'hi' });
    expect(model.calls, 'a recorded answer replays').toBe(1);
  });

  it('a stream this run\'s own abort closed is no cut', async () => {
    const journal = new InMemoryStorage().runs;
    const controller = new AbortController();
    const model = {
      ...scripted([]),
      doStream: async () => {
        const s = streamOf(text('half'));
        controller.abort();
        return { stream: s };
      },
    };
    const { errors } = await drive({ runId: 'abort', journal, model, prompt: 'hi', abortSignal: controller.signal }).catch((e) => ({ errors: [e] }));
    expect(errors.some((e: unknown) => e instanceof RunUnfinishedError)).toBe(false);
    expect(await journal.get(runKeys.model('abort', 0)), 'nor is it an answer').toBeUndefined();
  });
});

describe('a v2 model', () => {
  const v2 = (reason: string, u: unknown) => ({ type: 'finish', finishReason: reason, usage: u });
  const u2 = { inputTokens: 5, outputTokens: 7, totalTokens: 12 };
  const none = { inputTokens: undefined, outputTokens: undefined, totalTokens: undefined };

  it('has its endings kept: the SDK\'s v2 bridge drops raw from all of them', async () => {
    for (const [i, end] of [v2('unknown', u2), v2('other', u2), v2('unknown', none), v2('other', none)].entries()) {
      const r = await drive({ runId: `v2-${i}`, journal: new InMemoryStorage().runs, model: scripted([{ parts: [...text('the answer'), end] }], 'v2'), prompt: 'hi' });
      expect(r.errors).toEqual([]);
      expect(r.text).toBe('the answer');
    }
  });

  it('with no finish at all is cut like any other', async () => {
    const r = await drive({ runId: 'v2-cut', journal: new InMemoryStorage().runs, model: scripted([{ parts: text('half') }], 'v2'), prompt: 'hi' });
    expect(r.errors[0]).toBeInstanceOf(RunUnfinishedError);
  });

  it('behind wrapLanguageModel reports v4: usage keeps its endings, and one with none reads as a cut', async () => {
    // Pinned, not wanted. Nothing below the wrapper says v2, and the finish of an ending that reported no
    // usage is the finish of a cut. If the SDK ever exposes the wrapped model, this is where to use it.
    const behind = (end: unknown) => wrapLanguageModel({ model: scripted([{ parts: [...text('the answer'), end] }], 'v2') as any, middleware: { specificationVersion: 'v4' } });
    expect(behind(v2('other', u2)).specificationVersion).toBe('v4');
    const withUsage = await drive({ runId: 'w1', journal: new InMemoryStorage().runs, model: behind(v2('other', u2)), prompt: 'hi' });
    expect(withUsage.errors).toEqual([]);
    const without = await drive({ runId: 'w2', journal: new InMemoryStorage().runs, model: behind(v2('other', none)), prompt: 'hi' });
    expect(without.errors[0]).toBeInstanceOf(RunUnfinishedError);
  });
});

describe('a step cut after its tool call', () => {
  function charge() {
    const counter = { runs: 0 };
    const t = tool({ description: 'charge', inputSchema: jsonSchema({ type: 'object', properties: { amount: { type: 'number' } } }), execute: async () => { counter.runs++; return { ok: true }; } });
    Object.assign(t, { sideEffect: true });
    return { charge: t as any, counter };
  }

  it.each([
    ['no finish', [] as unknown[]],
    ["the adapter's default finish", [finish('other', undefined, noUsage)]],
  ])('%s: the tool runs once, on the re-drive, from the journaled call — not from a re-plan', async (_name, tail) => {
    const journal = new InMemoryStorage().runs;
    const { charge: chargeTool, counter } = charge();
    // Every completion mints a fresh id, as a real provider does: a re-plan would run a second charge.
    const replan = { parts: [{ type: 'stream-start', warnings: [] }, toolCall('call-REPLAN'), finish('tool-calls', 'tool_calls')] };
    const model = scripted([{ parts: [{ type: 'stream-start', warnings: [] }, toolCall('call-A'), ...tail] }, { parts: whole }, replan]);
    const args = { runId: 'tc', journal, model, tools: { charge: chargeTool }, prompt: 'charge', stopWhen: undefined };

    const first = await drive(args);
    expect(first.errors[0]).toBeInstanceOf(RunUnfinishedError);
    expect(counter.runs, 'a cut step runs no tool').toBe(0);
    expect((await journal.get<{ partial?: boolean }>(runKeys.model('tc', 0)))?.partial, 'the write-ahead copy stays').toBe(true);

    const second = await drive(args);
    expect(second.errors).toEqual([]);
    expect(second.text).toBe('whole answer');
    expect(counter.runs).toBe(1);
    expect(await journal.get(runKeys.tool('tc', 'call-A'))).toMatchObject({ status: 'succeeded' });
    expect(model.calls, 'the cut call, then the step after the tool').toBe(2);
  });

  it('a later step cut leaves the earlier step and its tool as they are', async () => {
    const journal = new InMemoryStorage().runs;
    const { charge: chargeTool, counter } = charge();
    const model = scripted([
      { parts: [{ type: 'stream-start', warnings: [] }, toolCall('call-A'), finish('tool-calls', 'tool_calls')] },
      { parts: [...text('half'), finish('other', undefined, noUsage)] },
      { parts: whole },
    ]);
    const args = { runId: 'tc2', journal, model, tools: { charge: chargeTool }, prompt: 'charge' };
    expect((await drive(args)).errors[0]).toBeInstanceOf(RunUnfinishedError);
    expect((await drive(args)).text).toBe('whole answer');
    expect(counter.runs).toBe(1);
    expect(model.calls).toBe(3);
  });
});
