// The optimizer in a real Studio: studioOptimizer is accepted where Studio takes `optimizer` (a
// type-level contract — the two packages do not import each other), the tab's routes diagnose and
// replay the host's agent over HTTP, and the replay runs no tool.
import { describe, it, expect } from 'vitest';
import { tool } from 'ai';
import { z } from 'zod';
import { runDurable, gnlTool, InMemoryJournal } from '@gnldev/durable';
import { createStudioApi } from '@gnldev/studio';
import { createMockModel } from '../../durable/test/mock.js';
import { studioOptimizer } from '../src/index.js';

let executed = 0;
const refund = gnlTool(tool({ description: 'Refund', inputSchema: z.object({ id: z.string() }), execute: async () => { executed++; return 'ok'; } }), { sideEffect: true });
function planned(modelId: string) {
  let step = 0;
  const m = createMockModel(async () => {
    step++;
    const usage = { inputTokens: 1200, outputTokens: 20 };
    const response = { modelId };
    return step % 2 === 1
      ? { content: [{ type: 'tool-call', toolCallId: `c${step}`, toolName: 'refund', input: '{"id":"a"}' }], finishReason: 'tool-calls', usage, response }
      : { content: [{ type: 'text', text: 'done' }], finishReason: 'stop', usage, response };
  });
  m.modelId = modelId;
  return m;
}

describe('the optimizer tab, end to end', () => {
  it('diagnosis and a replay over HTTP; the agent\'s tool ran once — for the recorded run, never for the replay', async () => {
    const journal = new InMemoryJournal();
    const config = { agents: { support: { model: planned('big'), system: 'refunds', tools: { refund } } } };
    await runDurable({ runId: 'r1', journal, prompt: 'refund a', model: planned('big'), tools: { refund }, agentName: 'support' } as any);
    expect(executed).toBe(1);
    const app = createStudioApi({
      reader: journal,
      optimizer: studioOptimizer({ config, models: { 'small/model': planned('small') }, pricing: { big: { inputPer1M: 10, outputPer1M: 40 }, small: { inputPer1M: 1, outputPer1M: 4 } } }),
    });
    const ask = (path: string, init?: RequestInit) => (app as any)(new Request(`http://studio${path}`, init));
    expect(await (await ask('/optimizer')).json()).toEqual({ agents: ['support'], models: ['small/model'] });
    const d = await (await ask('/optimizer/diagnosis?agent=support')).json();
    expect(d).toMatchObject({ agent: 'support', runs: 1, modelSteps: 2 });
    const res = await ask('/optimizer/replay', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ agent: 'support', model: 'small/model', limit: 5 }) });
    expect(res.status).toBe(200);
    const r = await res.json();
    expect(r.summary).toMatchObject({ replayed: 1, diverged: 0, priced: true });
    expect(r.summary.costRatio).toBeCloseTo(0.1, 9);
    expect(executed).toBe(1);
  });

  it('a candidate model the host did not offer is refused before anything runs or is kept', async () => {
    const opt = studioOptimizer({ config: { agents: { support: {} } }, models: {} });
    const journal = new InMemoryJournal();
    await expect(opt.replay(journal as any, { agent: 'support', model: 'nope' })).rejects.toThrow(/no candidate model named 'nope'/);
    expect(await journal.listKeys!('__optimizer__:')).toEqual([]);
  });

  it('a misspelled option is refused', () => {
    expect(() => studioOptimizer({ config: { agents: {} }, model: {} } as any)).toThrow(/model/);
  });
});
