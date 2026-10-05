// EVIDENCE: what a standard A2A client does, step by step, against a GNL agent.
//
// A client that speaks the Agent2Agent protocol (JSON-RPC binding, 0.2.x/0.3.x shape) does two things
// and nothing GNL-specific: it fetches the agent card from `<agent base>/.well-known/agent.json`
// (`agent-card.json` from 0.3), then POSTs a JSON-RPC 2.0 `message/send` to the card's `url`.
// Before `createA2AServer`, @gnldev/a2a could only CALL a GNL server's own REST route, and that REST
// API (`createRestApi`) answered both steps with 404 — measured on 770f14fe: GET
// /.well-known/agent.json → 404, POST /agents/a {jsonrpc:'2.0',method:'message/send'} → 404.
// This test is written with plain fetch on purpose: no GNL helper, only what any A2A client sends.
import { describe, it, expect } from 'vitest';
import { InMemoryJournal } from '@gnldev/durable';
import { createA2AServer } from '../src/server.js';
import { textModel } from './models.js';

describe('a standard A2A client against a GNL agent', () => {
  it('reads the agent card, then gets a completed Task from message/send', async () => {
    const serve = createA2AServer({ journal: new InMemoryJournal(), agents: { helper: { model: textModel('hello from gnl'), description: 'Answers questions' } } } as never);
    const fetchA2A = (url: string, init?: RequestInit) => serve(new Request(url, init));

    const cardRes = await fetchA2A('http://localhost/agents/helper/.well-known/agent.json');
    expect(cardRes.status).toBe(200);
    const card = await cardRes.json();
    expect(card).toMatchObject({ name: 'helper', description: 'Answers questions', url: 'http://localhost/agents/helper' });
    expect(card.skills.length).toBeGreaterThan(0);
    expect(card.capabilities).toMatchObject({ streaming: false });

    const res = await fetchA2A(card.url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        jsonrpc: '2.0', id: 1, method: 'message/send',
        params: { message: { kind: 'message', role: 'user', messageId: 'm-1', parts: [{ kind: 'text', text: 'hi' }] } },
      }),
    });
    expect(res.status).toBe(200);
    const rpc = await res.json();
    expect(rpc).toMatchObject({ jsonrpc: '2.0', id: 1 });
    expect(rpc.result).toMatchObject({ kind: 'task', status: { state: 'completed' } });
    expect(rpc.result.artifacts[0].parts[0]).toEqual({ kind: 'text', text: 'hello from gnl' });
  });
});
