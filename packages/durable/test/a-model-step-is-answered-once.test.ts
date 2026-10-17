// A model step is answered ONCE: the first complete answer recorded for (run, step) is the step's
// answer, and every attempt at that step — the one that lost its claim to a takeover, a concurrent
// twin, a stale holder waking after a partition — returns that answer, never its own. Its own answer
// would be a different plan: other tool calls, under other toolCallIds, which durableTool cannot
// collapse into the recorded ones, so their side effects would run beside the recorded plan's.
//
// The stale holder below is a worker whose link to the store is cut while its model call is in
// flight, with no process liveness (the takeover is decided by the claim's age, as it is when the
// holder's process is judged dead), and healed once a takeover has answered the step.
import { describe, it, expect, vi, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { InMemoryStorage, type Storage } from '../src/index.js';
import { SqliteStorage } from '../src/sqlite-storage.js';
import { PostgresStorage } from '../src/postgres-storage.js';
import { runKeys } from '../src/journal.js';
import { withDurableModel } from '../src/durable-model.js';
import { durableTool } from '../src/durable-tool.js';
import { createMockModel, finalTextResult, toolCallResult } from './mock.js';
import type { DurableCtx, Journal } from '../src/journal.js';

beforeAll(() => { vi.spyOn(console, 'warn').mockImplementation(() => {}); });
const ends: Array<() => Promise<unknown> | unknown> = [];
afterAll(async () => { for (const e of ends.reverse()) await e(); });

const PG_URL = process.env.GNL_PG_URL;
const STORES: Array<[string, () => Promise<Storage>]> = [
  ['in-memory', async () => new InMemoryStorage()],
  ['sqlite file', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'gnl-model-once-'));
    const s = new SqliteStorage(join(dir, 'runs.db'));
    ends.push(() => rmSync(dir, { recursive: true, force: true }));
    ends.push(() => (s as any).close?.());
    return s;
  }],
];
if (PG_URL) STORES.push(['postgres', async () => { const s = new PostgresStorage({ connectionString: PG_URL }); ends.push(() => s.close()); return s; }]);

const unique = () => `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
const gate = () => { let open!: () => void; const p = new Promise<void>((r) => { open = r; }); return { p, open }; };
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const settled = <T>(p: Promise<T>) => p.then((v) => v, (e) => e);

/** One worker's view of the store: no process liveness, and a link that can be cut and healed. */
function worker(journal: Journal) {
  let down: ReturnType<typeof gate> | undefined;
  const j = new Proxy(journal as any, {
    get(t, p) {
      if (p === 'processLiveness') return undefined;
      const v = t[p];
      if (typeof v !== 'function') return v;
      return async (...a: unknown[]) => { while (down) await down.p; return v.apply(t, a); };
    },
  }) as Journal;
  return { journal: j, cut() { down = gate(); }, heal() { const d = down; down = undefined; d?.open(); } };
}

const TTL = 150;
const params: any = { prompt: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }] };
const ctxOf = (journal: Journal, runId: string) => ({ journal, runId } as unknown as DurableCtx);
const generate = (model: any, journal: Journal, runId: string, exclusive = true) =>
  withDurableModel(model, ctxOf(journal, runId), exclusive ? { exclusiveStep: { ttlMs: TTL } } : undefined).doGenerate(params);
const stream = async (model: any, journal: Journal, runId: string) => {
  const { stream: s } = await withDurableModel(model, ctxOf(journal, runId), { exclusiveStep: { ttlMs: TTL } }).doStream(params);
  const parts: any[] = [];
  const reader = s.getReader();
  for (;;) { const { done, value } = await reader.read(); if (done) break; parts.push(value); }
  return parts;
};
const textOf = (r: any) => (r instanceof Error ? `Error:${r.name}` : (r?.content ?? []).map((c: any) => c.text ?? c.toolCallId).join(''));
const streamedText = (parts: any) => (parts instanceof Error ? `Error:${parts.name}` : parts.filter((p: any) => p.type === 'text-delta').map((p: any) => p.delta).join(''));
const recordedText = async (journal: Journal, runId: string) => {
  const r: any = await journal.get(runKeys.model(runId, 0));
  return r?.content ? r.content.map((c: any) => c.text ?? c.toolCallId).join('') : (r?.parts ?? []).filter((p: any) => p.type === 'text-delta').map((p: any) => p.delta).join('');
};

/** A model whose first call (the stale holder's) waits for `resume`; later calls answer at once. */
function staleFirst(answer: (call: number) => any) {
  const inFirst = gate(); const resume = gate();
  const counter = { calls: 0 };
  const model = createMockModel(async () => {
    const me = ++counter.calls;
    if (me === 1) { inFirst.open(); await resume.p; }
    return answer(me);
  });
  return { model, inFirst, resume, counter };
}

describe.each(STORES)('a model step is answered once — %s', (_name, make) => {
  it('a stale holder that wakes after a takeover answered the step returns the recorded answer, and a replay gives the same', async () => {
    const storage = await make();
    const runId = `once-g-${unique()}`;
    const m = staleFirst((n) => finalTextResult(n === 1 ? 'from-A' : 'from-B'));
    const A = worker(storage.runs);
    const a = settled(generate(m.model, A.journal, runId));
    await m.inFirst.p; A.cut(); await sleep(TTL * 3);
    const b = await settled(generate(m.model, storage.runs, runId));
    A.heal(); m.resume.open();
    const aOut = await a;
    const replay = await settled(generate(m.model, storage.runs, runId));
    expect(textOf(b)).toBe('from-B');
    expect(await recordedText(storage.runs, runId)).toBe('from-B');
    expect(textOf(aOut)).toBe('from-B');
    expect(textOf(replay)).toBe('from-B');
    expect(m.counter.calls).toBe(2);
  });

  it('a stale holder\'s plan does not run beside the takeover\'s: one side effect for the step', async () => {
    const storage = await make();
    const runId = `once-e-${unique()}`;
    // A real provider mints a fresh toolCallId for every completion.
    // Two completions of one step need not agree on arguments either: a second plan is not a duplicate.
    const m = staleFirst((n) => toolCallResult('charge', `tc-${n}`, { amount: n }));
    let charges = 0;
    const charge = { sideEffect: true, claimTtlMs: TTL, execute: async () => ({ chargeId: `ch-${++charges}` }) };
    const act = async (journal: Journal) => {
      const r: any = await generate(m.model, journal, runId);
      const call = r.content.find((c: any) => c.type === 'tool-call');
      return durableTool(charge as any, ctxOf(journal, runId), 'charge').execute!(JSON.parse(call.input), { toolCallId: call.toolCallId } as any);
    };
    const A = worker(storage.runs);
    const a = settled(act(A.journal));
    await m.inFirst.p; A.cut(); await sleep(TTL * 3);
    const b = await settled(act(storage.runs));
    A.heal(); m.resume.open();
    const aOut = await a;
    expect(b).toEqual({ chargeId: 'ch-1' });
    expect(aOut).toEqual({ chargeId: 'ch-1' });
    expect(charges).toBe(1);
  });

  it('a stale holder whose model call fails after the takeover answered writes no failure over it', async () => {
    const storage = await make();
    const runId = `once-f-${unique()}`;
    const m = staleFirst((n) => { if (n === 1) throw new Error('A late failure'); return finalTextResult('from-B'); });
    const A = worker(storage.runs);
    const a = settled(generate(m.model, A.journal, runId));
    await m.inFirst.p; A.cut(); await sleep(TTL * 3);
    await generate(m.model, storage.runs, runId);
    A.heal(); m.resume.open();
    await a;
    const claim: any = await storage.runs.get(runKeys.proc(runId, '__gnl_model_claim:0'));
    expect(claim?.status).toBe('succeeded');
    expect(textOf(await settled(generate(m.model, storage.runs, runId)))).toBe('from-B');
    expect(m.counter.calls).toBe(2);
  });

  it('a stale streaming holder that wakes after a takeover answered the step does not replace the answer, and its stream says it lost', async () => {
    const storage = await make();
    const runId = `once-s-${unique()}`;
    const m = staleFirst((n) => finalTextResult(n === 1 ? 'from-A' : 'from-B'));
    const A = worker(storage.runs);
    const a = settled(stream(m.model, A.journal, runId));
    await m.inFirst.p; A.cut(); await sleep(TTL * 3);
    const b = await settled(stream(m.model, storage.runs, runId));
    A.heal(); m.resume.open();
    const aOut = await a;
    expect(streamedText(b)).toBe('from-B');
    expect(await recordedText(storage.runs, runId)).toBe('from-B');
    expect(aOut).toBeInstanceOf(Error);
    expect(streamedText(await settled(stream(m.model, storage.runs, runId)))).toBe('from-B');
  });

  it('a stale streaming holder does not hand its own tool call to its run once the takeover answered the step', async () => {
    const storage = await make();
    const runId = `once-st-${unique()}`;
    const m = staleFirst((n) => toolCallResult('charge', `tc-${n}`, { amount: 1 }));
    const A = worker(storage.runs);
    const a = settled(stream(m.model, A.journal, runId));
    await m.inFirst.p; A.cut(); await sleep(TTL * 3);
    await stream(m.model, storage.runs, runId);
    A.heal(); m.resume.open();
    const aOut = await a;
    const handed = aOut instanceof Error ? [] : aOut.filter((p: any) => p.type === 'tool-call').map((p: any) => p.toolCallId);
    expect(handed).not.toContain('tc-1');
  });

  it('without exclusivity, two attempts at one step in flight together both return the answer recorded first', async () => {
    const storage = await make();
    const runId = `once-c-${unique()}`;
    const inA = gate(); const releaseA = gate(); let calls = 0;
    const model = createMockModel(async () => {
      const me = ++calls;
      if (me === 1) { inA.open(); await releaseA.p; }
      return finalTextResult(me === 1 ? 'from-A' : 'from-B');
    });
    const a = settled(generate(model, storage.runs, runId, false));
    await inA.p;
    const b = await settled(generate(model, storage.runs, runId, false));
    releaseA.open();
    const aOut = await a;
    expect(textOf(b)).toBe('from-B');
    expect(textOf(aOut)).toBe('from-B');
    expect(await recordedText(storage.runs, runId)).toBe('from-B');
  });
});
