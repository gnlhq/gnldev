// K3 leak sweep, part 1 — every path that reaches the provider THROUGH the engine (runDurable / streamDurable and
// what is built on them). Each one is started with a history that holds GNL call ids; the request the provider
// gets must hold only the provider's own ids. Two observers: a recording fake model and the real @ai-sdk/openai
// provider over a fake fetch.
import { describe, it, expect, vi, beforeAll } from 'vitest';
import { stepCountIs } from 'ai';
import { InMemoryJournal } from '../src/journal.js';
import { runDurable, streamDurable, resumeRun } from '../src/run.js';
import { rolloverRun } from '../src/rollover.js';
import { forkRun } from '../src/time-travel.js';
import { replayRun } from '../src/regression.js';
import { withModelFallback } from '../src/model-router.js';
import { createAgentTool } from '../src/agent-tool.js';
import { createMockModel, toolCallResult, countToolResults } from './mock.js';
import { CAPS, leakCheck, expectCalls, gnlHistory, pay, recorder } from './k3x-leak-kit.js';

beforeAll(() => { vi.spyOn(console, 'warn').mockImplementation(() => {}); });

for (const [kind, mk] of CAPS) {
  describe(`[${kind}] provider request carries only provider ids`, () => {
    it('L1 main run, generate: step 2 carries step 1 (control)', async () => {
      const cap = mk('tool-then-text'); const paid: number[] = [];
      await runDurable({ runId: `l1-${kind}`, journal: new InMemoryJournal(), model: cap.model, tools: { pay: pay(paid) }, stopWhen: stepCountIs(6), prompt: 'go' } as any);
      expect(paid).toEqual([5]); leakCheck(cap, 'L1'); expectCalls(cap, 'L1');
    });
    it('L2 main run, stream (agui / chat / server / studio door): step 2 carries step 1 (control)', async () => {
      const cap = mk('tool-then-text'); const paid: number[] = [];
      const r: any = await streamDurable({ runId: `l2-${kind}`, journal: new InMemoryJournal(), model: cap.model, tools: { pay: pay(paid) }, stopWhen: stepCountIs(6), prompt: 'go' } as any);
      await r.text; leakCheck(cap, 'L2'); expectCalls(cap, 'L2');
    });
    it('L3 next turn: client / memory history with GNL ids as `messages` (chat, AG-UI, A2A, MCP, studio doors) — generate', async () => {
      const h = await gnlHistory(`l3h-${kind}`); const cap = mk('text');
      await runDurable({ runId: `l3-${kind}`, journal: new InMemoryJournal(), model: cap.model, tools: { pay: pay() }, stopWhen: stepCountIs(4), messages: [...h.messages, { role: 'user', content: 'again?' }] } as any);
      leakCheck(cap, 'L3'); expectCalls(cap, 'L3');
    });
    it('L3s same, stream', async () => {
      const h = await gnlHistory(`l3sh-${kind}`); const cap = mk('text');
      const r: any = await streamDurable({ runId: `l3s-${kind}`, journal: new InMemoryJournal(), model: cap.model, tools: { pay: pay() }, stopWhen: stepCountIs(4), messages: [...h.messages, { role: 'user', content: 'again?' }] } as any);
      await r.text; leakCheck(cap, 'L3s'); expectCalls(cap, 'L3s');
    });
    it('L4 crash then resumeRun: the step after the crash is sent the earlier steps', async () => {
      const journal = new InMemoryJournal(); const paid: number[] = [];
      const boom = createMockModel(async ({ prompt }: any) => { if (countToolResults(prompt) === 0) return toolCallResult('pay', 'call_0', { amount: 5 }); throw new Error('boom'); });
      await runDurable({ runId: `l4-${kind}`, journal, model: boom, tools: { pay: pay(paid) }, stopWhen: stepCountIs(6), prompt: 'go', maxRetries: 0 } as any).catch(() => {});
      const cap = mk('text');
      await resumeRun(`l4-${kind}`, { journal, model: cap.model, tools: { pay: pay(paid) }, stopWhen: stepCountIs(6) } as any);
      expect(paid).toEqual([5]); leakCheck(cap, 'L4'); expectCalls(cap, 'L4');
    });
    it('L5 rollover: the next period continues from the old run\'s messages', async () => {
      const h = await gnlHistory(`l5-${kind}`); const cap = mk('text');
      const r = await rolloverRun(h.journal, h.runId);
      await resumeRun(r.newRunId, { journal: h.journal, model: cap.model, tools: { pay: pay() }, stopWhen: stepCountIs(4) } as any);
      leakCheck(cap, 'L5'); expectCalls(cap, 'L5');
    });
    it('L6 model-router fallback: the second candidate is sent the history', async () => {
      const h = await gnlHistory(`l6h-${kind}`); const cap = mk('text'); const journal = new InMemoryJournal();
      const down = createMockModel(async () => { throw new Error('upstream down'); });
      const chain = withModelFallback([{ spec: 'a/down', model: down }, { spec: 'b/up', model: cap.model }] as any, journal, `l6-${kind}`);
      await runDurable({ runId: `l6-${kind}`, journal, model: chain, tools: { pay: pay() }, stopWhen: stepCountIs(4), maxRetries: 0, messages: [...h.messages, { role: 'user', content: 'again?' }] } as any);
      leakCheck(cap, 'L6'); expectCalls(cap, 'L6');
    });
    it('L7 sub-agent (agent-as-tool): the child\'s own second step is sent its first', async () => {
      const journal = new InMemoryJournal(); const cap = mk('tool-then-text');
      const ask = createAgentTool({ journal, model: cap.model, tools: { pay: pay() }, maxSteps: 6 } as any);
      const parent = createMockModel(async ({ prompt }: any) => (countToolResults(prompt) === 0 ? toolCallResult('ask', 'p_0', { task: 'pay 5' }) : { content: [{ type: 'text', text: 'done' }], finishReason: 'stop', usage: { inputTokens: 1, outputTokens: 1 }, warnings: [] }));
      await runDurable({ runId: `l7-${kind}`, journal, model: parent, tools: { ask } as any, stopWhen: stepCountIs(6), prompt: 'delegate' } as any);
      leakCheck(cap, 'L7'); expectCalls(cap, 'L7');
    });
    it('L8 forkRun + resume: the fork\'s next step is sent the copied steps', async () => {
      const h = await gnlHistory(`l8-${kind}`); const cap = mk('text');
      const f = await forkRun(h.journal, h.runId, 1);
      await resumeRun(f.newRunId, { journal: h.journal, model: cap.model, tools: { pay: pay() }, stopWhen: stepCountIs(4) } as any);
      leakCheck(cap, 'L8'); expectCalls(cap, 'L8');
    });
    it('L9 replayRun (regression) over a run whose recorded input holds GNL ids', async () => {
      const h = await gnlHistory(`l9h-${kind}`); const cap = mk('text'); const journal = new InMemoryJournal();
      await runDurable({ runId: `l9src-${kind}`, journal, model: recorder('text').model, tools: { pay: pay() }, stopWhen: stepCountIs(4), messages: [...h.messages, { role: 'user', content: 'again?' }] } as any);
      await replayRun({ journal, runId: `l9src-${kind}`, newRunId: `l9-${kind}`, model: cap.model, tools: { pay: pay() }, stopWhen: stepCountIs(4) } as any);
      leakCheck(cap, 'L9'); expectCalls(cap, 'L9');
    });
  });
}
