// Aday D, S14 (second half): the REAL @ai-sdk/openai provider over a fake fetch. The id in the HTTP request body
// (chat completions: `tool_call_id`; responses: `call_id`) is the id the provider issued, never the GNL id.
import { describe, it, expect, vi, beforeAll } from 'vitest';
import { stepCountIs } from 'ai';
import { z } from 'zod';
import { createOpenAI } from '@ai-sdk/openai';
import { InMemoryJournal } from '../src/journal.js';
import { runDurable } from '../src/run.js';

beforeAll(() => { vi.spyOn(console, 'warn').mockImplementation(() => {}); });
const pay = (paid: number[]) => ({ description: 'pay', inputSchema: z.object({ amount: z.number() }), sideEffect: true, execute: async (a: any) => { paid.push(a.amount); return { charged: a.amount }; } });
const json = (body: unknown) => new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });

const dump: Record<string, unknown> = {};
function fakeFetch(api: 'chat' | 'responses', bodies: any[], ids: 'same' | 'unique' = 'same') {
  let n = 0;
  return (async (_url: any, init: any) => {
    bodies.push(JSON.parse(init.body));
    const step = n++;
    const amount = step === 0 ? 5 : 7;
    const cid = ids === 'same' ? 'call_0' : `call_u${step}`;
    if (api === 'chat') {
      const msg = step < 2
        ? { role: 'assistant', content: null, tool_calls: [{ id: cid, type: 'function', function: { name: 'pay', arguments: JSON.stringify({ amount }) } }] }
        : { role: 'assistant', content: 'done' };
      return json({ id: `c${step}`, object: 'chat.completion', created: 1, model: 'gpt-4o', choices: [{ index: 0, message: msg, finish_reason: step < 2 ? 'tool_calls' : 'stop' }], usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } });
    }
    const output = step < 2
      ? [{ type: 'function_call', id: `fc_${step}`, call_id: cid, name: 'pay', arguments: JSON.stringify({ amount }), status: 'completed' }]
      : [{ type: 'message', id: 'msg_1', role: 'assistant', status: 'completed', content: [{ type: 'output_text', text: 'done', annotations: [] }] }];
    return json({ id: `resp_${step}`, object: 'response', created_at: 1, model: 'gpt-4o', status: 'completed', output, usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 } });
  }) as any;
}

describe('S14 over the real OpenAI provider', () => {
  // ids=unique: the request bodies are captured for a byte comparison with the base tree (K3D_DUMP2=<file>);
  // on the base tree only this capture is meaningful (ids=same there is the R1 bug).
  for (const api of ['chat', 'responses'] as const) {
    it(`${api}: capture with unique ids`, async () => {
      const bodies: any[] = []; const paid: number[] = [];
      const openai = createOpenAI({ apiKey: 'test', fetch: fakeFetch(api, bodies, 'unique') });
      await runDurable({ runId: `k3d-oa-u-${api}`, journal: new InMemoryJournal(), model: api === 'chat' ? openai.chat('gpt-4o') : openai.responses('gpt-4o'), tools: { pay: pay(paid) }, stopWhen: stepCountIs(6), prompt: 'go', ...(api === 'responses' ? { providerOptions: { openai: { store: true, previousResponseId: 'resp_prev' } } } : {}) } as any);
      expect(paid).toEqual([5, 7]);
      dump[api] = bodies;
    });
  }
  it('writes the captured bodies when asked', async () => {
    if (process.env.K3D_DUMP2) { const { writeFileSync } = await import('node:fs'); writeFileSync(process.env.K3D_DUMP2, JSON.stringify(dump, null, 1)); }
  });

  it('chat completions: tool_call_id in the request is the provider\'s id', async () => {
    const bodies: any[] = []; const paid: number[] = [];
    const openai = createOpenAI({ apiKey: 'test', fetch: fakeFetch('chat', bodies) });
    await runDurable({ runId: 'k3d-oa-chat', journal: new InMemoryJournal(), model: openai.chat('gpt-4o'), tools: { pay: pay(paid) }, stopWhen: stepCountIs(6), prompt: 'go' } as any);
    expect(paid).toEqual([5, 7]);
    const text = JSON.stringify(bodies);
    expect(text).not.toContain('.gnl-');
    const ids = bodies.slice(1).flatMap((b) => b.messages).flatMap((m: any) => [...(m.tool_calls ?? []).map((t: any) => t.id), ...(m.tool_call_id ? [m.tool_call_id] : [])]);
    expect(ids.length).toBeGreaterThanOrEqual(4);
    expect(new Set(ids)).toEqual(new Set(['call_0']));
  });
  for (const mode of ['store:true', 'store:true + previousResponseId'] as const) {
    it(`responses (${mode}): call_id in the request is the provider's id`, async () => {
      const bodies: any[] = []; const paid: number[] = [];
      const openai = createOpenAI({ apiKey: 'test', fetch: fakeFetch('responses', bodies) });
      await runDurable({
        runId: `k3d-oa-resp-${mode.length}`, journal: new InMemoryJournal(), model: openai.responses('gpt-4o'), tools: { pay: pay(paid) }, stopWhen: stepCountIs(6), prompt: 'go',
        providerOptions: { openai: { store: true, ...(mode.includes('previous') ? { previousResponseId: 'resp_prev' } : {}) } },
      } as any);
      expect(paid).toEqual([5, 7]);
      expect(JSON.stringify(bodies)).not.toContain('.gnl-');
      const callIds = bodies.slice(1).flatMap((b) => b.input ?? []).filter((i: any) => i.type === 'function_call' || i.type === 'function_call_output').map((i: any) => i.call_id);
      console.log(`[S14 responses ${mode}] input item types (last request)`, (bodies.at(-1)?.input ?? []).map((i: any) => i.type ?? i.role + ':' + (i.id ?? '')),  '| call_ids', callIds, '| keys', Object.keys(bodies[1] ?? {}).join(','));
      expect(callIds.length, 'the request carries the calls (not only item references)').toBeGreaterThanOrEqual(2);
      expect(new Set(callIds)).toEqual(new Set(['call_0']));
    });
  }
});
