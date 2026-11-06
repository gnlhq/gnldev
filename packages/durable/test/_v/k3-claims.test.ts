// k3 (Mod 3): "being the holder's process" is not proof that a claim is held. The audit's A7 repro
// (a transient failure of the success write), plus siblings S3 (a twin in this process meets an attempt
// that IS in flight — the legitimate wait must stay) and S4 (a run lock whose release failed once).
// Real Postgres: the store's process liveness is bound (as createGnl / the first durable call does).
import { describe, it, expect, afterAll, beforeAll } from 'vitest';
import pg from 'pg';
import { durableTool } from '../../src/durable-tool.js';
import { BACKEND, BASE_URL, newStorage, scopeUrl } from './backends.mjs';
import { acquireRunLock } from '../../src/run-lock.js';
import { storeLiveness } from '../../src/process-liveness.js';

const URL_ = BASE_URL!;
// A measurement against a real server (K3_BACKEND, backends.mjs): skipped without one, as every real-backend test is.
const live = it.skipIf(!(BASE_URL));
let storage: Awaited<ReturnType<typeof newStorage>>;
let armed: string | false = false;
let queries = 0;
let counting = false;
beforeAll(async () => {
  if (!(BASE_URL)) return;
  storage = await newStorage(await scopeUrl('claims'), { src: true });
  await storage.runs.get('warm');
  await storeLiveness(storage.runs, { own: () => storage.processLiveness() });
  const j = storage.runs as unknown as Record<string, (...a: unknown[]) => Promise<unknown>>;
  for (const m of ['put', 'putIfMatch', 'putIfAbsent', 'applyBatch']) {
    const orig = j[m]?.bind(j);
    if (!orig) continue;
    j[m] = async (...a: unknown[]) => {
      if (armed === m || armed === '*') { armed = false; throw new Error(`injected transient failure in ${m}`); }
      return orig(...a);
    };
  }
  // The statement count is only printed (never asserted); it is Postgres' driver that is hooked.
  if (BACKEND === 'postgres') {
    const oq = (pg as any).Client.prototype.query;
    (pg as any).Client.prototype.query = function (this: unknown, ...a: unknown[]) { if (counting) queries++; return oq.apply(this, a); };
  }
});
afterAll(async () => { await storage?.close(); });

const uid = () => `k3-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`;
const pause = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function within<T>(p: Promise<T>, ms: number): Promise<{ v?: T; e?: string; timeout?: true; ms: number }> {
  const t0 = performance.now();
  const r = await Promise.race([
    p.then((v) => ({ v }), (e) => ({ e: `${e?.constructor?.name}: ${String(e?.message).slice(0, 120)}` })),
    pause(ms).then(() => ({ timeout: true as const })),
  ]);
  return { ...r, ms: Math.round(performance.now() - t0) };
}

for (const mode of ['args', 'call'] as const) {
  live(`R2-a7 (${mode}): the success write failing once does not leave the call stuck/busy for the life of the process`, async () => {
    const runId = uid();
    let execs = 0;
    const tool = {
      sideEffect: true, claimTtlMs: 1000,
      ...(mode === 'args' ? { idempotency: 'args' as const } : {}),
      recover: async () => ({ done: false as const }),
      execute: async () => { execs++; if (execs === 1) armed = '*'; return { ok: true }; },
    };
    const call = (id: string) => durableTool(tool as any, { journal: storage.runs, runId } as any, 'charge').execute!({ orderId: 'o1' }, { toolCallId: id } as any);
    const first = await within(call('c1'), 5000);
    armed = false;
    queries = 0; counting = true;
    const second = await within(call(mode === 'args' ? 'c2' : 'c1'), 5000);
    counting = false;
    const perSec = Math.round(queries / (second.ms / 1000));
    console.log(`[k3 R2-a7 ${mode}] first=${JSON.stringify(first)} second=${JSON.stringify(second)} execs=${execs} pgQueries/s=${perSec}`);
    expect(second.timeout).toBeUndefined();
    expect(second.e ?? '').not.toMatch(/RunBusyError/);
  }, 20_000);
}

live('S3 (must stay): a twin in THIS process meets an attempt that is really in flight past its TTL — it waits and gets the one answer', async () => {
  const runId = uid();
  let execs = 0;
  const tool = {
    sideEffect: true, claimTtlMs: 300, idempotency: 'args' as const,
    recover: async () => ({ done: false as const }),
    execute: async () => { execs++; await pause(1500); return { n: execs }; },
  };
  const call = (id: string) => durableTool(tool as any, { journal: storage.runs, runId } as any, 'charge').execute!({ orderId: 'o2' }, { toolCallId: id } as any);
  const p1 = call('c1');
  await pause(100);
  const p2 = call('c2');
  const [a, b] = await Promise.all([p1, p2]);
  console.log(`[k3 S3] a=${JSON.stringify(a)} b=${JSON.stringify(b)} execs=${execs}`);
  expect(execs).toBe(1);
  expect(b).toEqual(a);
}, 20_000);

live('S4: a run lock whose release failed once is not held for the life of this process', async () => {
  const key = uid();
  const a = await acquireRunLock(storage.runs, key, 'A', 400);
  expect(a).not.toBeNull();
  armed = 'putIfMatch';
  await a!.release(); // best effort: swallowed
  armed = false;
  const t0 = performance.now();
  let b = null;
  while (!b && performance.now() - t0 < 4000) { b = await acquireRunLock(storage.runs, key, 'B', 400); if (!b) await pause(100); }
  console.log(`[k3 S4] re-acquired=${!!b} after ${Math.round(performance.now() - t0)} ms`);
  expect(b).not.toBeNull();
  await b?.release();
}, 20_000);

live('S4b (must stay): a run lock held by a live handle in THIS process is not taken by a second acquire, past its TTL', async () => {
  const key = uid();
  const a = await acquireRunLock(storage.runs, key, 'A', 200);
  expect(a).not.toBeNull();
  await pause(600);
  const b = await acquireRunLock(storage.runs, key, 'B', 200);
  console.log(`[k3 S4b] second acquire while held: ${b ? 'TAKEN' : 'refused'}`);
  expect(b).toBeNull();
  await a!.release();
}, 20_000);
