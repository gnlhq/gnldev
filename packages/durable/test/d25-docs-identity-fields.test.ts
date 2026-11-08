// What identityOf(options) really returns inside a tool, and what serverIdentityOf returns for a direct call (d25 docs).
import { describe, it, expect } from 'vitest';
import { z } from 'zod';
import { InMemoryJournal } from '../src/journal.js';
import { createGnl, serverIdentityOf } from '../src/registry.js';
import { identityOf } from '../src/run-identity.js';
import { createMockModel, countToolResults, toolCallResult, finalTextResult } from './mock.js';

describe('identityOf / serverIdentityOf as documented', () => {
  it('a tool sees runId, threadId and the user; a dynamic tools function sees the identity the engine resolved on a direct call (no organization: none was sealed)', async () => {
    let seen: any; let sealed: any;
    const model = createMockModel(async ({ prompt }: any) => countToolResults(prompt) === 0 ? toolCallResult('who', 'c1', {}) : finalTextResult('ok'));
    const gnl = createGnl({
      journal: new InMemoryJournal(),
      agents: { a: { model,
        tools: ((ctx: any) => { sealed = serverIdentityOf(ctx); return { who: { description: 'w', inputSchema: z.object({}), execute: async (_i: unknown, o: unknown) => { seen = identityOf(o); return 'x'; } } }; }) as any } },
    } as any);
    await gnl.run('a', { runId: 'r1', threadId: 'T1', resourceId: 'u1', prompt: 'hi' } as any);
    expect(seen).toMatchObject({ kind: 'user', id: 'u1', runId: 'r1', threadId: 'T1' });
    // d25 P2-7: a direct call binds what the engine resolved (it was `{}` before); an organization is never invented, so a tools function that keys on `orgId` still gets none
    expect(sealed).toEqual({ resourceId: 'u1', threadId: 'T1' });
    expect(sealed.orgId).toBeUndefined();
  });
});
