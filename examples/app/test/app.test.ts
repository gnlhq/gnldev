// The support desk's "Try it" path, asserted: open a ticket, ask for a refund, the refund waits for a
// human, approving it refunds once — and approving again does not refund twice. Driven through the
// app's own routes, as the browser UI drives them.
import { describe, it, expect } from 'vitest';
import { InMemoryStorage } from '@gnldev/durable';
import { buildSupport } from '../src/agent.js';
import { buildServer } from '../src/server.js';

async function desk() {
  const storage = new InMemoryStorage();
  const state = { refunds: { count: 0, total: 0 } };
  const { gnl, memory, resume } = await buildSupport(storage as any, state);
  const { app } = buildServer({ storage: storage as any, gnl, resume, memory, state });
  const post = async (path: string, body: unknown) => (await app.request(path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })).json() as Promise<any>;
  return { app, state, post };
}

describe('the support desk', () => {
  it('a refund waits for approval, then happens exactly once', async () => {
    const { state, post } = await desk();
    const { ticketId } = await post('/api/tickets', { customerId: 'cust-1', subject: 'refund' });
    const asked = await post(`/api/tickets/${ticketId}/messages`, { text: 'I want a refund for ORD-1042' });
    expect(asked.pending, 'the refund did not wait for a human').not.toBeNull();
    expect(state.refunds.count).toBe(0);

    await post(`/api/tickets/${ticketId}/approve`, { approve: true });
    expect(state.refunds.count).toBe(1);

    const again = await post(`/api/tickets/${ticketId}/approve`, { approve: true });
    expect(again.error).toBe('no pending approval');
    expect(state.refunds.count, 'a second approval refunded twice').toBe(1);
  });
});
