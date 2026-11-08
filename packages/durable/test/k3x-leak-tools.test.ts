// K3 leak sweep, part 2 — paths that call a model WITHOUT going through the engine's model boundary
// (withDurableModel): the lab, the experiment replay, memory's observer/reflector. Each is handed a history that
// holds GNL ids (what a chat client, memory or a Studio-kept thread holds); the provider must get only its own ids.
import { describe, it, expect, vi, beforeAll } from 'vitest';
import { stepCountIs } from 'ai';
import { InMemoryJournal } from '../src/journal.js';
import { runDurable } from '../src/run.js';
import { replayCounterfactual } from '../../experiment/src/index.js';
import { playAgent, runScenarios, checkPrune, sampledToolChoice } from '../../lab/src/index.js';
import { guessPrompt } from '../../lab/src/thread-diagnose.js';
import { observe, reflect } from '../../memory/src/observational.js';
import { CAPS, GNL, leakCheck, expectCalls, gnlHistory, pay, recorder } from './k3x-leak-kit.js';

beforeAll(() => { vi.spyOn(console, 'warn').mockImplementation(() => {}); });
const user = { role: 'user', content: 'again?' };
const payDef = { name: 'pay', description: 'pay', parameters: { type: 'object', properties: { amount: { type: 'number' } } }, otherwise: { output: { ok: true } } };

for (const [kind, mk] of CAPS) {
  describe(`[${kind}] non-engine model callers`, () => {
    it('T1 experiment replayCounterfactual: the recorded input (earlier turns, GNL ids) goes to the candidate model', async () => {
      const h = await gnlHistory(`t1h-${kind}`); const journal = new InMemoryJournal();
      await runDurable({ runId: `t1src-${kind}`, journal, model: recorder('text').model, tools: { pay: pay() }, stopWhen: stepCountIs(4), messages: [...h.messages, user] } as any);
      const cap = mk('text');
      await replayCounterfactual({ journal, runId: `t1src-${kind}`, model: cap.model, tools: { pay: pay() } as any, maxSteps: 3 });
      leakCheck(cap, 'T1'); expectCalls(cap, 'T1');
    });
    it('T2 lab playAgent (the page / Studio playground, a kept conversation as messages)', async () => {
      const h = await gnlHistory(`t2h-${kind}`); const cap = mk('text');
      await playAgent({ model: cap.model, agent: { system: 's', tools: [payDef] } as any, messages: [...h.messages, user] as any });
      leakCheck(cap, 'T2'); expectCalls(cap, 'T2');
    });
    it('T3 lab runScenarios (a scenario kept from a run: its messages)', async () => {
      const h = await gnlHistory(`t3h-${kind}`); const cap = mk('text');
      const scenario: any = { v: 1, id: 's1', agent: 'a', title: 't', at: 0, by: 'u', from: { playground: true }, system: 's', messages: [...h.messages, user], expect: {}, results: [], answers: [] };
      await runScenarios({ scenarios: [scenario], model: cap.model, tools: { pay: pay() } as any, trials: 1 });
      leakCheck(cap, 'T3'); expectCalls(cap, 'T3');
    });
    it('T4 lab checkPrune (history before each prompt)', async () => {
      const h = await gnlHistory(`t4h-${kind}`); const cap = mk('text');
      await checkPrune({ model: cap.model, tools: { pay: pay() } as any, systemSections: { a: 'A', b: 'B' }, remove: 'a', history: h.messages, prompts: ['x'], trials: 1, concurrency: 1 } as any);
      leakCheck(cap, 'T4'); expectCalls(cap, 'T4');
    });
    it('T5 lab sampledToolChoice (messages before the text)', async () => {
      const h = await gnlHistory(`t5h-${kind}`); const cap = mk('text');
      await sampledToolChoice({ model: cap.model, tools: { pay: pay() } as any, tool: 'pay', before: h.messages, samples: 1 } as any)('hello');
      leakCheck(cap, 'T5'); expectCalls(cap, 'T5');
    });
  });
}

describe('text prompts that embed a history the engine recorded (the id sits INSIDE the text, not in a tool-call slot)', () => {
  it('T6 lab thread-diagnose guessPrompt: the conversation is JSON-dumped into the guesser\'s prompt', async () => {
    const h = await gnlHistory('t6h');
    const p = guessPrompt({} as any, { runId: 'r', input: { system: 's' }, messages: h.messages } as any, [], []);
    expect(p).not.toContain(GNL);
  });
  for (const [kind, mk] of CAPS) {
    it(`T8 [${kind}] memory observer + reflector: a block of messages with tool calls is summarised as text`, async () => {
      const h = await gnlHistory(`t8h-${kind}`); const cap = mk('text');
      await observe(cap.model, h.messages);
      await reflect(cap.model, [{ text: 'a' }, { text: 'b' }] as any);
      leakCheck(cap, 'T8');
    });
  }
});
