// A record lists every call it answered, however many answer from it at once.
//
// A call answered by an existing record adds its toolCallId to the record's `resolvedToolCallIds` —
// that list is how a later replay of the same request knows the record is its own past, and narrates it
// as such ('self') rather than as work done in an earlier request ('window'). The id was added by
// read-modify-put: two calls answered at the same moment (a model step asking twice, its tools run in
// parallel) both read the list, and the second put dropped the first one's id. Measured: after the
// approval resumed the run, its own call came back as 'window' — the request told it had been done in
// an earlier request. The id is now added by compare-and-set over the record as read.
//
// Postgres runs when GNL_PG_URL is set.
import { describe, it, expect, vi, beforeAll, afterAll } from 'vitest';
import { stepCountIs } from 'ai';
import { z } from 'zod';
import { InMemoryStorage, gnlTool, toJournal, type Storage } from '../src/index.js';
import { SqliteStorage } from '../src/sqlite-storage.js';
import { PostgresStorage } from '../src/postgres-storage.js';
import { runDurable } from '../src/run.js';
import type { Journal } from '../src/journal.js';
import { createMockModel, finalTextResult } from './mock.js';

beforeAll(() => { vi.spyOn(console, 'warn').mockImplementation(() => {}); });
const ends: Array<() => Promise<unknown>> = [];
afterAll(async () => { for (const e of ends.reverse()) await e(); });

const PG_URL = process.env.GNL_PG_URL;
const STORES: Array<[string, () => Promise<Storage>]> = [
  ['in-memory', async () => new InMemoryStorage()],
  ['sqlite', async () => new SqliteStorage(':memory:')],
];
if (PG_URL) {
  STORES.push(['postgres (real)', async () => {
    const s = new PostgresStorage({ connectionString: PG_URL });
    ends.push(() => s.close());
    return s;
  }]);
}
const unique = () => `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;

/** The journal, with the first `n` reads of a key held until all `n` have read — answered at the same moment. */
function together(inner: Journal, match: (k: string) => boolean, n: number): Journal {
  const waiting: Array<() => void> = [];
  return new Proxy(inner, {
    get(t, p) {
      const v = (t as any)[p];
      if (p === 'get') {
        return async (k: string) => {
          const out = await (t as any).get(k);
          if (match(k) && n > 0) {
            n--;
            if (n === 0) for (const w of waiting.splice(0)) w();
            else await new Promise<void>((r) => waiting.push(r));
          }
          return out;
        };
      }
      return typeof v === 'function' ? v.bind(t) : v;
    },
  });
}

const call = (toolName: string, toolCallId: string, input: object) => ({ type: 'tool-call', toolCallId, toolName, input: JSON.stringify(input) });
const step = (content: object[]) => ({ content, finishReason: 'tool-calls', usage: { inputTokens: 1, outputTokens: 1 }, warnings: [] });

describe.each(STORES)('a record lists every call it answered — %s', (_name, make) => {
  it('two calls answered at once: both are listed, and a resume narrates both as its own', async () => {
    const storage = await make();
    const root = toJournal(storage.runs);
    const id = unique();
    const thread = `T-${id}`;
    let paid = 0; let shipped = 0;
    const tools = {
      pay: {
        description: 'pay', sideEffect: true, idempotency: 'args' as const, idempotencyWindow: 'thread' as const,
        recover: async () => ({ done: false as const }),
        execute: async (a: { order: string }) => { paid++; return { paid: a.order }; },
      },
      ship: gnlTool({ description: 'ship', inputSchema: z.object({}).passthrough(), execute: async () => { shipped++; return { shipped: true }; } }, { sideEffect: true, confirm: true } as any),
    };
    // r1 pays. r2 asks to pay the same twice in one step (both answered by r1's record), then ships (a question).
    const model = (pre: string, steps: object[][]) => createMockModel(async ({ prompt }: any) => {
      const done = prompt.filter((m: any) => m.role === 'tool').length; // one tool message per finished step
      return done < steps.length ? step(steps[done]!) : finalTextResult('done');
    });
    const opts = { prompt: 'pay', threadId: thread, stopWhen: stepCountIs(6), replayDisclosure: 'explain' };
    await runDurable({ runId: `r1-${id}`, journal: root, model: model('a', [[call('pay', 'a-0', { order: 'O-1' })]]), tools, ...opts } as any);
    expect(paid).toBe(1);

    const r2Model = model('b', [[call('pay', 'b-0', { order: 'O-1' }), call('pay', 'b-1', { order: 'O-1' })], [call('ship', 'b-2', {})]]);
    const recordKey = (k: string) => k.startsWith(`xthr:${thread}:args-pay-`);
    const first: any = await runDurable({ runId: `r2-${id}`, journal: together(root, recordKey, 2), model: r2Model, tools, ...opts } as any);
    expect(first.interrupts?.[0]?.toolCallId).toBe('b-2');
    expect(paid).toBe(1);

    const recordKeys = (await root.listKeys!(`xthr:${thread}:args-pay-`)).filter(recordKey);
    expect(recordKeys).toHaveLength(1);
    const record = await root.get<{ resolvedToolCallIds?: string[] }>(recordKeys[0]!);
    expect.soft([...(record?.resolvedToolCallIds ?? [])].sort()).toEqual(['a-0', 'b-0', 'b-1']);

    // The approval resumes r2: step 0 replays, and both of its calls are r2's own past.
    const resumed: any = await runDurable({ runId: `r2-${id}`, journal: root, model: r2Model, tools, approvals: { 'b-2': true }, ...opts } as any);
    expect(shipped).toBe(1);
    expect(paid).toBe(1);
    const origins = Object.fromEntries((resumed.replayedToolCalls ?? []).filter((e: any) => e.toolName === 'pay').map((e: any) => [e.toolCallId, e.origin]));
    expect(origins).toEqual({ 'b-0': 'self', 'b-1': 'self' });
  });
}, 60_000);
