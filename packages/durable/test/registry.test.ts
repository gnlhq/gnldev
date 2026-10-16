// 8.6 createGnl (registry/DI) + model('provider/model') router.
import { describe, it, expect } from 'vitest';
import { tool, stepCountIs } from 'ai';
import { z } from 'zod';
import { InMemoryJournal } from '../src/journal.js';
import { createGnl } from '../src/registry.js';
import { resolveModel } from '../src/model-router.js';
import { RunBusyError } from '../src/errors.js';
import { createMockModel, countToolResults, toolCallResult, finalTextResult } from './mock.js';

describe('createGnl + model router (8.6)', () => {
  it('registered agent runs durably', async () => {
    const journal = new InMemoryJournal();
    const gnl = createGnl({
      journal,
      agents: {
        support: { model: createMockModel(async () => finalTextResult('hello')), system: 'Be helpful' },
      },
    });
    const res = await gnl.run('support', { prompt: 'hi', runId: 's1' });
    expect(res.text).toBe('hello');
  });

  it('unknown agent -> error', async () => {
    const gnl = createGnl({ journal: new InMemoryJournal() });
    await expect(gnl.run('nope', { prompt: 'x', runId: 'r' })).rejects.toThrow('is not registered');
  });

  it('model router: provider/model parse + error paths', async () => {
    await expect(resolveModel('justmodel')).rejects.toThrow(/provider\/model/);
    await expect(resolveModel('bogus/x')).rejects.toThrow(/Unknown provider/);
  });

  // RunOptions.lock MUST be
  // forwarded to runDurable through gnl.run. If it isn't, two concurrent runs of the same runId emit
  // DIFFERENT toolCallIds (this test mimics that: call-A vs call-B) → the toolCallId-keyed claim lets
  // both through → DOUBLE side-effect. The lock serializes the run: only one runs, the other gets RunBusyError.
  it('concurrent calls for the same runId execute it ONCE: the second attaches (no lock option — design decision D2)', async () => {
    // The run lock is gone from the registry: one execution per run is what the executor's record gives
    // (detached.ts). Two registries over one store, distinct toolCallIds per model, no lock, a 'warn'
    // duplicate ladder (so the ladder cannot be what saves it): still one charge, and both calls answered.
    const journal = new InMemoryJournal();
    let charges = 0;
    const charge = tool({
      description: 'charge', inputSchema: z.object({}),
      execute: async () => { charges++; await new Promise((r) => setTimeout(r, 60)); return { ok: true }; },
    });
    const model = (id: string) => createMockModel(async ({ prompt }: any) =>
      countToolResults(prompt) === 0 ? toolCallResult('charge', `call-${id}`, {}) : finalTextResult('done'));
    const gnl = createGnl({ journal, agents: { pay: { model: model('A'), tools: { charge }, maxSteps: 4 } } });
    const gnlB = createGnl({ journal, agents: { pay: { model: model('B'), tools: { charge }, maxSteps: 4 } } });
    const limits = { sideEffectDuplicates: 'warn' };
    const settled = await Promise.allSettled([
      gnl.run('pay', { runId: 'race-1', prompt: 'x', limits } as any),
      gnlB.run('pay', { runId: 'race-1', prompt: 'x', limits } as any),
    ]);
    expect(settled.map((s) => s.status)).toEqual(['fulfilled', 'fulfilled']);
    expect(settled.map((s) => (s as PromiseFulfilledResult<any>).value.text)).toEqual(['done', 'done']);
    expect(charges).toBe(1);
  });

  it('a registry refuses the removed lock option by name', () => {
    const gnl = createGnl({ journal: new InMemoryJournal(), agents: { pay: { model: createMockModel(async () => finalTextResult('x')) } } });
    return expect(gnl.run('pay', { runId: 'r', prompt: 'x', lock: { owner: 'a', ttlMs: 1 } } as any)).rejects.toThrow(/lock/);
  });
});
