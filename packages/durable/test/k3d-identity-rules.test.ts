// Aday D — the identity rule's own scenarios (the shared k3-call-identity-* files are the common acceptance tests):
//   S17 legacy marker, S18 doors that do not pass the model boundary, S19 lengths, S20 replay,
//   S21 approval aliases, X1 a new door, X2 a per-call record.
import { describe, it, expect, vi, beforeAll } from 'vitest';
import { stepCountIs } from 'ai';
import { z } from 'zod';
import { InMemoryJournal, runKeys } from '../src/journal.js';
import { InMemoryStorage } from '../src/index.js';
import { claimDupMarker, type DupMarker } from '../src/attempt.js';
import { mintCallId } from '../src/call-identity.js';
import { nestedAgentRunId } from '../src/journal.js';
import { resolveApprovals, runDurable } from '../src/run.js';
import { forkRun } from '../src/time-travel.js';
import { AmbiguousApprovalKeyError, callerConflictAnswer } from '../src/errors.js';
import { createMockModel, finalTextResult } from './mock.js';

beforeAll(() => { vi.spyOn(console, 'warn').mockImplementation(() => {}); });

describe('S17/S18 — who may take over a dead attempt\'s marker', () => {
  const OLD = 1_000;
  const journalWith = async (marker: Partial<DupMarker>) => {
    const j = new InMemoryJournal();
    await j.put('xthr:T:dup-x', { firstToolCallId: 'c', at: OLD, inFlight: true, ttlMs: 1_000, ...marker } as DupMarker);
    return j;
  };
  const next = (runId: string): DupMarker & { firstRunId: string } => ({ firstToolCallId: 'c', firstRunId: runId, at: Date.now(), inFlight: true, hold: 'new', proc: 'newp' });

  it('S17 a marker with no run named: taken over by the call whose own earlier record carries the same hold', async () => {
    const j = await journalWith({ hold: 'h1', proc: 'p1' });
    const got = await claimDupMarker(j, 'xthr:T:dup-x', next('R'), 30_000, undefined, { hold: 'h1' });
    expect(got.won).toBe(true);
  });
  it('S17 …and by nobody else: another hold, no own record, or a record without a hold is asked, not taken over', async () => {
    for (const own of [{ hold: 'h2' }, undefined, {}, { proc: 'p1' }] as const) {
      const j = await journalWith({ hold: 'h1', proc: 'p1' });
      const got = await claimDupMarker(j, 'xthr:T:dup-x', next('R'), 30_000, undefined, own);
      expect(got.won, JSON.stringify(own)).toBe(false);
      expect(got.stale).toBe(true);
    }
  });
  it('S17 with no hold on the marker, the process decides', async () => {
    const j = await journalWith({ proc: 'p1' });
    expect((await claimDupMarker(j, 'xthr:T:dup-x', next('R'), 30_000, undefined, { proc: 'p1' })).won).toBe(true);
    const j2 = await journalWith({ proc: 'p1' });
    expect((await claimDupMarker(j2, 'xthr:T:dup-x', next('R'), 30_000, undefined, { proc: 'p9' })).won).toBe(false);
  });
  it('S18 a marker that names its run is taken over by that run\'s call, never by another run\'s call with the same id (`mcp`, `item:<key>`)', async () => {
    const mine = await journalWith({ firstToolCallId: 'mcp', firstRunId: 'A', hold: 'h1' });
    expect((await claimDupMarker(mine, 'xthr:T:dup-x', { ...next('A'), firstToolCallId: 'mcp' }, 30_000, undefined, undefined)).won).toBe(true);
    const other = await journalWith({ firstToolCallId: 'mcp', firstRunId: 'A', hold: 'h1' });
    const got = await claimDupMarker(other, 'xthr:T:dup-x', { ...next('B'), firstToolCallId: 'mcp' }, 30_000, undefined, { hold: 'h1' });
    expect(got.won).toBe(false);
    expect(got.stale).toBe(true);
    expect(got.cur?.firstRunId).toBe('A');
  });
  it('a LIVE marker is never taken over, and is not called stale', async () => {
    const j = new InMemoryJournal();
    await j.put('xthr:T:dup-x', { firstToolCallId: 'c', firstRunId: 'R', at: await j.now!(), inFlight: true, ttlMs: 60_000 } as DupMarker);
    const got = await claimDupMarker(j, 'xthr:T:dup-x', next('R'), 30_000, undefined, undefined);
    expect(got.won).toBe(false);
    expect(got.stale).toBe(false);
  });
});

describe('S19 — lengths', () => {
  const openai = 'call_' + 'a'.repeat(24);
  const anthropic = 'toolu_01' + 'B'.repeat(22);
  it('a Telegram button (`a:<id>`, 64 bytes) is still there for OpenAI- and Anthropic-shaped ids, up to step 999', () => {
    for (const p of [openai, anthropic, 'call_0']) for (const step of [0, 9, 99, 999]) {
      expect(Buffer.byteLength(`a:${mintCallId(p, 'run1_' + 'f'.repeat(32), step, 0)}`), `${p} step ${step}`).toBeLessThanOrEqual(64);
    }
  });
  it('MySQL: five nested sub-agent levels keep run_id ≤ 2048 and the key ≤ 3072; the growth per level is reported', () => {
    let run = 'run1_' + 'f'.repeat(32);
    const lens: number[] = [];
    for (let depth = 0; depth < 5; depth++) {
      run = nestedAgentRunId(run, mintCallId(openai, run, 3, 0));
      lens.push(run.length);
    }
    const key = runKeys.tool(run, mintCallId(openai, run, 3, 0));
    console.log('[S19] nested run_id length by level', lens.join(','), '| key', key.length);
    expect(run.length).toBeLessThanOrEqual(2048);
    expect(key.length).toBeLessThanOrEqual(3072);
  });
});

describe('S21 — approvals keyed by the provider\'s id', () => {
  const pending = async (j: InMemoryJournal, runId: string, id: string, extra: object = {}) =>
    j.put(runKeys.tool(runId, id), { status: 'suspended', output: { __gnl_suspend: { toolCallId: id, toolName: 'pay', args: {}, reason: 'q', kind: 'confirm', ...extra } } });
  const A = mintCallId('call_0', 'r', 0, 0); const B = mintCallId('call_0', 'r', 1, 0);

  it('one open question carries the id → the answer is bound to it', async () => {
    const j = new InMemoryJournal(); await pending(j, 'r', A);
    expect(await resolveApprovals(j, 'r', { call_0: true })).toEqual({ [A]: true });
    expect(await j.listKeys(runKeys.approval('r', ''))).toEqual([runKeys.approval('r', A)]);
  });
  it('the GNL id itself is untouched; an id no open question carries is no answer: a yes for it is dropped (d25 step 1), a no is kept', async () => {
    const j = new InMemoryJournal(); await pending(j, 'r', A);
    expect(await resolveApprovals(j, 'r', { [A]: false })).toEqual({ [A]: false });
    expect(await resolveApprovals(j, 'r', { zzz: true })).toEqual({ [A]: false });
    expect(await resolveApprovals(j, 'r', { zzz: false })).toEqual({ zzz: false, [A]: false });
  });
  it('two open questions carry it → AmbiguousApprovalKeyError, nothing written, 409 approval_key_ambiguous', async () => {
    const j = new InMemoryJournal(); await pending(j, 'r', A); await pending(j, 'r', B);
    const err: any = await resolveApprovals(j, 'r', { call_0: true }).catch((e) => e);
    expect(err).toBeInstanceOf(AmbiguousApprovalKeyError);
    expect(err.detail.candidates.sort()).toEqual([A, B].sort());
    expect(await j.listKeys(runKeys.approval('r', ''))).toEqual([]);
    const ans = callerConflictAnswer(err)!;
    expect([ans.status, ans.code]).toEqual([409, 'approval_key_ambiguous']);
  });
  it('a sub-agent question (addressed <delegation>/<child>) is found by the provider ids of both hops', async () => {
    const j = new InMemoryJournal();
    const P = mintCallId('call_0', 'r', 0, 0); const C = mintCallId('call_0', 'agent:r:x', 0, 0);
    await pending(j, 'r', P, { kind: 'nested', nested: { interrupts: [{ toolCallId: C }] } });
    expect(await resolveApprovals(j, 'r', { 'call_0/call_0': true })).toEqual({ [`${P}/${C}`]: true });
  });
});

describe('S20 — replay: the same call keeps its id', () => {
  const usage = { inputTokens: 1, outputTokens: 1 };
  it('crash after the first tool, resume: the recorded id is reused, the tool does not run again; fork keeps working', async () => {
    const journal = new InMemoryJournal(); const paid: number[] = []; const seen: string[] = [];
    const tools = { pay: { description: 'pay', inputSchema: z.object({ amount: z.number() }), sideEffect: true, execute: async (a: any, o: any) => { paid.push(a.amount); seen.push(o.toolCallId); return { charged: a.amount }; } } };
    const mk = (crashAt: number) => createMockModel(async ({ prompt }: any) => {
      const n = prompt.filter((m: any) => m.role === 'tool').length;
      if (n === crashAt) throw new Error('CRASH');
      if (n >= 2) return finalTextResult('done');
      return { content: [{ type: 'tool-call', toolCallId: 'call_0', toolName: 'pay', input: JSON.stringify({ amount: n === 0 ? 5 : 7 }) }], finishReason: 'tool-calls', usage, warnings: [] };
    });
    await expect(runDurable({ runId: 'k3d-s20', journal, model: mk(1), tools, stopWhen: stepCountIs(6), prompt: 'x' } as any)).rejects.toThrow('CRASH');
    const idAfterCrash = seen[0];
    expect(idAfterCrash).toMatch(/^call_0\.gnl-[0-9a-z]{8}-0-0$/);
    await runDurable({ runId: 'k3d-s20', journal, model: mk(-1), tools, stopWhen: stepCountIs(6), prompt: 'x' } as any);
    expect(paid).toEqual([5, 7]);                  // the first call was not repeated
    expect(seen[0]).toBe(idAfterCrash);            // …and the resumed run knows it by the same id
    expect(seen[1]).toMatch(/^call_0\.gnl-[0-9a-z]{8}-1-0$/);
    const forked: any = await forkRun(journal as any, 'k3d-s20', 1);
    await runDurable({ runId: forked.newRunId ?? forked.runId, journal, model: mk(-1), tools, stopWhen: stepCountIs(6), prompt: 'x' } as any);
    expect(paid.filter((x) => x === 5)).toHaveLength(1); // the copy replays step 0 from the copied records, no second payment
  });
});

describe('X1 — a new door that lists questions and sends answers', () => {
  it('uses only the public run API and treats the id as an opaque string', async () => {
    const journal = new InMemoryJournal(); let paid = 0;
    const usage = { inputTokens: 1, outputTokens: 1 };
    const model = createMockModel(async ({ prompt }: any) => (prompt.some((m: any) => m.role === 'tool')
      ? finalTextResult('done')
      : { content: [{ type: 'tool-call', toolCallId: 'call_0', toolName: 'pay', input: '{}' }], finishReason: 'tool-calls', usage, warnings: [] }));
    const tools = { pay: { description: 'pay', inputSchema: z.object({}), confirm: true, sideEffect: true, execute: async () => ({ n: ++paid }) } };
    const gate = async (approvals?: Record<string, boolean>) => runDurable({ runId: 'x1', journal, model, tools, stopWhen: stepCountIs(4), prompt: 'p', ...(approvals ? { approvals } : {}) } as any);
    const first: any = await gate();
    const open = first.interrupts.map((i: any) => i.toolCallId as string);   // listed
    expect(open).toHaveLength(1);
    const second: any = await gate(Object.fromEntries(open.map((id: string) => [id, true]))); // answered, no (runId, step) composed
    expect(second.text).toBe('done');
    expect(paid).toBe(1);
  });
});

describe('X2 — a per-call record keyed by the call\'s id', () => {
  it('two steps that the provider both names call_0 get two separate cost notes, with no extra identity code', async () => {
    const journal = new InMemoryJournal(); const usage = { inputTokens: 1, outputTokens: 1 };
    const model = createMockModel(async ({ prompt }: any) => {
      const n = prompt.filter((m: any) => m.role === 'tool').length;
      if (n >= 2) return finalTextResult('done');
      return { content: [{ type: 'tool-call', toolCallId: 'call_0', toolName: 'pay', input: JSON.stringify({ amount: n === 0 ? 5 : 7 }) }], finishReason: 'tool-calls', usage, warnings: [] };
    });
    const tools = { pay: { description: 'pay', inputSchema: z.object({ amount: z.number() }), sideEffect: true, execute: async (a: any, o: any) => { await journal.put(runKeys.proc('x2', 'cost-' + o.toolCallId), { cents: a.amount }); return { ok: 1 }; } } };
    await runDurable({ runId: 'x2', journal, model, tools, stopWhen: stepCountIs(6), prompt: 'p' } as any);
    const notes = (await journal.listKeys(runKeys.proc('x2', 'cost-'))).sort();
    expect(notes).toHaveLength(2);
    expect(await Promise.all(notes.map((k) => journal.get<any>(k).then((v) => v.cents)))).toEqual([5, 7]);
  });
});
