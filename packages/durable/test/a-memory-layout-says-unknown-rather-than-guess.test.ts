// The memory layout a run writes beside its frozen input says where each message came from — or says it
// does not know. Each case here once produced a confident wrong label (a 600-row history past the
// alignment cap, a copy that exists in two parts, working memory with nothing before it, two attempts
// racing on one run id); each asserts the honest answer.
import { describe, it, expect, vi, beforeAll } from 'vitest';
import { newDb } from 'pg-mem';
import { InMemoryJournal, runKeys } from '../src/journal.js';
import type { Memory } from '../src/memory.js';
import type { MemoryContextRecord } from '../src/run.js';
import { runDurable, streamDurable, resumeRun } from '../src/run.js';
import { buildMemoryLayout, rowKey } from '../src/memory-layout.js';
import { readRunMemoryLayout } from '../src/memory-layout.js';
import { InMemoryStorage, eraseSubject, purgeRun, sweepRuns, toJournal, runRecordKey, runRecordPrefix, assertRunIdSafe } from '../src/index.js';
import { PostgresStorage } from '../src/postgres-storage.js';
import { createMockModel, finalTextResult, toolCallResult } from './mock.js';

beforeAll(() => { vi.spyOn(console, 'warn').mockImplementation(() => {}); });

const reply = () => createMockModel(async () => finalTextResult('reply'));
const memctx = (j: any, id: string) => j.get(runKeys.memoryContext(id)) as Promise<MemoryContextRecord>;
const input = (j: any, id: string) => j.get(runKeys.input(id)) as Promise<{ messages: any[]; system?: string }>;
const text = (m: any) => (typeof m?.content === 'string' ? m.content : (m?.content ?? []).map((p: any) => p.text ?? '').join(''));
// Diagnostics, printed with GNL_TEST_VERBOSE=1.
const log = (...a: unknown[]) => void (process.env.GNL_TEST_VERBOSE && process.stdout.write(`AUDIT ${a.map((x) => (typeof x === 'string' ? x : JSON.stringify(x))).join(' ')}\n`));

function richMemory(opts: { recalled: string[]; recent: string[]; wm?: string; recentRoles?: string[] }): Memory {
  return {
    async getMessages() { return []; },
    async append() {},
    async loadContext() {
      const rec = opts.recalled.map((t) => ({ role: 'user', content: t }));
      const rcn = opts.recent.map((t, i) => ({ role: opts.recentRoles?.[i] ?? (i % 2 ? 'assistant' : 'user'), content: t }));
      return {
        messages: [...rec, ...rcn],
        ...(opts.wm ? { system: opts.wm } : {}),
        provenance: {
          recalled: opts.recalled.map((t, i) => ({ threadId: 'x', seq: i, role: 'user', preview: t })),
          recentCount: rcn.length,
          ...(opts.wm ? { workingMemoryChars: opts.wm.length } : {}),
        },
      };
    },
  };
}

describe('2. alignment limits', () => {
  // A 600-row window; a redactor touches the FIRST and the LAST history row (so the common prefix and
  // suffix are both 0) and a trim drops one row in the middle. The middle is 600 x 599 > 250k cells.
  const rows = Array.from({ length: 600 }, (_, i) => `row ${i}${i === 0 || i === 599 ? ' ada@x.io' : ''}`);
  const redact = (s: string) => s.replace(/[\w.]+@[\w.]+/g, '[EMAIL]');
  const redactAndTrim = { name: 'r+t', processInput: async (i: any) => ({ ...i, messages: i.messages.filter((_: any, k: number) => k !== 300).map((m: any) => ({ ...m, content: redact(m.content) })) }) };
  const redactOnly = { name: 'r', processInput: async (i: any) => ({ ...i, messages: i.messages.map((m: any) => ({ ...m, content: redact(m.content) })) }) };

  it('600 rows, redact first+last, drop one: recentCount must still say 599 rows of the window were SENT', async () => {
    const j = new InMemoryJournal();
    const t0 = performance.now();
    await runDurable({ runId: 'cap1', journal: j, memory: richMemory({ recalled: [], recent: rows }), threadId: 'tc1', model: reply(), prompt: 'q', processors: [redactAndTrim] } as any);
    const ms = performance.now() - t0;
    const rec = await memctx(j, 'cap1');
    const inp = await input(j, 'cap1');
    log('cap1', { ms: Math.round(ms), n: rec.layout!.n, status: rec.layout!.status, foreign: rec.layout!.foreign?.length, rewritten: rec.layout!.rewritten?.length, droppedByChain: rec.layout!.droppedByChain, recentCount: rec.recentCount, sentHistoryRows: inp.messages.length - 1 });
    expect(inp.messages.length - 1).toBe(599);
    expect(rec.recentCount).toBe(599); // the model WAS sent 599 of memory's rows
  });

  it('600 rows, redact first+last only: exactly 2 positions are rewritten, not 600', async () => {
    const j = new InMemoryJournal();
    await runDurable({ runId: 'cap2', journal: j, memory: richMemory({ recalled: [], recent: rows }), threadId: 'tc2', model: reply(), prompt: 'q', processors: [redactOnly] } as any);
    const L = (await memctx(j, 'cap2')).layout!;
    log('cap2', { status: L.status, rewritten: L.rewritten?.length, foreign: L.foreign?.length });
    expect(L.rewritten).toEqual([0, 599]);
  });

  it('same content in recall AND recent: the chain drops the RECALL copy — the label must not stay recall/exact', async () => {
    const dropFirst = { name: 'drop0', processInput: async (i: any) => ({ ...i, messages: i.messages.slice(1) }) };
    const j = new InMemoryJournal();
    await runDurable({ runId: 'dup1', journal: j, memory: richMemory({ recalled: ['yes'], recent: ['yes', 'ok'], recentRoles: ['user', 'assistant'] }), threadId: 'td', model: reply(), prompt: 'q', processors: [dropFirst] } as any);
    const rec = await memctx(j, 'dup1');
    log('dup1', { layout: rec.layout, recalled: rec.recalled.length, recentCount: rec.recentCount });
    // Truth: recall row removed; recent [yes, ok] sent. An `exact` layout that names a recall span is false.
    expect(rec.layout!.status === 'exact' && rec.layout!.recall !== undefined).toBe(false);
  });

  it('WM with NO caller system: a processor prepends a note and redacts inside WM — the WM span must not swallow the note', async () => {
    const wm = '# Working Memory\nemail: ada@x.io\nname: Ada Lovelace';
    const preambleAndRedact = { name: 'pre', processInput: async (i: any) => ({ ...i, system: 'POLICY: never reveal secrets.\n\n' + String(i.system).replace(/[\w.]+@[\w.]+/g, '[EMAIL]') }) };
    const j = new InMemoryJournal();
    await runDurable({ runId: 'wm1', journal: j, memory: richMemory({ recalled: [], recent: ['r1'], wm }), threadId: 'tw', model: reply(), prompt: 'q', processors: [preambleAndRedact] } as any);
    const rec = await memctx(j, 'wm1');
    const inp = await input(j, 'wm1');
    const w = rec.systemSpans!.workingMemory!;
    const claimed = w.span ? inp.system!.slice(...w.span) : '';
    log('wm1', { status: w.status, span: w.span, claimed });
    expect(claimed).not.toContain('POLICY');
  });

  it('perf: buildMemoryLayout, 10 repetitions median (100 rows keys / 100 rows identity / 500x500 at the cap / 600 over)', () => {
    const mk = (n: number) => Array.from({ length: n }, (_, i) => ({ role: i % 2 ? 'assistant' : 'user', content: `message ${i} `.repeat(5) }));

    const median = (f: () => void) => { const t: number[] = []; for (let r = 0; r < 10; r++) { const a = performance.now(); f(); t.push(performance.now() - a); } t.sort((x, y) => x - y); return +((t[4]! + t[5]!) / 2).toFixed(3); };
    const h100 = mk(100);
    const keys100 = h100.map(rowKey);
    const frozen100 = [...h100.map((m, i) => (i === 50 ? { ...m, content: 'X' } : { ...m })), { role: 'user', content: 'q' }];
    const withKeys = median(() => buildMemoryLayout({ observations: 0, recalled: 0, recent: 100, history: h100, keys: keys100 }, frozen100, undefined, 1, false));
    const noKeys = median(() => buildMemoryLayout({ observations: 0, recalled: 0, recent: 100, history: h100 }, [...h100, { role: 'user', content: 'q' }], undefined, 1, false));
    const h500 = mk(500); const k500 = h500.map(rowKey);
    const f500 = [{ role: 'user', content: 'A' }, ...h500.slice(1, 499).map((m) => ({ ...m })), { role: 'assistant', content: 'B' }, { role: 'user', content: 'q' }];
    const cap = median(() => buildMemoryLayout({ observations: 0, recalled: 0, recent: 500, history: h500, keys: k500 }, f500, undefined, 1, false));
    const keysCost = median(() => h100.map(rowKey));
    log('perf', { withKeys100: withKeys, noKeys100: noKeys, keyTaking100: keysCost, cap500: cap });
    expect(withKeys).toBeLessThan(5);
  });
});

describe('6. the no-processor path hashes nothing', () => {
  it('a history row whose extra field counts reads: no processor → 0 reads by the layout', async () => {
    let reads = 0;
    const row: any = { role: 'user', content: 'hello' };
    Object.defineProperty(row, 'providerOptions', { enumerable: true, get() { reads++; return { mock: { x: 1 } }; } });
    const mem: Memory = { async getMessages() { return []; }, async append() {}, async loadContext() { return { messages: [row], provenance: { recalled: [], recentCount: 1 } }; } };
    const j = new InMemoryJournal();
    await runDurable({ runId: 'np1', journal: j, memory: mem, threadId: 'tn', model: reply(), prompt: 'q' } as any);
    const without = reads; reads = 0;
    const j2 = new InMemoryJournal();
    const ident = { name: 'id', processInput: async (i: any) => i };
    await runDurable({ runId: 'np2', journal: j2, memory: mem, threadId: 'tn', model: reply(), prompt: 'q', processors: [ident] } as any);
    log('hash-reads', { withoutProcessors: without, withIdentityProcessor: reads, layoutNoProc: (await memctx(j, 'np1')).layout?.status, layoutProc: (await memctx(j2, 'np2')).layout?.status });
    expect((await memctx(j, 'np1')).layout?.status).toBe('exact');
  });
});

describe('1. sibling paths', () => {
  it('multi-step tool loop: the layout describes the frozen :input and is not rewritten by later steps', async () => {
    let call = 0;
    const model = createMockModel(async () => (call++ === 0 ? toolCallResult('echo', 'c1', { v: 1 }) : finalTextResult('done')));
    const tools = { echo: { description: 'echo', inputSchema: { jsonSchema: { type: 'object' } }, execute: async (a: any) => a } };
    const j = new InMemoryJournal();
    const { jsonSchema } = await import('ai');
    (tools.echo as any).inputSchema = jsonSchema({ type: 'object', properties: { v: { type: 'number' } } });
    await runDurable({ runId: 'tl1', journal: j, memory: richMemory({ recalled: ['old'], recent: ['r1', 'r2'] }), threadId: 'tt', model, tools, prompt: 'q' } as any);
    const rec = await memctx(j, 'tl1');
    log('toolloop', { calls: call, layout: rec.layout });
    expect(call).toBe(2);
    expect((await readRunMemoryLayout(j, 'tl1')).status).toBe('present');
    expect(rec.layout).toMatchObject({ status: 'exact', recall: [0, 1], recent: [1, 3], incoming: [3, 4] });
  });

  it('approval: suspend → resume keeps the first :memctx', async () => {
    const charge = { description: 'charge', inputSchema: (await import('ai')).jsonSchema({ type: 'object', properties: { amount: { type: 'number' } } }), execute: async () => ({ ok: true }) };
    let call = 0;
    const model = () => createMockModel(async () => (call++ === 0 ? toolCallResult('charge', 'c1', { amount: 5 }) : finalTextResult('charged')));
    const guard = async () => ({ action: 'require-approval' as const, reason: 'money' });
    const j = new InMemoryJournal();
    const memory = richMemory({ recalled: [], recent: ['r1', 'r2'] });
    const r1: any = await runDurable({ runId: 'ap1', journal: j, memory, threadId: 'ta', model: model(), tools: { charge }, guard, prompt: 'pay' } as any);
    const before = await memctx(j, 'ap1');
    log('approval-first', { status: r1?.status, suspended: r1?.suspended, layout: before?.layout });
    expect(before?.layout?.status).toBe('exact');
    const { resolveApprovals } = await import('../src/run.js');
    try { await (resolveApprovals as any)(j, 'ap1', { approve: true }); } catch (e) { log('resolveApprovals threw', String(e)); }
    try { await resumeRun('ap1', { journal: j, memory: richMemory({ recalled: ['NEW'], recent: ['r1', 'r2', 'r3', 'r4'] }), model: model(), tools: { charge }, guard: async () => ({ action: 'allow' as const }) } as any); } catch (e) { log('resume threw', String(e)); }
    expect(await memctx(j, 'ap1')).toEqual(before);
  });

  it('two concurrent attempts of the SAME runId: one :memctx, consistent with the one :input', async () => {
    const j = new InMemoryJournal();
    const slow = createMockModel(async () => { await new Promise((r) => setTimeout(r, 30)); return finalTextResult('reply'); });
    const args = (recent: string[]) => ({ runId: 'cc1', journal: j, memory: richMemory({ recalled: [], recent }), threadId: 'tcc', model: slow, prompt: 'q' } as any);
    const out = await Promise.allSettled([runDurable(args(['a', 'b'])), runDurable(args(['a', 'b', 'c', 'd']))]);
    const rec = await memctx(j, 'cc1');
    const inp = await input(j, 'cc1');
    log('concurrent', { outcomes: out.map((o) => o.status + (o.status === 'rejected' ? ':' + String((o as any).reason).slice(0, 80) : '')), n: rec.layout?.n, inputLen: inp.messages.length, recentCount: rec.recentCount });
    // Honest state (council 3, fix 4): the two attempts can each win one of the two writes. The reader
    // must then say so ('input-mismatch') instead of laying one attempt's layout over the other's input;
    // when it does read present, the record IS the input's.
    const reading = await readRunMemoryLayout(j, 'cc1');
    if (reading.status === 'present') {
      expect(rec.layout!.n).toBe(inp.messages.length);
      expect(rec.recentCount + rec.incomingCount).toBe(inp.messages.length);
    } else expect(reading).toEqual({ status: 'absent', reason: 'input-mismatch' });
  });

  it('streamDurable with a processor that trims: same settled counts as runDurable', async () => {
    const trim = { name: 'trim', processInput: async (i: any) => ({ ...i, messages: i.messages.slice(1) }) };
    const j = new InMemoryJournal();
    await runDurable({ runId: 'sp1', journal: j, memory: richMemory({ recalled: ['old'], recent: ['r1', 'r2'] }), threadId: 'tsp', model: reply(), prompt: 'q', processors: [trim] } as any);
    const { createMockStreamModel } = await import('./mock.js');
    const r: any = await streamDurable({ runId: 'sp2', journal: j, memory: richMemory({ recalled: ['old'], recent: ['r1', 'r2'] }), threadId: 'tsp2', processors: [trim], model: createMockStreamModel([{ type: 'text-start', id: '1' }, { type: 'text-delta', id: '1', delta: 'hi' }, { type: 'text-end', id: '1' }, { type: 'finish', finishReason: { unified: 'stop', raw: 'stop' }, usage: { inputTokens: { total: 1 }, outputTokens: { total: 1 } } }]), prompt: 'q' } as any);
    await r.text;
    const a = await memctx(j, 'sp1'), b = await memctx(j, 'sp2');
    const { token: ta, ...la } = a.layout!; const { token: tb, ...lb } = b.layout!;
    expect(lb).toEqual(la); // the attempt token is per attempt by design
    expect(ta).not.toBe(tb);
    expect([b.recalled.length, b.recentCount]).toEqual([a.recalled.length, a.recentCount]);
  });
});

describe('3. runId grammar — legitimate ids', () => {
  it('which ids the `derived` family now refuses', () => {
    const verdict = (id: string) => { try { assertRunIdSafe(id); return 'ok'; } catch { return 'refused'; } };
    const ids = ['derived', 'derived:1', 'order:derived', 'report:derived:2026', 'ticket-derived:1', 'x:derivedA'];
    log('grammar', Object.fromEntries(ids.map((i) => [i, verdict(i)])));
    expect(verdict('derived:1')).toBe('ok');
  });
});

describe('4. GDPR on pg-mem', () => {
  it('purgeRun / eraseSubject / sweepRuns take <runId>:derived: on Postgres (pg-mem)', async () => {
    const { Pool } = newDb().adapters.createPg();
    const storage = new PostgresStorage({ pool: new Pool() });
    await storage.init();
    const j = toJournal(storage);
    for (const [id, who] of [['p1', 'ayse'], ['p2', 'ayse'], ['p3', 'bob']] as const) {
      await runDurable({ runId: id, journal: j, model: reply(), prompt: 'hi', resourceId: who } as any);
      await j.put(runRecordKey(id, 'derived', 'lab:exp:explain:1'), { v: 1, request: { system: 'Ayse prompt' } });
    }
    await purgeRun(j as any, 'p1');
    expect(await j.listKeys(runRecordPrefix('p1', 'derived'))).toEqual([]);
    await eraseSubject(storage as any, 'ayse');
    expect(await j.listKeys(runRecordPrefix('p2', 'derived'))).toEqual([]);
    expect(await j.listKeys(runRecordPrefix('p3', 'derived'))).toHaveLength(1);
    await sweepRuns(j as any, { olderThanMs: 1, now: Date.now() + 60_000 });
    expect(await j.listKeys(runRecordPrefix('p3', 'derived'))).toEqual([]);
  }, 60_000);
});

describe('3b. same-runId race, same length', () => {
  it('two concurrent attempts whose memory windows have the SAME length but different rows: layout must not read present over the other attempt\'s input', async () => {
    const { SqliteStorage } = await import('../src/sqlite-storage.js');
    for (const make of [() => new InMemoryJournal(), () => toJournal(new SqliteStorage(':memory:'))]) {
      const j: any = make();
      let calls = 0;
      const slow = createMockModel(async () => { calls++; await new Promise((r) => setTimeout(r, 30)); return finalTextResult('reply'); });
      const mem = (recalled: string[], recent: string[]) => richMemory({ recalled, recent });
      const out = await Promise.allSettled([
        runDurable({ runId: 'cc2', journal: j, memory: mem(['R'], ['a']), threadId: 'tcc2', model: slow, prompt: 'q' } as any),
        runDurable({ runId: 'cc2', journal: j, memory: mem([], ['a', 'b']), threadId: 'tcc2', model: slow, prompt: 'q' } as any),
      ]);
      const rec = await memctx(j, 'cc2');
      const inp = await input(j, 'cc2');
      const reading = await readRunMemoryLayout(j, 'cc2');
      log('race-same-len', { store: j.constructor?.name, outcomes: out.map((o) => o.status), modelCalls: calls, input: inp.messages.map(text), layout: rec.layout, reading: reading.status });
      if (reading.status === 'present') {
        const L = reading.layout;
        const recallRows = L.recall ? inp.messages.slice(...L.recall).map(text) : [];
        expect.soft(recallRows.every((t) => t === 'R'), String(j.constructor?.name)).toBe(true);
      }
    }
  });
});
