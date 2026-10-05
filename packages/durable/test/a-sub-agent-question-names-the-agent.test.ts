// A sub-agent's question is read by a person — in a chat UI, a nurse approving a dose. It said
// "nested run 'agent:<id>:call-<uuid>'" (measured). It names the sub-agent now; the run id rides in
// `delegatedTo`, a hop at a time.
import { describe, it, expect } from 'vitest';
import { z } from 'zod';
import { InMemoryStorage, createGnl, gnlTool, STAFF } from '../src/index.js';
import { createMockModel, toolCallResult, finalTextResult } from './mock.js';

const dose = gnlTool({ description: 'dose', inputSchema: z.object({}).passthrough(), execute: async () => ({ ok: true }) }, { sideEffect: true, confirm: true } as any);
const calls = (name: string, input: object) => createMockModel(async ({ prompt }: any) => (prompt.some((m: any) => m.role === 'tool') ? finalTextResult('ok') : toolCallResult(name, 'call_0', input)));

describe('a sub-agent question names the sub-agent, not its run', () => {
  it('one level', async () => {
    const r: any = await createGnl({ storage: new InMemoryStorage(), agents: {
      ward: { model: calls('agent_medic', { task: 'dose' }), agents: ['medic'] },
      medic: { model: calls('giveDose', { p: 'P-1' }), tools: { giveDose: dose } },
    } } as any).run('ward', { runId: 'q1', prompt: 'go', caller: STAFF } as any);
    const [q] = r.interrupts;
    expect(q.reason).toMatch(/^The 'medic' sub-agent asks: 'giveDose' requires explicit confirmation/);
    expect(q.reason).not.toContain('agent:q1');
    expect(q.delegatedTo).toEqual({ runId: 'agent:q1:call_0', agent: 'medic' });
  });

  it('two levels: the chain reads by name, the next hop is `via`', async () => {
    const r: any = await createGnl({ storage: new InMemoryStorage(), agents: {
      ward: { model: calls('agent_lead', { task: 'round' }), agents: ['lead'] },
      lead: { model: calls('agent_medic', { task: 'dose' }), agents: ['medic'] },
      medic: { model: calls('giveDose', { p: 'P-1' }), tools: { giveDose: dose } },
    } } as any).run('ward', { runId: 'q2', prompt: 'go', caller: STAFF } as any);
    const [q] = r.interrupts;
    expect(q.reason).toMatch(/^The 'lead' sub-agent asks: The 'medic' sub-agent asks: /);
    expect(q.delegatedTo).toMatchObject({ agent: 'lead', via: { agent: 'medic' } });
  });
});
