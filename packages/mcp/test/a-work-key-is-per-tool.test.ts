// A work key names work within ONE tool: the same key sent to two tools is two runs, never one tool's
// result returned as the other's. The id is derived server-side from the tool's name and the key
// (`resolveWorkIdentity('mcp:<tool>', …)`); a client cannot send a runId at all — so the rule a runId
// belongs to its target holds here by construction, which this pins.
import { describe, it, expect } from 'vitest';
import { InMemoryJournal } from '@gnldev/durable';
import { createMcpServer } from '../src/server.js';

describe('the same work key on two tools', () => {
  it('runs each tool once and answers each with its own result', async () => {
    const ran: string[] = [];
    const s = createMcpServer({
      journal: new InMemoryJournal(),
      identify: () => ({ kind: 'subject', id: 'u1', roles: [] }),
      allowTool: () => true,
      tools: {
        charge: { description: 'c', execute: async () => { ran.push('charge'); return { from: 'charge' }; } },
        refund: { description: 'r', execute: async () => { ran.push('refund'); return { from: 'refund' }; } },
      },
    } as any);
    const text = (r: any) => JSON.stringify(r);
    const a = await s.callTool({ name: 'charge', arguments: {}, idempotencyKey: 'inv-7', caller: {} });
    const b = await s.callTool({ name: 'refund', arguments: {}, idempotencyKey: 'inv-7', caller: {} });
    const a2 = await s.callTool({ name: 'charge', arguments: {}, idempotencyKey: 'inv-7', caller: {} });
    expect(text(a)).toContain('charge');
    expect(text(b)).toContain('refund');
    expect(text(b)).not.toContain('"from":"charge"');
    expect(text(a2), 'the same tool and key replays').toContain('charge');
    expect(ran).toEqual(['charge', 'refund']);
  });
});
