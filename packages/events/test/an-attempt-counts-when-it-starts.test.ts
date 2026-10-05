// An attempt is counted when it starts, and the event is held while it runs.
//
// Measured before: an event whose handler took its process down (simulated: a handler that never
// returns, then a fresh consumer of the same name) was started 10 times under maxAttempts 3 and never
// quarantined. Counting at the start alone, as the queue does, was measured too and was wrong here — events
// has no per-delivery lock, so a second process took a running event for a dead one (29 of 30 false "did
// not finish" records). The hold lives in the attempt record's `nextAt`, renewed by a heartbeat.
import { describe, it, expect, vi, afterEach } from 'vitest';
import { InMemoryStorage } from '@gnldev/durable';
import { emit, createConsumer, listDeadEvents } from '../src/index.js';

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const never = () => new Promise<void>(() => {});
afterEach(() => vi.restoreAllMocks());

describe('an attempt counts when it starts', () => {
  it('an event whose process dies while it runs is quarantined after maxAttempts starts', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const work = new InMemoryStorage().work!;
    await emit(work, 't', {}, { id: 'p' });
    let starts = 0;
    // Each loop is a fresh process. Once its handler starts the process is gone: the handler never
    // returns and every store call it would make fails, its heartbeat's included, so its hold runs out.
    for (let i = 0; i < 6; i++) {
      let dead = false;
      const view = new Proxy(work, { get(t: any, k) {
        const v = t[k];
        return typeof v === 'function' ? (...a: unknown[]) => (dead ? Promise.reject(new Error('process gone')) : v.apply(t, a)) : v;
      } });
      const c = createConsumer(view, 't', () => { starts++; dead = true; return never(); }, { name: 'A', maxAttempts: 3, retryDelayMs: 0, leaseMs: 40 });
      void c.poll().catch(() => {});
      await sleep(70);
    }
    expect(starts).toBe(3);
    const [dead] = await listDeadEvents(work, 't', 'A');
    expect(dead).toMatchObject({ status: 'quarantined', attempts: 3 });
    expect(String(dead!.error)).toMatch(/did not finish in 3 attempts/);
  });

  it('while one process runs the event, another under the same name does not start it', async () => {
    const work = new InMemoryStorage().work!;
    await emit(work, 't', {}, { id: 'p' });
    let starts = 0;
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const mk = () => createConsumer(work, 't', async () => { starts++; await gate; }, { name: 'A', retryDelayMs: 0, leaseMs: 60 });
    const a = mk(), b = mk();
    const running = a.poll();
    await sleep(10);
    for (let i = 0; i < 5; i++) { expect(await b.poll()).toBe(0); await sleep(30); } // 150 ms: past leaseMs, renewed
    release();
    expect(await running).toBe(1);
    expect(starts).toBe(1);
  });

  it('maxHoldMs: a handler that hangs in a live process is eventually quarantined', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const work = new InMemoryStorage().work!;
    await emit(work, 't', {}, { id: 'p' });
    let starts = 0;
    const c = createConsumer(work, 't', () => { starts++; return never(); }, { name: 'A', maxAttempts: 3, retryDelayMs: 0, leaseMs: 40, maxHoldMs: 80 });
    for (let i = 0; i < 30; i++) { void c.poll(); await sleep(40); }
    expect(starts).toBe(3);
    expect((await listDeadEvents(work, 't', 'A'))[0]).toMatchObject({ status: 'quarantined', attempts: 3 });
  });

  it('a successful delivery shows one attempt; a failure then a success shows two', async () => {
    const work = new InMemoryStorage().work!;
    await emit(work, 't', {}, { id: 'ok' });
    await emit(work, 't', {}, { id: 'flaky' });
    let n = 0;
    const c = createConsumer(work, 't', (_p, ctx) => { if (ctx.id === 'flaky' && n++ === 0) throw new Error('once'); }, { name: 'A', retryDelayMs: 0 });
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    await c.poll(); await c.poll();
    expect(await work.get<any>('evtatt:t:A:ok')).toMatchObject({ n: 1 });
    expect(await work.get<any>('evtatt:t:A:flaky')).toMatchObject({ n: 2 });
  });

  it('leaseMs and maxHoldMs must be positive numbers; leaseMs finite', () => {
    const work = new InMemoryStorage().work!;
    for (const bad of [{ leaseMs: 0 }, { leaseMs: -1 }, { leaseMs: Infinity }, { maxHoldMs: 0 }, { leaseMs: '5' as any }]) {
      expect(() => createConsumer(work, 't', () => {}, { name: 'A', ...bad }), JSON.stringify(bad)).toThrow(/must be/);
    }
  });
});
