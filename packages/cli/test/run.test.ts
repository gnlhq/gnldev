// gnl run: getRunCore (pure).
import { describe, it, expect } from 'vitest';
import * as Durable from '@gnldev/durable';
import { InMemoryJournal, runDurable } from '@gnldev/durable';
import { getRunCore } from '../src/commands/run.js';
import { agentModel } from './helpers.js';

describe('getRunCore', () => {
  it('returns summary/cost/state for a completed run', async () => {
    const journal = new InMemoryJournal();
    await runDurable({
      runId: 'r1',
      journal,
      model: agentModel('t', 'c1', { x: 1 }, 'done'),
      tools: { t: { execute: async () => ({ ok: true }) } },
      prompt: 'go',
    });
    const timeline = await getRunCore({ journal } as any, Durable, 'r1');
    expect(timeline.summary.status).toBe('completed');
    expect(timeline.summary.modelSteps).toBe(2);
    expect(timeline.summary.toolCalls).toBe(1);
    expect(timeline.cost.modelCalls).toBe(2);
    expect(timeline.state.messages.length).toBeGreaterThan(0);
    expect(timeline.entries.length).toBeGreaterThan(0);
  });

  it('throws a clear error for a runId with no trace', async () => {
    await expect(getRunCore({ journal: new InMemoryJournal() } as any, Durable, 'ghost')).rejects.toThrow(/run not found/);
  });

  it('opens a run that is recorded with no steps (its first model call was refused) — by its outcome', async () => {
    const journal = new InMemoryJournal();
    const refused: any = { specificationVersion: 'v2', provider: 'mock', modelId: 'm', supportedUrls: {}, doGenerate: async () => { throw Object.assign(new Error('Not Found'), { statusCode: 404 }); } };
    await runDurable({ runId: 'zero', journal, model: refused, prompt: 'go' }).catch(() => {});
    expect(await journal.readRun('zero')).toHaveLength(0);
    const timeline = await getRunCore({ journal } as any, Durable, 'zero');
    expect(timeline.summary.status).toBe('failed');
    expect(timeline.summary.modelSteps).toBe(0);
    expect(timeline.outcome).toMatchObject({ status: 'failed', error: 'Not Found', errorStatus: 404 });
  });
});
