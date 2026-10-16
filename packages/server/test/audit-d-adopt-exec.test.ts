// Audit D (red): a run waiting on a human (approval) when the deployment is adopted into an
// organization (`storage.adoptIntoOrg`).
//
// Its outcome record says `running` while it waits, so `assertNoRunsInFlight` calls it "still executing"
// and refuses the adoption; the advice ("let the runs finish") cannot be followed — the run waits for a
// person. The only way through is `allowInFlight` ("if you know these runs are abandoned"); the run is
// then moved into the organization and must still be answerable there.
import { describe, it, expect } from 'vitest';
import { tool } from 'ai';
import { z } from 'zod';
import { InMemoryStorage } from '@gnldev/durable';
import { SqliteStorage } from '../../durable/src/sqlite-storage.js';
import { createRestApi } from '../src/index.js';
import { call } from './call.js';

const usage = { inputTokens: 1, outputTokens: 1, totalTokens: 2 };
const model: any = {
  specificationVersion: 'v2', provider: 'mock', modelId: 'm', supportedUrls: {},
  doGenerate: async ({ prompt }: any) => (JSON.stringify(prompt).includes('tool-result')
    ? { content: [{ type: 'text', text: 'APPROVED-DONE' }], finishReason: 'stop', usage, warnings: [] }
    : { content: [{ type: 'tool-call', toolCallId: 'call-1', toolName: 'stall', input: '{}' }], finishReason: 'tool-calls', usage, warnings: [] }),
};
const agents = { stall: { model, tools: { stall: tool({ description: 's', inputSchema: z.object({}), execute: async () => ({ ok: true }) }) }, guard: ({ approved }: any) => (approved ? { action: 'allow' as const } : { action: 'require-approval' as const }) } };
const json = { 'content-type': 'application/json' };

describe.each([['InMemory', () => new InMemoryStorage()], ['Sqlite', () => new SqliteStorage(':memory:')]] as const)('adopting a deployment with a run waiting on approval (%s)', (_n, mk) => {
  it('the adoption is not refused as "still executing", and the run is answered in the organization', async () => {
    const storage: any = (mk as any)(); await storage.init?.();
    const before = createRestApi({ storage, memory: false, agents } as never, { protectionsBanner: false } as never);
    const r = await call(before, '/agents/stall/run', { method: 'POST', headers: json, body: JSON.stringify({ runId: 'p1', prompt: 'hi' }) });
    expect(r.status).toBe(200);
    expect((await r.json()).interrupts?.length).toBe(1);

    let refusal: string | undefined;
    try { await storage.adoptIntoOrg('acme', { allowUnregistered: true, dryRun: true }); } catch (e: any) { refusal = e.message; }
    expect(refusal, 'a run waiting on a person was called "still executing"').toBeUndefined();

    await storage.adoptIntoOrg('acme', { allowUnregistered: true, allowInFlight: true });
    const after = createRestApi({ storage, memory: false, agents } as never, { org: {}, protectionsBanner: false } as never);
    const res = await call(after, '/agents/stall/run', { method: 'POST', headers: { ...json, 'x-gnl-org': 'acme' }, body: JSON.stringify({ runId: 'p1', prompt: 'hi', approvals: { 'call-1': true } }) });
    const body = await res.json();
    expect({ status: res.status, text: body.text }).toEqual({ status: 200, text: 'APPROVED-DONE' });
  });
});
