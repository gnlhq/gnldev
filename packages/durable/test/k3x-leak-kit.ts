// K3 leak sweep kit: models that RECORD what the provider would be sent, two ways.
//   recorder : a fake model that keeps the prompt it was handed (what the provider-facing model object receives)
//   openai   : the REAL @ai-sdk/openai chat provider over a fake fetch (what goes over the wire: `tool_call_id`, `tool_calls[].id`)
// `leakCheck` asserts the invariant of the decision: a request built from a history that holds GNL ids
// (`<providerId>.gnl-…`) carries only the provider's own ids. `expectCalls` keeps the check from being vacuous.
import { expect } from 'vitest';
import { stepCountIs } from 'ai';
import { z } from 'zod';
import { createOpenAI } from '@ai-sdk/openai';
import { InMemoryJournal } from '../src/journal.js';
import { runDurable } from '../src/run.js';
import { createMockModel, finalTextResult } from './mock.js';

export const GNL = '.gnl-';
const usage = { inputTokens: 1, outputTokens: 1 };

/** 'text': always the final text. 'tool-then-text': one `pay` call (id `call_0`) while no result is in the history. */
export type Mode = 'text' | 'tool-then-text';
export interface Cap { kind: 'recorder' | 'openai'; model: any; requests: string[]; sentIds: () => string[]; calls: () => number }

const hasResult = (msgs: any[]) => msgs.some((m) => m.role === 'tool');

export function recorder(mode: Mode = 'text', callId = 'call_0'): Cap {
  const requests: string[] = []; const ids: string[] = [];
  const model = createMockModel(async (o: any) => {
    requests.push(JSON.stringify(o.prompt));
    for (const m of o.prompt) if (Array.isArray(m.content)) for (const p of m.content) if (p.toolCallId) ids.push(p.toolCallId);
    if (mode === 'tool-then-text' && !hasResult(o.prompt.slice(o.prompt.map((m: any) => m.role).lastIndexOf('user')))) {
      return { content: [{ type: 'tool-call', toolCallId: callId, toolName: 'pay', input: JSON.stringify({ amount: 5 }) }], finishReason: 'tool-calls', usage, warnings: [] as any[] };
    }
    return finalTextResult('ok');
  });
  return { kind: 'recorder', model, requests, sentIds: () => ids, calls: () => requests.length };
}

const json = (body: unknown) => new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });
export function openaiChat(mode: Mode = 'text', callId = 'call_0'): Cap {
  const requests: string[] = []; const ids: string[] = [];
  const fetchFn = (async (_u: any, init: any) => {
    const body = JSON.parse(init.body);
    requests.push(init.body);
    const msgs: any[] = body.messages ?? [];
    for (const m of msgs) { for (const t of m.tool_calls ?? []) ids.push(t.id); if (m.tool_call_id) ids.push(m.tool_call_id); }
    const lastUser = msgs.map((m) => m.role).lastIndexOf('user');
    const msg = mode === 'tool-then-text' && !hasResult(msgs.slice(lastUser))
      ? { role: 'assistant', content: null, tool_calls: [{ id: callId, type: 'function', function: { name: 'pay', arguments: JSON.stringify({ amount: 5 }) } }] }
      : { role: 'assistant', content: 'ok' };
    const calling = 'tool_calls' in msg;
    if (body.stream) {
      const chunk = (delta: any, fin: string | null, u?: any) => `data: ${JSON.stringify({ id: 'c', object: 'chat.completion.chunk', created: 1, model: 'gpt-4o', choices: [{ index: 0, delta, finish_reason: fin }], ...(u ? { usage: u } : {}) })}\n\n`;
      const parts = calling
        ? [chunk({ role: 'assistant', tool_calls: [{ index: 0, id: callId, type: 'function', function: { name: 'pay', arguments: JSON.stringify({ amount: 5 }) } }] }, null), chunk({}, 'tool_calls', { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 })]
        : [chunk({ role: 'assistant', content: 'ok' }, null), chunk({}, 'stop', { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 })];
      return new Response(parts.join('') + 'data: [DONE]\n\n', { status: 200, headers: { 'content-type': 'text/event-stream' } });
    }
    return json({ id: 'c', object: 'chat.completion', created: 1, model: 'gpt-4o', choices: [{ index: 0, message: msg, finish_reason: calling ? 'tool_calls' : 'stop' }], usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } });
  }) as any;
  const model = createOpenAI({ apiKey: 'test', fetch: fetchFn }).chat('gpt-4o');
  return { kind: 'openai', model, requests, sentIds: () => ids, calls: () => requests.length };
}
export const CAPS = [['recorder', recorder], ['openai', openaiChat]] as const;

/** Every request that reached the provider-facing model: no GNL id anywhere, and the history DID carry calls. */
export function leakCheck(cap: Cap, label = ''): void {
  expect(cap.calls(), `${label}: the model was asked`).toBeGreaterThan(0);
  const all = cap.requests.join('\n');
  const leaked = [...new Set(all.match(/[A-Za-z0-9_\-]*\.gnl-[0-9a-z\-]+/g) ?? [])];
  expect(leaked, `${label}: GNL ids that reached the provider (${cap.kind})`).toEqual([]);
}
export function expectCalls(cap: Cap, label = ''): void {
  expect(cap.sentIds().length, `${label}: the request carried earlier tool calls (else this test proves nothing)`).toBeGreaterThan(0);
  expect(new Set(cap.sentIds()), `${label}: only the provider's id`).toEqual(new Set(['call_0']));
}

export const pay = (paid: number[] = []) => ({ description: 'pay', inputSchema: z.object({ amount: z.number() }), sideEffect: true, execute: async (a: any) => { paid.push(a.amount); return { charged: a.amount }; } });

/** A finished run whose messages hold GNL ids: its seed + every step's own messages (the shape a chat client / memory holds next turn). */
export async function gnlHistory(runId = 'hist'): Promise<{ journal: InMemoryJournal; runId: string; messages: any[] }> {
  const journal = new InMemoryJournal();
  const r: any = await runDurable({ runId, journal, model: recorder('tool-then-text').model, tools: { pay: pay() }, stopWhen: stepCountIs(6), prompt: 'pay 5' } as any);
  const messages = [{ role: 'user', content: 'pay 5' }, ...r.steps.flatMap((s: any) => s.response.messages)];
  const text = JSON.stringify(messages);
  expect(text, 'precondition: the history holds a GNL id').toContain(GNL);
  return { journal, runId, messages };
}
