// d25 P5 / karar 16: the repeat ("duplicate side effect") question has ONE text producer.
// Default text: no internal `call-…` id; "another channel" only when the channel really differs;
// the developer can supply the text (any language) through createGnl({ questionText }).
import { describe, it, expect, vi, afterEach } from 'vitest';
import { InMemoryJournal } from '../src/journal.js';
import { createGnl } from '../src/registry.js';
import { durableTool } from '../src/durable-tool.js';
import { createMockModel, countToolResults, toolCallResult, finalTextResult } from './mock.js';

const model = () => createMockModel(async ({ prompt }: any) =>
  countToolResults(prompt) === 0 ? toolCallResult('transfer', 'call-' + Math.random().toString(36).slice(2, 10), { to: 'B', amount: 100 }) : finalTextResult('done'));
const semantic = { semanticIdentity: { keys: ['to'], amountFields: ['amount'] }, recover: async () => ({ done: false as const }) };
const argsDup = { idempotency: 'args' };
afterEach(() => vi.restoreAllMocks());

/** Two runs of one user; returns the second run's first interrupt. `config` extends createGnl. */
async function ask(decl: Record<string, unknown>, first: Record<string, unknown>, second: Record<string, unknown>, config: Record<string, unknown> = {}) {
  const gnl = createGnl({ journal: new InMemoryJournal(), preset: 'assistant', ...config,
    agents: { bank: { model: model(), tools: { transfer: { sideEffect: true, effectClass: 'transactional', ...decl, execute: async () => ({ ok: true }) } } as any } } } as any);
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  await gnl.run('bank', { runId: 'm1', resourceId: 'u', channel: 'chat', prompt: 'send', ...first } as any);
  const r2: any = await gnl.run('bank', { runId: 'm2', resourceId: 'u', channel: 'chat', prompt: 'send', ...second } as any);
  return r2.interrupts?.[0] as any;
}

describe('16: default question text', () => {
  it('same thread (args duplicate): no internal call id', async () => {
    const i = await ask(argsDup, { threadId: 'T1' }, { threadId: 'T1' });
    expect(i?.reason).toBeTruthy();
    expect(i.reason).not.toMatch(/call-[a-z0-9]+/);
  });
  it('another conversation, SAME user and channel (semantic): not called "another channel", no call id', async () => {
    const i = await ask(semantic, { threadId: 'T1' }, { threadId: 'T2' });
    console.log('XCONV:', i?.reason);
    expect(i.reason).not.toMatch(/another channel/);
    expect(i.reason).not.toMatch(/call-[a-z0-9]+/);
  });
  it('SIBLING: a really different channel never leaks the call id either', async () => {
    const i = await ask(semantic, { threadId: 'T1', channel: 'chat' }, { threadId: 'T2', channel: 'api' });
    console.log('XCHANNEL:', i?.reason);
    expect(i.reason).toBeTruthy();
    expect(i.reason).not.toMatch(/call-[a-z0-9]+/);
  });
  it('SIBLING (direct tool path, 2nd source of the text): same-user conversation, no "another channel", no call id', async () => {
    const journal = new InMemoryJournal();
    const tool = { sideEffect: true, semanticIdentity: { keys: ['ref'], amountFields: ['amount'] }, recover: async () => ({ done: false as const }), execute: async () => ({ ok: 1 }) };
    const ctx = (runId: string) => ({ journal, runId, channel: 'chat', identity: { kind: 'user', id: 'u9', runId }, limits: { sideEffectDuplicates: 'suspend' } }) as any;
    await durableTool(tool as any, ctx('c1'), 'pay').execute!({ ref: 'F-9', amount: 50 }, { toolCallId: 'call-first1' } as any);
    const out: any = await durableTool(tool as any, ctx('c2'), 'pay').execute!({ ref: 'F-9', amount: 50 }, { toolCallId: 'call-second' } as any);
    expect(out.__gnl_suspend.reason).not.toMatch(/another channel/);
    expect(out.__gnl_suspend.reason).not.toMatch(/call-[a-z0-9]+/);
  });
});

describe('16: questionText hook', () => {
  const turkish = (facts: any) => `Bu işlem daha önce yapıldı (${String(facts?.tool ?? 'araç')}); tekrar yapılsın mı?`;
  it('the hook text replaces the default — same-thread duplicate', async () => {
    const i = await ask(argsDup, { threadId: 'T1' }, { threadId: 'T1' }, { questionText: () => 'Bu transfer tekrar yapılsın mı?' });
    expect(i.reason).toContain('Bu transfer tekrar yapılsın mı?');
    expect(i.reason).not.toMatch(/Duplicate side effect/);
  });
  it('SIBLING: the SAME hook serves the cross-conversation (semantic) question', async () => {
    const i = await ask(semantic, { threadId: 'T1' }, { threadId: 'T2' }, { questionText: () => 'Başka bir konuşmada yapıldı, tekrar edilsin mi?' });
    expect(i.reason).toContain('Başka bir konuşmada yapıldı, tekrar edilsin mi?');
  });
  it('the hook gets structured facts (an object), once per question', async () => {
    const seen: unknown[] = [];
    await ask(semantic, { threadId: 'T1' }, { threadId: 'T2' }, { questionText: (f: unknown) => { seen.push(f); return turkish(f); } });
    console.log('FACTS:', JSON.stringify(seen));
    expect(seen.length).toBeGreaterThanOrEqual(1);
    expect(typeof seen[0]).toBe('object');
    expect(seen[0]).not.toBeNull();
  });
  it('NEGATIVE: the hook returning undefined falls back to the default (still no call id, not empty)', async () => {
    const i = await ask(semantic, { threadId: 'T1' }, { threadId: 'T2' }, { questionText: () => undefined });
    expect(i.reason).toBeTruthy();
    expect(i.reason).not.toMatch(/call-[a-z0-9]+/);
  });
  it('a typo of the option name is refused, not ignored', () => {
    expect(() => createGnl({ journal: new InMemoryJournal(), questionTxt: () => 'x', agents: { bank: { model: model() } } } as any)).toThrow(/questionTxt/);
  });
});
