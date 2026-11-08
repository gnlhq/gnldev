// KARAR 7/7 (B): the actor lock stands aside in the engine for an AUTHORISED answerer who brings only `approvals`
// (nothing, or the recorded content); new content under the same runId, and an end user on somebody else's run,
// meet the lock as before.
import { describe, it, expect, beforeAll, vi } from 'vitest';
import { z } from 'zod';
import { InMemoryStorage, createGnl, STAFF } from '../src/index.js';
import { createMockModel, toolCallResult, finalTextResult, countToolResults } from './mock.js';

beforeAll(() => { vi.spyOn(console, 'warn').mockImplementation(() => {}); });

function setup() {
  const effects = { n: 0 };
  const gnl = createGnl({ storage: new InMemoryStorage(), agents: { a: {
    model: createMockModel(async ({ prompt }: any) => (countToolResults(prompt) === 0 ? toolCallResult('refund', 'c1', { amount: 1 }) : finalTextResult('done'))),
    tools: { refund: { description: 'r', inputSchema: z.object({ amount: z.number() }), execute: async () => { effects.n++; return { ok: true }; } } },
    guard: () => ({ action: 'approve' }),
  } } } as never);
  const start = async () => {
    const r: any = await gnl.run('a', { runId: 'r', prompt: 'refund', resourceId: 'u-ayse', actor: 'u-ayse' } as never);
    return r.interrupts[0].toolCallId as string;
  };
  return { gnl, effects, start };
}
const settle = <T>(p: Promise<T>) => p.then((r) => ({ ok: true as const, r }), (e: any) => ({ ok: false as const, e }));

describe('the actor lock and the authorised answer', () => {
  it('staff with approvals only (no content, or the recorded content) continues the user\'s run', async () => {
    for (const body of [{}, { prompt: 'refund' }]) {
      const s = setup(); const id = await s.start();
      const out = await settle(s.gnl.run('a', { runId: 'r', caller: STAFF, actor: 'operator:veli', approvals: { [id]: true }, ...body } as never));
      expect(out.ok, String((out as any).e)).toBe(true);
      expect(s.effects.n).toBe(1);
    }
  });
  it('staff with approvals AND new content under the same runId: the lock still refuses (409 run_actor_mismatch)', async () => {
    const s = setup(); const id = await s.start();
    const out: any = await settle(s.gnl.run('a', { runId: 'r', caller: STAFF, actor: 'operator:veli', prompt: 'something else entirely', approvals: { [id]: true } } as never));
    expect(out.ok).toBe(false);
    expect(out.e.name).toBe('RunActorMismatchError');
    expect(out.e.code ?? 'run_actor_mismatch').toBeDefined();
    expect(s.effects.n).toBe(0);
  });
  it('an end user on somebody else\'s run is still refused', async () => {
    const s = setup(); const id = await s.start();
    const out: any = await settle(s.gnl.run('a', { runId: 'r', resourceId: 'u-mallory', actor: 'u-mallory', approvals: { [id]: true } } as never));
    expect(out.ok).toBe(false);
    expect(['RunActorMismatchError', 'RunOwnerMismatchError']).toContain(out.e.name);
    expect(s.effects.n).toBe(0);
  });
});
