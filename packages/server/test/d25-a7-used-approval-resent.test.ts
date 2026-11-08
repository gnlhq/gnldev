// d25 A7 — an approval that was already used, sent again. The client lost the response and retries ("send
// the same request again" is the documented recovery). The run is finished and its effect happened once:
// every door answers with the run's final answer; none starts a second execution; /stream does not
// answer with an empty `event: done`.
import { describe, it, expect } from 'vitest';
import { z } from 'zod';
import { InMemoryJournal } from '@gnldev/durable';
import { createRestApi } from '../src/index.js';
import { call } from './call.js';

const usage = { inputTokens: 1, outputTokens: 1, totalTokens: 2 };
function mkModel(): any {
  const hasTool = (prompt: any[]) => (prompt ?? []).some((m: any) => m.role === 'tool');
  const callPart = { type: 'tool-call', toolCallId: 'c1', toolName: 'charge', input: JSON.stringify({ amount: 5 }) };
  return {
    specificationVersion: 'v2', provider: 'mock', modelId: 'm', supportedUrls: {},
    doGenerate: async ({ prompt }: any) => (hasTool(prompt)
      ? { content: [{ type: 'text', text: 'Charged.' }], finishReason: 'stop', usage, warnings: [] }
      : { content: [callPart], finishReason: 'tool-calls', usage, warnings: [] }),
    doStream: async ({ prompt }: any) => {
      const parts = hasTool(prompt)
        ? [{ type: 'stream-start', warnings: [] }, { type: 'text-start', id: '1' }, { type: 'text-delta', id: '1', delta: 'Charged.' }, { type: 'text-end', id: '1' }, { type: 'finish', finishReason: 'stop', usage }]
        : [{ type: 'stream-start', warnings: [] }, callPart, { type: 'finish', finishReason: 'tool-calls', usage }];
      return { stream: new ReadableStream({ start(c) { for (const p of parts) c.enqueue(p); c.close(); } }) };
    },
  };
}
function mkApi() {
  const effects: number[] = [];
  const api = createRestApi({
    journal: new InMemoryJournal(),
    agents: { a: { model: mkModel(), tools: { charge: {
      description: 'charge', inputSchema: z.object({ amount: z.number() }), sideEffect: true, confirm: true,
      execute: async (x: { amount: number }) => { effects.push(x.amount); return { ok: true }; },
    } } } },
  } as never, { allowOpenAccess: true, protectionsBanner: false } as never);
  return { api, effects };
}
const post = (api: any, path: string, body: unknown) => call(api, path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });

describe('d25 A7 — a used approval sent again on a finished run', () => {
  for (const door of ['stream', 'run', 'resume'] as const) {
    for (const times of [1, 2]) {
      it(`${door}: the approval re-sent ${times}x after it was used → the run's answer each time, effect stays 1`, async () => {
        const { api, effects } = mkApi();
        const runId = `used-${door}-${times}`;
        const first = await (await post(api, '/agents/a/run', { runId, prompt: 'charge 5' })).json();
        expect(first.interrupts?.length, 'precondition: the run asks').toBe(1);
        const body = door === 'resume' ? { runId, approvals: { c1: true } } : { runId, prompt: 'charge 5', approvals: { c1: true } };
        const path = `/agents/a/${door}`;
        const used = await post(api, path, body);
        const tu = await used.text();
        expect(used.status, tu).toBe(200);
        expect(tu, 'the first use answers').toMatch(/Charged\./);
        expect(effects.length).toBe(1);
        for (let i = 0; i < times; i++) {
          const again = await post(api, path, body);
          const ta = await again.text();
          expect(again.status, ta).toBe(200);
          expect(ta, `re-send #${i + 1} on ${door}: the final answer, not an empty done`).toMatch(/Charged\./);
          expect(ta).not.toMatch(/event: error|"type":"error"/);
          expect(effects.length, 'no second execution').toBe(1);
        }
      });
    }
  }
  it('stream: an approval-free /stream of the finished run still reads the answer (sibling, unchanged rule)', async () => {
    const { api, effects } = mkApi();
    const runId = 'used-plain';
    await post(api, '/agents/a/run', { runId, prompt: 'charge 5' });
    await post(api, '/agents/a/run', { runId, prompt: 'charge 5', approvals: { c1: true } });
    const r = await post(api, '/agents/a/stream', { runId, prompt: 'charge 5' });
    const t = await r.text();
    expect(r.status, t).toBe(200);
    expect(t).toMatch(/Charged\./);
    expect(effects.length).toBe(1);
  });
});
