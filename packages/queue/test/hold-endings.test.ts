// WORK IN HAND ENDS ON EVERY ENDING — one table over every place that holds work (`holdWhile`), times every
// way that work can end. A held unit that outlives its work keeps a drain from finishing and tells another
// process (`gnl pending`, `gnl upgrade`) that something runs when nothing does; a wait that waits for its own
// caller never settles. Round 2 of the release audit found both, three times, each at one call site (R2-4: a
// stream whose reader went away; R2-7: a job closing its own worker; C2's close). The rule is the primitive's
// (process-liveness.ts `holdWhile`: the unit ends when its work does, and a wait never waits for the units
// its caller runs inside) — this table holds every call site to it, and fails when a new one appears
// without a row.
import { describe, it, expect, afterEach } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, dirname, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  InMemoryStorage, InMemoryJournal, toJournal, runDurable, streamDurable, drainProcess, endDrain, pendingWork, type Storage,
} from '@gnldev/durable';
import { enqueue, createWorker, cancelJob } from '../src/index.js';
import { scheduleWorkflow, pollScheduler } from '../../scheduler/src/index.js';

const here = dirname(fileURLToPath(import.meta.url));
const packagesDir = join(here, '..', '..');
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
afterEach(() => endDrain());

// ── models ──────────────────────────────────────────────────────────────────────────────────────────
const usage2 = { inputTokens: 1, outputTokens: 1, totalTokens: 2 };
const usage3 = { inputTokens: { total: 1, noCache: 1, cacheRead: undefined, cacheWrite: undefined }, outputTokens: { total: 1, text: 1, reasoning: undefined } };
const sawTool = (prompt: any[]) => (prompt ?? []).some((m: any) => m.role === 'tool');
/** Generate: one call of tool `act` (when asked), then an answer. `fail`: the model throws. */
const genModel = (o: { tool?: boolean; fail?: boolean; gapMs?: number } = {}): any => ({
  specificationVersion: 'v2', provider: 'probe', modelId: 'm', supportedUrls: {},
  doGenerate: async ({ prompt, abortSignal }: any) => {
    if (o.gapMs) await sleep(o.gapMs);
    abortSignal?.throwIfAborted?.();
    if (o.fail) throw new Error('model down');
    return o.tool && !sawTool(prompt)
      ? { content: [{ type: 'tool-call', toolCallId: 'c1', toolName: 'act', input: '{}' }], finishReason: 'tool-calls', usage: usage2, warnings: [] }
      : { content: [{ type: 'text', text: 'done' }], finishReason: 'stop', usage: usage2, warnings: [] };
  },
  doStream: async () => { throw new Error('no stream'); },
});
/** Stream: words with a gap, or one call of tool `act` first; `fail`: an error part mid-stream. */
const streamModel = (o: { words?: number; gapMs?: number; tool?: boolean; fail?: boolean } = {}): any => ({
  specificationVersion: 'v3', provider: 'probe', modelId: 'm', supportedUrls: {},
  doGenerate: async () => { throw new Error('stream only'); },
  doStream: async ({ prompt }: any) => ({
    stream: new ReadableStream({
      async start(c) {
        c.enqueue({ type: 'stream-start', warnings: [] });
        if (o.tool && !sawTool(prompt)) {
          c.enqueue({ type: 'tool-call', toolCallId: 'c1', toolName: 'act', input: '{}' });
          c.enqueue({ type: 'finish', finishReason: { unified: 'tool-calls', raw: 'tool-calls' }, usage: usage3 });
          c.close();
          return;
        }
        c.enqueue({ type: 'text-start', id: 't' });
        for (let i = 0; i < (o.words ?? 2); i++) {
          if (o.gapMs) await sleep(o.gapMs);
          if (o.fail && i === 1) { c.enqueue({ type: 'error', error: new Error('stream broke') }); break; }
          c.enqueue({ type: 'text-delta', id: 't', delta: `w${i} ` });
        }
        c.enqueue({ type: 'text-end', id: 't' });
        c.enqueue({ type: 'finish', finishReason: { unified: o.fail ? 'error' : 'stop', raw: 'stop' }, usage: usage3 });
        c.close();
      },
    }),
  }),
});

// ── what "ended" means, the same for every row ──────────────────────────────────────────────────────
/** Nothing of the unit is in hand: a drain from outside finishes, and no reader lists its run as running. */
async function assertReleased(journal: any, name: string): Promise<void> {
  const drain = await drainProcess({ deadlineMs: 2_000 });
  endDrain();
  const listed = (await pendingWork(journal)).running.some((r) => r.runId === name);
  expect({ drain, listed }, `'${name}' is still in hand`).toEqual({ drain: { drained: true }, listed: false });
}
/** A drain from INSIDE the unit: it does not wait for its caller (it settles well before its deadline). */
async function drainFromInside(): Promise<{ drained: boolean; ms: number }> {
  const t = Date.now();
  const r = await drainProcess({ deadlineMs: 5_000 });
  endDrain(); // let the unit go on: the case is the wait, not the shutdown
  return { drained: r.drained, ms: Date.now() - t };
}
const settles = <T>(p: Promise<T>, ms = 8_000): Promise<T | 'never settled'> =>
  Promise.race([p, sleep(ms).then(() => 'never settled' as const)]);

type Ending = 'complete' | 'error' | 'cancel' | 'reader-cancels' | 'never-read' | 'drain-from-inside' | 'close-from-inside';
type Case = (ending: Ending) => Promise<void>;

// ── the call sites ──────────────────────────────────────────────────────────────────────────────────
interface Site { site: string; file: string; marker: string; endings: Ending[]; run: Case }

const SITES: Site[] = [
  {
    site: 'runDurable', file: 'durable/src/run.ts', marker: 'holdWhile(() => runDurableHeld(args)',
    endings: ['complete', 'error', 'cancel', 'drain-from-inside'],
    run: async (ending) => {
      const journal = toJournal(new InMemoryStorage().runs);
      const ac = new AbortController();
      let inside: { drained: boolean; ms: number } | undefined;
      const p = runDurable({
        runId: `rd-${ending}`, journal, resourceId: 'u', prompt: 'go',
        model: genModel({ tool: ending === 'drain-from-inside', fail: ending === 'error', gapMs: ending === 'cancel' ? 300 : 0 }),
        ...(ending === 'drain-from-inside' ? { tools: { act: { execute: async () => { inside = await drainFromInside(); return { ok: true }; } } } } : {}),
        abortSignal: ac.signal,
      } as never);
      if (ending === 'cancel') setTimeout(() => ac.abort(new Error('stop')), 50);
      expect(await settles(p.then(() => 'ok', () => 'threw'))).not.toBe('never settled');
      if (ending === 'drain-from-inside') expect(inside).toMatchObject({ drained: true });
      await assertReleased(journal, `rd-${ending}`);
    },
  },
  {
    site: 'streamDurable', file: 'durable/src/run.ts', marker: 'void holdWhile(async () => {\n    const started = streamDurableHeld(args, run);',
    endings: ['complete', 'error', 'cancel', 'reader-cancels', 'never-read', 'drain-from-inside'],
    run: async (ending) => {
      const journal = toJournal(new InMemoryStorage().runs);
      const ac = new AbortController();
      let inside: { drained: boolean; ms: number } | undefined;
      const r = await streamDurable({
        runId: `sd-${ending}`, journal, resourceId: 'u', prompt: 'go',
        model: streamModel({ words: ending === 'cancel' || ending === 'reader-cancels' ? 30 : 2, gapMs: ending === 'cancel' || ending === 'reader-cancels' ? 10 : 0, fail: ending === 'error', tool: ending === 'drain-from-inside' }),
        ...(ending === 'drain-from-inside' ? { tools: { act: { execute: async () => { inside = await drainFromInside(); return { ok: true }; } } } } : {}),
        abortSignal: ac.signal,
      } as never);
      if (ending === 'reader-cancels') {
        const reader = (r.textStream as ReadableStream<string>).getReader();
        await reader.read();
        await reader.cancel();
      } else if (ending === 'cancel') {
        const reader = (r.textStream as ReadableStream<string>).getReader();
        await reader.read();
        ac.abort(new Error('stop'));
        await settles((async () => { for (;;) { const x = await reader.read().catch(() => ({ done: true })); if (x.done) return; } })());
      } else if (ending !== 'never-read') {
        await settles(Promise.resolve(r.consumeStream()));
      }
      if (ending === 'drain-from-inside') {
        for (let i = 0; i < 200 && !inside; i++) await sleep(10);
        expect(inside).toMatchObject({ drained: true });
      }
      await assertReleased(journal, `sd-${ending}`);
    },
  },
  {
    site: 'queue worker runOnce', file: 'queue/src/index.ts', marker: 'holdWhile(runOnceHeld)',
    endings: ['complete', 'error', 'close-from-inside', 'drain-from-inside'],
    run: (ending) => queueCase(ending, 'runOnce'),
  },
  {
    site: 'queue job', file: 'queue/src/index.ts', marker: 'return await holdWhile(async (): Promise<boolean> => {',
    endings: ['complete', 'error', 'cancel', 'close-from-inside', 'drain-from-inside'],
    run: (ending) => queueCase(ending, 'job'),
  },
  {
    site: 'scheduler fire', file: 'scheduler/src/index.ts', marker: 'await holdWhile(async (): Promise<void> => {',
    endings: ['complete', 'error', 'drain-from-inside'],
    run: async (ending) => {
      const journal = new InMemoryJournal();
      let inside: { drained: boolean; ms: number } | undefined;
      const runner = {
        async runWorkflow() {
          if (ending === 'error') throw new Error('workflow failed');
          if (ending === 'drain-from-inside') inside = await drainFromInside();
          return { output: 'ok' };
        },
      };
      const T0 = Date.UTC(2026, 0, 1);
      await scheduleWorkflow(journal as any, { id: `t-${ending}`, name: 'w', every: 60_000, maxAttempts: 3 }, T0);
      expect(await settles(pollScheduler(journal as any, runner as any, T0 + 60_000))).not.toBe('never settled');
      if (ending === 'drain-from-inside') expect(inside).toMatchObject({ drained: true });
      await assertReleased(journal, `sched:t-${ending}:0`);
    },
  },
];

/** The two queue units: the scan (`runOnce`) and the job inside it end together, so one case drives both. */
async function queueCase(ending: Ending, _unit: 'runOnce' | 'job'): Promise<void> {
  const storage: Storage = new InMemoryStorage();
  const id = await enqueue(storage.work!, 't', {});
  let inside: { drained: boolean; ms: number } | undefined;
  let canceledWith: string | undefined;
  let worker!: ReturnType<typeof createWorker>;
  worker = createWorker(storage, {
    t: async (_p: unknown, ctx: any) => {
      if (ending === 'error') throw new Error('handler failed');
      if (ending === 'cancel') {
        await cancelJob(storage.work!, id);
        await new Promise<void>((_r, rej) => { ctx.signal.addEventListener('abort', () => { canceledWith = String(ctx.signal.reason); rej(ctx.signal.reason); }); setTimeout(() => rej(new Error('not canceled')), 3_000); });
      }
      if (ending === 'close-from-inside') await worker.close();
      if (ending === 'drain-from-inside') inside = await drainFromInside();
    },
  }, { maxAttempts: 1, retryDelayMs: 0, ttlMs: 300 } as never);
  expect(await settles(worker.runOnce())).not.toBe('never settled');
  if (ending === 'cancel') expect(canceledWith).toMatch(/cancelled/);
  if (ending === 'drain-from-inside') expect(inside).toMatchObject({ drained: true });
  await assertReleased(toJournal(storage.runs), `job:${id}`);
  await worker.close();
}

// ── the source scan: every call site has a row ──────────────────────────────────────────────────────
function sourcesOf(dir: string): string[] {
  const out: string[] = [];
  for (const e of readdirSync(dir)) {
    const p = join(dir, e);
    if (statSync(p).isDirectory()) out.push(...sourcesOf(p));
    else if (/\.tsx?$/.test(e) && !e.endsWith('.d.ts')) out.push(p);
  }
  return out;
}
function holdCallSites(): Array<{ file: string; at: number }> {
  const out: Array<{ file: string; at: number }> = [];
  for (const pkg of readdirSync(packagesDir)) {
    const src = join(packagesDir, pkg, 'src');
    try { statSync(src); } catch { continue; }
    for (const f of sourcesOf(src)) {
      const text = readFileSync(f, 'utf8');
      for (const m of text.matchAll(/\bholdWhile\(/g)) {
        const line = text.slice(text.lastIndexOf('\n', m.index!) + 1, text.indexOf('\n', m.index!));
        if (/^\s*(\/\/|\*)/.test(line) || /function holdWhile/.test(line) || /`holdWhile`/.test(line)) continue;
        out.push({ file: relative(packagesDir, f), at: m.index! });
      }
    }
  }
  return out;
}

describe('work in hand ends on every ending — every holdWhile call site', () => {
  it('every holdWhile call site in the packages has a row in this table, and every row names a real one', () => {
    const calls = holdCallSites();
    const unclaimed = calls.filter((c) => {
      const text = readFileSync(join(packagesDir, c.file), 'utf8');
      return !SITES.some((s) => s.file === c.file && text.slice(c.at - 40, c.at + s.marker.length + 40).includes(s.marker));
    });
    const missing = SITES.filter((s) => !readFileSync(join(packagesDir, s.file), 'utf8').includes(s.marker)).map((s) => s.site);
    expect({ calls: calls.length, unclaimed, missing }).toEqual({ calls: SITES.length, unclaimed: [], missing: [] });
  });

  for (const s of SITES) {
    describe(s.site, () => {
      for (const ending of s.endings) it(`ends when its work ends: ${ending}`, () => s.run(ending), 30_000);
    });
  }
});

describe('a wait from inside a unit waits for every OTHER unit (the exclusion is the caller\'s own, nothing more)', () => {
  it('a job that drains still waits for another run in hand', async () => {
    const storage: Storage = new InMemoryStorage();
    const journal = toJournal(storage.runs);
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    let inBody = false;
    const other = runDurable({ runId: 'other', journal, resourceId: 'u', prompt: 'go', model: genModel({ tool: true }), tools: { act: { execute: async () => { inBody = true; await gate; return { ok: true }; } } } } as never);
    while (!inBody) await sleep(5);
    await enqueue(storage.work!, 't', {});
    let fromJob: { drained: boolean } | undefined;
    const worker = createWorker(storage, { t: async () => { fromJob = await drainProcess({ deadlineMs: 300 }); endDrain(); } }, { maxAttempts: 1 } as never);
    await worker.runOnce();
    release();
    await other;
    expect(fromJob).toEqual({ drained: false });
    await worker.close();
  });

  it('a job that closes its worker still waits for the worker\'s other job', async () => {
    const storage: Storage = new InMemoryStorage();
    await enqueue(storage.work!, 'slow', {});
    await enqueue(storage.work!, 'closer', {});
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    let slowRunning = false;
    let slowDone = false;
    let closedAfterSlow: boolean | undefined;
    let worker!: ReturnType<typeof createWorker>;
    worker = createWorker(storage, {
      slow: async () => { slowRunning = true; await gate; slowDone = true; },
      closer: async () => { setTimeout(release, 300); await worker.close(); closedAfterSlow = slowDone; },
    }, { maxAttempts: 1 } as never);
    const first = worker.runOnce(); // takes 'slow'
    while (!slowRunning) await sleep(5);
    await worker.runOnce(); // takes 'closer', which closes while 'slow' runs
    await first;
    expect(closedAfterSlow).toBe(true);
  });
});
