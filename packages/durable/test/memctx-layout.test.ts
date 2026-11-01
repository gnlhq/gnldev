// The run records WHERE each part of its frozen input came from (`:memctx.layout`, `systemSpans`),
// computed after the input chain ran — so a reader slicing `:input` by these spans gets what memory
// actually put there, or is told the run cannot say.
import { describe, it, expect, vi, beforeAll } from 'vitest';
import { InMemoryJournal, runKeys } from '../src/journal.js';
import { BasicMemory } from '../src/memory.js';
import type { Memory } from '../src/memory.js';
import type { MemoryContextRecord } from '../src/run.js';
import { runDurable, streamDurable, resumeRun } from '../src/run.js';
import { forkRun } from '../src/time-travel.js';
import { readMemoryLayout, readRunMemoryLayout } from '../src/memory-layout.js';
import { InMemoryStorage, eraseSubject, purgeRun, withOrg, toJournal } from '../src/index.js';
import { SqliteStorage } from '../src/sqlite-storage.js';
import { readRunOutcome } from '../src/outcome.js';
import { createMockModel, createMockStreamModel, finalTextResult } from './mock.js';

beforeAll(() => { vi.spyOn(console, 'warn').mockImplementation(() => {}); });

const reply = () => createMockModel(async () => finalTextResult('reply'));
const memctx = (j: any, id: string) => j.get(runKeys.memoryContext(id)) as Promise<MemoryContextRecord>;
const input = (j: any, id: string) => j.get(runKeys.input(id)) as Promise<{ messages: any[]; system?: string }>;
const text = (m: any) => (typeof m?.content === 'string' ? m.content : (m?.content ?? []).map((p: any) => p.text ?? '').join(''));

/**
 * The layout reads `present` against the frozen input, and — when the counts are settled — memory's
 * counts plus the foreign rows add up to the frozen length (the invariant settleProvenance promises).
 */
async function assertLayoutFrozen(j: any, id: string) {
  const rec = await memctx(j, id);
  const inp = await input(j, id);
  const reading = await readRunMemoryLayout(j, id);
  expect(reading.status).toBe('present');
  const L = rec.layout!;
  expect(L.n).toBe(inp.messages.length);
  expect('hashes' in L).toBe(false); // no content fingerprint is kept beside the content
  if (L.incoming) expect(L.incoming[1] - L.incoming[0]).toBe(rec.incomingCount);
  if (L.status === 'exact' || L.status === 'changed') {
    const obs = rec.observationCount ? 1 : 0;
    expect(obs + rec.recalled.length + rec.recentCount + (L.foreign?.length ?? 0) + (L.ambiguous?.length ?? 0) + rec.incomingCount).toBe(L.n);
  }
  return { rec, inp, L };
}

/** A rich memory that returns [recall..., recent...] and a WM system text, with honest provenance. */
function richMemory(opts: { recalled: string[]; recent: string[]; wm?: string; observations?: string }): Memory {
  return {
    async getMessages() { return []; },
    async append() {},
    async loadContext() {
      const obs = opts.observations ? [{ role: 'system', content: `# Observations\n${opts.observations}` }] : [];
      const rec = opts.recalled.map((t) => ({ role: 'user', content: t }));
      const rcn = opts.recent.map((t, i) => ({ role: i % 2 ? 'assistant' : 'user', content: t }));
      return {
        messages: [...obs, ...rec, ...rcn],
        ...(opts.wm ? { system: opts.wm } : {}),
        provenance: {
          recalled: opts.recalled.map((t, i) => ({ threadId: 'x', seq: i, role: 'user', preview: t })),
          recentCount: rcn.length,
          ...(opts.observations ? { observationCount: 1 } : {}),
          ...(opts.wm ? { workingMemoryChars: opts.wm.length } : {}),
        },
      };
    },
  };
}

const redactEmails = (s: string) => s.replace(/[\w.]+@[\w.]+/g, '[EMAIL]');
const redactor = {
  name: 'redact',
  processInput: async (i: any) => ({
    ...i,
    system: typeof i.system === 'string' ? redactEmails(i.system) : i.system,
    messages: i.messages.map((m: any) => (typeof m.content === 'string' ? { ...m, content: redactEmails(m.content) } : m)),
  }),
};
const dropOldest = { name: 'drop-oldest', processInput: async (i: any) => ({ ...i, messages: i.messages.filter((_: any, k: number) => k !== 0) }) };
const appendReminder = { name: 'reminder', processInput: async (i: any) => ({ ...i, messages: [...i.messages, { role: 'system', content: 'be brief' }] }) };
const injectAhead = { name: 'jit', processInput: async (i: any) => ({ ...i, messages: [{ role: 'system', content: 'retrieved doc' }, ...i.messages] }) };

describe(':memctx.layout — the run records where each part of its frozen input came from', () => {
  it('recall + recent + incoming, WM on: spans are exact and cover the right rows', async () => {
    const j = new InMemoryJournal();
    const memory = richMemory({ recalled: ['old A', 'old B'], recent: ['r1', 'r2', 'r3'], wm: '# Working Memory\nname: Ada' });
    await runDurable({ runId: 'l1', journal: j, memory, threadId: 't1', model: reply(), prompt: 'new q', system: 'You are helpful.' } as any);
    const { rec, inp, L } = await assertLayoutFrozen(j, 'l1');
    expect(L.status).toBe('exact');
    expect([L.recall, L.recent, L.incoming]).toEqual([[0, 2], [2, 5], [5, 6]]);
    expect(L.observations).toBeUndefined();
    expect(inp.messages.slice(...L.recall!).map(text)).toEqual(['old A', 'old B']);
    expect(text(inp.messages[L.incoming![0]])).toBe('new q');
    expect(rec.systemSpans?.workingMemory?.status).toBe('exact');
    expect(inp.system!.slice(...rec.systemSpans!.workingMemory!.span!)).toBe('# Working Memory\nname: Ada');
  });

  it('OM on: the observations row is span [0,1)', async () => {
    const j = new InMemoryJournal();
    await runDurable({ runId: 'l2', journal: j, memory: richMemory({ recalled: [], recent: ['r1', 'r2'], observations: 'user is Ada' }), threadId: 't2', model: reply(), prompt: 'q' } as any);
    const { inp, L } = await assertLayoutFrozen(j, 'l2');
    expect(L.status).toBe('exact');
    expect(L.observations).toEqual([0, 1]);
    expect(L.recall).toBeUndefined();
    expect(text(inp.messages[0])).toMatch(/^# Observations/);
    expect(L.recent).toEqual([1, 3]);
    expect(L.incoming).toEqual([3, 4]);
  });

  it('legacy BasicMemory + working memory: recent window and WM span', async () => {
    const j = new InMemoryJournal();
    const memory = new BasicMemory(j) as any;
    memory.getWorkingMemory = async () => 'likes tea';
    await runDurable({ runId: 'l3a', journal: j, memory, threadId: 't3', model: reply(), prompt: 'u1' } as any);
    await runDurable({ runId: 'l3b', journal: j, memory, threadId: 't3', model: reply(), prompt: 'u2', system: 'S' } as any);
    const { rec, inp, L } = await assertLayoutFrozen(j, 'l3b');
    expect(L).toMatchObject({ status: 'exact', recent: [0, 2], incoming: [2, 3] });
    expect(inp.system!.slice(...rec.systemSpans!.workingMemory!.span!)).toBe('# Working Memory\nlikes tea');
  });

  it('a redacting processor: NOT exact — the rewritten position is named, its label positional only', async () => {
    const j = new InMemoryJournal();
    const memory = richMemory({ recalled: ['mail me a@b.co'], recent: ['r1', 'r2'], wm: '# Working Memory\nemail: ada@x.io' });
    await runDurable({ runId: 'l4', journal: j, memory, threadId: 't4', model: reply(), prompt: 'ping z@z.com', processors: [redactor] } as any);
    const { rec, inp, L } = await assertLayoutFrozen(j, 'l4');
    expect(L).toMatchObject({ status: 'changed', recall: [0, 1], recent: [1, 3], incoming: [3, 4], rewritten: [0] });
    expect(L.foreign).toBeUndefined();
    expect(text(inp.messages[0])).toBe('mail me [EMAIL]');
    // The redaction took the WM's own tail ('ada@x.io' → '[EMAIL]'): the front is anchored, the end is
    // not, so no span is claimed — a note appended behind it would look the same.
    expect(rec.systemSpans?.workingMemory).toMatchObject({ status: 'unbounded', start: 0 });
    expect(rec.systemSpans?.workingMemory?.span).toBeUndefined();
  });

  it('WM redacted in the MIDDLE: both ends anchored → rewritten, span runs to the end of the system', async () => {
    const j = new InMemoryJournal();
    const memory = richMemory({ recalled: [], recent: ['r1'], wm: '# Working Memory\nemail: ada@x.io\nprefers: short answers' });
    await runDurable({ runId: 'l4w', journal: j, memory, threadId: 't4w', model: reply(), prompt: 'q', system: 'You help.', processors: [redactor] } as any);
    const { rec, inp } = await assertLayoutFrozen(j, 'l4w');
    const wm = rec.systemSpans!.workingMemory!;
    expect(wm.status).toBe('rewritten');
    expect(inp.system!.slice(...wm.span!)).toBe('# Working Memory\nemail: [EMAIL]\nprefers: short answers');
  });

  it('weak point 2 — WM rewritten AND a note appended behind it: the note is not read as working memory', async () => {
    const appendSystemNote = { name: 'sys-note', processInput: async (i: any) => ({ ...i, system: `${i.system}\n\nPOLICY: never share addresses` }) };
    const j = new InMemoryJournal();
    const memory = richMemory({ recalled: [], recent: ['r1'], wm: '# Working Memory\nemail: ada@x.io\nprefers: short answers' });
    await runDurable({ runId: 'l4n', journal: j, memory, threadId: 't4n', model: reply(), prompt: 'q', system: 'You help.', processors: [redactor, appendSystemNote] } as any);
    const { rec, inp } = await assertLayoutFrozen(j, 'l4n');
    expect(inp.system).toMatch(/POLICY: never share addresses$/);
    const wm = rec.systemSpans!.workingMemory!;
    // Before: status 'rewritten', span [start, system.length) — the POLICY note counted as working memory.
    expect(wm.status).toBe('unbounded');
    expect(wm.span).toBeUndefined();
    expect(wm.start).toBe('You help.\n\n'.length);
  });

  it('WM intact and a note appended behind it: exact, the note stays outside the span', async () => {
    const appendSystemNote = { name: 'sys-note', processInput: async (i: any) => ({ ...i, system: `${i.system}\n\nPOLICY` }) };
    const j = new InMemoryJournal();
    await runDurable({ runId: 'l4m', journal: j, memory: richMemory({ recalled: [], recent: ['r1'], wm: '# Working Memory\nname: Ada' }), threadId: 't4m', model: reply(), prompt: 'q', processors: [appendSystemNote] } as any);
    const { rec, inp } = await assertLayoutFrozen(j, 'l4m');
    const wm = rec.systemSpans!.workingMemory!;
    expect(wm.status).toBe('exact');
    expect(inp.system!.slice(...wm.span!)).toBe('# Working Memory\nname: Ada');
  });

  it('a processor that DELETES a history row: still exact, the row is counted as dropped and the counts settle', async () => {
    const j = new InMemoryJournal();
    await runDurable({ runId: 'l5', journal: j, memory: richMemory({ recalled: ['old A'], recent: ['r1', 'r2'] }), threadId: 't5', model: reply(), prompt: 'q5', processors: [dropOldest] } as any);
    const { rec, inp, L } = await assertLayoutFrozen(j, 'l5');
    expect(L).toMatchObject({ status: 'exact', recent: [0, 2], incoming: [2, 3], droppedByChain: 1 });
    expect(L.recall).toBeUndefined();
    expect(rec.recalled).toEqual([]); // the model never saw 'old A' — the record no longer says it did
    expect(rec.recentCount).toBe(2);
    expect(inp.messages.slice(...L.incoming!).map(text)).toEqual(['q5']);
  });

  it('a processor that INJECTS ahead: changed — position 0 is foreign, memory\'s rows keep their labels', async () => {
    const j = new InMemoryJournal();
    await runDurable({ runId: 'l5b', journal: j, memory: richMemory({ recalled: ['old A'], recent: ['r1', 'r2'] }), threadId: 't5b', model: reply(), prompt: 'q', processors: [injectAhead] } as any);
    const { inp, L } = await assertLayoutFrozen(j, 'l5b');
    expect(L).toMatchObject({ status: 'changed', foreign: [0], recall: [1, 2], recent: [2, 4], incoming: [4, 5] });
    expect(text(inp.messages[0])).toBe('retrieved doc');
    expect(inp.messages.slice(...L.recall!).map(text)).toEqual(['old A']);
  });

  it('a processor that mutates a row IN PLACE: caught by the key taken before the chain', async () => {
    const inPlace = { name: 'in-place', processInput: async (i: any) => { i.messages[0].content = 'MUTATED'; return i; } };
    const j = new InMemoryJournal();
    await runDurable({ runId: 'l5c', journal: j, memory: richMemory({ recalled: ['old A'], recent: ['r1', 'r2'] }), threadId: 't5c', model: reply(), prompt: 'q', processors: [inPlace] } as any);
    const { L } = await assertLayoutFrozen(j, 'l5c');
    expect(L).toMatchObject({ status: 'changed', rewritten: [0], recall: [0, 1] });
  });

  it('a processor that APPENDS a reminder behind the turn: exact; incoming covers the turn + chainAppended', async () => {
    const j = new InMemoryJournal();
    await runDurable({ runId: 'l6', journal: j, memory: richMemory({ recalled: [], recent: ['r1', 'r2'] }), threadId: 't6', model: reply(), prompt: 'q6', processors: [appendReminder] } as any);
    const { rec, L } = await assertLayoutFrozen(j, 'l6');
    expect(L).toMatchObject({ status: 'exact', recent: [0, 2], incoming: [2, 4] });
    expect(rec.chainAppended).toBe(1);
  });

  it('a memory whose own counts do not add up: counts-mismatch, nothing inside the history is claimed', async () => {
    const j = new InMemoryJournal();
    const liar: Memory = {
      async getMessages() { return []; }, async append() {},
      async loadContext() { return { messages: [{ role: 'user', content: 'old' }], provenance: { recalled: [{ threadId: 't', seq: 1, role: 'user', preview: 'old' }], recentCount: 1 } }; },
    };
    await runDurable({ runId: 'l7', journal: j, memory: liar, threadId: 't7', model: reply(), prompt: 'q' } as any);
    const { L } = await assertLayoutFrozen(j, 'l7');
    expect(L.status).toBe('counts-mismatch');
    expect(L.incoming).toEqual([1, 2]);
  });

  it('write-ahead: a failed attempt stored the question; the fresh-runId retry marks it incomingAlreadyInThread', async () => {
    const j = new InMemoryJournal();
    const memory = new BasicMemory(j);
    await runDurable({ runId: 'w0', journal: j, memory, threadId: 'tw', model: reply(), prompt: 'first' } as any);
    const boom = createMockModel(async () => { throw Object.assign(new Error('rate limited'), { name: 'RateLimitError' }); });
    await expect(runDurable({ runId: 'w1', journal: j, memory, threadId: 'tw', model: boom, prompt: 'second' } as any)).rejects.toThrow();
    // errorName rides along with the message on the outcome.
    expect(await readRunOutcome(j, 'w1')).toMatchObject({ status: 'failed', error: 'rate limited', errorName: 'RateLimitError' });
    const w1 = await assertLayoutFrozen(j, 'w1');
    expect(w1.L).toMatchObject({ status: 'exact', recent: [0, 2], incoming: [2, 3] });
    await runDurable({ runId: 'w2', journal: j, memory, threadId: 'tw', model: reply(), prompt: 'second' } as any);
    const { inp, L } = await assertLayoutFrozen(j, 'w2');
    expect(inp.messages.map(text)).toEqual(['first', 'reply', 'second']); // stored once, shown once
    expect(L).toMatchObject({ status: 'exact', recent: [0, 2], incoming: [2, 3], incomingAlreadyInThread: 1 });
  });

  it('resume of the SAME runId after the thread grew: :memctx is first-wins, layout still reads present against the frozen input', async () => {
    const j = new InMemoryJournal();
    const memory = new BasicMemory(j);
    await runDurable({ runId: 'r0', journal: j, memory, threadId: 'tr', model: reply(), prompt: 'a' } as any);
    const boom = createMockModel(async () => { throw new Error('5xx'); });
    await expect(runDurable({ runId: 'r1', journal: j, memory, threadId: 'tr', model: boom, prompt: 'b' } as any)).rejects.toThrow();
    const before = await memctx(j, 'r1');
    await runDurable({ runId: 'rX', journal: j, memory, threadId: 'tr', model: reply(), prompt: 'c' } as any); // thread grows
    await resumeRun('r1', { journal: j, memory, model: reply() } as any);
    expect(await memctx(j, 'r1')).toEqual(before);
    await assertLayoutFrozen(j, 'r1');
  });

  it('FORK of a memory run carries the source note, which still reads present against the copied input', async () => {
    const j = new InMemoryJournal();
    const memory = new BasicMemory(j);
    await runDurable({ runId: 'f0', journal: j, memory, threadId: 'tf', model: reply(), prompt: 'a' } as any);
    await runDurable({ runId: 'f1', journal: j, memory, threadId: 'tf', model: reply(), prompt: 'b' } as any);
    await runDurable({ runId: 'f2', journal: j, memory, threadId: 'tf', model: reply(), prompt: 'c' } as any); // thread grows after f1
    const { newRunId } = await forkRun(j as any, 'f1', 0);
    await resumeRun(newRunId, { journal: j, memory, model: reply() } as any);
    const fork = await memctx(j, newRunId);
    const inp = await input(j, newRunId);
    // Before forkRun copied `:memctx`, this was a fresh record from TODAY's thread: recentCount 6,
    // incomingCount 0, layout boundary-lost, for a 3-message input. Now it is the source's note.
    expect(fork).toEqual(await memctx(j, 'f1'));
    await assertLayoutFrozen(j, newRunId);
    expect(fork.layout).toMatchObject({ status: 'exact', recent: [0, 2], incoming: [2, 3] });
  });

  it('streamDurable writes the same layout', async () => {
    const j = new InMemoryJournal();
    const r: any = await streamDurable({ runId: 's1', journal: j, memory: richMemory({ recalled: ['old'], recent: ['r1', 'r2'], wm: 'WM' }), threadId: 'ts', model: createMockStreamModel([{ type: 'text-start', id: '1' }, { type: 'text-delta', id: '1', delta: 'hi' }, { type: 'text-end', id: '1' }, { type: 'finish', finishReason: { unified: 'stop', raw: 'stop' }, usage: { inputTokens: { total: 1 }, outputTokens: { total: 1 } } }]), prompt: 'q' } as any);
    await r.text;
    const { L } = await assertLayoutFrozen(j, 's1');
    expect(L).toMatchObject({ status: 'exact', recall: [0, 1], recent: [1, 3], incoming: [3, 4] });
  });

  it('org-scoped journal: the layout lands under the org prefix with the rest of the run', async () => {
    const storage = new InMemoryStorage();
    const root = toJournal(storage);
    const org = withOrg(root, 'acme');
    await runDurable({ runId: 'o1', journal: org, memory: richMemory({ recalled: ['old'], recent: ['r1'] }), threadId: 'to', model: reply(), prompt: 'q' } as any);
    const { L } = await assertLayoutFrozen(org, 'o1');
    expect(L.status).toBe('exact');
    expect(await root.get(runKeys.memoryContext('o1'))).toBeUndefined(); // not readable outside the org
  });

  it('Sqlite round-trip: the stored :input still matches the recorded layout', async () => {
    const storage = new SqliteStorage(':memory:');
    const j = toJournal(storage);
    const memory = new BasicMemory(j);
    await runDurable({ runId: 'q0', journal: j, memory, threadId: 'tq', model: reply(), prompt: 'a' } as any);
    await runDurable({ runId: 'q1', journal: j, memory, threadId: 'tq', model: reply(), prompt: 'b', resourceId: 'ayse' } as any);
    await assertLayoutFrozen(j, 'q1');
  });

  it('GDPR: purgeRun and eraseSubject take :memctx (layout included) with the run', async () => {
    for (const make of [() => new InMemoryStorage(), () => new SqliteStorage(':memory:')]) {
      const storage = make();
      const j = toJournal(storage);
      const memory = new BasicMemory(j);
      await runDurable({ runId: 'g0', journal: j, memory, threadId: 'tg', model: reply(), prompt: 'a', resourceId: 'ayse' } as any);
      await runDurable({ runId: 'g1', journal: j, memory, threadId: 'tg', model: reply(), prompt: 'b', resourceId: 'ayse' } as any);
      await runDurable({ runId: 'g2', journal: j, memory, threadId: 'tg2', model: reply(), prompt: 'c', resourceId: 'bob' } as any);
      expect((await memctx(j, 'g1')).layout).toBeDefined();
      await purgeRun(j as any, 'g0');
      expect(await j.get(runKeys.memoryContext('g0'))).toBeUndefined();
      await eraseSubject(storage as any, 'ayse');
      expect(await j.get(runKeys.memoryContext('g1'))).toBeUndefined();
      expect((await memctx(j, 'g2')).layout).toBeDefined(); // another person's run is untouched
    }
  });
});

const swapOldestForDoc = { name: 'swap', processInput: async (i: any) => ({ ...i, messages: [{ role: 'user', content: 'INJECTED DOC' }, ...i.messages.slice(1)] }) };

describe('weak point 1 — a processor that removes a row and puts another of the same role in its place', () => {
  it('the position is named rewritten and the layout does not say exact', async () => {
    const j = new InMemoryJournal();
    await runDurable({ runId: 'd3', journal: j, memory: richMemory({ recalled: ['old A'], recent: ['r1', 'r2'] }), threadId: 'td3', model: reply(), prompt: 'q', processors: [swapOldestForDoc] } as any);
    const { inp, L } = await assertLayoutFrozen(j, 'd3');
    expect(text(inp.messages[0])).toBe('INJECTED DOC');
    // Before: status 'exact' with only a part-level flag — a reader took 'INJECTED DOC' for recall.
    expect(L.status).toBe('changed');
    expect(L.rewritten).toEqual([0]);
    expect(L.recall).toEqual([0, 1]); // positional: where memory's recall row WAS — not its content
  });
  it('the same swap in the recent window, mid-span', async () => {
    const swapMid = { name: 'swap-mid', processInput: async (i: any) => ({ ...i, messages: i.messages.map((m: any, k: number) => (k === 2 ? { role: m.role, content: 'NOT MEMORY' } : m)) }) };
    const j = new InMemoryJournal();
    await runDurable({ runId: 'd4', journal: j, memory: richMemory({ recalled: ['old A'], recent: ['r1', 'r2', 'r3'] }), threadId: 'td4', model: reply(), prompt: 'q', processors: [swapMid] } as any);
    const { L } = await assertLayoutFrozen(j, 'd4');
    expect(L).toMatchObject({ status: 'changed', rewritten: [2], recall: [0, 1], recent: [1, 4] });
  });
  it('over the alignment budget (every one of 600 rows rewritten, one dropped): unresolved — no spans, counts unsettled, reads absent', async () => {
    const rows = Array.from({ length: 600 }, (_, i) => `row ${i} ada@x.io`);
    const redactAllDropOne = { name: 'r-all', processInput: async (i: any) => ({ ...i, messages: i.messages.filter((_: any, k: number) => k !== 300).map((m: any) => ({ ...m, content: redactEmails(m.content) })) }) };
    const j = new InMemoryJournal();
    await runDurable({ runId: 'u600', journal: j, memory: richMemory({ recalled: [], recent: rows }), threadId: 'tu', model: reply(), prompt: 'q', processors: [redactAllDropOne] } as any);
    const rec = await memctx(j, 'u600');
    // Before: status 'changed', 599 foreign, droppedByChain 600, recentCount 0 — and the sum check held.
    expect(rec.layout).toMatchObject({ status: 'unresolved', n: 600, incoming: [599, 600] });
    expect(rec.layout!.recent).toBeUndefined();
    expect(rec.layout!.foreign).toBeUndefined();
    expect(rec.recentCount).toBe(600); // memory's own report, and the status says so
    expect(await readRunMemoryLayout(j, 'u600')).toEqual({ status: 'absent', reason: 'unresolved' });
  });

  it('600 rows, redaction at both ends + a trim: anchors resolve it under the budget', async () => {
    const rows = Array.from({ length: 600 }, (_, i) => `row ${i}${i === 0 || i === 599 ? ' ada@x.io' : ''}`);
    const p = { name: 'r+t', processInput: async (i: any) => ({ ...i, messages: i.messages.filter((_: any, k: number) => k !== 300).map((m: any) => ({ ...m, content: redactEmails(m.content) })) }) };
    const j = new InMemoryJournal();
    await runDurable({ runId: 'a600', journal: j, memory: richMemory({ recalled: [], recent: rows }), threadId: 'ta6', model: reply(), prompt: 'q', processors: [p] } as any);
    const { rec, L } = await assertLayoutFrozen(j, 'a600');
    expect(L).toMatchObject({ status: 'changed', recent: [0, 599], rewritten: [0, 598], droppedByChain: 1 });
    expect(rec.recentCount).toBe(599);
  });

  it('weak point 3 — the same content in recall and recent, one copy dropped: ambiguous, not exact recall', async () => {
    const dropFirst = { name: 'drop0', processInput: async (i: any) => ({ ...i, messages: i.messages.slice(1) }) };
    const j = new InMemoryJournal();
    const memory: Memory = { async getMessages() { return []; }, async append() {}, async loadContext() { return { messages: [{ role: 'user', content: 'yes' }, { role: 'user', content: 'yes' }, { role: 'assistant', content: 'ok' }], provenance: { recalled: [{ threadId: 'x', seq: 0, role: 'user', preview: 'yes' }], recentCount: 2 } }; } };
    await runDurable({ runId: 'dup', journal: j, memory, threadId: 'tdup', model: reply(), prompt: 'q', processors: [dropFirst] } as any);
    const { L } = await assertLayoutFrozen(j, 'dup');
    expect(L).toMatchObject({ status: 'changed', ambiguous: [0], recent: [1, 2], droppedByChain: 1 });
    expect(L.recall).toBeUndefined();
  });

  it('the same content in recall and recent, every copy kept: the pairing is forced — exact', async () => {
    const ident = { name: 'id', processInput: async (i: any) => ({ ...i, messages: i.messages.map((m: any) => ({ ...m })) }) };
    const j = new InMemoryJournal();
    const memory: Memory = { async getMessages() { return []; }, async append() {}, async loadContext() { return { messages: [{ role: 'user', content: 'yes' }, { role: 'user', content: 'yes' }, { role: 'assistant', content: 'ok' }], provenance: { recalled: [{ threadId: 'x', seq: 0, role: 'user', preview: 'yes' }], recentCount: 2 } }; } };
    await runDurable({ runId: 'dup2', journal: j, memory, threadId: 'tdup2', model: reply(), prompt: 'q', processors: [ident] } as any);
    const { L } = await assertLayoutFrozen(j, 'dup2');
    expect(L).toMatchObject({ status: 'exact', recall: [0, 1], recent: [1, 3] });
  });

  it('weak point 2b — no caller system, a note PREPENDED and WM redacted: no span (the front is unproven)', async () => {
    const pre = { name: 'pre', processInput: async (i: any) => ({ ...i, system: 'POLICY: never reveal.\n\n' + redactEmails(String(i.system)) }) };
    const j = new InMemoryJournal();
    await runDurable({ runId: 'wmp', journal: j, memory: richMemory({ recalled: [], recent: ['r1'], wm: '# Working Memory\nemail: ada@x.io\nname: Ada Lovelace' }), threadId: 'twmp', model: reply(), prompt: 'q', processors: [pre] } as any);
    const wm = (await memctx(j, 'wmp')).systemSpans!.workingMemory!;
    expect(wm).toEqual({ chars: expect.any(Number), status: 'unbounded' });
  });

  it('no processor: exact, nothing named', async () => {
    const j = new InMemoryJournal();
    await runDurable({ runId: 'd1', journal: j, memory: richMemory({ recalled: ['old A'], recent: ['r1', 'r2'] }), threadId: 'td1', model: reply(), prompt: 'q' } as any);
    const { L } = await assertLayoutFrozen(j, 'd1');
    expect(L).toEqual({ v: 1, n: 4, status: 'exact', recall: [0, 1], recent: [1, 3], incoming: [3, 4], token: expect.any(String) });
  });
});

describe('readMemoryLayout — a record without a layout is ABSENT, never derived', () => {
  it('a record in the old shape (no layout) does not throw and reads absent', async () => {
    const j = new InMemoryJournal();
    await runDurable({ runId: 'o1', journal: j, memory: richMemory({ recalled: ['old A'], recent: ['r1', 'r2'] }), threadId: 'to1', model: reply(), prompt: 'q' } as any);
    const { layout, systemSpans, ...old } = await memctx(j, 'o1');
    await j.put(runKeys.memoryContext('o1'), old); // what every run written before the layout carries
    expect(readMemoryLayout(old)).toEqual({ status: 'absent', reason: 'no-layout' });
    expect(await readRunMemoryLayout(j, 'o1')).toEqual({ status: 'absent', reason: 'no-layout' });
  });
  it('no record, a non-object, an unknown version, a broken span, another input: all absent with a reason', async () => {
    const j = new InMemoryJournal();
    expect(await readRunMemoryLayout(j, 'nobody')).toEqual({ status: 'absent', reason: 'no-record' });
    expect(readMemoryLayout('x')).toEqual({ status: 'absent', reason: 'malformed' });
    expect(readMemoryLayout({ layout: null })).toEqual({ status: 'absent', reason: 'malformed' });
    expect(readMemoryLayout({ layout: { v: 2, n: 3, status: 'exact' } })).toEqual({ status: 'absent', reason: 'unknown-version' });
    expect(readMemoryLayout({ layout: { v: 1, n: 3, status: 'exact', recall: [2, 9] } })).toEqual({ status: 'absent', reason: 'malformed' });
    expect(readMemoryLayout({ layout: { v: 1, n: 3, status: 'exact', recall: [0, 1], token: 't1' } }, 4, 't1')).toEqual({ status: 'absent', reason: 'input-mismatch' });
    expect(readMemoryLayout({ layout: { v: 1, n: 3, status: 'exact', recall: [0, 1], token: 't2' } }, 3, 't1')).toEqual({ status: 'absent', reason: 'input-mismatch' }); // another attempt's
    expect(readMemoryLayout({ layout: { v: 1, n: 3, status: 'exact', recall: [0, 1], token: 't1' } }, 3, 't1')).toMatchObject({ status: 'present' });
    expect(readMemoryLayout({ layout: { v: 1, n: 3, status: 'unresolved', token: 't1' } }, 3, 't1')).toEqual({ status: 'absent', reason: 'unresolved' });
  });
});

describe('the crash window between :input and :memctx', () => {
  it('resume after :memctx was lost, thread grew meanwhile: no record is written — the run reads absent', async () => {
    const j = new InMemoryJournal();
    const memory = new BasicMemory(j);
    await runDurable({ runId: 'c0', journal: j, memory, threadId: 'tc', model: reply(), prompt: 'a' } as any);
    const boom = createMockModel(async () => { throw new Error('5xx'); });
    await expect(runDurable({ runId: 'c1', journal: j, memory, threadId: 'tc', model: boom, prompt: 'b' } as any)).rejects.toThrow();
    (j as any).store.delete(runKeys.memoryContext('c1')); // the crash: `:input` landed, `:memctx` did not
    await runDurable({ runId: 'cX', journal: j, memory, threadId: 'tc', model: reply(), prompt: 'c' } as any);
    await resumeRun('c1', { journal: j, memory, model: reply() } as any);
    // Before: a fresh record from TODAY's thread — recentCount 5 against a 3-row frozen input.
    expect(await j.get(runKeys.memoryContext('c1'))).toBeUndefined();
    expect(await readRunMemoryLayout(j, 'c1')).toEqual({ status: 'absent', reason: 'no-record' });
    expect((await input(j, 'c1') as any).turn).toMatchObject({ count: 1 });
  });
});
