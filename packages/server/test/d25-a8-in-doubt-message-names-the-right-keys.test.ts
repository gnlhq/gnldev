// d25 A8 — the "it may already have happened" refusal (side_effect_retry_blocked) over REST says what to
// send. Following that advice must work: the key(s) the message names, sent as approvals, release the
// retry. The keys are READ FROM THE MESSAGE, never hard-coded. (On 0.17.1 the message names only c2 while
// c1 + c2 are needed: answering c2 alone is refused again.)
import { describe, it, expect } from 'vitest';
import { z } from 'zod';
import { InMemoryStorage } from '@gnldev/durable';
import { createRestApi } from '../src/index.js';
import { call } from './call.js';

const usage = { inputTokens: 1, outputTokens: 1, totalTokens: 2 };
const toolResults = (prompt: any[] | undefined) => (prompt ?? []).filter((m: any) => m.role === 'tool').length;
function model(ids: string[]): any {
  const callOf = (prompt: any[]) => { const id = ids[toolResults(prompt)]; return id ? { type: 'tool-call', toolCallId: id, toolName: 'refund', input: JSON.stringify({ amount: 12500 }) } : undefined; };
  return {
    specificationVersion: 'v2', provider: 'mock', modelId: 'm', supportedUrls: {},
    doGenerate: async ({ prompt }: any) => { const c = callOf(prompt); return c
      ? { content: [c], finishReason: 'tool-calls', usage, warnings: [] }
      : { content: [{ type: 'text', text: 'Done.' }], finishReason: 'stop', usage, warnings: [] }; },
  };
}
function mkApi(failFirst = 1, ids = ['c1', 'c2']) {
  let n = 0;
  const api = createRestApi({ storage: new InMemoryStorage(), memory: false, agents: { support: { model: model(ids), tools: { refund: {
    description: 'refund', inputSchema: z.object({ amount: z.number() }), sideEffect: true, idempotency: 'args', maxRetries: 5,
    execute: async () => { n++; if (n <= failFirst) throw new Error('provider 502 after the request left'); return { ok: true }; },
  } } } } } as never, { allowOpenAccess: true, protectionsBanner: false } as never);
  return { api, effects: () => n };
}
const post = (api: any, path: string, body: unknown) => call(api, path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
const keysIn = (text: string) => [...new Set([...text.matchAll(/approvals\[\\?['"]([^'"\\\]]+)\\?['"]\]/g)].map((m) => m[1]!))];

describe('d25 A8 — the in-doubt refusal names the keys that release it', () => {
  for (const door of ['run', 'resume'] as const) {
    it(`${door}: sending exactly the keys the refusal names lets the retry through`, async () => {
      const { api, effects } = mkApi();
      const runId = `a8-${door}`;
      await post(api, '/agents/support/run', { runId, prompt: 'refund' });
      expect(effects(), 'precondition: one attempt, it failed').toBe(1);
      const refused = await post(api, '/agents/support/run', { runId, prompt: 'refund' });
      const text = await refused.text();
      expect(text, 'precondition: refused as in doubt').toContain('side_effect_retry_blocked');
      const keys = keysIn(text);
      expect(keys.length, `the message names at least one key: ${text.slice(0, 400)}`).toBeGreaterThan(0);
      const approvals = Object.fromEntries(keys.map((k) => [k, true]));
      const body = door === 'resume' ? { runId, approvals } : { runId, prompt: 'refund', approvals };
      const r = await post(api, `/agents/support/${door}`, body);
      const t = await r.text();
      expect(r.status, `followed the advice (${JSON.stringify(keys)}): ${t.slice(0, 400)}`).toBe(200);
      expect(t).not.toContain('side_effect_retry_blocked');
      expect(effects(), 'the approved retry ran once').toBe(2);
    });
  }

  // Sibling: the retry the approval released failed again (a second attempt in doubt). The new refusal
  // must also name keys that, sent as the message says, release it — however many rounds it takes.
  it('run: a second failed attempt, a second refusal — following the advice each time still gets through', async () => {
    const { api, effects } = mkApi(2, ['c1', 'c2', 'c3']);
    const runId = 'a8-twice';
    await post(api, '/agents/support/run', { runId, prompt: 'refund' });
    let approvals: Record<string, boolean> = {};
    let r: Response | undefined; let t = '';
    for (let round = 0; round < 4; round++) {
      r = await post(api, '/agents/support/run', { runId, prompt: 'refund', ...(Object.keys(approvals).length ? { approvals } : {}) });
      t = await r.text();
      if (!t.includes('side_effect_retry_blocked')) break;
      const keys = keysIn(t);
      expect(keys.length, `round ${round}: the message names a key: ${t.slice(0, 400)}`).toBeGreaterThan(0);
      // what the message says, sent as it says: a key the caller already sent and was refused again means the advice is wrong
      expect(keys.every((k) => approvals[k]), `round ${round}: the message names ${JSON.stringify(keys)} which were already sent`).toBe(false);
      for (const k of keys) approvals[k] = true;
    }
    expect(r!.status, t.slice(0, 400)).toBe(200);
    expect(t).not.toContain('side_effect_retry_blocked');
    expect(effects()).toBe(3);
  });
});
