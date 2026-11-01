// The layout under a processor that reorders, drops or rewrites rows, and under resume and fork: the
// anchors it aligns on, the positions it calls ambiguous, the working memory span it will not claim,
// and the attempt token that ties the layout to the input it describes.
import { describe, it, expect, vi, beforeAll } from 'vitest';
import { InMemoryJournal, runKeys } from '../src/journal.js';
import type { Memory } from '../src/memory.js';
import { BasicMemory } from '../src/memory.js';
import type { MemoryContextRecord } from '../src/run.js';
import { runDurable, resumeRun } from '../src/run.js';
import { forkRun } from '../src/time-travel.js';
import { buildMemoryLayout, rowKey, readRunMemoryLayout } from '../src/memory-layout.js';
import { createMockModel, finalTextResult } from './mock.js';

beforeAll(() => { vi.spyOn(console, 'warn').mockImplementation(() => {}); });
const reply = () => createMockModel(async () => finalTextResult('reply'));
const memctx = (j: any, id: string) => j.get(runKeys.memoryContext(id)) as Promise<MemoryContextRecord>;
const input = (j: any, id: string) => j.get(runKeys.input(id)) as Promise<{ messages: any[]; system?: string; turn?: any }>;
const text = (m: any) => (typeof m?.content === 'string' ? m.content : '');
// Diagnostics, printed with GNL_TEST_VERBOSE=1.
const log = (...a: unknown[]) => void (process.env.GNL_TEST_VERBOSE && process.stdout.write(`AUDIT ${a.map((x) => (typeof x === 'string' ? x : JSON.stringify(x))).join(' ')}\n`));

function richMemory(opts: { recalled: string[]; recent: string[]; wm?: string }): Memory {
  return {
    async getMessages() { return []; }, async append() {},
    async loadContext() {
      const rec = opts.recalled.map((t) => ({ role: 'user', content: t }));
      const rcn = opts.recent.map((t, i) => ({ role: i % 2 ? 'assistant' : 'user', content: t }));
      return { messages: [...rec, ...rcn], ...(opts.wm ? { system: opts.wm } : {}), provenance: { recalled: opts.recalled.map((t, i) => ({ threadId: 'x', seq: i, role: 'user', preview: t })), recentCount: rcn.length } };
    },
  };
}
const proc = (name: string, f: (m: any[]) => any[], sys?: (s: any) => any) => ({ name, processInput: async (i: any) => ({ ...i, messages: f(i.messages), ...(sys ? { system: sys(i.system) } : {}) }) });
async function run(id: string, memory: Memory, processors: any[], system?: string) {
  const j = new InMemoryJournal();
  await runDurable({ runId: id, journal: j, memory, threadId: 't-' + id, model: reply(), prompt: 'Q', processors, ...(system ? { system } : {}) } as any);
  const rec = await memctx(j, id); const inp = await input(j, id);
  return { j, rec, inp, L: rec.layout!, reading: await readRunMemoryLayout(j, id) };
}
/** Every labelled position's content must be a row memory returned in THAT part (or be named rewritten/foreign/ambiguous). */
function labelsTrue(L: any, inp: any, recalled: string[], recent: string[]) {
  const named = new Set([...(L.rewritten ?? []), ...(L.foreign ?? []), ...(L.ambiguous ?? [])]);
  const bad: string[] = [];
  for (const [part, pool] of [['recall', recalled], ['recent', recent]] as const) {
    if (!L[part]) continue;
    for (let i = L[part][0]; i < L[part][1]; i++) if (!named.has(i) && !pool.includes(text(inp.messages[i]))) bad.push(`${part}@${i}=${text(inp.messages[i])}`);
  }
  return bad;
}

describe('round 2 — alignment', () => {
  it('a foreign row in the MIDDLE of recent: named foreign, the recent span around it stays honest', async () => {
    const recent = ['a', 'b', 'c', 'd'];
    const { L, inp, rec } = await run('m1', richMemory({ recalled: ['R'], recent }), [proc('mid', (m) => [...m.slice(0, 3), { role: 'user', content: 'DOC' }, ...m.slice(3)])]);
    log('mid-foreign', L, { recentCount: rec.recentCount });
    expect(L.foreign).toEqual([3]);
    expect(labelsTrue(L, inp, ['R'], recent)).toEqual([]);
  });

  it('repeated content inside ONE part, one copy dropped: exact (the label is the same either way)', async () => {
    const recent = ['ok', 'x', 'ok', 'y', 'ok', 'z'];
    const { L, inp } = await run('m2', richMemory({ recalled: [], recent }), [proc('drop2', (m) => m.filter((_: any, k: number) => k !== 2))]);
    log('same-part-dup', L);
    expect(L.ambiguous).toBeUndefined();
    expect(L.droppedByChain).toBe(1);
    expect(labelsTrue(L, inp, [], recent)).toEqual([]);
  });

  it('same content in recall AND recent, copies equal, the processor MOVES the recall copy behind recent', async () => {
    const recalled = ['same'], recent = ['same', 'p', 'u2', 'q'];
    const { L, inp, rec } = await run('m3', richMemory({ recalled, recent }), [proc('move', (m) => [...m.slice(1, 5), m[0], ...m.slice(5)])]);
    log('dup-move', L, { recalled: rec.recalled.length, recentCount: rec.recentCount, input: inp.messages.map(text) });
    // position 0 is now the recent 'same'; position 4 is the recall 'same' — a layout saying recall=[0,1) lies.
    expect(L.recall === undefined || L.recall[0] !== 0 || (L.ambiguous ?? []).includes(0)).toBe(true);
  });

  it('a processor that REVERSES the history: nothing labelled with the wrong part', async () => {
    const recalled = ['R1', 'R2'], recent = ['a', 'b', 'c', 'd'];
    const { L, inp } = await run('m4', richMemory({ recalled, recent }), [proc('rev', (m) => [...m.slice(0, -1).reverse(), m[m.length - 1]])]);
    log('reverse', L, inp.messages.map(text));
    expect(labelsTrue(L, inp, recalled, recent)).toEqual([]);
    // the part spans must not claim a row of the other part
    if (L.recall) for (let i = L.recall[0]; i < L.recall[1]; i++) if (!(L.foreign ?? []).includes(i) && !(L.rewritten ?? []).includes(i)) expect(recalled).toContain(text(inp.messages[i]));
  });

  it('one-for-one gap rule across a part boundary: drop the last recall row, inject a user row in its place', async () => {
    const recalled = ['R1', 'R2'], recent = ['a', 'b'];
    const { L, inp } = await run('m5', richMemory({ recalled, recent }), [proc('swap', (m) => [m[0], { role: 'user', content: 'INJECTED' }, ...m.slice(2)])]);
    log('swap-boundary', L);
    // documented: `rewritten` positional only — acceptable only if the position is NAMED rewritten
    expect(L.rewritten ?? []).toContain(1);
  });

  it('a window with NO unique rows (every content twice) over the cap: unresolved and absent, fast', async () => {
    const recent = Array.from({ length: 600 }, (_, i) => `dup ${i % 300}`); // i and i+300 share role and content: no unique key
    const t0 = performance.now();
    const { L, reading, rec } = await run('m6', richMemory({ recalled: [], recent }), [proc('ends', (m) => m.map((x: any, k: number) => (k === 0 || k === 599 ? { ...x, content: 'MASK' } : x)))]);
    const ms = performance.now() - t0;
    log('no-unique', { status: L.status, reading, ms: Math.round(ms), recentCount: rec.recentCount });
    expect(L.status).toBe('unresolved');
    expect(reading).toEqual({ status: 'absent', reason: 'unresolved' });
  });
});

describe('round 2 — working memory front anchor', () => {
  for (const [label, system] of [['with caller system', 'You help.'], ['without caller system', undefined]] as const) {
    it(`${label}: WM's first 8 chars masked → unbounded, no span`, async () => {
      const wm = 'secret@x.io is the user; name: Ada Lovelace';
      const { rec, inp } = await run('w' + (system ? 1 : 2), richMemory({ recalled: [], recent: ['r'], wm }), [proc('mask', (m) => m, (s: any) => String(s).replace(/[\w.]+@[\w.]+/g, '[EMAIL]'))], system);
      const w = rec.systemSpans!.workingMemory!;
      log('wm-front', label, w, inp.system);
      expect(w.status).toBe('unbounded');
      expect(w.span).toBeUndefined();
    });
  }
});

describe('round 2 — the attempt token', () => {
  it('resume reads the SAME token; :input.turn.token === :memctx.layout.token', async () => {
    const j = new InMemoryJournal();
    const memory = new BasicMemory(j);
    await runDurable({ runId: 'k0', journal: j, memory, threadId: 'tk', model: reply(), prompt: 'a' } as any);
    const boom = createMockModel(async () => { throw new Error('5xx'); });
    await expect(runDurable({ runId: 'k1', journal: j, memory, threadId: 'tk', model: boom, prompt: 'b' } as any)).rejects.toThrow();
    const t1 = { in: (await input(j, 'k1')).turn?.token, mc: (await memctx(j, 'k1')).layout?.token };
    await resumeRun('k1', { journal: j, memory, model: reply() } as any);
    await runDurable({ runId: 'k1', journal: j, memory, threadId: 'tk', model: reply(), prompt: 'b' } as any);
    const t2 = { in: (await input(j, 'k1')).turn?.token, mc: (await memctx(j, 'k1')).layout?.token };
    log('token-resume', t1, t2);
    expect(t1.in).toBeDefined();
    expect(t1.in).toBe(t1.mc);
    expect(t2).toEqual(t1);
    expect((await readRunMemoryLayout(j, 'k1')).status).toBe('present');
    const thread = (await memory.getMessages('tk')).map(text);
    expect(thread.filter((t) => t === 'b')).toHaveLength(1);
  });

  it('fork: the copy carries matching tokens and reads present; resuming the fork does not re-mint', async () => {
    const j = new InMemoryJournal();
    const memory = new BasicMemory(j);
    await runDurable({ runId: 'f0', journal: j, memory, threadId: 'tf', model: reply(), prompt: 'a' } as any);
    await runDurable({ runId: 'f1', journal: j, memory, threadId: 'tf', model: reply(), prompt: 'b' } as any);
    const { newRunId } = await forkRun(j as any, 'f1', 0);
    await resumeRun(newRunId, { journal: j, memory, model: reply() } as any);
    const src = (await memctx(j, 'f1')).layout!.token, fk = (await memctx(j, newRunId)).layout!.token, fin = (await input(j, newRunId)).turn?.token;
    log('token-fork', { src, fk, fin });
    expect([fk, fin]).toEqual([src, src]);
    expect((await readRunMemoryLayout(j, newRunId)).status).toBe('present');
  });

  it('a run with memory but NO processor and no layout seed path: token still pairs (no false input-mismatch)', async () => {
    const j = new InMemoryJournal();
    const memory = new BasicMemory(j);
    for (let i = 0; i < 3; i++) await runDurable({ runId: 'n' + i, journal: j, memory, threadId: 'tn', model: reply(), prompt: 'p' + i } as any);
    const readings = await Promise.all([0, 1, 2].map((i) => readRunMemoryLayout(j, 'n' + i)));
    log('token-plain', readings.map((r) => r.status));
    expect(readings.every((r) => r.status === 'present')).toBe(true);
  });
});

describe('round 2 — performance (10 repetitions, median)', () => {
  it('600 / 1000 rows: processor path with scattered edits, identity path, no-unique worst case', () => {
    const mk = (n: number) => Array.from({ length: n }, (_, i) => ({ role: i % 2 ? 'assistant' : 'user', content: `message ${i} `.repeat(5) }));
    const median = (f: () => void) => { const t: number[] = []; for (let r = 0; r < 10; r++) { const a = performance.now(); f(); t.push(performance.now() - a); } t.sort((x, y) => x - y); return +((t[4]! + t[5]!) / 2).toFixed(3); };
    const out: Record<string, number> = {};
    for (const n of [100, 600, 1000]) {
      const h = mk(n);
      const keys = h.map(rowKey);
      const edited = h.map((m, i) => (i % 50 === 0 ? { ...m, content: 'EDIT ' + i } : m)).filter((_, i) => i % 97 !== 5);
      out[`proc${n}`] = median(() => buildMemoryLayout({ observations: 0, recalled: 0, recent: n, history: h, keys }, [...edited, { role: 'user', content: 'q' }], undefined, 1, false));
      out[`keys${n}`] = median(() => h.map(rowKey));
      out[`identity${n}`] = median(() => buildMemoryLayout({ observations: 0, recalled: 0, recent: n, history: h }, [...h, { role: 'user', content: 'q' }], undefined, 1, false));
      const half = n / 2; const pairs = Array.from({ length: n }, (_, i) => ({ role: i % 2 ? 'assistant' : 'user', content: `dup ${i % half}` }));
      const pk = pairs.map(rowKey);
      out[`worst${n}`] = median(() => buildMemoryLayout({ observations: 0, recalled: 0, recent: n, history: pairs, keys: pk }, [{ role: 'user', content: 'A' }, ...pairs.slice(1, -1), { role: 'assistant', content: 'B' }, { role: 'user', content: 'q' }], undefined, 1, false));
    }
    log('perf2', out);
    expect(out.proc1000).toBeLessThan(50);
  });
});
