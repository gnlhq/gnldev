// k3 — one tool call is (run, model step, tool-call id); a provider may repeat the id string (`call_0` in every
// response). Library-level behaviour through the public API (runDurable, createAgentTool, compensateRun):
//
//   R3  cross-run: a thread-window replay in a second run whose call has the same id as the first run's is
//       still disclosed as earlier work (to the model: the replay note; to the caller: origin), not as "self".
//   R4  sub-agent: two delegations in one run with the same id → two separate child runs, each task gets its
//       own answer.
//   N   nested approval (addressedId): two delegations with the same id, each child asks a person; approving
//       the first does not answer the second.
//   C   compensation: two steps with the same id that both ran are each unwound with their own arguments.
//
// Each case also runs with distinct ids (the control: today's behaviour, shows the expectation is reachable).
import { describe, it, expect, vi, beforeAll } from 'vitest';
import { stepCountIs } from 'ai';
import { z } from 'zod';
import { runDurable, createAgentTool, compensateRun, InMemoryStorage, InMemoryJournal } from '../src/index.js';
import { createMockModel, countToolResults, toolCallResult, finalTextResult, streamFromGenerate } from './mock.js';

beforeAll(() => { vi.spyOn(console, 'warn').mockImplementation(() => {}); });
const lastToolOutput = (prompt: any[]) => JSON.stringify((prompt ?? []).filter((m: any) => m.role === 'tool').at(-1)?.content?.at(-1)?.output ?? null);
const usage = { inputTokens: 1, outputTokens: 1, totalTokens: 2 };

describe('k3 R3 — a cross-run replay is disclosed as earlier work even when the two calls share an id', () => {
  const scenario = async (ids: [string, string]) => {
    const journal = new InMemoryJournal();
    const state = { n: 0 };
    const tools = { order: { description: 'order', inputSchema: z.object({ sku: z.string() }), sideEffect: true, idempotency: 'args' as const, idempotencyWindow: 'thread' as const, recover: async () => ({ done: false as const }), execute: async (a: unknown) => { state.n++; return { ok: true, order: a }; } } };
    const mk = (id: string, prompts: string[]) => createMockModel(async ({ prompt }: any) => { prompts.push(JSON.stringify(prompt)); return countToolResults(prompt) === 0 ? toolCallResult('order', id, { sku: 'abc' }) : finalTextResult('done'); });
    const p1: string[] = []; const p2: string[] = [];
    await runDurable({ runId: 'r3-1', journal, threadId: 'th-1', prompt: 'order abc', model: mk(ids[0], p1), tools, stopWhen: stepCountIs(4), replayDisclosure: 'explain' } as any);
    const r2: any = await runDurable({ runId: 'r3-2', journal, threadId: 'th-1', prompt: 'order abc', model: mk(ids[1], p2), tools, stopWhen: stepCountIs(4), replayDisclosure: 'explain' } as any);
    const lastPrompt = p2.at(-1) ?? '';
    return { executed: state.n, origins: (r2.replayedToolCalls ?? []).map((e: any) => e.origin), note: lastPrompt.includes('[gnl]') };
  };
  for (const ids of [['call_0', 'call_0'], ['c-A', 'c-B']] as Array<[string, string]>) {
    it(`ids=${ids}: executed once; the second run is told it got the record of earlier work`, async () => {
      const got = await scenario(ids);
      const ref = await scenario(['c-A', 'c-B']);
      console.log(`[R3 ${ids}] got=${JSON.stringify(got)} control=${JSON.stringify(ref)}`);
      expect(got.executed).toBe(1);
      expect(got.origins, 'the caller is told the answer came from another run, as with distinct ids').toEqual(ref.origins);
      expect(got.origins).not.toContain('self');
      expect(got.note, 'the model is told (the replay note), as with distinct ids').toBe(ref.note);
      expect(got.note).toBe(true);
    });
  }
});

/** A parent that delegates `tasks` in order (one per step), call id ids[n]; records what it saw after each. */
function delegatingParent(tasks: string[], ids: string[], seen: string[]) {
  return {
    specificationVersion: 'v2', provider: 'scripted', modelId: 'p', supportedUrls: {},
    doGenerate: async ({ prompt }: any) => {
      const n = (prompt ?? []).filter((m: any) => m.role === 'tool').length;
      if (n >= 1) seen[n] = lastToolOutput(prompt);
      if (n < tasks.length) return { content: [{ type: 'tool-call', toolCallId: ids[n], toolName: 'ask', input: JSON.stringify({ task: tasks[n] }) }], finishReason: 'tool-calls', usage, warnings: [] };
      return { content: [{ type: 'text', text: 'ok' }], finishReason: 'stop', usage, warnings: [] };
    },
    doStream: async function (this: any, o: any) { return streamFromGenerate(this, o); },
  } as any;
}

describe('k3 R4 — two delegations in one run with the same id are two sub-agent runs', () => {
  for (const ids of [['stable', 'stable'], ['stable', 'other']]) {
    it(`ids=${ids}: the sub-agent runs twice and each task gets its own answer`, async () => {
      const storage = new InMemoryStorage();
      const journal = storage.runs;
      let subCalls = 0;
      const sub: any = {
        specificationVersion: 'v2', provider: 'scripted', modelId: 'sub', supportedUrls: {},
        doGenerate: async ({ prompt }: any) => { subCalls++; const t = JSON.stringify(prompt).includes('acme') ? 'acme-answer' : 'globex-answer'; return { content: [{ type: 'text', text: t }], finishReason: 'stop', usage, warnings: [] }; },
        doStream: async function (this: any, o: any) { return streamFromGenerate(this, o); },
      };
      const ask = createAgentTool({ journal, model: sub } as any);
      const seen: string[] = [];
      await runDurable({ runId: 'r4-' + ids.join('-'), journal, model: delegatingParent(['acme', 'globex'], ids, seen), tools: { ask } as any, prompt: 'ask twice', stopWhen: stepCountIs(5) } as any);
      const listed: any = await (journal as any).listRuns();
      const children = (Array.isArray(listed) ? listed : listed.items ?? []).filter((r: any) => r.parentRunId === 'r4-' + ids.join('-'));
      console.log(`[R4 ${ids}] subCalls=${subCalls} children=${children.length} seen=${JSON.stringify(seen.slice(1))}`);
      expect(subCalls).toBe(2);
      expect(children.length, 'two child runs').toBe(2);
      expect(seen[1]).toContain('acme-answer');
      expect(seen[2], 'the second task gets its own answer, not the first one\'s').toContain('globex-answer');
    });
  }
});

describe('k3 N — a nested approval (addressed through the delegation) answers only its own delegation', () => {
  for (const ids of [['stable', 'stable'], ['stable', 'other']]) {
    it(`parent ids=${ids}, both children ask with call_0: approving the first does not run the second`, async () => {
      const storage = new InMemoryStorage();
      const journal = storage.runs;
      const paid: number[] = [];
      const child = createMockModel(async ({ prompt }: any) => {
        const amount = JSON.stringify(prompt).includes('pay 7') ? 7 : 5;
        return countToolResults(prompt) === 0 ? toolCallResult('pay', 'call_0', { amount }) : finalTextResult(`paid ${amount}`);
      });
      const ask = createAgentTool({ journal, model: child, tools: { pay: { description: 'pay', inputSchema: z.object({ amount: z.number() }), sideEffect: true, confirm: true, execute: async (a: any) => { paid.push(a.amount); return { charged: a.amount }; } } } } as any);
      const seen: string[] = [];
      const runId = 'n-' + ids.join('-');
      const go = (approvals?: Record<string, boolean>) => runDurable({ runId, journal, model: delegatingParent(['pay 5', 'pay 7'], ids, seen), tools: { ask } as any, prompt: 'pay 5 then 7', stopWhen: stepCountIs(6), ...(approvals ? { approvals } : {}) } as any);
      const r1: any = await go();
      expect(r1.interrupts.length, 'precondition: the first child asks').toBe(1);
      const q1 = r1.interrupts[0].toolCallId;
      const r2: any = await go({ [q1]: true });
      console.log(`[N ${ids}] q1=${q1} after approving q1: paid=${JSON.stringify(paid)} q=${JSON.stringify(r2.interrupts.map((i: any) => [i.toolCallId, i.args]))} seen=${JSON.stringify(seen.slice(1))}`);
      expect(paid).toEqual([5]);
      expect(r2.interrupts.length, 'the second child\'s pay 7 is asked').toBe(1);
      const q2 = r2.interrupts[0].toolCallId;
      await go({ [q1]: true, [q2]: true });
      expect(paid).toEqual([5, 7]);
    });
  }
});

describe('k3 C — compensation unwinds each call of a run with its own arguments', () => {
  for (const ids of [['call_0', 'call_0'], ['call_0', 'call_1']]) {
    it(`ids=${ids}: pay 5 and pay 7 both ran, each is unwound once with its own amount`, async () => {
      const journal = new InMemoryJournal();
      const paid: number[] = []; const refunds: number[] = [];
      const tools = { pay: { description: 'pay', inputSchema: z.object({ amount: z.number() }), sideEffect: true, execute: async (a: any) => { paid.push(a.amount); return { charged: a.amount }; }, compensate: async (input: any, output: any) => { refunds.push(input?.amount ?? output?.charged); return { refunded: true }; } } };
      const model = createMockModel(async ({ prompt }: any) => {
        const n = countToolResults(prompt);
        if (n === 0) return toolCallResult('pay', ids[0], { amount: 5 });
        if (n === 1) return toolCallResult('pay', ids[1], { amount: 7 });
        return finalTextResult('done');
      });
      await runDurable({ runId: 'c-' + ids.join('-'), journal, model, tools, prompt: 'pay 5 then 7', stopWhen: stepCountIs(5) } as any);
      const report = await compensateRun('c-' + ids.join('-'), { journal, tools } as any);
      console.log(`[C ${ids}] paid=${JSON.stringify(paid)} refunds=${JSON.stringify(refunds)} entries=${JSON.stringify(report.entries.map((e) => e.status))}`);
      expect(paid).toEqual([5, 7]);
      expect([...refunds].sort()).toEqual([5, 7]);
    });
  }
});
