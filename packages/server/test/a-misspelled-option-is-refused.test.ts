// createRestApi refuses a name it does not take, in its options and in every bag inside them
// (@gnldev/options), and every limit the server sets reaches the run. Measured before:
//   a deny-all `auth` written `ath`              → 200, the model ran (403 spelled right)
//   `org.required` written `requried`            → 200 with no organization (400 spelled right)
//   `limits.maxToolCalls: 1` written `maxToolCall` → the tool ran 3 times (422 spelled right)
//   `cors.origins` written `origin`              → "Cannot read properties of undefined"
//   five server limits, spelled right            → only `{"maxToolCalls":5}` frozen on the run
// A request's own `limits` may only tighten the four numbers; any other name is refused with 400
// instead of being dropped.
import { describe, it, expect } from 'vitest';
import { z } from 'zod';
import { InMemoryStorage, createGnl } from '@gnldev/durable';
import { createRestApi, pipeAgentStream } from '../src/index.js';

const usage = { inputTokens: 1, outputTokens: 1, totalTokens: 2 };
let toolRuns = 0;
const thrice: any = { specificationVersion: 'v2', provider: 'm', modelId: 'm', supportedUrls: {},
  doGenerate: async ({ prompt }: any) => prompt.filter((m: any) => m.role === 'tool').length >= 3
    ? { content: [{ type: 'text', text: 'done' }], finishReason: 'stop', usage, warnings: [] }
    : { content: [{ type: 'tool-call', toolCallId: `c${prompt.length}`, toolName: 't', input: JSON.stringify({ n: prompt.length }) }], finishReason: 'tool-calls', usage, warnings: [] } };
const t = { description: 't', inputSchema: z.object({ n: z.number() }), execute: async () => { toolRuns++; return { ok: true }; } };
const cfg = (): any => ({ storage: new InMemoryStorage(), agents: { a: { model: thrice, tools: { t } } } });
const open = { allowOpenAccess: true, protectionsBanner: false } as const;
const run = (api: any, body: object = {}, headers: Record<string, string> = {}) =>
  api(new Request('http://x/agents/a/run', { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify({ runId: `r${Math.random()}`, prompt: 'go', ...body }) }));

describe('createRestApi: a misspelled option is refused when the API is built', () => {
  it.each([
    ['auth', { ath: {} }, /createRestApi: `ath` is not an option — did you mean `auth`\?/],
    ['allowOpenAccess', { allowOpenAcess: true }, /`allowOpenAcess` .* did you mean `allowOpenAccess`\?/],
    ['org.required', { ...open, org: { resolve: () => undefined, requried: true } }, /createRestApi: org: `requried` .* did you mean `required`\?/],
    ['limits.maxToolCalls', { ...open, limits: { maxToolCall: 1 } }, /createRestApi: limits: `maxToolCall` .* did you mean `maxToolCalls`\?/],
    ['cors.origins', { ...open, cors: { origin: ['http://a'] } }, /createRestApi: cors: `origin` .* did you mean `origins`\?/],
    ['budgets.default', { ...open, budgets: { default: { usdLimt: 1 } } }, /createRestApi: budgets\.default: `usdLimt` .* did you mean `usdLimit`\?/],
    ['budgets.perOrg', { ...open, budgets: { perOrg: { acme: { tokenLimt: 1 } } } }, /budgets\.perOrg\.acme: `tokenLimt`/],
    ['an engine name in the config', null, /createGnl: agents\.a: `gaurd` .* did you mean `guard`\?/],
  ])('%s', (_n, opts, message) => {
    if (opts === null) expect(() => createRestApi({ ...cfg(), agents: { a: { model: thrice, gaurd: () => ({ action: 'deny' }) } } } as any, open)).toThrow(message);
    else expect(() => createRestApi(cfg(), opts as any)).toThrow(message);
  });

  it('spelled right, the same options hold', async () => {
    expect((await run(createRestApi(cfg(), { ...open, org: { resolve: (r: Request) => r.headers.get('x-gnl-org') ?? undefined, required: true } }))).status).toBe(400);
    toolRuns = 0;
    expect((await run(createRestApi(cfg(), { ...open, limits: { maxToolCalls: 1 } }))).status).toBe(422);
    expect(toolRuns).toBe(1);
  });

  it('a project config carrying its door options (gnl dev) still builds', () => {
    expect(() => createRestApi({ ...cfg(), title: 'app', surfaces: [] } as any, open)).not.toThrow();
  });
});

describe('every limit the server sets reaches the run', () => {
  it('the five of them, frozen as given', async () => {
    const c = cfg();
    const api = createRestApi(c, { ...open, limits: { maxToolCalls: 5, taintedSideEffects: 'block', sideEffectDuplicates: 'block', approvalScope: 'attempt', strict: true, loopDetection: { maxRepeats: 4, onRepeat: 'reflect' } } });
    await (await run(api, { runId: 'r1' })).text();
    expect(await c.storage.runs.get('r1:cfg:limits')).toEqual({
      maxToolCalls: 5, taintedSideEffects: 'block', sideEffectDuplicates: 'block', approvalScope: 'attempt', strict: true, loopDetection: { maxRepeats: 4, onRepeat: 'reflect' },
    });
  });

  it('a request tightens a number, never loosens it, and cannot set the rest', async () => {
    const c = cfg();
    const api = createRestApi(c, { ...open, limits: { maxToolCalls: 5, taintedSideEffects: 'block' } });
    await (await run(api, { runId: 'r2', limits: { maxToolCalls: 9, maxTokens: 100 } })).text();
    expect(await c.storage.runs.get('r2:cfg:limits')).toEqual({ maxToolCalls: 5, maxTokens: 100, taintedSideEffects: 'block' });
    const own = await run(api, { limits: { taintedSideEffects: 'off' } });
    expect(own.status).toBe(400);
    expect((await own.json()).error).toMatch(/`limits\.taintedSideEffects` is the server's to set/);
    const typo = await run(api, { limits: { maxToolCall: 1 } });
    expect(typo.status).toBe(400);
    expect((await typo.json()).error).toMatch(/`limits\.maxToolCall` is not a limit/);
    expect((await run(api, { limits: { loopDetection: { onRepeat: 'reflect' } } })).status).toBe(400);
  });
});

it('pipeAgentStream refuses a misspelled option', () => {
  expect(() => pipeAgentStream({} as any, 'r', {}, { lastEventID: 1 } as any)).toThrow(/pipeAgentStream: `lastEventID` .* did you mean `lastEventId`\?/);
});

it('the engine built from the same config refuses the same way, and takes the project file\'s names', () => {
  expect(() => createGnl({ ...cfg(), titel: 'x' })).toThrow(/createGnl: `titel` .* did you mean `title`\?/);
  expect(() => createGnl({ ...cfg(), title: 'x' })).not.toThrow();
});
