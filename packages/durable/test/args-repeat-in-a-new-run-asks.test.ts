// d25 U2: a side-effect tool keyed by its arguments (`idempotency: 'args'`, or an `idempotencyKey` in the
// default 'run' window) met a repeat in a NEW run of the same conversation — the chat's next message — with
// neither its record (the 'run' window's key is the run's) nor the duplicate ladder (it skipped 'args' mode):
// the transfer ran a second time, no question, under the 'critical' profile that promises "every repeat is a
// human question". The repeat is now the profile's to answer, as it is for a tool keyed by its call: a QUESTION
// (assistant, critical), never a silent dedup — the person may really mean it twice — and a typed refusal where
// nobody is there to ask (headless). The repeat INSIDE one run is still answered from the record, silently.
import { describe, it, expect, vi, beforeAll } from 'vitest';
import { InMemoryJournal } from '../src/journal.js';
import { createGnl } from '../src/registry.js';
import { createMockModel, countToolResults, toolCallResult, finalTextResult } from './mock.js';

beforeAll(() => { vi.spyOn(console, 'warn').mockImplementation(() => {}); });

/** Each run's model asks for the same transfer `perRun` times (fresh call ids), then answers. */
function bank(preset: 'critical' | 'assistant' | 'headless' | undefined, decl: Record<string, unknown>, perRun = 1) {
  let n = 0;
  const model = createMockModel(async ({ prompt }: any) =>
    countToolResults(prompt) < perRun ? toolCallResult('transfer', `c${++n}`, { to: 'B', amount: 100 }) : finalTextResult('done'));
  let executions = 0;
  const gnl = createGnl({
    journal: new InMemoryJournal(), ...(preset ? { preset } : {}),
    agents: { bank: { model, tools: { transfer: { sideEffect: true, effectClass: 'transactional', ...decl, execute: async () => { executions++; return { ok: true }; } } } } },
  } as any);
  const message = (runId: string, approvals?: Record<string, boolean>) =>
    gnl.run('bank', { runId, threadId: 'T', resourceId: 'u', prompt: 'send 100 to B', ...(approvals ? { approvals } : {}) } as any) as Promise<any>;
  return { message, executions: () => executions };
}

const ARGS = { idempotency: 'args', recover: async () => ({ done: false }) };
const KEY_RUN = { idempotencyKey: (a: any) => `${a.to}:${a.amount}`, idempotencyWindow: 'run' };

describe("an 'args' tool's repeat in a new run of the conversation (d25 U2)", () => {
  for (const [preset, decl, name] of [['critical', ARGS, "idempotency:'args' + recover"], ['assistant', { idempotency: 'args' }, "idempotency:'args'"], ['critical', KEY_RUN, "idempotencyKey, 'run' window"]] as const) {
    it(`${preset}, ${name}: the second message is a human question; a yes runs it again, a no does not`, async () => {
      for (const answer of [true, false]) {
        const b = bank(preset, decl);
        await b.message('m1');
        const r2 = await b.message('m2');
        expect(b.executions(), 'not run silently').toBe(1);
        expect(r2.interrupts).toHaveLength(1);
        expect(r2.interrupts[0]).toMatchObject({ kind: 'duplicate', toolName: 'transfer' });
        expect(r2.interrupts[0].reason).toMatch(/already succeeded with identical arguments earlier in this conversation/);
        await b.message('m2', { [r2.interrupts[0].toolCallId]: answer });
        expect(b.executions(), answer ? 'a deliberate repeat runs once more' : 'refused').toBe(answer ? 2 : 1);
      }
    });
  }

  it('headless (nobody to ask): the repeat is refused, typed, not run', async () => {
    const b = bank('headless', { idempotency: 'args' });
    await b.message('m1');
    await expect(b.message('m2')).rejects.toMatchObject({ name: 'RunLimitExceededError', message: expect.stringMatching(/duplicate blocked, this call was NOT EXECUTED/) });
    expect(b.executions()).toBe(1);
  });

  it('inside ONE run the args record still answers the repeat, silently (unchanged)', async () => {
    const b = bank('critical', ARGS, 2);
    const r = await b.message('m1');
    expect(b.executions()).toBe(1);
    expect(r.interrupts ?? []).toEqual([]);
    expect(r.text).toBe('done');
  });

  it("a wider window ('thread') answers it from the record, as before: once, no question", async () => {
    const b = bank('critical', { idempotencyKey: (a: any) => `${a.to}:${a.amount}`, idempotencyWindow: 'thread' });
    await b.message('m1');
    const r2 = await b.message('m2');
    expect(b.executions()).toBe(1);
    expect(r2.interrupts ?? []).toEqual([]);
  });

  it('no profile: declarations stay inert, as before (runs again)', async () => {
    const b = bank(undefined, { idempotency: 'args' });
    await b.message('m1');
    await b.message('m2');
    expect(b.executions()).toBe(2);
  });
});

describe("an 'args' tool called twice in ONE model step (d25 U2 sibling)", () => {
  for (const preset of ['critical', 'assistant', undefined] as const) {
    it(`${preset ?? 'no profile'}: the twin is answered from the record — once, no question`, async () => {
      let executions = 0;
      const two = { content: [0, 1].map((i) => ({ type: 'tool-call', toolCallId: `t${i}`, toolName: 'transfer', input: JSON.stringify({ to: 'B', amount: 100 }) })), finishReason: toolCallResult('x', 'x', {}).finishReason, usage: toolCallResult('x', 'x', {}).usage, warnings: [] };
      const model = createMockModel(async ({ prompt }: any) => (countToolResults(prompt) === 0 ? two : finalTextResult('done')));
      const gnl = createGnl({
        journal: new InMemoryJournal(), ...(preset ? { preset } : {}),
        agents: { bank: { model, tools: { transfer: { sideEffect: true, effectClass: 'transactional', idempotency: 'args', recover: async () => ({ done: false }), execute: async () => { executions++; await new Promise((r) => setTimeout(r, 30)); return { ok: true }; } } } } },
      } as any);
      const r: any = await gnl.run('bank', { runId: 'm1', threadId: 'T', resourceId: 'u', prompt: 'x' } as any);
      expect(executions).toBe(1);
      expect(r.interrupts ?? []).toEqual([]);
    });
  }
});
