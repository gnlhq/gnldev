// A call that names nobody, refused on somebody's run, is told how to name someone; a caller who named
// someone and was refused is told nothing more. Measured before: the support-desk example resumed a
// customer's refund from its approval route with no `caller`, met "belongs to a different subject" and
// no way through, and the refund never happened.
import { describe, it, expect } from 'vitest';
import { InMemoryJournal, createGnl, resumeRun, STAFF, user } from '@gnldev/durable';
import { tool } from 'ai';
import { z } from 'zod';

const usage = { inputTokens: 1, outputTokens: 1, totalTokens: 2 };
const model: any = {
  specificationVersion: 'v2', provider: 'mock', modelId: 'm', supportedUrls: {},
  doGenerate: async (o: any) => (o.prompt ?? []).some((m: any) => m.role === 'tool')
    ? { content: [{ type: 'text', text: 'done' }], finishReason: 'stop', usage, warnings: [] }
    : { content: [{ type: 'tool-call', toolCallId: 'tc1', toolName: 'refund', input: '{}' }], finishReason: 'tool-calls', usage, warnings: [] },
};
const tools = { refund: tool({ inputSchema: z.object({}), execute: async () => 'refunded' }) } as any;
const guard = ({ toolName }: any) => (toolName === 'refund' ? { action: 'require-approval' as const, reason: 'a human approves refunds' } : { action: 'allow' as const });

async function suspended() {
  const journal = new InMemoryJournal();
  const gnl = createGnl({ journal, agents: { a: { model, tools, guard } } } as any);
  const r = await gnl.run('a', { runId: 'r1', prompt: 'refund', resourceId: 'cust-1' });
  expect(r.interrupts, 'PRECONDITION: the run did not suspend for approval').toHaveLength(1);
  return journal;
}

describe('the owner refusal says how to name someone — only to a call that named nobody', () => {
  it('no caller → refused, and the message names `caller` and `STAFF`', async () => {
    const journal = await suspended();
    const err = await resumeRun('r1', { journal, model, tools, guard, approvals: { tc1: true } } as any).then(() => undefined, (e) => e);
    expect(err?.name).toBe('RunOwnerMismatchError');
    expect(err.message).toMatch(/pass `caller`.*`STAFF`/);
  });
  it('another user → refused, and the message adds nothing', async () => {
    const journal = await suspended();
    const err = await resumeRun('r1', { journal, model, tools, guard, approvals: { tc1: true }, caller: user('mallory') } as any).then(() => undefined, (e) => e);
    expect(err?.name).toBe('RunOwnerMismatchError');
    expect(err.message).not.toMatch(/STAFF|caller/);
  });
  it('STAFF → the run continues as the customer it was started for', async () => {
    const journal = await suspended();
    const r = await resumeRun('r1', { journal, model, tools, guard, approvals: { tc1: true }, caller: STAFF } as any);
    expect(r.text).toBe('done');
  });
});
