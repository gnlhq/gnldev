// k3 perf probe (P1: journal writes, P2: model-boundary cost). A plain script, not a vitest suite:
//   npx tsx packages/durable/test/k3-perf.bench.ts [sqlite]
// It imports only ../src, so the SAME file runs on the base tree and on a candidate tree.
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { stepCountIs } from 'ai';
import { z } from 'zod';
import { InMemoryJournal } from '../src/journal.js';
import { withDurableModel } from '../src/durable-model.js';
import { runDurable } from '../src/run.js';
import { createMockModel, finalTextResult } from './mock.js';

const useSqlite = process.argv.includes('sqlite');
console.warn = () => {};

async function openJournal(): Promise<any> {
  if (!useSqlite) return new InMemoryJournal();
  const { SqliteStorage } = await import('../src/sqlite-storage.js');
  const { toJournal } = await import('../src/index.js');
  return toJournal(new SqliteStorage(join(mkdtempSync(join(tmpdir(), 'k3perf-')), 'j.db')) as any);
}

/** Counts writes (put / putIfAbsent / putIfMatch) and the bytes of the values written. */
function counting(journal: any) {
  const c = { put: 0, putIfAbsent: 0, putIfMatch: 0, bytes: 0 };
  const size = (v: unknown) => { try { return Buffer.byteLength(JSON.stringify(v) ?? ''); } catch { return 0; } };
  const proxy = new Proxy(journal, {
    get(t, p, r) {
      const orig = Reflect.get(t, p, r);
      if (typeof orig !== 'function') return orig;
      if (p === 'put') return (k: string, v: unknown, ...a: any[]) => { c.put++; c.bytes += Buffer.byteLength(k) + size(v); return orig.call(t, k, v, ...a); };
      if (p === 'putIfAbsent') return (k: string, v: unknown, ...a: any[]) => { c.putIfAbsent++; c.bytes += Buffer.byteLength(k) + size(v); return orig.call(t, k, v, ...a); };
      if (p === 'putIfMatch') return (k: string, e: unknown, v: unknown, ...a: any[]) => { c.putIfMatch++; c.bytes += Buffer.byteLength(k) + size(v); return orig.call(t, k, e, v, ...a); };
      return orig.bind(t);
    },
  });
  return { proxy, c };
}

const usage = { inputTokens: 1, outputTokens: 1 };
async function p1(ids: 'same' | 'unique') {
  const totals = { put: 0, putIfAbsent: 0, putIfMatch: 0, bytes: 0 };
  const RUNS = 100;
  for (let i = 0; i < RUNS; i++) {
    const { proxy, c } = counting(await openJournal());
    // 3 model steps × 2 tools, the provider numbering its calls call_0/call_1 in every answer
    const model = createMockModel(async ({ prompt }: any) => {
      const n = prompt.filter((m: any) => m.role === 'tool').length; // tool messages so far (one per step)
      if (n >= 3) return finalTextResult('done');
      return { content: [0, 1].map((k) => ({ type: 'tool-call', toolCallId: ids === 'same' ? `call_${k}` : `call_${n}_${k}`, toolName: 'work', input: JSON.stringify({ k, n }) })), finishReason: 'tool-calls', usage, warnings: [] };
    });
    await runDurable({ runId: `perf-${i}`, journal: proxy, model, tools: { work: { description: 'w', inputSchema: z.object({ k: z.number(), n: z.number() }), sideEffect: true, execute: async (a: any) => ({ ok: a.k }) } }, stopWhen: stepCountIs(8), prompt: 'go', sideEffectDuplicates: undefined } as any);
    for (const k of Object.keys(totals) as Array<keyof typeof totals>) totals[k] += c[k];
  }
  console.log(`P1 ${useSqlite ? 'sqlite' : 'memory'} ids=${ids} runs=${RUNS}`, JSON.stringify({ perRun: Object.fromEntries(Object.entries(totals).map(([k, v]) => [k, +(v / RUNS).toFixed(2)])) }));
}

async function p2() {
  const N = 1000; const REPS = 20;
  const mk = (journal: any, runId: string) => {
    const model: any = {
      specificationVersion: 'v4', provider: 'mock', modelId: 'm', supportedUrls: {},
      doGenerate: async () => { throw new Error('stream only'); },
      doStream: async () => ({ stream: new ReadableStream({ start(c) {
        c.enqueue({ type: 'stream-start', warnings: [] }); c.enqueue({ type: 'text-start', id: 't' });
        for (let i = 0; i < N; i++) c.enqueue({ type: 'text-delta', id: 't', delta: 'x' });
        c.enqueue({ type: 'text-end', id: 't' });
        c.enqueue({ type: 'finish', finishReason: { unified: 'stop', raw: 'stop' }, usage: { inputTokens: { total: 1 }, outputTokens: { total: 1 } } });
        c.close();
      } }) }),
    };
    return withDurableModel(model, { journal, runId } as any);
  };
  const times: number[] = [];
  for (let rep = -2; rep < REPS; rep++) {
    const journal = new InMemoryJournal();
    const m: any = mk(journal, `p2-${rep}`);
    const t0 = performance.now();
    const { stream } = await m.doStream({ prompt: [] });
    const reader = stream.getReader();
    for (;;) { const r = await reader.read(); if (r.done) break; }
    const dt = performance.now() - t0;
    if (rep >= 0) times.push(dt);
  }
  times.sort((a, b) => a - b);
  const q = (p: number) => times[Math.min(times.length - 1, Math.floor(p * times.length))]!;
  console.log(`P2 stream ${N} parts × ${REPS}: median ${q(0.5).toFixed(2)} ms, p95 ${q(0.95).toFixed(2)} ms`);
}

await p1('same');
await p1('unique');
if (!useSqlite) await p2();
