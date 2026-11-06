// K2 (decision 2a) for event consumers: a handler still running leaseMs after its hold was taken (or
// maxHoldMs ran out) did not observe its signal: one warning. One that stops in time: none.
import { describe, it, expect, vi, afterEach } from 'vitest';
import { InMemoryStorage } from '@gnldev/durable';
import { emit, createConsumer } from '../src/index.js';

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
afterEach(() => vi.restoreAllMocks());
const unheeded = (spy: ReturnType<typeof vi.spyOn>) => spy.mock.calls.map((c) => String(c[0])).filter((m) => /still running/.test(m));

async function lostHold(obey: boolean) {
  const spy = vi.spyOn(console, 'warn').mockImplementation(() => {});
  const work = new InMemoryStorage().work!;
  await emit(work, 't', {}, { id: 'p' });
  const c = createConsumer(work, 't', async (_p, meta: any) => {
    const signal: AbortSignal | undefined = meta.signal;
    await new Promise<void>((res) => {
      const t = setTimeout(res, 900);
      if (obey) signal?.addEventListener('abort', () => { clearTimeout(t); res(); }, { once: true });
    });
  }, { name: 'A', retryDelayMs: 0, leaseMs: 90 });
  const running = c.poll();
  await sleep(20);
  const key = 'evtatt:t:A:p';
  const cur = await work.get<any>(key);
  await work.put(key, { ...cur, n: cur.n + 1, nextAt: Date.now() + 10_000 });
  await running;
  return unheeded(spy);
}

describe('K2 2a: event consumer handler that ignores its signal', () => {
  it('hold taken, handler ignores the signal and runs on: one warning', async () => {
    const w = await lostHold(false);
    expect(w).toHaveLength(1);
    expect(w[0]).toMatch(/lease was lost/);
    // In the consumer's words: meta.signal, an idempotent handler — events has no ctx.run (nor ctx).
    expect(w[0]).toMatch(/meta\.signal may not be observed/);
    expect(w[0]).toMatch(/idempotent/);
    expect(w[0]).not.toMatch(/ctx\./);
  });
  it('hold taken, handler obeys the signal: no warning', async () => {
    expect(await lostHold(true)).toHaveLength(0);
  });
});
