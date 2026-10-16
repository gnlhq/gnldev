// The registry's own doors run detached: `gnl.stream()` and `gnl.run()` start a run that does not
// depend on the caller. A caller that stops reading (a closed tab) leaves the run going; a second call
// for the same run follows it from a cursor instead of executing it again; a door's encoder
// (fullStream, toUIMessageStream) reads the followed run exactly as it read the in-request one.
// `abortSignal` is the caller saying "stop": it cancels the run, durably (design decision D2).
import { describe, it, expect } from 'vitest';
import { InMemoryStorage, createGnl, readRunOutcome } from '../src/index.js';
import { streamingModel } from './detached/models.js';
import { tool } from 'ai';
import { createMockModel, toolCallResult, finalTextResult } from './mock.js';
import { z } from 'zod';

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const words = Array.from({ length: 40 }, (_, i) => `w${i} `);

function app(withTool = true) {
  const storage = new InMemoryStorage();
  const effects: string[] = [];
  const gnl = createGnl({
    storage,
    agents: {
      a: {
        model: streamingModel({ words, gapMs: 15, ...(withTool ? { tool: { name: 'effect', input: { order: 'o-1' } } } : {}) }),
        tools: {
          effect: Object.assign(tool({
            description: 'a side effect', inputSchema: z.object({ order: z.string() }),
            execute: async () => { effects.push('sent'); return 'ok'; },
          }), { sideEffect: true }),
        },
      },
    },
  } as any);
  return { storage, gnl, effects };
}

/** Reads the stream's text; with `stopAfter`, the reader leaves after that many deltas (it stops reading). */
async function textOfStream(result: any, stopAfter?: number): Promise<string> {
  let t = '';
  let n = 0;
  for await (const p of result.fullStream) {
    if (p.type === 'text-delta') { t += p.text ?? p.delta ?? ''; n++; }
    if (stopAfter !== undefined && n >= stopAfter) break;
  }
  return t;
}

describe('the registry runs detached', () => {
  it('R1: a caller that leaves does not stop the run', async () => {
    const { storage, gnl } = app(false);
    const r1: any = await gnl.stream('a', { runId: 'r1', prompt: 'go', resourceId: 'alice' } as any);
    await textOfStream(r1, 3);
    await sleep(1_500);
    expect((await readRunOutcome(storage.runs as any, 'r1'))?.status, 'the run stopped with its caller').toBe('completed');
  });

  it('R2: a second call for the same run follows it from a cursor — no second execution, no gap', async () => {
    const { gnl, effects } = app();
    const r1: any = await gnl.stream('a', { runId: 'r2', prompt: 'go', resourceId: 'alice' } as any);
    const head = await textOfStream(r1, 3);
    const cursor = r1.cursor?.() ?? r1.lastEventId;
    expect(cursor, 'the followed result says where its reader is').toBeDefined();
    const r2: any = await gnl.stream('a', { runId: 'r2', prompt: 'go', resourceId: 'alice', after: cursor } as any);
    const rest = await textOfStream(r2);
    expect(head + rest).toBe(words.join(''));
    expect(effects).toEqual(['sent']);
  });

  it('R3: a door encoder reads the followed run (toUIMessageStream)', async () => {
    const { gnl } = app();
    const r: any = await gnl.stream('a', { runId: 'r3', prompt: 'go', resourceId: 'alice' } as any);
    const chunks: any[] = [];
    for await (const c of r.toUIMessageStream()) chunks.push(c);
    const text = chunks.filter((c) => c.type === 'text-delta').map((c) => c.delta).join('');
    expect(text).toBe(words.join(''));
    expect(chunks.some((c) => c.type === 'tool-output-available')).toBe(true);
    expect(chunks[chunks.length - 1].type).toBe('finish');
  });

  it('R4: gnl.run() survives its caller leaving and a retry returns the same result', async () => {
    const storage = new InMemoryStorage();
    const effects: string[] = [];
    let calls = 0;
    const model = createMockModel(async ({ abortSignal }: any) => {
      calls++;
      if (calls === 1) return toolCallResult('effect', 'c-1', { order: 'o-1' });
      // A slow final step; a real provider stops when its caller aborts, so does this one.
      for (let i = 0; i < 30; i++) { await sleep(20); if (abortSignal?.aborted) throw abortSignal.reason ?? new Error('aborted'); }
      return finalTextResult('done');
    });
    const gnl = createGnl({ storage, agents: { a: { model, tools: { effect: Object.assign(tool({ description: 'e', inputSchema: z.object({ order: z.string() }), execute: async () => { effects.push('sent'); return 'ok'; } }), { sideEffect: true }) } } } } as any);
    // The caller goes away without waiting (a dropped request): nothing awaits this call.
    void gnl.run('a', { runId: 'r4', prompt: 'go', resourceId: 'alice' } as any).catch(() => undefined);
    await sleep(1_500);
    expect((await readRunOutcome(storage.runs as any, 'r4'))?.status, 'the run stopped with its caller').toBe('completed');
    const again: any = await gnl.run('a', { runId: 'r4', prompt: 'go', resourceId: 'alice' } as any);
    expect(again.text).toBe('done');
    expect(effects).toEqual(['sent']);
  });

  it('R5: abortSignal cancels the run — the caller said stop', async () => {
    const { storage, gnl } = app(false);
    const ac = new AbortController();
    const r: any = await gnl.stream('a', { runId: 'r5', prompt: 'go', resourceId: 'alice', abortSignal: ac.signal } as any);
    setTimeout(() => ac.abort(), 60);
    await textOfStream(r).catch(() => '');
    await sleep(800);
    expect((await readRunOutcome(storage.runs as any, 'r5'))?.status).toBe('canceled');
  });
});
