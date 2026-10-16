// A process that records a run's result and dies before its last events: a reader still gets every
// event the run produced, replayed from the journal — no model call, no tool call.
//
// Sibling of a-run-ended-elsewhere-is-read-whole (a late process ending the run with its events
// refused). Here the run's own process P writes the run's journal to its end — the tool's result, the
// answer, the outcome `completed` — but its event log stops after the tool call and its execution
// record still says it runs: it died in between. The process that takes the run over finds the run
// ended without its log saying so, and replays what the log lacks through the one writer.
import { describe, it, expect, vi, beforeAll, afterAll, afterEach } from 'vitest';
import { tool } from 'ai';
import { z } from 'zod';
import { DetachedRuns, streamDurable, installProcessLiveness, runKeys, claimRunOwner, user, readRunEvents, type Storage, type ProcessLiveness, type Journal } from '../src/index.js';
import { SqliteStorage } from '../src/sqlite-storage.js';
import { PostgresStorage } from '../src/postgres-storage.js';
import { textOf } from './detached/models.js';

beforeAll(() => { vi.spyOn(console, 'warn').mockImplementation(() => {}); });
const ends: Array<() => Promise<unknown>> = [];
afterAll(async () => { for (const e of ends.reverse()) await e(); });
const perTest: Array<() => Promise<unknown>> = [];
afterEach(async () => {
  for (const e of perTest.splice(0).reverse()) await e();
  installProcessLiveness(undefined);
});

const PG_URL = process.env.GNL_PG_URL;
const STORES: Array<[string, () => Promise<Storage>]> = [['sqlite', async () => new SqliteStorage(':memory:')]];
if (PG_URL) {
  STORES.push(['postgres (real)', async () => {
    const s = new PostgresStorage({ connectionString: PG_URL });
    ends.push(() => s.close());
    return s;
  }]);
}
const unique = () => `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const until = async (what: string, ok: () => Promise<boolean>, ms = 8_000) => {
  const end = Date.now() + ms;
  while (!(await ok())) { if (Date.now() > end) throw new Error(`timed out: ${what}`); await sleep(20); }
};
const usage = { inputTokens: { total: 1, noCache: 1, cacheRead: undefined, cacheWrite: undefined }, outputTokens: { total: 1, text: 1, reasoning: undefined } };

/** Calls `lookup` once, then answers with what it returned. Counts its calls. */
function echoModel(calls: { n: number }): any {
  return {
    specificationVersion: 'v3', provider: 'scripted', modelId: 'echo', supportedUrls: {},
    doGenerate: async () => { throw new Error('stream only'); },
    doStream: async ({ prompt }: any) => {
      calls.n++;
      const result = (prompt as any[]).flatMap((m) => (m.role === 'tool' ? m.content : [])).find((p: any) => p.type === 'tool-result');
      return {
        stream: new ReadableStream({
          start(c) {
            c.enqueue({ type: 'stream-start', warnings: [] });
            if (!result) {
              c.enqueue({ type: 'tool-call', toolCallId: 'call-1', toolName: 'lookup', input: JSON.stringify({ q: 'x' }) });
              c.enqueue({ type: 'finish', finishReason: { unified: 'tool-calls', raw: 'tool-calls' }, usage });
            } else {
              c.enqueue({ type: 'text-start', id: 't' });
              c.enqueue({ type: 'text-delta', id: 't', delta: `saw ${JSON.stringify(result.output?.value ?? result.output)}` });
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

const alive = new Set<string>();
const liveness = (id: string): ProcessLiveness => {
  alive.add(id);
  return { id, isAlive: async (o) => alive.has(o), confirm: async () => alive.has(id), close: async () => { alive.delete(id); } };
};

/**
 * The journal as process P sees it: once `diesAfter` says so nothing more of P's event log or execution
 * record lands — P is gone — while the writes it made before are kept. Its run's own records (steps,
 * the tool's result, the outcome) went in before; here they go in too, as if just before it died.
 */
function dyingView(journal: Journal, diesAfter: (key: string, value: any) => boolean): Journal {
  let gone = false;
  const blocked = (key: unknown) => gone && typeof key === 'string' && (key.includes(':ev:') || key.startsWith('__exec__'));
  const view = new Proxy(journal as any, {
    get(target, prop, receiver) {
      const v = Reflect.get(target, prop, receiver);
      if (typeof v !== 'function') return v;
      if (prop === 'put' || prop === 'delete' || prop === 'deletePrefix') return (k: unknown, ...a: unknown[]) => (blocked(k) ? Promise.resolve() : v.call(target, k, ...a));
      if (prop === 'putIfAbsent' || prop === 'putIfMatch') {
        return async (k: unknown, ...a: unknown[]) => {
          if (blocked(k)) return true;
          const ok = await v.call(target, k, ...a);
          if (typeof k === 'string' && diesAfter(k, a[a.length - 1])) gone = true;
          return ok;
        };
      }
      return v.bind(target);
    },
  });
  return view as Journal;
}

describe.each(STORES)('a process that records a run\'s result and dies before its last events — %s', (_name, make) => {
  it('a reader still gets the tool\'s result, the answer and the end, replayed with no model or tool call', async () => {
    const storage = await make();
    const journal = storage.runs as unknown as Journal;
    const runId = `r-died-${unique()}`;
    await claimRunOwner(journal as any, runId, user('alice'));
    const calls = { n: 0 };
    const executions = { n: 0 };
    const lookup = tool({ description: 'reads', inputSchema: z.object({ q: z.string() }), execute: async () => { executions.n++; return 'found it'; } });
    const launch = (j: Journal) => (signal: AbortSignal) => streamDurable({ journal: j, runId, model: echoModel(calls), tools: { lookup }, prompt: 'go', resourceId: 'alice', abortSignal: signal } as any);

    // P executes the run; it dies right after its log has the tool call.
    const p = liveness(`P-${unique()}`);
    const view = dyingView(journal, (k, v) => k.includes(':ev:') && v?.kind === 'tool-call');
    const runsP = new DetachedRuns({ journal: view, liveness: p, resume: () => launch(view), sweepMs: 0 });
    perTest.push(() => runsP.close());
    const events = () => readRunEvents(journal, runId, 0);
    await runsP.start({ runId, launch: launch(view) });
    await until('P wrote the run\'s outcome', async () => (await journal.get<any>(runKeys.outcome(runId)))?.status === 'completed');
    await sleep(100);
    await p.close();
    const before = await events();
    expect(before.some((e) => e.kind === 'tool-result'), "P's log stops before the tool's result").toBe(false);
    expect(before.some((e) => e.kind === 'status' && (e.data as any).state === 'completed')).toBe(false);
    const modelCalls = calls.n;
    const toolCalls = executions.n;
    expect(toolCalls).toBe(1);

    // D, alive, finds P gone and takes the run over.
    const d = liveness(`D-${unique()}`);
    const runsD = new DetachedRuns({ journal, liveness: d, resume: () => launch(journal), sweepMs: 0 });
    perTest.push(() => runsD.close());
    expect(await runsD.sweep()).toBe(1);
    await until('the run is read as completed', async () => { const st = (await events()).filter((e) => e.kind === 'status'); return (st[st.length - 1]?.data as any)?.state === 'completed'; });
    const evs = await events();
    expect(evs.filter((e) => e.kind === 'tool-result').map((e) => (e.data as any).output), "the tool's result").toContain('found it');
    expect(textOf(evs as any), 'the answer').toContain('found it');
    const seqs = evs.map((e) => e.seq);
    expect(new Set(seqs).size, 'no event twice').toBe(seqs.length);
    expect(calls.n, 'replayed from the journal: no model call').toBe(modelCalls);
    expect(executions.n, 'and no tool call').toBe(toolCalls);
  });
});
