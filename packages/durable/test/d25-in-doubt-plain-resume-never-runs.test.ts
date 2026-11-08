// A call left IN DOUBT is never run by a plain resume (d25 doubt1 follow-up; found while adapting the d25-a1 id shapes).
//
// A side-effect refund whose approved first attempt FAILED after the request may have left. The model asks
// again (a new id, 'args' idempotency → the same record); the guard's question over it says the effect "MAY
// already have happened". That question is answered by a person. A resume that carries NO answer is not an
// answer: the side effect must not run a second time.
//
// Written against ids as the system gives them (read from the interrupts), so it runs on any base.
import { describe, it, expect, beforeAll, vi } from 'vitest';
import { z } from 'zod';
import { InMemoryStorage, InMemoryJournal, createGnl, runDurable, STAFF } from '../src/index.js';
import { createMockModel, toolCallResult, finalTextResult, countToolResults } from './mock.js';

beforeAll(() => { vi.spyOn(console, 'warn').mockImplementation(() => {}); });

type Call = { name: string; id: string; input: object };
const script = (calls: Call[]) => createMockModel(async ({ prompt }: any) => {
  const next = calls[countToolResults(prompt)];
  return next ? toolCallResult(next.name, next.id, next.input) : finalTextResult('done');
});

describe('an in-doubt question is not released by a plain resume', () => {
  it('the approved first attempt fails; the repeat is asked about; resuming with no answer runs nothing', async () => {
    let effects = 0;
    let attempts = 0;
    const refund = {
      description: 'refund', inputSchema: z.object({ order: z.number() }).passthrough(),
      sideEffect: true, idempotency: 'args', maxRetries: 5,
      execute: async () => { attempts++; effects++; if (attempts === 1) throw new Error('provider 502 after the request left'); return { refunded: true }; },
    };
    const gnl = createGnl({ storage: new InMemoryStorage(), agents: { a: {
      model: script([{ name: 'refund', id: 'call_0', input: { order: 42 } }, { name: 'refund', id: 'call_1', input: { order: 42 } }]),
      tools: { refund }, guard: async () => ({ action: 'require-approval' as const, reason: 'a human decides' }),
    } } } as any);
    const first: any = await gnl.run('a', { runId: 'doubt-plain', prompt: 'go', caller: STAFF } as any);
    const second: any = await gnl.run('a', { runId: 'doubt-plain', prompt: 'go', caller: STAFF, approvals: { [first.interrupts[0].toolCallId]: true } } as any);
    expect(effects, 'precondition: the approved first attempt ran (and failed)').toBe(1);
    expect(String(second.interrupts[0].reason), 'precondition: the repeat is asked about as in doubt').toMatch(/MAY already have happened/);
    const third: any = await gnl.run('a', { runId: 'doubt-plain', prompt: 'go', caller: STAFF } as any); // no answer
    expect(effects, 'a plain resume ran the side effect again (nobody answered the in-doubt question)').toBe(1);
    expect(third.interrupts.map((i: any) => i.toolCallId)).toEqual(second.interrupts.map((i: any) => i.toolCallId));
  });

  // The same rule without the registry door: nothing parks the run, so every call evaluates it afresh.
  // (On release/0.17.1 `gnl.run` hides this by answering a repeat of a parked run from the parked state;
  // runDurable has no such shortcut and runs the side effect again there too.)
  it('runDurable: the same — a resume with no answer runs nothing', async () => {
    let effects = 0;
    const tools = { refund: {
      description: 'refund', inputSchema: z.object({ order: z.number() }).passthrough(), sideEffect: true, idempotency: 'args', maxRetries: 5,
      execute: async () => { effects++; if (effects === 1) throw new Error('provider 502 after the request left'); return { refunded: true }; },
    } };
    const base: any = {
      journal: new InMemoryJournal(), runId: 'doubt-plain-rd', prompt: 'go', caller: STAFF, tools,
      model: script([{ name: 'refund', id: 'call_0', input: { order: 42 } }, { name: 'refund', id: 'call_1', input: { order: 42 } }]),
      guard: async () => ({ action: 'require-approval' as const, reason: 'a human decides' }),
    };
    const first: any = await runDurable(base);
    const second: any = await runDurable({ ...base, approvals: { [first.interrupts[0].toolCallId]: true } });
    expect(effects, 'precondition: the approved first attempt ran (and failed)').toBe(1);
    expect(String(second.interrupts[0].reason), 'precondition: the repeat is asked about as in doubt').toMatch(/MAY already have happened/);
    await runDurable(base); // no answer
    expect(effects, 'a plain resume ran the side effect again (nobody answered the in-doubt question)').toBe(1);
  });
});
