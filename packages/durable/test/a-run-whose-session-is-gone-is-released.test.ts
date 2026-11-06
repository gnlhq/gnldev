// A run whose process cannot start its next call because its liveness session is gone is RELEASED, not
// finished without the call.
//
// The call is refused with LivenessUnavailableError (attempt.ts assertHeld) and the AI SDK hands that to the
// model as a failed tool ("error-text"): the model answered, and the run ended `completed` with the tool run
// ZERO times — measured. Like a drain, the execution is released instead: nothing of it is told to the model,
// the claim is given back, and the next sweep continues the run from its log once a session is back; the
// call then runs once and the run completes.
import { describe, it, expect, afterEach } from 'vitest';
import { tool } from 'ai';
import { z } from 'zod';
import { DetachedRuns, streamDurable } from '../src/index.js';
import { SqliteStorage } from '../src/sqlite-storage.js';
import { bindLiveness, unbindLiveness, sessionSignals } from '../src/process-liveness.js';
import { execKey } from '../src/exec-record.js';
import { streamingModel } from './detached/models.js';

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
let cleanup: Array<() => Promise<unknown> | unknown> = [];
afterEach(async () => { for (const c of cleanup.reverse()) await c(); cleanup = []; });

describe('a run whose session is gone when its call would start', () => {
  it('is released; once a session is back the run continues and the call runs once', async () => {
    const GRACE = 600;
    const signals = sessionSignals(GRACE);
    let healthy = true;
    const l: any = { id: 'p-gone', reconnectGraceMs: GRACE, sessionSignal: signals.signal, confirm: async () => healthy, isAlive: async () => true, close: async () => undefined };
    const storage = new SqliteStorage(':memory:');
    const journal = storage.runs as any;
    bindLiveness(journal, l);
    cleanup.push(() => { signals.close(); unbindLiveness(journal); return storage.close(); });
    let execs = 0;
    const effect = tool({ description: 'x', inputSchema: z.object({ order: z.string() }), execute: async () => { execs++; return 'done'; } });
    Object.assign(effect, { sideEffect: true });
    const base = streamingModel({ words: ['ok '], gapMs: 5, tool: { name: 'effect', input: { order: 'o-1' } } });
    const prompts: string[] = [];
    // The session goes as the model asks for the call, and stays gone past half its grace.
    const model = { ...base, doStream: async (o: any) => { prompts.push(JSON.stringify(o.prompt)); const r = await base.doStream(o); if (prompts.length === 1) healthy = false; return r; } };
    const args = (runId: string) => ({ journal, runId, model, tools: { effect }, prompt: 'do it', resourceId: 'alice', timeouts: { claimTtlMs: 30_000 } }) as any;
    const runs = new DetachedRuns({ journal, liveness: l, sweepMs: 0, pollMs: 25, resume: (rec: any) => (s: AbortSignal) => streamDurable({ ...args(rec.runId), abortSignal: s }) });
    cleanup.push(() => runs.close?.());
    await runs.start({ runId: 'r1', launch: (s: AbortSignal) => streamDurable({ ...args('r1'), abortSignal: s }) } as any);

    const rec = async () => (await journal.get(execKey(undefined, 'r1'))) as { status?: string } | undefined;
    for (let i = 0; i < 200 && (await rec())?.status === 'running'; i++) await sleep(25);
    expect((await rec())?.status, 'the execution is released').toBe('released');
    const so = async () => { const evs: any[] = []; const ac = new AbortController(); setTimeout(() => ac.abort(), 300); for await (const e of runs.follow({ runId: 'r1', signal: ac.signal })) evs.push(e); return evs; };
    const first = await so();
    expect(first.some((e) => e.kind === 'status' && e.data.state === 'completed'), 'not finished without its call').toBe(false);
    expect(first.some((e) => e.kind === 'tool-error'), 'the failure is not part of the run').toBe(false);
    expect(execs).toBe(0);
    expect(prompts.length, 'the model was not asked again').toBe(1);

    healthy = true; signals.proven();
    expect(await runs.sweep()).toBe(1);
    const evs: any[] = [];
    for await (const e of runs.follow({ runId: 'r1' })) evs.push(e);
    expect(evs.at(-1)).toMatchObject({ kind: 'status', data: { state: 'completed' } });
    expect(execs, 'the call ran once, after the session came back').toBe(1);
    expect(prompts.at(-1)).toContain('done');
  }, 30_000);

  it('a body told to stop after it started is not run again: the run waits for a person', async () => {
    const GRACE = 600;
    const signals = sessionSignals(GRACE);
    let healthy = true;
    const l: any = { id: 'p-gone', reconnectGraceMs: GRACE, sessionSignal: signals.signal, confirm: async () => healthy, isAlive: async () => true, close: async () => undefined };
    const storage = new SqliteStorage(':memory:');
    const journal = storage.runs as any;
    bindLiveness(journal, l);
    cleanup.push(() => { signals.close(); unbindLiveness(journal); return storage.close(); });
    let execs = 0;
    const effect = tool({
      description: 'x', inputSchema: z.object({ order: z.string() }),
      execute: async (_: unknown, o: any) => {
        execs++; // the effect happened
        healthy = false; // and the session goes under the body, past half its grace
        return new Promise<string>((_r, reject) => { o.abortSignal.addEventListener('abort', () => reject(o.abortSignal.reason)); });
      },
    });
    Object.assign(effect, { sideEffect: true });
    const model = streamingModel({ words: ['ok '], gapMs: 5, tool: { name: 'effect', input: { order: 'o-1' } } });
    const args = (runId: string) => ({ journal, runId, model, tools: { effect }, prompt: 'do it', resourceId: 'alice', timeouts: { claimTtlMs: 30_000 } }) as any;
    const runs = new DetachedRuns({ journal, liveness: l, sweepMs: 0, pollMs: 25, resume: (rec: any) => (s: AbortSignal) => streamDurable({ ...args(rec.runId), abortSignal: s }) });
    cleanup.push(() => runs.close?.());
    await runs.start({ runId: 'r1', launch: (s: AbortSignal) => streamDurable({ ...args('r1'), abortSignal: s }) } as any);

    const rec = async () => (await journal.get(execKey(undefined, 'r1'))) as { status?: string } | undefined;
    for (let i = 0; i < 200 && (await rec())?.status === 'running'; i++) await sleep(25);
    expect((await rec())?.status, 'the execution is released').toBe('released');

    healthy = true; signals.proven();
    expect(await runs.sweep()).toBe(1);
    const evs: any[] = [];
    for await (const e of runs.follow({ runId: 'r1' })) { evs.push(e); if (e.kind === 'status' && e.data.state === 'waiting-approval') break; }
    expect(evs.at(-1)).toMatchObject({ kind: 'status', data: { state: 'waiting-approval', error: { name: 'SideEffectRetryBlockedError' } } });
    expect(execs, 'the effect may have happened: it does not run again by itself').toBe(1);
  }, 30_000);
});
