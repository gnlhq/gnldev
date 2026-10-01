// Studio's agent run and stream routes answer the engine's caller-conflict family the way every other
// door does: 409, the error's own code and its detail. They used to recognise one member
// (`run_thread_mismatch`) by name and answer the rest with a bare 400 — measured: agent `b` driven with
// agent `a`'s runId through the real engine → 400 with no code, where @gnldev/server, AG-UI and chat
// answer 409 run_target_mismatch. The fork and resume routes already read `callerConflictCode`.
import { describe, it, expect } from 'vitest';
import { InMemoryJournal, createGnl, RunActorMismatchError, RunThreadMismatchError } from '@gnldev/durable';
import { createStudioRunner } from '../src/runner.js';
import { createStudioApi, type StudioAgentRunner } from '../src/server.js';
import { call } from './call.js';

const usage = { inputTokens: 1, outputTokens: 1, totalTokens: 2 };
const mkStream = (arr: any[]) => new ReadableStream({ start(c) { for (const p of arr) c.enqueue(p); c.close(); } });
const mk = (n: string): any => ({
  specificationVersion: 'v2', provider: 'mock', modelId: n, supportedUrls: {},
  doGenerate: async () => ({ content: [{ type: 'text', text: `answer-from-${n}` }], finishReason: 'stop', usage, warnings: [] }),
  doStream: async () => ({ stream: mkStream([{ type: 'stream-start', warnings: [] }, { type: 'text-start', id: '1' },
    { type: 'text-delta', id: '1', delta: `answer-from-${n}` }, { type: 'text-end', id: '1' }, { type: 'finish', finishReason: 'stop', usage }]) }),
});
const post = (api: any, p: string, b: unknown) => call(api, p, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(b) });

describe('Studio agent routes: a caller-conflict refusal carries its code', () => {
  for (const route of ['run', 'stream']) {
    it(`/agents/b/${route} with agent a's runId → 409 run_target_mismatch, through the real engine`, async () => {
      const journal = new InMemoryJournal();
      const cfg = { journal, agents: { a: { model: mk('a') }, b: { model: mk('b') } } } as any;
      const api = createStudioApi({ reader: journal, gnl: createStudioRunner(createGnl(cfg), cfg, { toJsonSchema: () => ({}) } as any) } as any) as any;
      expect((await post(api, '/agents/a/run', { runId: 'r1', prompt: 'hi' })).status).toBe(200);
      const res = await post(api, `/agents/b/${route}`, { runId: 'r1', prompt: 'hi' });
      const body = await res.json();
      expect(res.status).toBe(409);
      expect(body.code).toBe('run_target_mismatch');
      expect(body.detail).toMatchObject({ startedFor: { kind: 'agent', name: 'a' }, requested: { kind: 'agent', name: 'b' } });
    });
  }
  for (const [label, err, code] of [
    ['another member of the family', new RunActorMismatchError('actor differs', { runId: 'r1' } as any), 'run_actor_mismatch'],
    ['the member it always knew', new RunThreadMismatchError('thread differs', { runId: 'r1', startedForThread: 'A', requestedThread: 'B' }), 'run_thread_mismatch'],
  ] as const) {
    for (const route of ['run', 'stream']) {
      it(`${label} on /${route} → 409 ${code}`, async () => {
        const runner: StudioAgentRunner = {
          listAgents: () => [{ name: 'x', model: 'custom', hasTools: false, maxSteps: 6 }],
          run: async () => { throw err; }, stream: async () => { throw err; },
        } as any;
        const res = await post(createStudioApi({ reader: new InMemoryJournal(), gnl: runner } as any), `/agents/x/${route}`, { runId: 'r1', prompt: 'hi' });
        expect(res.status).toBe(409);
        expect((await res.json()).code).toBe(code);
      });
    }
  }
});
