// P2 (AUDIT-R2): tokenLimiter — the one trim of the package (tokenLimit is it with defaults). Whole turns;
// the current turn is never cut, and stops the run when it alone is over the limit.
import { describe, it, expect } from 'vitest';
import { InMemoryJournal, createProcessorCtx, readProcessorReports, ProcessorTripwire } from '@gnldev/durable';
import { tokenLimiter } from '../src/token-limiter.js';
import { tokenLimit } from '../src/safety.js';

const ctx = { runId: 'r', journal: {} as any, step: async (_n: string, c: any) => c() } as any;
const u = (c: string) => ({ role: 'user', content: c });
const a = (c: string) => ({ role: 'assistant', content: c });
const sys = (c: string) => ({ role: 'system', content: c });

describe('tokenLimiter — under limit', () => {
  it('leaves the input untouched when under maxInputTokens', () => {
    const input = { system: 'sys', messages: [u('hello'), a('hi')] };
    const out = tokenLimiter({ maxInputTokens: 1000 }).processInput!(input, ctx) as any;
    expect(out).toEqual(input);
  });
});

describe('tokenLimiter — trim-oldest (default)', () => {
  it('trims oldest non-protected messages first, keeping system + the last user message', () => {
    // Each 'x'.repeat(40) message ≈ 10 tokens (char/4 heuristic). Budget 25 tokens.
    const big = 'x'.repeat(40); // ~10 tokens
    const messages = [
      sys('system prompt'),      // protected (role: system)
      u(big),                    // oldest droppable — index 1
      a(big),                    // index 2
      u(big),                    // index 3
      a(big),                    // index 4
      u(big),                    // LAST user message — protected, index 5
    ];
    const out = tokenLimiter({ maxInputTokens: 25 }).processInput!({ messages }, ctx) as any;
    const roles = out.messages.map((m: any) => m.role);
    // system + last user are always present; oldest droppable entries are removed first.
    expect(out.messages[0]).toBe(messages[0]); // system kept
    expect(out.messages[out.messages.length - 1]).toBe(messages[5]); // last user kept
    expect(out.messages.length).toBeLessThan(messages.length);
    // Whatever remains besides system/last-user must be more recent than what was dropped:
    // i.e. index 1 (oldest droppable) must be gone if anything was dropped at all.
    expect(out.messages).not.toContain(messages[1]);
    expect(roles).toContain('system');
    expect(roles.filter((r: string) => r === 'user').length).toBeGreaterThanOrEqual(1);
  });

  it('the current turn alone over budget stops the run, naming the turn — it is never cut', () => {
    const huge = 'y'.repeat(4000); // ~1000 tokens
    const messages = [u('short'), a('short'), u(huge)];
    const proc = tokenLimiter({ maxInputTokens: 5 });
    expect(() => proc.processInput!({ messages }, ctx)).toThrow(ProcessorTripwire);
    expect(() => proc.processInput!({ messages }, ctx)).toThrow(/current turn alone is ~1000 tokens, over the 5 limit/);
  });

  it('never drops system messages (keepSystem default true); the older turn between goes whole', () => {
    const huge = 'y'.repeat(4000);
    const messages = [sys('system rules'), u(huge), u('final question')];
    const out = tokenLimiter({ maxInputTokens: 10 }).processInput!({ messages }, ctx) as any;
    expect(out.messages).toEqual([messages[0], messages[2]]);
  });

  it('keepSystem: false — a system message in the array CAN be dropped (only last-user stays protected)', () => {
    const huge = 'y'.repeat(4000);
    const messages = [sys('system rules'), u(huge), u('final question')];
    const out = tokenLimiter({ maxInputTokens: 10, keepSystem: false }).processInput!({ messages }, ctx) as any;
    expect(out.messages).toEqual([messages[2]]);
  });

  it('input.system (the separate system-prompt field) counts and is never trimmed: older turns go instead', () => {
    const system = 'S'.repeat(40); // ~10 tokens
    const messages = [u('x'.repeat(400)), a('ok'), u('hi')];
    const out = tokenLimiter({ maxInputTokens: 15 }).processInput!({ system, messages }, ctx) as any;
    expect(out.system).toBe(system);
    expect(out.messages).toEqual([messages[2]]);
  });

  it('input.system alone over budget stops the run: nothing that can be dropped would make it fit', () => {
    expect(() => tokenLimiter({ maxInputTokens: 1 }).processInput!({ system: 'S'.repeat(4000) }, ctx)).toThrow(ProcessorTripwire);
  });

  it('the current turn keeps the question, the tool call and the tool result together; older turns go whole', () => {
    const call = { role: 'assistant', content: [{ type: 'tool-call', toolCallId: 'c1', toolName: 'price', input: { order: 7 } }] };
    const result = { role: 'tool', content: [{ type: 'tool-result', toolCallId: 'c1', toolName: 'price', output: { type: 'text', value: 'P'.repeat(400) } }] };
    const older = [u('o'.repeat(400)), a('old answer')];
    const turn = [u('What is the price of order 7?'), call, result];
    const out = tokenLimiter({ maxInputTokens: 150 }).processInput!({ messages: [...older, ...turn] }, ctx) as any;
    expect(out.messages).toEqual(turn);
  });

  it('tokenLimit is the same trim under its own name', () => {
    const messages = [u('o'.repeat(400)), a('old'), u('q'), a('answer'), u('now')];
    const a1 = tokenLimit({ maxTokens: 5 }).processInput!({ messages }, ctx) as any;
    const a2 = tokenLimiter({ maxInputTokens: 5 }).processInput!({ messages }, ctx) as any;
    expect(a1.messages).toEqual(a2.messages);
    expect(tokenLimit({ maxTokens: 5 }).name).toBe('token-limit');
  });
});

describe("tokenLimiter — strategy: 'error'", () => {
  it('throws ProcessorTripwire synchronously when over budget; does not touch the input', () => {
    const messages = [u('a'.repeat(400))]; // ~100 tokens
    const proc = tokenLimiter({ maxInputTokens: 10, strategy: 'error' });
    expect(() => proc.processInput!({ messages }, ctx)).toThrow(ProcessorTripwire);
  });

  it('does not throw when under budget', () => {
    const proc = tokenLimiter({ maxInputTokens: 1000, strategy: 'error' });
    expect(() => proc.processInput!({ messages: [u('short')] }, ctx)).not.toThrow();
  });
});

describe('tokenLimiter — custom countTokens', () => {
  it('honors a custom tokenizer instead of the char/4 default', () => {
    // Custom counter: 1 token per message regardless of length. Budget 2: the current turn (1) fits, the
    // older turn (user + answer = 2) does not, so it goes whole — never its answer without its question.
    const messages = [u('short'), a('short'), u('huge '.repeat(1000))];
    const proc = tokenLimiter({ maxInputTokens: 2, countTokens: () => 1 });
    const out = proc.processInput!({ messages }, ctx) as any;
    expect(out.messages).toEqual([messages[2]]);
  });

  it("custom countTokens=()=>0 → never over budget, strategy 'error' never throws", () => {
    const proc = tokenLimiter({ maxInputTokens: 1, countTokens: () => 0, strategy: 'error' });
    expect(() => proc.processInput!({ messages: [u('x'.repeat(10000))] }, ctx)).not.toThrow();
  });
});

describe('tokenLimiter — recordProcessorReport (real journal)', () => {
  it('trim-oldest: a report is written with droppedCount when messages are actually dropped', async () => {
    const journal = new InMemoryJournal();
    const rctx = createProcessorCtx(journal, 'run-tl-trim');
    const big = 'x'.repeat(4000);
    const messages = [u(big), a(big), u('final')];
    tokenLimiter({ maxInputTokens: 5 }).processInput!({ messages }, rctx);
    await new Promise((r) => setTimeout(r, 0));
    const reports = await readProcessorReports(journal, 'run-tl-trim');
    expect(reports).toHaveLength(1);
    expect(reports[0]).toMatchObject({ name: 'token-limiter', phase: 'input' });
    expect((reports[0]!.findings as any).droppedCount).toBeGreaterThan(0);
  });

  it("'error' strategy: a report is written before the throw", async () => {
    const journal = new InMemoryJournal();
    const rctx = createProcessorCtx(journal, 'run-tl-err');
    const proc = tokenLimiter({ maxInputTokens: 5, strategy: 'error' });
    expect(() => proc.processInput!({ messages: [u('x'.repeat(400))] }, rctx)).toThrow(ProcessorTripwire);
    await new Promise((r) => setTimeout(r, 0));
    const reports = await readProcessorReports(journal, 'run-tl-err');
    expect(reports).toHaveLength(1);
    expect(reports[0]).toMatchObject({ name: 'token-limiter', phase: 'input' });
  });

  it('no report is written when under budget', async () => {
    const journal = new InMemoryJournal();
    const rctx = createProcessorCtx(journal, 'run-tl-clean');
    tokenLimiter({ maxInputTokens: 1000 }).processInput!({ messages: [u('hi')] }, rctx);
    await new Promise((r) => setTimeout(r, 0));
    expect(await readProcessorReports(journal, 'run-tl-clean')).toEqual([]);
  });
});
