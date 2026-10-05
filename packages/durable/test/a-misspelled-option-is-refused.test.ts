// Every options object @gnldev/durable reads refuses a name it does not take (@gnldev/options), naming
// the option it is closest to. Measured before, with a tool the model calls three times:
//   agent `gaurd` (a guard that denies)      → the tool ran 3 times; spelled right, 0
//   run `limits.maxToolCall: 1`               → 3 times; spelled right, 1 and the run stopped
//   run `limitz`                              → 3 times
// and `gnlTool(t, { sideEfect: true })` declared a side-effecting tool as having none.
//
// runDurable / streamDurable pass the AI SDK's options on to generateText / streamText: there a name is
// refused only as a misspelling of a known one, so an option a newer AI SDK adds still passes.
import { describe, it, expect } from 'vitest';
import { z } from 'zod';
import { stepCountIs } from 'ai';
import {
  InMemoryJournal, InMemoryStorage, createGnl, runDurable, resumeRun, gnlTool, sweepRuns, sweepLog, sweepThreads,
  createRetentionSweeper, purgeResource, eraseSubject, withIdempotency, releaseFailedClaim, createPollLoop, policyGuard,
  rolloverRun, cancelAgentRun, composite, getRunCost, assertBudget, isBudgetExceeded, createAgentTool, createSuggestions,
  describeProtections, formatProtections, listLog, readIdemLedger, readMetricsSummary, withSubjectJournal, ProcessorRetry, createBatch,
  validateJudgeConfig,
} from '../src/index.js';
import { RedisStorage } from '../src/redis-storage.js';
import { PostgresStorage } from '../src/postgres-storage.js';
import { toolCallingModel } from '../src/mock-model.js';
import { createMockModel, toolCallResult, finalTextResult, countToolResults } from './mock.js';

const usage = { inputTokens: 1, outputTokens: 1, totalTokens: 2 };
let toolRuns = 0;
const thrice: any = { specificationVersion: 'v2', provider: 'm', modelId: 'm', supportedUrls: {},
  doGenerate: async ({ prompt }: any) => prompt.filter((m: any) => m.role === 'tool').length >= 3
    ? { content: [{ type: 'text', text: 'done' }], finishReason: 'stop', usage, warnings: [] }
    : { content: [{ type: 'tool-call', toolCallId: `c${prompt.length}`, toolName: 't', input: JSON.stringify({ n: prompt.length }) }], finishReason: 'tool-calls', usage, warnings: [] } };
const t = { description: 't', inputSchema: z.object({ n: z.number() }), execute: async () => { toolRuns++; return { ok: true }; } };
const deny = async () => ({ action: 'deny' as const, reason: 'no' });
const cfg = (agent: object = {}): any => ({ storage: new InMemoryStorage(), agents: { a: { model: thrice, tools: { t }, ...agent } } });

describe('the measured holes, spelled right and misspelled', () => {
  it('an agent\'s guard', async () => {
    toolRuns = 0;
    await createGnl(cfg({ guard: deny })).run('a', { runId: 'g', prompt: 'go' });
    expect(toolRuns).toBe(0);
    expect(() => createGnl(cfg({ gaurd: deny }))).toThrow(/createGnl: agents\.a: `gaurd` is not an option — did you mean `guard`\?/);
  });

  it('a run\'s limits, and a name inside them', async () => {
    toolRuns = 0;
    await expect(createGnl(cfg()).run('a', { runId: 'l', prompt: 'go', limits: { maxToolCalls: 1 } })).rejects.toThrow(/maxToolCalls limit/);
    expect(toolRuns).toBe(1);
    await expect(createGnl(cfg()).run('a', { runId: 'l2', prompt: 'go', limits: { maxToolCall: 1 } } as any)).rejects.toThrow(/run\('a'\): limits: `maxToolCall` .* did you mean `maxToolCalls`\?/);
    await expect(createGnl(cfg()).run('a', { runId: 'l3', prompt: 'go', limitz: { maxToolCalls: 1 } } as any)).rejects.toThrow(/run\('a'\): `limitz` .* did you mean `limits`\?/);
    await expect(createGnl(cfg()).run('a', { runId: 'l4', prompt: 'go', limits: { loopDetection: { maxRepeat: 2 } } } as any)).rejects.toThrow(/limits\.loopDetection: `maxRepeat`/);
    expect(toolRuns).toBe(1);
  });

  it('a tool\'s durability', () => {
    expect(() => gnlTool(t, { sideEfect: true } as any)).toThrow(/gnlTool: `sideEfect` .* did you mean `sideEffect`\?/);
    expect(() => gnlTool(t, { sideEffect: true, semanticIdentity: { key: ['a'] } } as any)).toThrow(/gnlTool: semanticIdentity: `key` .* did you mean `keys`\?/);
    expect(() => gnlTool(t, { sideEffect: true, idempotent: true })).not.toThrow();
  });
});

describe('a project file handed to createGnl whole', () => {
  it('takes the names gnl.config carries for gnl dev and the doors, and still refuses a misspelled one', () => {
    // What the scaffold's src/app.ts does: `createGnl(raw)` with raw = gnl.config.ts.
    expect(() => createGnl({ ...cfg(), studio: true, title: 'app', surfaces: [], port: 3000 } as any)).not.toThrow();
    expect(() => createGnl({ ...cfg(), stuido: true } as any)).toThrow(/createGnl: `stuido` .* did you mean `studio`\?/);
  });
});

describe('runDurable passes the AI SDK\'s options on', () => {
  const run = (extra: object) => runDurable({ journal: new InMemoryJournal(), runId: `d${Math.random()}`, model: thrice, tools: { t }, prompt: 'go', stopWhen: stepCountIs(5), ...extra } as any);
  it('refuses a misspelling of its own option or of the AI SDK\'s', async () => {
    await expect(run({ gaurd: deny })).rejects.toThrow(/runDurable: `gaurd` .* did you mean `guard`\?/);
    await expect(run({ temprature: 0 })).rejects.toThrow(/runDurable: `temprature` .* did you mean `temperature`\?/);
  });
  it('passes a name close to none — an option a newer AI SDK added', async () => {
    await expect(run({ experimental_somethingNew: true })).resolves.toBeDefined();
  });
  it('resumeRun holds its own names', async () => {
    await expect(resumeRun('x', { journal: new InMemoryJournal(), model: thrice, aprovals: {} } as any)).rejects.toThrow(/resumeRun: `aprovals` .* did you mean `approvals`\?/);
  });
});

describe('every other option bag the package reads', () => {
  const j = () => new InMemoryJournal() as any;
  const s = () => new InMemoryStorage() as any;
  it.each([
    ['sweepRuns', () => sweepRuns(j(), { olderThan: 1 } as any), /sweepRuns: `olderThan` .* `olderThanMs`/],
    ['sweepLog', () => sweepLog(j(), 'ns', { olderThan: 1 } as any), /sweepLog: `olderThan`/],
    ['sweepThreads', () => sweepThreads(j(), { olderThan: 1 } as any), /sweepThreads: `olderThan`/],
    ['createRetentionSweeper', () => createRetentionSweeper(j(), { sweep: { olderThanMs: 1 }, intervalMS: 5 } as any), /createRetentionSweeper: `intervalMS` .* `intervalMs`/],
    ['createRetentionSweeper sweep', () => createRetentionSweeper(j(), { sweep: { olderThan: 1 } } as any), /createRetentionSweeper: sweep: `olderThan`/],
    ['purgeResource', () => purgeResource(j(), 'u', { vector: {} } as any), /purgeResource: `vector` .* `vectors`/],
    ['eraseSubject', () => eraseSubject(s(), 'u', { orgID: 'a' } as any), /eraseSubject: `orgID` .* `orgId`/],
    ['withIdempotency', () => withIdempotency({}, { journal: j(), windows: 1 } as any), /withIdempotency: `windows` .* `window`/],
    ['releaseFailedClaim', () => releaseFailedClaim(j(), { toolName: 't', args: {}, threadID: 'x' } as any), /releaseFailedClaim: `threadID` .* `threadId`/],
    ['createPollLoop', () => createPollLoop(async () => false, { pollMS: 5 } as any), /createPollLoop: `pollMS` .* `pollMs`/],
    ['policyGuard', () => policyGuard(j(), { fallbak: 'deny' } as any), /policyGuard: `fallbak` .* `fallback`/],
    ['rolloverRun', () => rolloverRun(j(), 'r', { newRunID: 'n' } as any), /rolloverRun: `newRunID` .* `newRunId`/],
    ['cancelAgentRun', () => cancelAgentRun(j(), 'r', { reasons: 'x' } as any), /cancelAgentRun: `reasons` .* `reason`/],
    ['composite', () => composite({ default: s(), override: {} } as any), /composite: `override` .* `overrides`/],
    ['getRunCost', () => getRunCost(j(), 'r', { modelID: 'm' } as any), /getRunCost: `modelID` .* `modelId`/],
    ['assertBudget', () => assertBudget(j(), { fallback: { usdLimt: 1 } } as any), /assertBudget: fallback: `usdLimt` .* `usdLimit`/],
    ['isBudgetExceeded', () => isBudgetExceeded({ usd: 0, tokens: 0, runs: 0 } as any, { tokenLimt: 1 } as any), /isBudgetExceeded: `tokenLimt` .* `tokenLimit`/],
    ['createAgentTool', () => createAgentTool({ journal: j(), model: thrice, maxStep: 2 } as any), /createAgentTool: `maxStep` .* `maxSteps`/],
    ['createAgentTool limits', () => createAgentTool({ journal: j(), model: thrice, limits: { maxCostUSD: 1 } } as any), /createAgentTool: limits: `maxCostUSD` .* `maxCostUsd`/],
    ['createSuggestions', () => createSuggestions(j(), { generate: false, apply: false, maxInjects: 1 } as any), /suggestions: `maxInjects` .* `maxInject`/],
    ['describeProtections', () => describeProtections(cfg(), { devonly: true } as any), /describeProtections: `devonly` .* `devOnly`/],
    ['formatProtections', () => formatProtections([], { titel: 'x' } as any), /formatProtections: `titel` .* `title`/],
    ['listLog', () => listLog(j(), 'ns', { limt: 1 } as any), /listLog: `limt` .* `limit`/],
    ['readIdemLedger', () => readIdemLedger(j(), { runID: 'r' } as any), /readIdemLedger: `runID` .* `runId`/],
    ['readMetricsSummary', () => readMetricsSummary(j(), { day: 1 } as any), /readMetricsSummary: `day` .* `days`/],
    ['withSubjectJournal', () => withSubjectJournal(j(), 'u', { roots: true } as any), /withSubjectJournal: `roots` .* `root`/],
    ['createBatch', () => createBatch(j(), { tool: t, itemkey: () => 'k' } as any), /createBatch: `itemkey` .* did you mean `itemKey`\?/],
    ['createAgentTool opts', () => createAgentTool({ journal: j(), model: thrice }, { descripton: 'x' } as any), /createAgentTool: `descripton` .* did you mean `description`\?/],
    ['run exclusiveModelStep', () => createGnl(cfg()).run('a', { runId: 'x', prompt: 'go', exclusiveModelStep: { ttlMS: 5 } } as any), /exclusiveModelStep: `ttlMS` .* did you mean `ttlMs`\?/],
    ['validateJudgeConfig', () => validateJudgeConfig({ complete: async () => '', judgeModelID: 'm' } as any), /validateJudgeConfig: `judgeModelID` .* did you mean `judgeModelId`\?/],
    ['describeProtections config', () => describeProtections({ ...cfg(), presett: 'critical' } as any), /describeProtections: `presett` .* did you mean `preset`\?/],
    ['adoptIntoOrg', () => s().adoptIntoOrg('acme', { dryrun: true } as any), /adoptIntoOrg: `dryrun` .* did you mean `dryRun`\?/],
    ['listKeys', () => j().listKeys('p', { limt: 1 } as any), /listKeys: `limt` .* did you mean `limit`\?/],
    ['listStaleRuns', () => j().listStaleRuns(0, { includeSuspend: true } as any), /listStaleRuns: `includeSuspend`/],
    ['ProcessorRetry', () => new ProcessorRetry('f', 'p', { maxRetry: 1 } as any), /ProcessorRetry: `maxRetry` .* `maxRetries`/],
    ['RedisStorage', () => new RedisStorage({ keyprefix: 'x' } as any), /RedisStorage: `keyprefix` .* `keyPrefix`/],
    ['PostgresStorage', () => new PostgresStorage({ connectionstring: 'x' } as any), /PostgresStorage: `connectionstring` .* `connectionString`/],
    ['toolCallingModel', () => toolCallingModel({ toolname: 'x' } as any), /toolCallingModel: `toolname` .* `toolName`/],
    ['runWorkflow', () => createGnl({ storage: s(), workflows: { w: {} as any } }).runWorkflow('w', {}, { runID: 'r' } as any), /runWorkflow\('w'\): `runID` .* `runId`/],
  ])('%s', async (_n, build, message) => {
    await expect((async () => build())()).rejects.toThrow(message);
  });
});
