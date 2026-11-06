// KNOWN GAP, pinned. `POST /agents/:name/run` answers from `gnl.run()`, which follows a DETACHED run
// (registry.ts `run`) and builds its result from the run's event log and steps. The replay ledger
// (`ctx.replayLog`) lives in the memory of the process that executes the run and is not journaled, so
// the follower has nothing to read: the response never carries `replayedToolCalls`, although the
// replay itself happened (exactly-once holds: `state.n` stays 1). Closing it needs the disclosure
// written to the journal at the replay point (durable-tool.ts), not a patch in the server.
// `it.fails` flips to a red test the day the field arrives, which is the moment the README caveat goes.
import { describe, it, expect } from 'vitest';
import { InMemoryJournal } from '@gnldev/durable';
import { createRestApi } from '../src/index.js';
import { call } from './call.js';
// @ts-expect-error — the durable package's own mock helper, shared by the sibling suites' fixtures
import { createMockModel, countToolResults, toolCallResult, finalTextResult } from '../../durable/test/mock.js';

const state = { n: 0 };
const tools = {
  ok: {
    description: 'order', sideEffect: true, idempotency: 'args' as const, idempotencyWindow: 'thread' as const,
    recover: async () => ({ done: false as const }),
    execute: async (args: unknown) => { state.n += 1; return { ok: true, order: args }; },
  },
};
const model = createMockModel(async ({ prompt }: any) =>
  countToolResults(prompt) === 0 ? toolCallResult('ok', 'c' + Math.random(), { sku: 'abc', qty: 2 }) : finalTextResult('done'));
const post = (api: any, path: string, body: unknown) =>
  call(api, path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });

describe('POST /agents/:name/run forwards replayedToolCalls', () => {
  it.fails('absent on fresh work, present when a repeat was answered from the journal', async () => {
    const api = createRestApi({ journal: new InMemoryJournal(), agents: { a: { model, tools, maxSteps: 4 } } }) as any;
    const first = await (await post(api, '/agents/a/run', { runId: 'r1', prompt: 'order', threadId: 'th' })).json();
    expect(first.replayedToolCalls).toBeUndefined();
    const second = await (await post(api, '/agents/a/run', { runId: 'r2', prompt: 'order', threadId: 'th' })).json();
    expect(state.n).toBe(1);
    expect(second.replayedToolCalls).toEqual([expect.objectContaining({ toolName: 'ok', origin: 'window' })]);
  });
});
