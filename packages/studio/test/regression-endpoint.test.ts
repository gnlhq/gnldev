// GET /runs/:id/regression/:otherId: the decision-point diff of two existing runs, read-only. Playing a
// run again with another model or prompt is the Lab's capsule (POST /lab/capsule), which writes nothing.
import { describe, it, expect } from 'vitest';
import { InMemoryJournal, runDurable } from '@gnldev/durable';
import { roleAuth } from '@gnldev/auth';
import { createStudioApi } from '../src/server.js';
import { call } from './call.js';

// A minimal LanguageModelV2 mock without depending on ai/test (and transitively msw) — same pattern as durable/test/mock.ts.
const usage = { inputTokens: 10, outputTokens: 5, totalTokens: 15 };
function mockModel(text: string) {
  return {
    specificationVersion: 'v2',
    provider: 'mock',
    modelId: 'mock-model',
    supportedUrls: {},
    doGenerate: async () => ({ content: [{ type: 'text', text }], finishReason: 'stop' as const, usage, warnings: [] as any[] }),
  };
}

describe('GET /runs/:id/regression/:otherId', () => {
  it('diffs two existing runs without re-running them', async () => {
    const journal = new InMemoryJournal();
    await runDurable({ runId: 'r1', journal, model: mockModel('same'), prompt: 'x' } as any);
    await runDurable({ runId: 'r2', journal, model: mockModel('same'), prompt: 'x' } as any);
    const app = createStudioApi({ reader: journal });

    const res = await call(app, '/runs/r1/regression/r2');
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.baseRunId).toBe('r1');
    expect(body.newRunId).toBe('r2');
    expect(body.diff.divergentAt).toBeUndefined();
  });

  it('unauthorized (no identity while auth is on) → 401', async () => {
    const journal = new InMemoryJournal();
    await runDurable({ runId: 'r3', journal, model: mockModel('a'), prompt: 'x' } as any);
    await runDurable({ runId: 'r4', journal, model: mockModel('a'), prompt: 'x' } as any);
    const app = createStudioApi({ reader: journal, auth: roleAuth({ admin: { token: 'adm' } }) });
    const res = await call(app, '/runs/r3/regression/r4');
    expect(res.status).toBe(401);
  });
});
