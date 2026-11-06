// K2 sibling scenarios (event consumer): the end of an attempt's hold reaches its handler.
//   E1  maxHoldMs: a handler that obeys its signal is told when its hold is up (`timeout`), and stops.
//   E2  the hold taken from under the handler (another poll's start after an expiry) → the handler's signal
//       aborts with a lease reason.
import { describe, it, expect, vi } from 'vitest';
import { InMemoryStorage } from '@gnldev/durable';
import { emit, createConsumer } from '../src/index.js';

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe('K2 siblings: event consumer hold', () => {
  it('E1 maxHoldMs: the handler is told its time is up', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const work = new InMemoryStorage().work!;
    await emit(work, 't', {}, { id: 'p' });
    const reasons: string[] = [];
    const c = createConsumer(work, 't', async (_p, meta: any) => {
      const signal: AbortSignal | undefined = meta.signal;
      await new Promise<void>((res, rej) => {
        const t = setTimeout(res, 2_000);
        signal?.addEventListener('abort', () => { clearTimeout(t); reasons.push(String(signal.reason?.message ?? signal.reason)); rej(signal.reason); }, { once: true });
      });
    }, { name: 'A', maxAttempts: 5, retryDelayMs: 0, leaseMs: 60, maxHoldMs: 150 });
    const t0 = Date.now();
    await c.poll();
    const ms = Date.now() - t0;
    console.log('[K2-E1]', JSON.stringify({ ms, reasons }));
    expect(reasons).toHaveLength(1);
    expect(reasons[0]).toMatch(/hold|time/i);
    expect(ms).toBeLessThan(1_500);
  });

  it('E2 the hold taken from under the handler: its signal aborts with a lease reason', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const work = new InMemoryStorage().work!;
    await emit(work, 't', {}, { id: 'p' });
    const reasons: string[] = [];
    let open!: () => void;
    const gate = new Promise<void>((r) => (open = r));
    const c = createConsumer(work, 't', async (_p, meta: any) => {
      const signal: AbortSignal | undefined = meta.signal;
      signal?.addEventListener('abort', () => reasons.push(String(signal.reason?.message ?? signal.reason)), { once: true });
      await gate;
    }, { name: 'A', retryDelayMs: 0, leaseMs: 90 });
    const running = c.poll();
    await sleep(20);
    // Another poll's start after an expiry: the attempt record is no longer the one this attempt holds.
    const key = 'evtatt:t:A:p';
    const cur = await work.get<any>(key);
    await work.put(key, { ...cur, n: cur.n + 1, nextAt: Date.now() + 10_000 });
    await sleep(150);
    open();
    await running;
    console.log('[K2-E2]', JSON.stringify({ reasons }));
    expect(reasons).toHaveLength(1);
    expect(reasons[0]).toMatch(/lease|lock|hold/i);
  });
});
