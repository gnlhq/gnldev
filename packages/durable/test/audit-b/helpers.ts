// Shared helpers for the area-B audit tests (background tools): a scripted model and an in-process app.
import { tool } from 'ai';
import { z } from 'zod';
import { InMemoryStorage, BasicMemory, createGnl, gnlTool, scopeConfigToOrg } from '../../src/index.js';

export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const usage = { inputTokens: { total: 1, noCache: 1, cacheRead: undefined, cacheWrite: undefined }, outputTokens: { total: 1, text: 1, reasoning: undefined } };
export const textOf = (m: any): string => (typeof m?.content === 'string' ? m.content : Array.isArray(m?.content) ? m.content.map((p: any) => p.text ?? '').join('') : '');

/** Calls `research` on a "research …" turn, answers otherwise; records every model call's prompt kind. */
export function model(calls: string[]): any {
  return {
    specificationVersion: 'v4', provider: 'scripted', modelId: 'bg', supportedUrls: {},
    doGenerate: async () => { throw new Error('stream only'); },
    doStream: async ({ prompt }: any) => {
      let i = prompt.length - 1;
      while (i >= 0 && prompt[i].role !== 'user') i--;
      const text = textOf(prompt[i]);
      const toolAfter = prompt.slice(i + 1).some((m: any) => m.role === 'tool');
      calls.push(text.startsWith('Background task') ? 'cont' : 'turn');
      const callTool = text.startsWith('research') && !toolAfter;
      return {
        stream: new ReadableStream({
          start(c) {
            c.enqueue({ type: 'stream-start', warnings: [] });
            if (callTool) c.enqueue({ type: 'tool-call', toolCallId: 'call-1', toolName: 'research', input: JSON.stringify({ topic: 'tides' }) });
            else { c.enqueue({ type: 'text-start', id: 't' }); c.enqueue({ type: 'text-delta', id: 't', delta: `answer to ${text.slice(0, 30)}` }); c.enqueue({ type: 'text-end', id: 't' }); }
            c.enqueue({ type: 'finish', finishReason: callTool ? { unified: 'tool-calls', raw: 'tool-calls' } : { unified: 'stop', raw: 'stop' }, usage });
            c.close();
          },
        }),
      };
    },
  };
}

export function app(opts: { org?: string; bodyMs?: number; body?: (topic: string) => Promise<string>; toolOpts?: Record<string, unknown>; sweepMs?: number } = {}) {
  const storage = new InMemoryStorage();
  const effects: string[] = [];
  const calls: string[] = [];
  const research = gnlTool(tool({
    description: 'deep research', inputSchema: z.object({ topic: z.string() }),
    execute: async ({ topic }: { topic: string }) => {
      await sleep(opts.bodyMs ?? 50);
      if (opts.body) return opts.body(topic);
      effects.push(topic); return `report on ${topic}`;
    },
  }), { sideEffect: true, background: true, ...(opts.toolOpts ?? {}) } as any);
  const config: any = { storage, memoryFactory: (src: any) => new BasicMemory(src.runs ?? src), agents: { a: { model: model(calls), tools: { research } } }, detached: { sweepMs: opts.sweepMs ?? 0 } };
  const gnl = createGnl(opts.org ? scopeConfigToOrg(config, opts.org).config : config);
  return { storage, gnl, effects, calls };
}

export async function turn(gnl: any, opts: Record<string, unknown>) {
  const r = await gnl.stream('a', opts);
  await r.consumeStream();
  return r;
}
export async function until(cond: () => Promise<boolean> | boolean, ms = 5_000) {
  const end = Date.now() + ms;
  while (Date.now() < end) { if (await cond()) return true; await sleep(20); }
  return false;
}
