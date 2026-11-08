// k3 A2A — one parent run, two steps, both delegations named `call_0` by the provider (it numbers per
// response), different tasks. Both reach the remote agent and each step gets its own answer — against a GNL
// remote (createA2AServer, which replays a repeated run id from its journal) and a foreign A2A agent.
// Control: distinct ids per step.
import { describe, it, expect, vi, beforeAll } from 'vitest';
import { stepCountIs } from 'ai';
import { InMemoryJournal, runDurable } from '@gnldev/durable';
import { createA2ATool } from '../src/index.js';
import { createA2AServer } from '../src/server.js';

beforeAll(() => { vi.spyOn(console, 'warn').mockImplementation(() => {}); });
const usage = { inputTokens: 1, outputTokens: 1, totalTokens: 2 };
const gen = (fn: (prompt: any[]) => any) => ({
  specificationVersion: 'v2', provider: 'mock', modelId: 'm', supportedUrls: {},
  doGenerate: async ({ prompt }: any) => ({ ...fn(prompt), usage, warnings: [] }),
  // The same answer as a stream (a GNL remote streams its runs).
  doStream: async ({ prompt }: any) => {
    const r = fn(prompt);
    const parts: any[] = [{ type: 'stream-start', warnings: [] }];
    for (const c of r.content) {
      if (c.type === 'text') parts.push({ type: 'text-start', id: 't' }, { type: 'text-delta', id: 't', delta: c.text }, { type: 'text-end', id: 't' });
      else parts.push(c);
    }
    parts.push({ type: 'finish', finishReason: r.finishReason, usage });
    return { stream: new ReadableStream({ start(ctl) { for (const p of parts) ctl.enqueue(p); ctl.close(); } }) };
  },
}) as any;

/** The parent: delegates 'acme' then 'globex' (ids[n]), records the newest tool result it saw. */
function parent(ids: string[], seen: string[]) {
  return gen((prompt) => {
    const results = prompt.filter((m: any) => m.role === 'tool').flatMap((m: any) => m.content);
    const n = results.length;
    if (n > 0) seen[n] = JSON.stringify(results[n - 1].output);
    if (n < 2) return { content: [{ type: 'tool-call', toolCallId: ids[n], toolName: 'remote', input: JSON.stringify({ task: n === 0 ? 'acme' : 'globex' }) }], finishReason: 'tool-calls' };
    return { content: [{ type: 'text', text: 'ok' }], finishReason: 'stop' };
  });
}

describe('k3 A2A — two delegations of one run with a repeated id are two remote tasks', () => {
  for (const remote of ['gnl', 'foreign'] as const) for (const ids of [['call_0', 'call_0'], ['call_0', 'call_1']]) {
    it(`${remote} remote · ids=${ids}`, async () => {
      const tasks: string[] = [];
      let fetchImpl: typeof fetch;
      if (remote === 'gnl') {
        const serve = createA2AServer({ journal: new InMemoryJournal(), agents: { helper: { model: gen((prompt) => { const t = JSON.stringify(prompt).includes('globex') ? 'globex' : 'acme'; tasks.push(t); return { content: [{ type: 'text', text: `${t}-answer` }], finishReason: 'stop' }; }) } } } as never);
        fetchImpl = (async (u: string, i?: RequestInit) => serve(new Request(u, i))) as typeof fetch;
      } else {
        fetchImpl = (async (url: string, init?: RequestInit) => {
          if (url.endsWith('agent-card.json')) return Response.json({ name: 'helper', url: 'http://other/rpc', skills: [] });
          if (url !== 'http://other/rpc') return new Response('nope', { status: 404 });
          const b = JSON.parse(String(init?.body)); const t = b.params.message.parts[0].text; tasks.push(t);
          return Response.json({ jsonrpc: '2.0', id: b.id, result: { kind: 'message', role: 'agent', messageId: `r-${tasks.length}`, parts: [{ kind: 'text', text: `${t}-answer` }] } });
        }) as typeof fetch;
      }
      const tool = createA2ATool({ protocol: 'a2a', endpoint: remote === 'gnl' ? 'http://remote/agents/helper' : 'http://other/a/', agentName: 'helper', fetchImpl });
      const seen: string[] = [];
      await runDurable({ runId: `k3-a2a-${remote}-${ids.join('-')}`, journal: new InMemoryJournal(), model: parent(ids, seen), tools: { remote: tool } as any, prompt: 'ask twice', stopWhen: stepCountIs(5) } as any);
      console.log(`[A2A ${remote} ${ids}] remote tasks=${JSON.stringify(tasks)} seen=${JSON.stringify(seen.slice(1)).slice(0, 300)}`);
      expect(tasks).toEqual(['acme', 'globex']);
      expect(seen[1]).toContain('acme-answer');
      expect(seen[2], 'the second step gets its own answer').toContain('globex-answer');
    });
  }
});
