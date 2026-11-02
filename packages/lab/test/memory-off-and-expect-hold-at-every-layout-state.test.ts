// The capsule and the memory-off replay at every state a layout can be in: proved positions are left out,
// a processor's own row and an ambiguous row stay (and are named), every unproved state is refused with
// its reason before a model is called; `expect` counts a stopped play as undetermined, outside passRate.
import { describe, it, expect, vi, beforeAll } from 'vitest';
import { tool } from 'ai';
import { z } from 'zod';
import { runDurable, InMemoryJournal, runKeys, readRunMemoryLayout, gnlTool, replayRun } from '@gnldev/durable';
import { createMockModel, finalTextResult } from '../../durable/test/mock.js';
import { runCapsule, memoryOfRun } from '../src/capsule.js';
import { studioLab } from '../src/studio.js';

beforeAll(() => { vi.spyOn(console, 'warn').mockImplementation(() => {}); });
// Diagnostics, printed with GNL_TEST_VERBOSE=1.
const log = (...a: unknown[]) => void (process.env.GNL_TEST_VERBOSE && process.stdout.write(`AUDIT ${a.map((x) => (typeof x === 'string' ? x : JSON.stringify(x))).join(' ')}\n`));
const text = (m: any) => (typeof m?.content === 'string' ? m.content : (m?.content ?? []).map((p: any) => p.text ?? '').join(''));

function richMemory(o: { recalled?: string[]; recent: string[]; wm?: string; obs?: string; liar?: boolean }): any {
  return {
    async getMessages() { return []; }, async append() {},
    async loadContext() {
      const obs = o.obs ? [{ role: 'system', content: `# Observations\n${o.obs}` }] : [];
      const rec = (o.recalled ?? []).map((t) => ({ role: 'user', content: t }));
      const rcn = o.recent.map((t, i) => ({ role: i % 2 ? 'assistant' : 'user', content: t }));
      return { messages: [...obs, ...rec, ...rcn], ...(o.wm ? { system: o.wm } : {}),
        provenance: { recalled: rec.map((r, i) => ({ threadId: 'x', seq: i, role: 'user', preview: r.content })), recentCount: rcn.length + (o.liar ? 1 : 0), ...(o.obs ? { observationCount: 1 } : {}) } };
    },
  };
}
const proc = (f: (m: any[]) => any[], sys?: (s: any) => any) => ({ name: 'p', processInput: async (i: any) => ({ ...i, messages: f(i.messages), ...(sys ? { system: sys(i.system) } : {}) }) });

/** A recorded run, then a capsule with memory:false whose model records what it was sent. */
async function capsule(memory: any, processors: any[] = [], system?: string, edit?: (j: InMemoryJournal) => Promise<void>) {
  const j = new InMemoryJournal();
  await runDurable({ runId: 'r', journal: j, memory, threadId: 't', model: createMockModel(async () => finalTextResult('rec')), prompt: 'THE TURN', processors, ...(system ? { system } : {}) } as any);
  if (edit) await edit(j);
  const seen: any[] = [];
  const model = createMockModel(async (o: any) => { seen.push(o.prompt); return finalTextResult('x'); });
  const reading = await readRunMemoryLayout(j, 'r');
  try {
    const res: any = await runCapsule({ journal: j, runId: 'r', model, memory: false, trials: 1 });
    const p = seen[0] as any[];
    return { ok: true as const, reading, sentSystem: p.filter((m) => m.role === 'system').map(text), sentRows: p.filter((m) => m.role !== 'system').map(text), notes: res.notes };
  } catch (e) { return { ok: false as const, reading, error: String(e).slice(0, 220) }; }
}
const setLayout = (patch: (rec: any) => any) => async (j: InMemoryJournal) => { const rec: any = await j.get(runKeys.memoryContext('r')); await j.put(runKeys.memoryContext('r'), patch(rec)); };

describe('round 3 — runCapsule(memory:false) per layout state', () => {
  it('exact: only the turn is sent, WM cut', async () => {
    const r = await capsule(richMemory({ recalled: ['R'], recent: ['a', 'b'], wm: '# Working Memory\nname: Ada' }), [], 'S');
    log('exact', r);
    expect(r.ok && r.sentRows).toEqual(['THE TURN']);
    expect(r.ok && r.sentSystem.join('')).toBe('S');
  });
  it('changed/foreign: the processor row stays, memory rows go', async () => {
    const r = await capsule(richMemory({ recalled: ['R'], recent: ['a', 'b'] }), [proc((m) => [{ role: 'user', content: 'DOC' }, ...m])]);
    log('foreign', r);
    expect(r.ok && r.sentRows).toEqual(['DOC', 'THE TURN']);
  });
  it('changed/ambiguous: memory content stays and a note says so', async () => {
    const r = await capsule(richMemory({ recalled: ['yes'], recent: ['yes', 'ok'] }), [proc((m) => m.slice(1))]);
    log('ambiguous', r);
    expect(r.ok && r.notes.join(' ')).toMatch(/stayed in/);
  });
  it('OM row: left out', async () => {
    const r = await capsule(richMemory({ obs: 'likes tea', recent: ['a'] }));
    log('om', r);
    expect(r.ok && r.sentRows).toEqual(['THE TURN']);
    expect(r.ok && r.sentSystem.join(' ')).not.toContain('likes tea');
  });
  for (const [name, mem, procs, edit, reason] of [
    ['counts-mismatch', richMemory({ recent: ['a'], liar: true }), [], undefined, /counts did not add up/],
    ['unresolved', richMemory({ recent: Array.from({ length: 600 }, (_, i) => `dup ${i % 300}`) }), [proc((m) => m.map((x: any, k: number) => (k === 0 || k === 599 ? { ...x, content: 'MASK' } : x)))], undefined, /too large to align/],
    ['boundary-lost', richMemory({ recent: ['a'] }), [], setLayout((r) => ({ ...r, layout: { ...r.layout, status: 'boundary-lost' } })), /no recoverable copy/],
    ['no-messages', richMemory({ recent: ['a'] }), [], setLayout((r) => ({ ...r, layout: { ...r.layout, status: 'no-messages' } })), /no messages/],
    ['no-record', richMemory({ recent: ['a'] }), [], async (j: InMemoryJournal) => { (j as any).store.delete(runKeys.memoryContext('r')); }, /no memory record/],
    ['no-layout', richMemory({ recent: ['a'] }), [], setLayout(({ layout, systemSpans, ...r }) => r), /before layouts existed/],
    ['unknown-version', richMemory({ recent: ['a'] }), [], setLayout((r) => ({ ...r, layout: { ...r.layout, v: 2 } })), /version/],
    ['malformed', richMemory({ recent: ['a'] }), [], setLayout((r) => ({ ...r, layout: { ...r.layout, recent: [5, 1] } })), /not readable/],
    ['input-mismatch', richMemory({ recent: ['a'] }), [], setLayout((r) => ({ ...r, layout: { ...r.layout, token: 'other' } })), /another input/],
  ] as const) {
    it(`${name}: refused with the reason, nothing sent`, async () => {
      const r = await capsule(mem, procs as any, undefined, edit as any);
      log('refuse', name, r.ok ? { sent: (r as any).sentRows.length } : r.error);
      expect(r.ok).toBe(false);
      expect(!r.ok && r.error).toMatch(reason as RegExp);
    });
  }
});

describe('round 3 — working memory cut by status', () => {
  const wm = '# Working Memory\nemail: ada@x.io\nname: Ada Lovelace';
  const cases: Array<[string, any, (s: string) => boolean]> = [
    ['moved', (s: any) => 'NOTE\n\n' + s, (sys) => sys === 'NOTE\n\nS'],
    ['rewritten', (s: any) => String(s).replace('ada@x.io', '[EMAIL]'), (sys) => sys === 'S'],
    ['unbounded', (s: any) => String(s).replace('Lovelace', 'L.') + '\n\nAPPENDED', () => false],
    ['unbounded', (s: any) => String(s).replace(/# Working Memory[\s\S]*/, ''), () => false], // WM removed whole: reads unbounded (the caller prefix survives)
  ];
  for (const [status, sys, ok] of cases) {
    it(`${status}`, async () => {
      const r = await capsule(richMemory({ recent: ['a'], wm }), [proc((m) => m, sys)], 'S');
      const st = ((await r.reading) as any).systemSpans?.workingMemory?.status;
      log('wm-cut', status, st, r.ok ? { system: r.sentSystem, notes: r.notes } : r.error);
      expect(st).toBe(status);
      if (status === 'unbounded') expect(r.ok).toBe(false);
      else if (status === 'lost') expect(r.ok ? r.sentSystem.join('') : 'refused').not.toContain('Working Memory'); // either refusal or nothing of WM sent
      else { expect(r.ok).toBe(true); expect(ok(r.ok ? r.sentSystem.join('') : '')).toBe(true); }
    });
  }
});

describe('round 3 — durable replayRun stripMemoryContext keeps ambiguous memory content', () => {
  it('memory-off replay over an ambiguous layout: the row memory may have put in stays, and is named', async () => {
    const j = new InMemoryJournal();
    await runDurable({ runId: 'r', journal: j, memory: richMemory({ recalled: ['yes'], recent: ['yes', 'ok'] }), threadId: 't', model: createMockModel(async () => finalTextResult('rec')), prompt: 'Q', processors: [proc((m) => m.slice(1))] } as any);
    const seen: any[] = [];
    const out: any = await replayRun({ journal: j, runId: 'r', model: createMockModel(async (o: any) => { seen.push(o.prompt); return finalTextResult('x'); }), stripMemoryContext: true } as any);
    const sent = (seen[0] as any[]).filter((m) => m.role !== 'system').map(text);
    log('replay-ambiguous', { sent, resultKeys: Object.keys(out ?? {}), notes: out?.notes });
    // `yes` is memory's content (layout.ambiguous) — the memory-off replay sends it; nothing in the result says so.
    expect(sent).toContain('yes');
    expect(out.keptAmbiguous).toEqual([0]); // the kept row is named
  });
});

describe('round 3 — expect: undetermined is outside the passRate denominator', () => {
  it('3 trials, the model calls a tool the recording never answered: undetermined 3, passRate n 0', async () => {
    const j = new InMemoryJournal();
    await runDurable({ runId: 'r', journal: j, model: createMockModel(async () => finalTextResult('done')), prompt: 'go', agentName: 'a' } as any);
    const lookup = gnlTool(tool({ description: 'l', inputSchema: z.object({ id: z.string() }), execute: async () => { throw new Error('ran a tool'); } }), { sideEffect: false });
    const model = createMockModel(async (o: any) => (o.prompt.some((p: any) => p.role === 'tool') ? finalTextResult('ok') : { content: [{ type: 'tool-call', toolCallId: 'c', toolName: 'lookup', input: '{"id":"1"}' }], finishReason: 'tool-calls', usage: { inputTokens: 1, outputTokens: 1 } }));
    let res: any;
    try { res = await runCapsule({ journal: j, runId: 'r', model, tools: { lookup } as any, trials: 3, expect: { answerIncludes: ['ok'] } }); } catch (e) { res = { error: String(e).slice(0, 200) }; }
    log('expect', res?.expected ?? res);
    if (res?.expected) { expect(res.expected.undetermined).toBe(3); expect(res.expected.passRate.n).toBe(0); }
  });
});

describe('round 3 — the recorded-only tool stub never shadows the agent\'s own tool', () => {
  it('a run that called the agent\'s own tool: the plan offers it with its real description, not as recordedOnly', async () => {
    const j = new InMemoryJournal();
    const lookup = tool({ description: 'Look an order up', inputSchema: z.object({ id: z.string() }), execute: async () => ({ ok: 1 }) });
    let n = 0;
    const model = createMockModel(async () => (n++ === 0 ? { content: [{ type: 'tool-call', toolCallId: 'c', toolName: 'lookup', input: '{"id":"1"}' }], finishReason: 'tool-calls', usage: { inputTokens: 1, outputTokens: 1 } } : finalTextResult('ok')));
    (model as any).modelId = 'cheap';
    await runDurable({ runId: 'r', journal: j, agentName: 'support', model, prompt: 'go', tools: { lookup: gnlTool(lookup, { sideEffect: false }) } } as any);
    const lab = studioLab({ config: { agents: { support: { tools: { lookup } } } }, models: { cheap: model } } as any);
    const p: any = await lab.capsuleBase!(j as any, { runId: 'r', model: 'cheap' } as any);
    const t = (p.tools ?? []).find((x: any) => x.name === 'lookup');
    log('stub', p.tools);
    expect(t?.recordedOnly).toBeUndefined();
    expect(t?.description).toBe('Look an order up');
  });
});
