// Aday D, S14 + S20: what the provider is sent, and what the journal records.
//   · the request the provider receives is BYTE-IDENTICAL to what it was before GNL named the calls
//     (K3D_DUMP=<file> writes the captured requests as JSON; running the same test on the base tree and
//     diffing the two files is the byte comparison — the in-process assertions below hold on both trees).
//   · the model step records carry the GNL id; a replay returns the record as it stands.
import { describe, it, expect, vi, beforeAll } from 'vitest';
import { writeFileSync } from 'node:fs';
import { stepCountIs } from 'ai';
import { z } from 'zod';
import { InMemoryJournal, runKeys } from '../src/journal.js';
import { runDurable, streamDurable } from '../src/run.js';
import { createMockModel, finalTextResult } from './mock.js';

beforeAll(() => { vi.spyOn(console, 'warn').mockImplementation(() => {}); });

const usage = { inputTokens: { total: 1, noCache: 1 }, outputTokens: { total: 1, text: 1 } };
const done = (prompt: any[]) => prompt.filter((m: any) => m.role === 'tool').length;
const pay = (paid: number[]) => ({ description: 'pay', inputSchema: z.object({ amount: z.number() }), sideEffect: true, execute: async (a: any) => { paid.push(a.amount); return { charged: a.amount }; } });
const dump: Record<string, unknown> = {};

function scripted(requests: any[], ids: (n: number) => string, streamedArgs: boolean) {
  const answer = (prompt: any[]) => {
    const n = done(prompt);
    if (n >= 2) return finalTextResult('done');
    return { content: [{ type: 'tool-call', toolCallId: ids(n), toolName: 'pay', input: JSON.stringify({ amount: n === 0 ? 5 : 7 }) }], finishReason: 'tool-calls', usage: { inputTokens: 1, outputTokens: 1 }, warnings: [] as any[] };
  };
  const m = createMockModel(async (options: any) => { requests.push(JSON.parse(JSON.stringify({ prompt: options.prompt, tools: options.tools, toolChoice: options.toolChoice }))); return answer(options.prompt); });
  if (streamedArgs) {
    const base = m.doStream;
    m.doStream = async (options: any) => {
      const n = done(options.prompt);
      const id = ids(n); const input = JSON.stringify({ amount: n === 0 ? 5 : 7 });
      if (n >= 2) return base(options);
      requests.push(JSON.parse(JSON.stringify({ prompt: options.prompt, tools: options.tools, toolChoice: options.toolChoice })));
      return { stream: new ReadableStream({ start(c) {
        for (const p of [{ type: 'stream-start', warnings: [] }, { type: 'tool-input-start', id, toolName: 'pay' }, { type: 'tool-input-delta', id, delta: input }, { type: 'tool-input-end', id }, { type: 'tool-call', toolCallId: id, toolName: 'pay', input }, { type: 'finish', finishReason: { unified: 'tool-calls', raw: 'tool-calls' }, usage }]) c.enqueue(p);
        c.close();
      } }) };
    };
  }
  return m;
}

describe('S14 — the provider sees its own ids, byte for byte', () => {
  for (const door of ['generate', 'stream', 'stream-with-input-deltas'] as const) for (const ids of ['same', 'unique'] as const) {
    it(`${door} · ids=${ids}`, async () => {
      const requests: any[] = []; const paid: number[] = [];
      const model = scripted(requests, (n) => (ids === 'same' ? 'call_0' : `call_${n}_x`), door === 'stream-with-input-deltas');
      const journal = new InMemoryJournal();
      const args = { runId: `k3d-s14-${door}-${ids}`, journal, model, tools: { pay: pay(paid) }, stopWhen: stepCountIs(6), prompt: 'pay 5 then 7' } as any;
      if (door === 'generate') await runDurable(args); else { const r: any = await streamDurable(args); await r.text; }
      // K3D_BASE=1: the base tree — only the capture runs (its `same` run is the R1 bug: the second call is never run).
      const base = process.env.K3D_BASE === '1';
      // the request hash of each step (the divergence check's), taken on the request as the provider gets it
      const hashes: unknown[] = [];
      for (let i = 0; i < 3; i++) hashes.push(((await journal.get(runKeys.proc(args.runId, `__gnl_model_claim:${i}`))) as any)?.reqHash);
      dump[`${door}-${ids}`] = { requests, hashes };
      if (base) return;
      expect(paid).toEqual([5, 7]);
      // the second and third request carry the earlier calls and their results: under the PROVIDER's ids
      const sent = requests.slice(1).flatMap((r) => r.prompt.flatMap((m: any) => (Array.isArray(m.content) ? m.content : [])).filter((p: any) => p.type === 'tool-call' || p.type === 'tool-result').map((p: any) => `${p.type}:${p.toolCallId}`));
      const c = (n: number) => (ids === 'same' ? 'call_0' : `call_${n}_x`);
      const want = [`tool-call:${c(0)}`, `tool-result:${c(0)}`, `tool-call:${c(0)}`, `tool-result:${c(0)}`, `tool-call:${c(1)}`, `tool-result:${c(1)}`];
      expect(sent).toEqual(want);
      expect(JSON.stringify(requests)).not.toContain('.gnl-');
      expect(hashes.every((h) => typeof h === 'string')).toBe(true);
      // what the journal holds: the GNL id, per step, in the model record
      const rec: any = await journal.get(runKeys.model(args.runId, 0));
      const text = JSON.stringify(rec);
      expect(text).toMatch(/call_[0-9a-z_]*\.gnl-[0-9a-z]{8}-0-0/);
    });
  }
  it('writes the captured requests when asked (base vs candidate diff)', () => {
    if (process.env.K3D_DUMP) writeFileSync(process.env.K3D_DUMP, JSON.stringify(dump, null, 1));
  });
});
