// schemaCompat changes what the model is told; the tool still validates what it receives.
//
// Two paths shape tool schemas under schemaCompat, and they disagreed:
//   - a plain model: `applyToolCompat` replaced the tool's zod inputSchema with a bare `jsonSchema(js)`,
//     so the AI SDK validated nothing — measured, `{ to: 'not-an-email', count: -7 }` reached execute()
//     on an OpenAI model, and `.default('low')` never filled `priority`;
//   - a fallback chain: the wire JSON was reshaped per candidate and the zod validator kept, so the
//     OpenAI rule's "optional fields accept null" reached the model while the validator still refused
//     that null — the model did what it was told and the call failed.
// Both paths now validate with the tool's own schema, reading a null the rule invited as "absent".
import { describe, it, expect } from 'vitest';
import { z } from 'zod';
import { tool, stepCountIs } from 'ai';
import { runDurable } from '../src/run.js';
import { InMemoryJournal } from '../src/journal.js';
import { withModelFallback } from '../src/model-router.js';
import { countToolResults } from './mock.js';

const usage = { inputTokens: 1, outputTokens: 1, totalTokens: 2 };

function modelSending(provider: string, input: Record<string, unknown>, opts: { fail?: boolean } = {}): any {
  return {
    specificationVersion: 'v2', provider, modelId: 'gpt-4o', supportedUrls: {},
    doGenerate: async (o: any) => {
      if (opts.fail) throw new Error(`${provider} is down`);
      if (countToolResults(o.prompt) === 0) {
        return { content: [{ type: 'tool-call', toolCallId: 'call-1', toolName: 'sendMail', input: JSON.stringify(input) }], finishReason: 'tool-calls', usage, warnings: [] };
      }
      return { content: [{ type: 'text', text: 'done' }], finishReason: 'stop', usage, warnings: [] };
    },
    doStream: async () => { throw new Error('generate-only'); },
  };
}

function mailTool(seen: unknown[]) {
  return tool({
    description: 'send mail',
    inputSchema: z.object({
      to: z.string().email(),
      cc: z.string().optional(),
      count: z.number().int().positive(),
      priority: z.enum(['low', 'high']).default('low'),
    }),
    execute: async (args: any) => { seen.push(args); return { sent: true }; },
  });
}

async function run(model: any, schemaCompat: boolean, runId = `sc-${Math.random()}`) {
  const seen: unknown[] = [];
  const journal = new InMemoryJournal();
  await runDurable({ runId, journal, prompt: 'send', model, tools: { sendMail: mailTool(seen) }, schemaCompat, stopWhen: stepCountIs(3) } as any);
  const rec: any = await journal.get(`${runId}:tool:call-1`);
  return { seen, rec };
}

const BAD = { to: 'not-an-email', cc: null, count: -7 };
const OK = { to: 'a@b.co', count: 2 };

describe('schemaCompat keeps tool validation — plain model', () => {
  it('OpenAI + schemaCompat: invalid input never reaches execute', async () => {
    expect((await run(modelSending('openai.chat', BAD), true)).seen).toEqual([]);
  });

  it('OpenAI + schemaCompat: .default() is applied', async () => {
    expect((await run(modelSending('openai.chat', OK), true)).seen).toEqual([{ ...OK, priority: 'low' }]);
  });

  it('OpenAI + schemaCompat: the null the rule invites reaches execute as an absent key', async () => {
    const { seen } = await run(modelSending('openai.chat', { ...OK, cc: null, priority: null }), true);
    expect(seen).toEqual([{ ...OK, priority: 'low' }]);
  });

  it('argsHash is the same with compat on and off, for the same call', async () => {
    const on = await run(modelSending('openai.chat', OK), true);
    const off = await run(modelSending('openai.chat', OK), false);
    expect(on.rec.argsHash).toBeDefined();
    expect(on.rec.argsHash).toBe(off.rec.argsHash);
    // …and when the model uses the invited null, it is the same call as leaving the key out.
    const withNull = await run(modelSending('openai.chat', { ...OK, cc: null }), true);
    expect(withNull.rec.argsHash).toBe(off.rec.argsHash);
  });
});

describe('schemaCompat keeps tool validation — fallback chain (the other path)', () => {
  const chain = (runId: string, input: Record<string, unknown>) => {
    const journal = new InMemoryJournal();
    return {
      journal,
      model: withModelFallback([
        { spec: 'anthropic/claude-x', model: modelSending('anthropic', input, { fail: true }) },
        { spec: 'openai/gpt-4o', model: modelSending('openai.chat', input) },
      ], journal, runId),
    };
  };

  it('OpenAI answering after failover: the invited null is accepted and read as absent', async () => {
    const seen: unknown[] = [];
    const { journal, model } = chain('sc-chain-null', { ...OK, cc: null });
    await runDurable({ runId: 'sc-chain-null', journal, model, prompt: 'send', tools: { sendMail: mailTool(seen) }, schemaCompat: true, stopWhen: stepCountIs(3) } as any);
    expect(seen).toEqual([{ ...OK, priority: 'low' }]);
  });

  it('invalid input is still rejected on the chain path', async () => {
    const seen: unknown[] = [];
    const { journal, model } = chain('sc-chain-bad', BAD);
    await runDurable({ runId: 'sc-chain-bad', journal, model, prompt: 'send', tools: { sendMail: mailTool(seen) }, schemaCompat: true, stopWhen: stepCountIs(3) } as any);
    expect(seen).toEqual([]);
  });
});
