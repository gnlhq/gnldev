// k3-b2 (3b), the tool claim: a call that failed between its claim and its body gives its claim back
// (attempt.ts Attempt.giveBack). When that write fails once, the claim stayed 'running' and named its
// process — while that process lived, every other process read the call as busy; in this process it read
// as a crash that "may have run". The holder now retries the give-back (process-liveness.ts giveBack),
// fenced by its own stamp: a later claim of the same call is never touched.
import { describe, it, expect, afterAll, beforeAll, vi } from 'vitest';
import { spawn, type ChildProcess } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { durableTool } from '../../src/durable-tool.js';
import { InMemoryStorage, type Storage } from '../../src/index.js';
import { BACKEND, BASE_URL, newStorage, scopeUrl } from './backends.mjs';
import type { DurableCtx, Journal } from '../../src/journal.js';

const PG_URL = BASE_URL;
const CHILD = fileURLToPath(new URL('./k3-claim-give-back-child.mjs', import.meta.url));
const uid = () => `k3cgb-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`;
const pause = (ms: number) => new Promise((r) => setTimeout(r, ms));
beforeAll(() => { vi.spyOn(console, 'warn').mockImplementation(() => {}); });

/** A run journal where, after the call's claim lands, the duplicate-marker read fails once and then the claim's give-back write fails `backFails` times. */
function faulty(journal: Journal, toolKey: string, backFails: number) {
  const s = { claimed: false, dupFailed: false, backLeft: backFails };
  const wrapped = new Proxy(journal as any, {
    get(target, prop) {
      const v = target[prop];
      if (typeof v !== 'function') return v;
      if (!['get', 'putIfAbsent', 'putIfMatch'].includes(prop as string)) return v.bind(target);
      return async (key: string, ...rest: unknown[]) => {
        const value = (prop === 'putIfMatch' ? rest[1] : rest[0]) as { status?: string } | undefined;
        if (s.claimed && !s.dupFailed && prop === 'get' && key.includes('dup-')) { s.dupFailed = true; throw new Error('injected: dup read fails'); }
        if (s.dupFailed && s.backLeft > 0 && prop === 'putIfMatch' && key === toolKey && value?.status !== 'running') { s.backLeft--; throw new Error('injected: the store refuses the give-back'); }
        const r = await v.call(target, key, ...rest);
        if ((prop === 'putIfAbsent' || prop === 'putIfMatch') && r === true && key === toolKey && value?.status === 'running') s.claimed = true;
        return r;
      };
    },
  });
  return { journal: wrapped as Journal, s };
}

async function callWithin(call: () => Promise<unknown>, ms: number) {
  const t0 = performance.now();
  let last = '';
  for (;;) {
    try { return { out: await call(), ms: Math.round(performance.now() - t0) }; } catch (e) { last = `${(e as Error)?.name}: ${String((e as Error)?.message).slice(0, 100)}`; }
    if (performance.now() - t0 > ms) return { err: last, ms: Math.round(performance.now() - t0) };
    await pause(50);
  }
}

describe.skipIf(!PG_URL)(`k3-b2 claim give-back — another process, real ${BACKEND}`, () => {
  let storage: Storage;
  let url: string;
  const children: ChildProcess[] = [];
  beforeAll(async () => { url = await scopeUrl('claim_give_back'); storage = await newStorage(url, { src: true }); await storage.runs.get('warm'); });
  afterAll(async () => {
    for (const c of children) if (c.exitCode === null) c.kill('SIGKILL');
    await storage.close();
  });

  it('CGB1: the give-back write fails ONCE, its process alive — another process runs the call shortly after, once', async () => {
    const runId = uid();
    const toolCallId = 'c1';
    const c = spawn(process.execPath, [CHILD, url, runId, toolCallId], { stdio: ['ignore', 'pipe', 'pipe'] });
    children.push(c);
    let out = '';
    let err = '';
    c.stdout!.on('data', (d) => { out += d; });
    c.stderr!.on('data', (d) => { err += d; });
    for (let t = 0; t < 400 && !out.includes('GAVE_UP'); t++) await pause(50);
    expect(out, err).toContain('GAVE_UP dup=true back=true');
    let runs = 0;
    const tool = { sideEffect: true, execute: async () => { runs++; return { by: 'parent' }; } };
    const r = await callWithin(() => durableTool(tool as any, { journal: storage.runs, runId } as DurableCtx, 'charge').execute!({ amount: 1 }, { toolCallId } as any), 3000);
    console.log(`[k3-b2 CGB1 pg] other process: ${r.out ? `ran after ${r.ms} ms` : `refused for ${r.ms} ms (${r.err})`}; body runs=${runs}; child ran=${out.includes('CHILD_RAN')}; child alive=${c.exitCode === null}`);
    expect(r.out).toEqual({ by: 'parent' });
    expect(runs).toBe(1);
    expect(out).not.toContain('CHILD_RAN');
  }, 30_000);
});

const STORES: Array<[string, () => Promise<Storage>]> = [['in-memory', async () => new InMemoryStorage()]];
if (PG_URL) STORES.push([BACKEND, async () => { const s = await newStorage(await scopeUrl('claim_give_back'), { src: true }); await s.runs.get('warm'); return s; }]);

describe.each(STORES)('k3-b2 claim give-back — one process, %s', (name, make) => {
  it('CGB1 (one process): the give-back write fails once — a retry of the call runs it once (not "may have run")', async () => {
    const storage = await make();
    const runId = uid();
    const toolKey = `${runId}:tool:c1`;
    const f = faulty(storage.runs, toolKey, 1);
    let runs = 0;
    const tool = { sideEffect: true, execute: async () => { runs++; return { n: runs }; } };
    const call = (j: Journal) => durableTool(tool as any, { journal: j, runId } as DurableCtx, 'charge').execute!({ amount: 1 }, { toolCallId: 'c1' } as any);
    await expect(call(f.journal)).rejects.toThrow(/dup read fails/);
    const r = await callWithin(() => call(storage.runs), 2000);
    console.log(`[k3-b2 CGB1 one-process ${name}] ${r.out ? `ran after ${r.ms} ms` : `refused for ${r.ms} ms (${r.err})`}; runs=${runs}; injected back=${f.s.backLeft === 0}`);
    expect(f.s.backLeft).toBe(0);
    expect(r.out).toEqual({ n: 1 });
    expect(runs).toBe(1);
    if (name !== 'in-memory') await (storage as { close(): Promise<void> }).close();
  }, 20_000);

  it('CGB3 (fence): a late retry of an old give-back does not touch the claim the same call took again', async () => {
    const storage = await make();
    const runId = uid();
    const toolKey = `${runId}:tool:c1`;
    // The give-back fails now and at +100 ms; its next retry (~+300 ms) lands while the call's NEW attempt is in its body.
    const f = faulty(storage.runs, toolKey, 2);
    let runs = 0;
    const tool = {
      sideEffect: true,
      // The ladder asks the provider; nothing happened, so the call may run.
      recover: async () => ({ done: false }),
      execute: async () => { runs++; await pause(600); return { n: runs }; },
    };
    const call = (j: Journal) => durableTool(tool as any, { journal: j, runId } as DurableCtx, 'charge').execute!({ amount: 1 }, { toolCallId: 'c1' } as any);
    await expect(call(f.journal)).rejects.toThrow(/dup read fails/);
    const second = call(storage.runs);
    await pause(450); // the old give-back's retry has run by now, against the new claim
    const during = (await storage.runs.get(toolKey)) as { status?: string } | undefined;
    const out = await second;
    const after = (await storage.runs.get(toolKey)) as { status?: string } | undefined;
    console.log(`[k3-b2 CGB3 ${name}] during the new body: ${during?.status}; result=${JSON.stringify(out)}; after: ${after?.status}; runs=${runs}; give-back refusals left=${f.s.backLeft}`);
    expect(during?.status).toBe('running');
    expect(out).toEqual({ n: 1 });
    expect(after?.status).toBe('succeeded');
    expect(runs).toBe(1);
    if (name !== 'in-memory') await (storage as { close(): Promise<void> }).close();
  }, 20_000);
});
