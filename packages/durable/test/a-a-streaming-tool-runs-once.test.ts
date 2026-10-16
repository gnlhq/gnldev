// A streaming tool runs — once — under durableTool, and its record holds what it produced.
//
// The AI SDK runs a tool whose `execute` is an async generator by iterating it: every yield is a
// preliminary result, the last one is the output. durableTool wrapped every execute in an `async`
// function, so the SDK received a Promise, awaited it and took the generator OBJECT as the final
// output: the body never ran (effects 0), Sqlite and Postgres journaled `succeeded` with `{}`, and
// InMemory threw DataCloneError and left the claim 'running' (release audit E2). Exactly-zero, with a
// success on record.
//
// A tool declared as an async generator is now wrapped as one: the gates run first, the body is iterated
// once by the attempt that holds the claim, its yields pass through as preliminary results, and the last
// one is journaled. A replay yields the journaled output and does not run the body. A plain execute that
// RETURNS an async iterable is consumed by the attempt too (no preliminary parts, the last value is the
// output) — it never journals an iterator again.
//
// Postgres runs when GNL_PG_URL is set.
import { createRequire } from 'node:module';
import { describe, it, expect, vi, beforeAll, afterAll } from 'vitest';
import { stepCountIs } from 'ai';
import { z } from 'zod';
import { durableTool } from '../src/durable-tool.js';
import { InMemoryStorage, gnlTool, type Storage } from '../src/index.js';
import { SqliteStorage } from '../src/sqlite-storage.js';
import { PostgresStorage } from '../src/postgres-storage.js';
import { runDurable } from '../src/run.js';
import { runKeys } from '../src/journal.js';
import type { DurableCtx } from '../src/journal.js';
import { createMockModel, countToolResults, toolCallResult, finalTextResult } from './mock.js';

// The SDK's own consumer of a tool's execute, from the copy `ai` itself resolves.
const { executeTool } = createRequire(createRequire(import.meta.url).resolve('ai'))('@ai-sdk/provider-utils') as {
  executeTool: (a: { tool: unknown; input: unknown; options: unknown }) => AsyncIterable<{ type: string; output: unknown }>;
};

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

async function consume(tool: unknown, toolCallId: string): Promise<Array<{ type: string; output: unknown }>> {
  const parts: Array<{ type: string; output: unknown }> = [];
  for await (const part of executeTool({ tool, input: { amount: 1 }, options: { toolCallId, messages: [] } })) parts.push(part);
  return parts;
}

describe.each(STORES)('a streaming tool runs once — %s', (_name, make) => {
  it('E2: an async-generator tool runs its body once, streams its progress, and journals its last value', async () => {
    const storage = await make();
    const runId = `r-stream-${unique()}`;
    const counter = { entered: 0, effects: 0 };
    const tool = {
      sideEffect: true,
      execute: async function* () { counter.entered++; yield { status: 'charging' }; counter.effects++; yield { chargeId: 'ch_1' }; },
    };
    const ctx = { journal: storage.runs, runId } as unknown as DurableCtx;
    const parts = await consume(durableTool(tool as any, ctx, 'charge'), 'c1');
    expect(counter).toEqual({ entered: 1, effects: 1 });
    expect(parts.at(-1)).toEqual({ type: 'final', output: { chargeId: 'ch_1' } });
    expect(parts.filter((p) => p.type === 'preliminary').map((p) => p.output)).toContainEqual({ status: 'charging' });
    expect(await storage.runs.get(runKeys.tool(runId, 'c1'))).toMatchObject({ status: 'succeeded', output: { chargeId: 'ch_1' } });
    // A replay of the same call yields the journaled output and does not run the body again.
    const replay = await consume(durableTool(tool as any, ctx, 'charge'), 'c1');
    expect(replay.at(-1)).toEqual({ type: 'final', output: { chargeId: 'ch_1' } });
    expect(counter).toEqual({ entered: 1, effects: 1 });
  });

  it('E2 sibling: a generator that throws midway is journaled failed (its effect may have happened) and not re-run blindly', async () => {
    const storage = await make();
    const runId = `r-stream-f-${unique()}`;
    let effects = 0;
    const tool = {
      sideEffect: true,
      execute: async function* () { yield { status: 'charging' }; effects++; throw new Error('gateway reset'); },
    };
    const ctx = { journal: storage.runs, runId } as unknown as DurableCtx;
    await expect(consume(durableTool(tool as any, ctx, 'charge'), 'c1')).rejects.toThrow('gateway reset');
    expect(await storage.runs.get(runKeys.tool(runId, 'c1'))).toMatchObject({ status: 'failed', attempts: 1 });
    await expect(consume(durableTool(tool as any, ctx, 'charge'), 'c1')).rejects.toThrow(/not auto-retried/);
    expect(effects).toBe(1);
  });

  it('E2 sibling: a plain execute that returns an async iterable is consumed by the attempt, never journaled as an iterator', async () => {
    const storage = await make();
    const runId = `r-stream-i-${unique()}`;
    let effects = 0;
    const tool = {
      sideEffect: true,
      execute: () => (async function* () { effects++; yield { chargeId: 'ch_9' }; })(),
    };
    const ctx = { journal: storage.runs, runId } as unknown as DurableCtx;
    const parts = await consume(durableTool(tool as any, ctx, 'charge'), 'c1');
    expect(parts.at(-1)).toEqual({ type: 'final', output: { chargeId: 'ch_9' } });
    expect(effects).toBe(1);
    expect(await storage.runs.get(runKeys.tool(runId, 'c1'))).toMatchObject({ status: 'succeeded', output: { chargeId: 'ch_9' } });
  });

  it('E2 sibling (runDurable): the model sees the streamed tool\'s output, and a resume does not run it again', async () => {
    const storage = await make();
    const runId = `r-stream-run-${unique()}`;
    let effects = 0;
    const seen: unknown[] = [];
    const charge = gnlTool({
      description: 'charge', inputSchema: z.object({ amount: z.number() }),
      execute: async function* () { yield { status: 'charging' }; effects++; yield { chargeId: 'ch_1' }; },
    } as any, { sideEffect: true } as any);
    const model = createMockModel(async ({ prompt }: any) => {
      if (countToolResults(prompt) === 0) return toolCallResult('charge', 'c1', { amount: 1 });
      seen.push(prompt.filter((m: any) => m.role === 'tool').flatMap((m: any) => m.content).map((c: any) => c.output));
      return finalTextResult('done');
    });
    const run = () => runDurable({ runId, journal: storage.runs, model, tools: { charge }, prompt: 'charge it', stopWhen: stepCountIs(4) } as any);
    await run();
    expect(effects).toBe(1);
    expect(JSON.stringify(seen[0])).toContain('ch_1');
    expect(await storage.runs.get(runKeys.tool(runId, 'c1'))).toMatchObject({ status: 'succeeded', output: { chargeId: 'ch_1' } });
    await run();
    expect(effects).toBe(1);
  });
}, 60_000);
