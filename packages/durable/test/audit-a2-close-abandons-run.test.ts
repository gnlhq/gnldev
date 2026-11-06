// AUDIT A2 (evidence only, no fix): a DetachedRuns.close() mid-run — what does the run's log and its
// execution record say afterwards, and what does a second "process" (its own pool, its own liveness
// session, its own executor on the same Postgres database) answer for the same run id?
//
// Expected (executors.ts closeExecutorFor's own contract): "its local runs aborted — another process
// ... continues them from the journal". I.e. the close is a RELEASE, not an ending.
import { describe, it, expect, afterEach } from 'vitest';
import pg from 'pg';
import { tool } from 'ai';
import { z } from 'zod';
import { DetachedRuns, streamDurable, readRunEvents, postgresLiveness, installProcessLiveness, type Journal, type Launch } from '../src/index.js';
import { PostgresStorage } from '../src/postgres-storage.js';
import { execKey } from '../src/exec-record.js';
import { beginDrain, endDrain } from '../src/process-liveness.js';
import { streamingModel, textOf } from './detached/models.js';

const PG_URL = process.env.GNL_PG_URL;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
afterEach(() => installProcessLiveness(undefined));

const usage = { inputTokens: { total: 1, noCache: 1, cacheRead: undefined, cacheWrite: undefined }, outputTokens: { total: 1, text: 1, reasoning: undefined } };
/** A provider that does NOT obey its abort signal: keeps streaming until it is done. */
function deafModel(words: string[], gapMs: number): any {
  return {
    specificationVersion: 'v3', provider: 'scripted', modelId: 'deaf', supportedUrls: {},
    doGenerate: async () => { throw new Error('stream only'); },
    doStream: async () => ({
      stream: new ReadableStream({
        async start(c) {
          c.enqueue({ type: 'stream-start', warnings: [] });
          c.enqueue({ type: 'text-start', id: 't' });
          for (const w of words) { await sleep(gapMs); try { c.enqueue({ type: 'text-delta', id: 't', delta: w }); } catch { return; } }
          try { c.enqueue({ type: 'text-end', id: 't' }); c.enqueue({ type: 'finish', finishReason: { unified: 'stop', raw: 'stop' }, usage }); c.close(); } catch { /* canceled */ }
        },
      }),
    }),
  };
}

/** Completion notices the host received (DetachedRunsOptions.onComplete), from every process. */
const notices: string[] = [];
interface Proc { storage: PostgresStorage; journal: Journal; runs: DetachedRuns; liveness: any }
async function proc(url: string, launchFor: (runId: string, journal: Journal) => Launch): Promise<Proc> {
  const storage = new PostgresStorage({ connectionString: url });
  (storage as any).pool?.on?.('error', () => {});
  const journal = storage.runs as unknown as Journal;
  await storage.init();
  const liveness = await postgresLiveness({ connectionString: url, heartbeatMs: 500 });
  const runs = new DetachedRuns({ journal, liveness, sweepMs: 200, pollMs: 50, resume: (rec) => launchFor(rec.runId, journal), onComplete: async (c) => { notices.push(`${c.runId} ${c.state}`); } });
  return { storage, journal, runs, liveness };
}

async function withDb<T>(fn: (url: string) => Promise<T>): Promise<T> {
  const admin = new pg.Client({ connectionString: PG_URL });
  await admin.connect();
  const db = `a2_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`;
  await admin.query(`CREATE DATABASE ${db}`);
  const url = new URL(PG_URL!); url.pathname = `/${db}`;
  try { return await fn(url.toString()); } finally {
    await admin.query(`DROP DATABASE IF EXISTS ${db} WITH (FORCE)`);
    await admin.end();
  }
}

const states = (evs: any[]) => evs.filter((e) => e.kind === 'status').map((e) => e.data.state);

/**
 * Starts the run on A, waits for `ready`, closes A's executor (as storage.close() does), then reads the
 * store from B and lets B answer the same run id both ways (detached start+follow, and a direct
 * streamDurable call — the fixture's `/direct` door).
 */
async function scenario(tag: string, url: string, launchFor: (runId: string, journal: Journal) => Launch, ready: (a: Proc, runId: string) => Promise<void>, drainFlag = false) {
  const runId = `r-${tag}`;
  const A = await proc(url, launchFor);
  await A.runs.start({ runId, launch: launchFor(runId, A.journal) });
  await ready(A, runId);
  if (drainFlag) beginDrain();
  try { await A.runs.close(); } finally { if (drainFlag) endDrain(); }
  const afterClose = await readRunEvents(A.journal, runId);
  const exec = await A.journal.get(execKey(undefined, runId));
  const keys = (await (A.journal as any).listKeys('')).filter((k: string) => k.includes(runId) && !k.includes(':ev:'));
  const recs: Record<string, unknown> = {};
  for (const k of keys) recs[k] = await A.journal.get(k);
  await A.liveness.close();
  await A.storage.close();

  const B = await proc(url, launchFor);
  // B's sweep: does anybody continue the run?
  await sleep(1_500);
  const bAfterSweep = await readRunEvents(B.journal, runId);
  const execB = await B.journal.get(execKey(undefined, runId));
  // A caller asks B for the run.
  const started = await B.runs.start({ runId, launch: launchFor(runId, B.journal) });
  const followed: any[] = [];
  for await (const ev of B.runs.follow({ runId, untilPause: true })) followed.push(ev);
  let direct: unknown;
  try { const r: any = await launchFor(runId, B.journal)(new AbortController().signal); direct = { ok: true, text: await r.text }; }
  catch (e: any) { direct = { error: String(e?.message ?? e), name: e?.name }; }
  await B.runs.close();
  await B.liveness.close();
  await B.storage.close();

  const out = {
    tag,
    statusesAfterClose: states(afterClose),
    lastAfterClose: afterClose.at(-1) && { kind: afterClose.at(-1)!.kind, data: afterClose.at(-1)!.data },
    textAfterClose: textOf(afterClose as any),
    execRecordAfterClose: exec ?? null,
    runRecordsAfterClose: recs,
    statusesSeenByBAfterSweep: states(bAfterSweep),
    execRecordOnB: execB ?? null,
    startOnB: started.state,
    followOnBStatuses: states(followed),
    followOnBText: textOf(followed),
    directOnB: direct,
    completionNotices: notices.filter((n) => n.startsWith(runId + ' ')),
  };
  console.log(`[A2 ${tag}] ${JSON.stringify(out, null, 1)}`);
  return out;
}

const WORDS = Array.from({ length: 40 }, (_, i) => `w${i} `);
const firstText = async (a: Proc, runId: string) => {
  for (let i = 0; i < 200; i++) { if ((await readRunEvents(a.journal, runId)).some((e) => e.kind === 'text')) return; await sleep(25); }
  throw new Error('no text');
};

describe.skipIf(!PG_URL)('A2: DetachedRuns.close() mid-run', () => {
  it('AI SDK stream, provider obeys abort (detached/models.ts streamingModel: errors its stream)', { timeout: 60_000 }, async () => {
    const model = streamingModel({ words: WORDS, gapMs: 100 });
    const launchFor = (runId: string, journal: Journal): Launch => (signal) => streamDurable({ journal, runId, model, prompt: 'hi', resourceId: 'alice', abortSignal: signal } as any);
    const o = await withDb((url) => scenario('sdk-obeys', url, launchFor, firstText));
    // RED if the close ENDED the run: expected no ending, the record released, B continues it.
    expect(o.statusesAfterClose).not.toContain('completed');
  });

  it('AI SDK stream, provider ignores abort', { timeout: 60_000 }, async () => {
    const model = deafModel(WORDS, 100);
    const launchFor = (runId: string, journal: Journal): Launch => (signal) => streamDurable({ journal, runId, model, prompt: 'hi', resourceId: 'alice', abortSignal: signal } as any);
    const o = await withDb((url) => scenario('sdk-deaf', url, launchFor, firstText));
    expect(o.statusesAfterClose).not.toContain('completed');
  });

  it('AI SDK stream, close while a side-effect tool body is in flight', { timeout: 60_000 }, async () => {
    let started = 0;
    const effect = tool({ description: 'effect', inputSchema: z.object({ order: z.string() }), execute: async () => { started++; await sleep(1_500); return 'done'; } });
    Object.assign(effect, { sideEffect: true });
    const model = streamingModel({ words: ['ok '], gapMs: 10, tool: { name: 'effect', input: { order: 'o-1' } } });
    const launchFor = (runId: string, journal: Journal): Launch => (signal) => streamDurable({ journal, runId, model, tools: { effect }, prompt: 'hi', resourceId: 'alice', abortSignal: signal } as any);
    const o = await withDb((url) => scenario('sdk-tool', url, launchFor, async () => { for (let i = 0; i < 200 && started === 0; i++) await sleep(20); await sleep(100); }));
    console.log(`[A2 sdk-tool] tool bodies started: ${started}`);
    expect(o.statusesAfterClose).not.toContain('completed');
  });

  // Isolation without the AI SDK: a launch whose fullStream reacts to the abort in two ways.
  const rawLaunch = (mode: 'throw' | 'silent'): ((runId: string, journal: Journal) => Launch) => (runId, journal) => async (signal) => {
    // A run needs an owner record before the executor logs it (run-identity.ts): the real launch writes it.
    const r: any = await streamDurable({ journal, runId, model: streamingModel({ words: ['x '], gapMs: 1 }), prompt: 'hi', resourceId: 'alice' } as any);
    for await (const _ of r.fullStream) { /* let it finish: the owner record is written */ }
    return {
      steps: Promise.resolve([]),
      fullStream: (async function* () {
        yield { type: 'start' };
        yield { type: 'start-step' };
        yield { type: 'text-start', id: 't' };
        for (let i = 0; i < 100; i++) {
          if (signal.aborted) { if (mode === 'throw') throw signal.reason ?? new Error('aborted'); return; }
          yield { type: 'text-delta', id: 't', text: `y${i} ` };
          await sleep(50);
        }
        yield { type: 'text-end', id: 't' };
        yield { type: 'finish-step', finishReason: 'stop', usage: {} };
        yield { type: 'finish', finishReason: 'stop', totalUsage: {} };
      })(),
    };
  };

  it('raw fullStream that THROWS on abort', { timeout: 60_000 }, async () => {
    const o = await withDb((url) => scenario('raw-throw', url, rawLaunch('throw'), firstText));
    expect(o.statusesAfterClose).not.toContain('completed');
    expect(o.statusesAfterClose).not.toContain('failed');
  });

  it('raw fullStream that ENDS SILENTLY on abort', { timeout: 60_000 }, async () => {
    const o = await withDb((url) => scenario('raw-silent', url, rawLaunch('silent'), firstText));
    expect(o.statusesAfterClose).not.toContain('completed');
  });

  // CONTROL (isolation): the same close, with the process-wide drain flag up while the executor ends the
  // run — the only thing executeBody asks to tell a release from an ending.
  it('CONTROL drain flag up + raw fullStream that THROWS on abort', { timeout: 60_000 }, async () => {
    const o = await withDb((url) => scenario('ctl-drain-raw-throw', url, rawLaunch('throw'), firstText, true));
    expect(o.statusesAfterClose).toEqual(['running']);
  });
  it('CONTROL drain flag up + raw fullStream that ENDS SILENTLY on abort', { timeout: 60_000 }, async () => {
    const o = await withDb((url) => scenario('ctl-drain-raw-silent', url, rawLaunch('silent'), firstText, true));
    expect(o.statusesAfterClose).toEqual(['running']);
  });
  it('CONTROL drain flag up + AI SDK stream (provider obeys abort)', { timeout: 60_000 }, async () => {
    const model = streamingModel({ words: WORDS, gapMs: 100 });
    const launchFor = (runId: string, journal: Journal): Launch => (signal) => streamDurable({ journal, runId, model, prompt: 'hi', resourceId: 'alice', abortSignal: signal } as any);
    const o = await withDb((url) => scenario('ctl-drain-sdk', url, launchFor, firstText, true));
    expect(o.statusesAfterClose).toEqual(['running']);
  });
});
