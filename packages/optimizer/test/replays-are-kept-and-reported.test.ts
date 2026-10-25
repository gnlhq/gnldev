// A replay's outcome is kept — per organization, through the reader Studio hands the optimizer — and the
// report reads it back: what was found, what was tried, what held. It recommends; it changes nothing.
import { describe, it, expect } from 'vitest';
import { tool } from 'ai';
import { z } from 'zod';
import { runDurable, gnlTool, InMemoryJournal, withOrg } from '@gnldev/durable';
import { PLATFORM_ADMIN_ROLE } from '@gnldev/auth';
import { createStudioApi } from '@gnldev/studio';
import { createMockModel } from '../../durable/test/mock.js';
import { studioOptimizer, renderReport, type ExperimentRecord, type AgentDiagnosis } from '../src/index.js';

const SECRET_WORDS = 'my card ends 4242, please refund';
const refund = gnlTool(tool({ description: 'Refund', inputSchema: z.object({ id: z.string() }), execute: async () => 'ok' }), { sideEffect: true });
function planned(modelId: string, id = 'a') {
  let step = 0;
  const m = createMockModel(async () => {
    step++;
    const usage = { inputTokens: 1200, outputTokens: 20 };
    const response = { modelId };
    return step % 2 === 1
      ? { content: [{ type: 'tool-call', toolCallId: `c${step}`, toolName: 'refund', input: JSON.stringify({ id }) }], finishReason: 'tool-calls', usage, response }
      : { content: [{ type: 'text', text: 'done' }], finishReason: 'stop', usage, response };
  });
  m.modelId = modelId;
  return m;
}
const pricing = { big: { inputPer1M: 10, outputPer1M: 40 }, small: { inputPer1M: 1, outputPer1M: 4 } };
const auth = {
  authenticate: (req: Request) => {
    const t = req.headers.get('authorization')?.replace('Bearer ', '');
    if (t === 'acme' || t === 'globex') return { kind: 'operator', roles: ['admin'], id: `u-${t}`, orgId: t };
    if (t === 'ops') return { kind: 'operator', roles: ['admin', PLATFORM_ADMIN_ROLE], id: 'u-ops' };
    return null;
  },
  authorize: () => ({ allow: true }),
  capabilities: () => ({ sso: false, rbac: false, audit: false, multiOrganization: false, users: false }),
};

async function studio() {
  const journal = new InMemoryJournal();
  for (const org of ['acme', 'globex']) {
    await runDurable({ runId: 'r1', journal: withOrg(journal, org) as any, prompt: SECRET_WORDS, model: planned('big'), tools: { refund }, agentName: 'support' } as any);
  }
  const app = createStudioApi({
    reader: journal, auth: auth as any,
    optimizer: studioOptimizer({ config: { agents: { support: { tools: { refund } } } }, models: { 'small/model': planned('small') }, pricing }),
  });
  const as = (who: string) => (path: string, init: RequestInit = {}) =>
    (app as any)(new Request(`http://studio${path}`, { ...init, headers: { authorization: `Bearer ${who}`, 'content-type': 'application/json', ...(init.headers ?? {}) } }));
  return { journal, acme: as('acme'), globex: as('globex') };
}

describe('replays are kept, per organization, and reported', () => {
  it("acme's replay is in acme's history and report, not globex's; no conversation text is kept", async () => {
    const { journal, acme, globex } = await studio();
    const res = await acme('/optimizer/replay', { method: 'POST', body: JSON.stringify({ agent: 'support', model: 'small/model', limit: 5 }) });
    expect(res.status).toBe(200);
    const mine = (await (await acme('/optimizer/history?agent=support')).json()).items as ExperimentRecord[];
    expect(mine).toHaveLength(1);
    expect(mine[0]).toMatchObject({ agent: 'support', model: 'small/model', limit: 5, runs: [{ runId: 'r1', missed: 0, reordered: false }] });
    expect(mine[0]!.summary).toMatchObject({ replayed: 1, diverged: 0 });
    expect((await (await globex('/optimizer/history?agent=support')).json()).items).toEqual([]);
    const keys = await journal.listKeys!('org:acme:__optimizer__:exp:');
    expect(keys).toHaveLength(1);
    expect(JSON.stringify(await journal.get(keys[0]!))).not.toContain('4242');
    const report = (await (await acme('/optimizer/report?agent=support')).json()).markdown as string;
    expect(report).toMatch(/^# Cost report — support/);
    expect(report).toContain('| small/model | 1 | 0 (0%) | 0 | 10% |');
    expect(report).toMatch(/\*\*small\/model\*\* did the same work as the recorded runs in every one of 1 replayed run, at 10% of the recorded cost/);
    expect((await (await globex('/optimizer/report?agent=support')).json()).markdown).toContain('None yet.');
  });
});

describe('the recommendation', () => {
  const diagnosis = {
    agent: 'support', runs: 3, modelSteps: 6, costUsd: 0.07, inputTokens: 7200, outputTokens: 120, cachedTokens: 0, cacheWriteTokens: 0,
    byModel: { big: { steps: 6, costUsd: 0.07 } },
    repeatedPrefix: { tokens: 3600, uncachedTokens: 3600, cacheableUncachedTokens: 3600, share: 0.5, medianOpening: 1200 },
    sharedInstructions: { estimatedTokens: 0, cacheableUncachedTokens: 0, runs: 0, share: 0 },
    oldToolOutput: { estimatedTokens: 0, share: 0, keepLast: 2 }, findings: [], notes: [],
  } as AgentDiagnosis;
  const exp = (model: string, diverged: number, costRatio: number): ExperimentRecord => ({
    v: 1, at: Date.UTC(2026, 9, 24, 12), agent: 'support', model, limit: 10, runs: [], errors: [],
    summary: { replayed: 10, diverged, divergenceRate: diverged / 10, missedCallRuns: 0, reorderedRuns: 0, recordedCostUsd: 1, candidateCostUsd: costRatio, costRatio, recordedTokens: 1, candidateTokens: 1, priced: true },
  });

  it('a candidate that diverged is not recommended: keep the current setting', () => {
    const md = renderReport({ agent: 'support', diagnosis, experiments: [exp('small', 2, 0.1)] });
    expect(md).toContain('No candidate has yet done the same work on every replayed run');
  });

  it('of the clean candidates, the cheapest is named, with how many runs back it', () => {
    const md = renderReport({ agent: 'support', diagnosis, experiments: [exp('mid', 0, 0.4), exp('small', 0, 0.1), exp('tiny', 1, 0.02)] });
    expect(md).toContain('**small** did the same work as the recorded runs in every one of 10 replayed runs, at 10% of the recorded cost');
    expect(md).toContain('change the agent\'s model in your code');
  });

  it('an unpriced clean candidate is named, and the report says its saving is not known', () => {
    const unpriced = { ...exp('small', 0, NaN), summary: { ...exp('small', 0, NaN).summary, priced: false, costRatio: NaN, candidateTokens: 4571, recordedTokens: 4576 } };
    const md = renderReport({ agent: 'support', diagnosis, experiments: [unpriced] });
    expect(md).toContain('**small** did the same work as the recorded runs in every one of 10 replayed runs.');
    expect(md).toContain('What it would save is not known');
    expect(md).toContain('It used 4,571 tokens where the recorded runs used 4,576');
  });

  it('nothing tried yet: run a replay before changing anything', () => {
    expect(renderReport({ agent: 'support', diagnosis, experiments: [] })).toContain('Run a replay with a cheaper model before changing anything.');
  });
});
