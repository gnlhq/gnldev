// d25 A4 (stream/KARAR-04, option A), Studio's door: the playground's SSE stream is written from the same
// `agentStreamEvents` as @gnldev/server, so its `interrupt` event must carry the runId too.
import { describe, it, expect } from 'vitest';
import { tool } from 'ai';
import { z } from 'zod';
import { InMemoryJournal, createGnl } from '@gnldev/durable';
import { createStudioRunner } from '../src/runner.js';
import { createStudioApp } from '../src/server.js';
import { call } from './call.js';

const usage = { inputTokens: 1, outputTokens: 1, totalTokens: 2 };
const mkStream = (arr: any[]) => new ReadableStream({ start(c) { for (const p of arr) c.enqueue(p); c.close(); } });
const model: any = {
  specificationVersion: 'v2', provider: 'mock', modelId: 'm', supportedUrls: {},
  doGenerate: async () => { throw new Error('no gen'); },
  doStream: async ({ prompt }: any) => (prompt ?? []).some((m: any) => m.role === 'tool')
    ? { stream: mkStream([{ type: 'stream-start', warnings: [] }, { type: 'text-start', id: '1' }, { type: 'text-delta', id: '1', delta: 'ok' }, { type: 'text-end', id: '1' }, { type: 'finish', finishReason: 'stop', usage }]) }
    : { stream: mkStream([{ type: 'stream-start', warnings: [] }, { type: 'tool-call', toolCallId: 'call-s', toolName: 'chargeCard', input: JSON.stringify({ amount: 1 }) }, { type: 'finish', finishReason: 'tool-calls', usage }]) },
};
const tools = { chargeCard: tool({ description: 'c', inputSchema: z.object({ amount: z.number() }), execute: async () => ({ ok: true }) }) };

async function sse(res: Response) {
  return (await res.text()).split('\n\n').filter((f) => f.trim()).map((f) => {
    let event = 'message', data = '';
    for (const l of f.split('\n')) { if (l.startsWith('event:')) event = l.slice(6).trim(); else if (l.startsWith('data:')) data += l.slice(5).trim(); }
    return { event, data: data ? JSON.parse(data) : undefined };
  });
}

describe('A4 (Studio): the playground stream\'s interrupt event carries its runId', () => {
  it('/api/agents/:name/stream interrupt has runId', async () => {
    const journal = new InMemoryJournal();
    const config = { journal, agents: { a: { model, tools, guard: () => ({ action: 'require-approval' as const }), maxSteps: 4 } } } as any;
    const app = createStudioApp({ reader: journal, gnl: createStudioRunner(createGnl(config) as never, config) as any });
    const res = await call(app, '/api/agents/a/stream', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ runId: 'a4-studio', prompt: 'x' }) });
    expect(res.headers.get('content-type') ?? '').toContain('text/event-stream');
    const ev = await sse(res);
    const i = ev.find((e) => e.event === 'interrupt');
    expect(i, `events: ${ev.map((e) => e.event).join(',')}`).toBeDefined();
    expect(i!.data.runId).toBe('a4-studio');
  });
});
