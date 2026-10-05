// createA2ATool's standard A2A mode: agent card + JSON-RPC message/send, against a GNL agent served by
// createA2AServer and against a hand-written non-GNL A2A agent.
import { describe, it, expect } from 'vitest';
import { z } from 'zod';
import { InMemoryJournal } from '@gnldev/durable';
import { createA2ATool } from '../src/index.js';
import { createA2AServer } from '../src/server.js';
import { textModel, chargeModel } from './models.js';

const exec = (t: any, task: string, toolCallId: string) => t.execute({ task }, { toolCallId, messages: [] });

function gnlAgents(calls: { n: number }) {
  return createA2AServer({
    journal: new InMemoryJournal(),
    agents: {
      helper: { model: textModel('from gnl', calls) },
      pay: {
        model: chargeModel(),
        tools: { charge: { description: 'charge', inputSchema: z.object({ amount: z.number() }), execute: async () => ({ ok: true }) } },
        guard: async () => ({ action: 'require-approval' as const, reason: 'big amount' }),
      },
    },
  } as never);
}

describe("createA2ATool({ protocol: 'a2a' })", () => {
  it('reads the card, sends message/send, and a re-sent call is replayed, not re-run', async () => {
    const calls = { n: 0 };
    const serve = gnlAgents(calls);
    const seen: string[] = [];
    const fetchImpl = (async (url: string, init?: RequestInit) => { seen.push(`${init?.method} ${url}`); return serve(new Request(url, init)); }) as typeof fetch;
    const t = createA2ATool({ protocol: 'a2a', endpoint: 'http://remote/agents/helper', agentName: 'helper', fetchImpl });
    const a = await exec(t, 'hi', 'call-1');
    const b = await exec(t, 'hi', 'call-1');
    expect(a).toMatchObject({ text: 'from gnl', remoteAgent: 'helper' });
    expect(b.runId).toBe(a.runId);
    expect(calls.n).toBe(1);
    // The card is read once per tool.
    expect(seen.filter((s) => s.startsWith('GET')).length).toBe(1);
    expect(seen).toContain('POST http://remote/agents/helper');
  });

  it('an input-required task comes back as interrupts, like a suspended GNL run', async () => {
    const t = createA2ATool({ protocol: 'a2a', endpoint: 'http://remote/agents/pay', agentName: 'pay', fetchImpl: ((u: string, i?: RequestInit) => gnlAgents({ n: 0 })(new Request(u, i))) as typeof fetch });
    const r = await exec(t, 'charge', 'call-2');
    expect(r.text).toBe('');
    expect(r.interrupts[0]).toMatchObject({ toolCallId: 'c1', toolName: 'charge' });
  });

  it('talks to a non-GNL A2A agent: agent-card.json fallback, a Message result, a JSON-RPC error', async () => {
    const bodies: any[] = [];
    const foreign = (async (url: string, init?: RequestInit) => {
      if (url === 'http://other/a/.well-known/agent-card.json') return Response.json({ name: 'echo', url: 'http://other/rpc', skills: [] });
      if (url === 'http://other/rpc') {
        const b = JSON.parse(String(init?.body)); bodies.push(b);
        if (b.params.message.parts[0].text === 'boom') return Response.json({ jsonrpc: '2.0', id: b.id, error: { code: -32603, message: 'kaput' } });
        return Response.json({ jsonrpc: '2.0', id: b.id, result: { kind: 'message', role: 'agent', messageId: 'r', parts: [{ kind: 'text', text: `echo: ${b.params.message.parts[0].text}` }] } });
      }
      return new Response('nope', { status: 404 });
    }) as typeof fetch;
    const t = createA2ATool({ protocol: 'a2a', endpoint: 'http://other/a/', agentName: 'echo', fetchImpl: foreign });
    expect((await exec(t, 'hello', 'k1')).text).toBe('echo: hello');
    expect(bodies[0]).toMatchObject({ jsonrpc: '2.0', method: 'message/send', params: { message: { role: 'user', messageId: 'k1' } } });
    await expect(exec(t, 'boom', 'k2')).rejects.toThrow(/JSON-RPC error -32603: kaput/);
  });

  it('refuses `secret` in a2a mode — the signature is the REST contract', () => {
    expect(() => createA2ATool({ protocol: 'a2a', endpoint: 'http://x', agentName: 'a', secret: 's' })).toThrow(/secret/);
  });
});
