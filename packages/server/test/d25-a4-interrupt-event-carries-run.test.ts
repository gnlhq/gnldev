// d25 A4 (stream/KARAR-04, option A): the SSE `interrupt` event names its run. The `/run` answer and the chat door's
// `data-gnl-interrupt` already carry the runId; on `/stream` the client had to wait for the trailing `done{runId}` or
// remember the id itself — and if the stream breaks before `done`, it cannot address the approval.
// The option puts `runId` on the interrupt event at its one source (agentStreamEvents), so every SSE door gets it.
import { describe, it, expect } from 'vitest';
import { tool } from 'ai';
import { z } from 'zod';
import { InMemoryJournal, providerIdOf } from '@gnldev/durable';
import { createRestApi } from '../src/index.js';
import { call } from './call.js';

const usage = { inputTokens: 1, outputTokens: 1, totalTokens: 2 };
const mkStream = (arr: any[]) => new ReadableStream({ start(c) { for (const p of arr) c.enqueue(p); c.close(); } });
const toolCall = (id: string, name: string, input: unknown) => ({ stream: mkStream([{ type: 'stream-start', warnings: [] }, { type: 'tool-call', toolCallId: id, toolName: name, input: JSON.stringify(input) }, { type: 'finish', finishReason: 'tool-calls', usage }]) });
const text = (t: string) => ({ stream: mkStream([{ type: 'stream-start', warnings: [] }, { type: 'text-start', id: '1' }, { type: 'text-delta', id: '1', delta: t }, { type: 'text-end', id: '1' }, { type: 'finish', finishReason: 'stop', usage }]) });

/** One tool call, then text. */
const oneCall = (): any => ({
  specificationVersion: 'v2', provider: 'mock', modelId: 'm', supportedUrls: {},
  doGenerate: async () => { throw new Error('no gen'); },
  doStream: async ({ prompt }: any) => (prompt ?? []).some((m: any) => m.role === 'tool') ? text('ok') : toolCall('call-c', 'chargeCard', { amount: 5000 }),
});
/** Two guarded calls in a row: the resumed stream raises a SECOND interrupt. */
const twoCalls = (): any => ({
  specificationVersion: 'v2', provider: 'mock', modelId: 'm', supportedUrls: {},
  doGenerate: async () => { throw new Error('no gen'); },
  doStream: async ({ prompt }: any) => {
    const results = (prompt ?? []).filter((m: any) => m.role === 'tool').length;
    return results === 0 ? toolCall('call-1', 'chargeCard', { amount: 1 }) : results === 1 ? toolCall('call-2', 'chargeCard', { amount: 2 }) : text('done');
  },
});
const tools = { chargeCard: tool({ description: 'c', inputSchema: z.object({ amount: z.number() }), execute: async () => ({ ok: true }) }) };
const guard = () => ({ action: 'require-approval' as const });

async function sse(res: Response) {
  return (await res.text()).split('\n\n').filter((f) => f.trim()).map((f) => {
    let event = 'message', data = '';
    for (const l of f.split('\n')) { if (l.startsWith('event:')) event = l.slice(6).trim(); else if (l.startsWith('data:')) data += l.slice(5).trim(); }
    return { event, data: data ? JSON.parse(data) : undefined };
  });
}
const post = (api: any, p: string, b: any) => call(api, p, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(b) });

describe('A4: the SSE interrupt event carries its runId', () => {
  it('reported — /stream, first interrupt of a run', async () => {
    const api = createRestApi({ journal: new InMemoryJournal(), agents: { a: { model: oneCall(), tools, guard, maxSteps: 4 } } }, { protectionsBanner: false } as any);
    const ev = await sse(await post(api, '/agents/a/stream', { runId: 'a4-1', prompt: 'x' }));
    const i = ev.find((e) => e.event === 'interrupt');
    expect(i, 'an interrupt event was sent').toBeDefined();
    expect(i!.data.runId).toBe('a4-1');
    expect(i!.data.interrupts.length).toBeGreaterThan(0);
  });

  it('sibling — the interrupt raised on a RESUMED /stream (after approving the first call) carries the same runId', async () => {
    const api = createRestApi({ journal: new InMemoryJournal(), agents: { a: { model: twoCalls(), tools, guard, maxSteps: 6 } } }, { protectionsBanner: false } as any);
    const first = await sse(await post(api, '/agents/a/stream', { runId: 'a4-2', prompt: 'x' }));
    expect(first.find((e) => e.event === 'interrupt')?.data.interrupts?.[0]?.toolCallId ?? 'call-1').toSatisfy((id: string) => providerIdOf(id) === 'call-1');
    const second = await sse(await post(api, '/agents/a/stream', { runId: 'a4-2', prompt: 'x', approvals: { 'call-1': true } }));
    const i = second.find((e) => e.event === 'interrupt');
    expect(i, 'the second guarded call interrupts the resumed stream').toBeDefined();
    expect(i!.data.runId).toBe('a4-2');
  });

  it('control (green on 0.17.1) — /run with an interrupt already answers with its runId', async () => {
    const api = createRestApi({ journal: new InMemoryJournal(), agents: { a: { model: oneCall(), tools, guard, maxSteps: 4 } } }, { protectionsBanner: false } as any);
    const j: any = await (await post(api, '/agents/a/run', { runId: 'a4-3', prompt: 'x' })).json();
    expect(j.runId).toBe('a4-3');
  });
});
