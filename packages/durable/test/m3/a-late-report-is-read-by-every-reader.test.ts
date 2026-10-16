// A call's outcome has one reader (call-outcome.ts): its record AND the late reports kept beside it,
// found by the record's key. An attempt that finished its body after it lost the call kept its success
// there; every reader that decides what happened to the call reads it — the claim loop of ANOTHER run
// reaching the same window record, the unwind, a background task's ending — and a late success never
// replaces an answer the run was already given (siblings of release audit B5/B6 and its window hypothesis).
import { describe, it, expect, beforeAll, afterAll, afterEach, vi } from 'vitest';
import { tool } from 'ai';
import { z } from 'zod';
import { InMemoryStorage, runKeys, claimRunOwner, user, compensateRun, streamDurable, installProcessLiveness, type Journal, type ProcessLiveness } from '../../src/index.js';
import { SqliteStorage } from '../../src/sqlite-storage.js';
import { PostgresStorage } from '../../src/postgres-storage.js';
import { Attempt, compareAndSet } from '../../src/attempt.js';
import { stampFormat } from '../../src/format.js';
import { minted, withMintOf } from '../../src/run-id-grammar.js';
import { taskOutcome } from '../../src/deferred.js';

beforeAll(() => { vi.spyOn(console, 'warn').mockImplementation(() => {}); });
afterEach(() => installProcessLiveness(undefined));

const ends: Array<() => Promise<unknown>> = [];
afterAll(async () => { for (const e of ends.reverse()) await e(); });
const PG_URL = process.env.GNL_PG_URL;
const STORES: Array<[string, () => Promise<any>]> = [['in-memory', async () => new InMemoryStorage()], ['sqlite', async () => new SqliteStorage(':memory:')]];
if (PG_URL) {
  STORES.push(['postgres (real)', async () => {
    const s = new PostgresStorage({ connectionString: PG_URL });
    ends.push(() => s.close());
    await s.init?.();
    return s;
  }]);
}
const TTL = 60_000;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const unique = () => `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
async function until(what: string, ok: () => Promise<boolean> | boolean, ms = 8_000): Promise<void> {
  const end = Date.now() + ms;
  while (!(await ok())) { if (Date.now() > end) throw new Error(`timed out: ${what}`); await sleep(15); }
}

/** A late attempt of run `runId` (process `proc`) that finished its body after it lost the call `key`. */
function lateAttempt(journal: Journal, runId: string, key: string, proc: string, attempts: number, at: number) {
  const stamp = stampFormat({ status: 'running', startedAt: at, attempts, claimTtlMs: TTL, idempotencyKey: `${runId}:call-1`, proc }) as any;
  const write = (rec: any, expected: unknown) => compareAndSet(journal, key, expected, stampFormat({ ...rec, idempotencyKey: `${runId}:call-1` }));
  return new Attempt(journal, key, undefined, stamp, performance.now(), 'charge', write, { runId });
}

function liveOnly(id: string): ProcessLiveness {
  return { id, isAlive: async (x) => x === id, confirm: async () => true, close: async () => {} };
}

async function setUp(make: () => any, runId = `r-${unique()}`) {
  const storage = await make();
  const journal = storage.runs as Journal & Record<string, any>;
  await claimRunOwner(journal as any, runId, user('alice'), withMintOf({}, minted({ runId: runId }))); // the engine begins a task: its mark
  const key = runKeys.tool(runId, 'call-1');
  const at = journal.now ? await journal.now() : Date.now();
  return { storage, journal, runId, key, at };
}

const charge = (compensated: unknown[]) => ({ sideEffect: true, compensate: async (_i: unknown, out: unknown) => { compensated.push(out); return 'refunded'; } }) as any;

describe.each(STORES)('the one reader of a call (%s)', (_n, make) => {
  it('compensateRun undoes a call whose effect a late report proves — with the reported result, not "uncertain"', async () => {
    const { journal, runId, key, at } = await setUp(make);
    // Attempt 2 held the call live when attempt 1 reported late; attempt 2 then failed without a result.
    await journal.put(key, stampFormat({ status: 'running', startedAt: at, attempts: 2, claimTtlMs: TTL, idempotencyKey: `${runId}:call-1`, proc: 'live-B' }));
    installProcessLiveness(liveOnly('live-B'));
    expect(await lateAttempt(journal, runId, key, 'A', 1, at).succeed({ status: 'succeeded', output: 'charged ch_1', toolName: 'charge' } as any)).toBe(false);
    installProcessLiveness(undefined);
    await journal.put(key, stampFormat({ status: 'failed', error: 'timeout', attempts: 2, sideEffect: true, toolName: 'charge', idempotencyKey: `${runId}:call-1` }));
    const compensated: unknown[] = [];
    const report = await compensateRun(runId, { journal: journal as any, tools: { charge: charge(compensated) } });
    expect({ compensated, entries: report.entries.map((e) => e.status) }).toEqual({ compensated: ['charged ch_1'], entries: ['compensated'] });
  });

  it('a late success never replaces a person\'s "denied" — it is kept beside it, and the unwind undoes the effect', async () => {
    const { journal, runId, key, at } = await setUp(make);
    await journal.put(key, stampFormat({ status: 'denied', output: { denied: true, reason: 'not now' }, toolName: 'charge', idempotencyKey: `${runId}:call-1` }));
    const wrote = await lateAttempt(journal, runId, key, 'A', 1, at).succeed({ status: 'succeeded', output: 'charged ch_1', toolName: 'charge' } as any);
    const record = await journal.get<any>(key);
    const late = await journal.get<any>(runKeys.lateOf(key));
    const compensated: unknown[] = [];
    await compensateRun(runId, { journal: journal as any, tools: { charge: charge(compensated) } });
    expect({ wrote, status: record.status, kept: late?.late?.[0]?.output, compensated })
      .toEqual({ wrote: false, status: 'denied', kept: 'charged ch_1', compensated: ['charged ch_1'] });
  });

  it("a background task whose call failed beside a late report ended with the effect's result, not as failed", async () => {
    const parent = `p-${unique()}`;
    const task = `task:${parent}:call-1`;
    const { journal, key, at } = await setUp(make, task);
    expect(key).toBe(runKeys.tool(task, 'call-1'));
    await journal.put(key, stampFormat({ status: 'running', startedAt: at, attempts: 2, claimTtlMs: TTL, idempotencyKey: `${task}:call-1`, proc: 'live-B' }));
    installProcessLiveness(liveOnly('live-B'));
    await lateAttempt(journal, task, key, 'A', 1, at).succeed({ status: 'succeeded', output: 'report on tides', toolName: 'research' } as any);
    installProcessLiveness(undefined);
    await journal.put(key, stampFormat({ status: 'failed', error: 'already exists downstream', attempts: 2, sideEffect: true, toolName: 'research', idempotencyKey: `${task}:call-1` }));
    expect(await taskOutcome(journal, task, 'call-1')).toEqual({ state: 'completed', output: 'report on tides' });
  });

  it.each([['thread'], ['run']] as const)('a call reaching the same %s-window record settles from its late report — the effect is not run again', async (window) => {
    const storage = await make();
    const journal = storage.runs as Journal & Record<string, any>;
    const d = liveOnly(`D-${unique()}`);
    const alive = new Set<string>([d.id]);
    installProcessLiveness({ ...d, isAlive: async (x) => alive.has(x) });
    const thread = `t-${unique()}`;
    const r1 = `r1-${unique()}`;
    let effects = 0;
    let release!: () => void;
    let entered = false;
    const effect = Object.assign(tool({
      description: 'a side effect', inputSchema: z.object({ order: z.string() }),
      execute: async ({ order }: { order: string }) => {
        if (!entered) { entered = true; await new Promise<void>((r) => { release = r; }); }
        effects++;
        return `done ${order} by A`;
      },
    }), { sideEffect: true, maxRetries: 3, claimTtlMs: TTL, idempotency: 'args', idempotencyWindow: window });
    const run1 = consume(streamDurable({ journal, runId: r1, threadId: thread, model: echoModel('call-1'), tools: { effect }, prompt: 'do it', resourceId: 'alice' } as any));
    await until('A is in the body', () => entered);
    const prefix = window === 'thread' ? `xthr:${thread}:args-effect-` : `xreq:${r1}:args-effect-`;
    const key = ((await journal.listKeys(prefix)) as string[])[0]!;
    const claimed = await journal.get<any>(key);
    expect(claimed).toMatchObject({ status: 'running' });
    // A loses the call: attempt B (a live process) takes it over.
    alive.add('B');
    await journal.put(key, { ...claimed, attempts: 2, proc: 'B', startedAt: journal.now ? await journal.now() : Date.now() });
    // A's body finishes: its success is kept beside the WINDOW's record (B holds the call live).
    release();
    await run1;
    expect({ effects, kept: (await journal.get<any>(runKeys.lateOf(key)))?.late?.length }).toEqual({ effects: 1, kept: 1 });
    // B fails without a result (its body found the effect already there downstream).
    alive.delete('B');
    await journal.put(key, { ...claimed, status: 'failed', error: 'already exists downstream', attempts: 2, sideEffect: true, toolName: 'effect', startedAt: undefined, proc: undefined });
    // Another call on the same window: another run on the thread, or another call of run 1's request.
    const r2 = window === 'thread' ? `r2-${unique()}` : r1;
    const text = await consume(streamDurable({ journal, runId: r2, threadId: thread, model: echoModel(window === 'thread' ? 'call-1' : 'call-2'), tools: { effect }, prompt: 'do it', resourceId: 'alice' } as any));
    expect({ effects, sawTheEffect: text.includes('done o-1 by A'), record: (await journal.get<any>(key))?.status })
      .toEqual({ effects: 1, sawTheEffect: true, record: 'succeeded' });
  });
});

async function consume(r: Promise<any>): Promise<string> {
  try {
    const s = await r;
    let text = '';
    for await (const part of s.fullStream) if (part.type === 'text-delta') text += part.text ?? part.delta ?? '';
    return text;
  } catch (e) {
    return `threw ${(e as Error).name}: ${(e as Error).message}`;
  }
}

const usage = { inputTokens: { total: 1, noCache: 1, cacheRead: undefined, cacheWrite: undefined }, outputTokens: { total: 1, text: 1, reasoning: undefined } };
/** Calls `effect({order:'o-1'})` once under `toolCallId`, then answers with what the call returned. */
function echoModel(toolCallId: string): any {
  return {
    specificationVersion: 'v3', provider: 'scripted', modelId: 'echo', supportedUrls: {},
    doGenerate: async () => { throw new Error('stream only'); },
    doStream: async ({ prompt }: any) => {
      const result = (prompt as any[]).flatMap((m) => (m.role === 'tool' ? m.content : [])).find((p: any) => p.type === 'tool-result');
      return {
        stream: new ReadableStream({
          start(c) {
            c.enqueue({ type: 'stream-start', warnings: [] });
            if (!result) {
              c.enqueue({ type: 'tool-call', toolCallId, toolName: 'effect', input: JSON.stringify({ order: 'o-1' }) });
              c.enqueue({ type: 'finish', finishReason: { unified: 'tool-calls', raw: 'tool-calls' }, usage });
            } else {
              const out = result.output?.value ?? result.output;
              c.enqueue({ type: 'text-start', id: 't' });
              c.enqueue({ type: 'text-delta', id: 't', delta: `saw ${JSON.stringify(out)}` });
              c.enqueue({ type: 'text-end', id: 't' });
              c.enqueue({ type: 'finish', finishReason: { unified: 'stop', raw: 'stop' }, usage });
            }
            c.close();
          },
        }),
      };
    },
  };
}
