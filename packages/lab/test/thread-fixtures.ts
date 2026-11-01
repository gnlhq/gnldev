// A thread recorded with createMockModel, for the diagnosis tests: a memory that keeps a recent window
// of the thread (and, optionally, a working memory), a shop agent that ships to the address it can see,
// and the thread's turns run one after the other through runDurable. No real model is called.
import { tool, type ModelMessage } from 'ai';
import { z } from 'zod';
import { runDurable, gnlTool, InMemoryJournal } from '@gnldev/durable';
import { createMockModel } from '../../durable/test/mock.js';

export const usage = { inputTokens: 100, outputTokens: 10 };

/** A memory that hands the run the last `window` messages of the thread, and a working memory when given. */
export function windowMemory(window: number, wm?: () => string | undefined) {
  const stored: ModelMessage[] = [];
  return {
    stored,
    async getMessages() { return stored; },
    async append(_t: string, msgs: ModelMessage[]) { stored.push(...msgs); },
    async loadContext() {
      const recent = stored.slice(-window);
      const system = wm?.();
      return { messages: recent, provenance: { recalled: [], recentCount: recent.length }, ...(system ? { system } : {}) };
    },
  };
}

export const tools = () => ({
  createOrder: tool({ description: 'Create an order shipped to an address', inputSchema: z.object({ address: z.string() }) }),
  lookup: tool({ description: "Look up the customer's address", inputSchema: z.object({}) }),
});

/** The tools the recorded runs ran with — they run once, while recording, and never in the lab. */
export const recordingTools = (lookupAddress = 'Izmir') => ({
  createOrder: gnlTool(tool({ description: 'Create an order shipped to an address', inputSchema: z.object({ address: z.string() }), execute: async ({ address }) => ({ ok: true, address }) }), { sideEffect: false }),
  lookup: gnlTool(tool({ description: "Look up the customer's address", inputSchema: z.object({}), execute: async () => ({ address: lookupAddress }) }), { sideEffect: false }),
});

/** The lab's copy of the tools: any execute is a test failure. */
export const trap = () => {
  const t = tools() as any;
  for (const k of Object.keys(t)) t[k] = { ...t[k], execute: async () => { throw new Error('the lab ran a tool'); } };
  return t;
};

export const text = (o: any) => JSON.stringify(o.prompt);
export const final = (t: string) => ({ content: [{ type: 'text', text: t }], finishReason: 'stop', usage });
export const call = (toolName: string, args: unknown, id = 'c1') => ({ content: [{ type: 'tool-call', toolCallId: id, toolName, input: JSON.stringify(args) }], finishReason: 'tool-calls', usage });
export const toolResults = (o: any) => (o.prompt as any[]).filter((m) => m.role === 'tool');

/** A model run by `decide` until it calls a tool; after a tool result it says "Done.". */
export function agentModel(decide: (o: any) => any, id = 'cheap') {
  const m = createMockModel(async (o: any) => {
    const last = (o.prompt as any[]).at(-1);
    if (last?.role === 'tool') return final('Done.');
    return decide(o);
  });
  m.modelId = id;
  return m;
}

/** Runs each user message as one turn of thread 't'; returns the journal and the run ids in order. */
export async function recordThread(turns: string[], opts: { memory: any; model: any; system?: string; tools?: any; processors?: unknown[]; journal?: InMemoryJournal; prefix?: string }) {
  const journal = opts.journal ?? new InMemoryJournal();
  const ids: string[] = [];
  for (let i = 0; i < turns.length; i++) {
    const runId = `${opts.prefix ?? 'r'}${i + 1}`;
    ids.push(runId);
    await runDurable({ runId, journal, agentName: 'shop', memory: opts.memory, threadId: 't', prompt: turns[i], model: opts.model, tools: opts.tools ?? recordingTools(), ...(opts.system ? { system: opts.system } : {}), ...(opts.processors ? { processors: opts.processors } : {}) } as any)
      .catch(() => undefined);
  }
  return { journal, ids };
}
