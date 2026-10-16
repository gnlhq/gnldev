// The HTTP door (POST /agents/:name/run) takes a raw `runId` from the body. An id the engine composes
// from a parent run — `agent:<P>:<call>`, `wf:<P>:<call>`, `net:<P>:<step>` — is begun by the engine
// only (run-id-grammar.ts): a stranger who names one the engine has not made is refused exactly as a
// background call's `task:` id is — and as someone else's run is: 404 `run_not_found`
// (no-existence-oracle.test.ts) — and nothing is written under it. The owner's run then makes it as its own.
import { describe, it, expect } from 'vitest';
import { InMemoryStorage, createGnl, user } from '@gnldev/durable';
import { createRestApi } from '../src/index.js';

const textModel = (fn: (prompt: any[]) => any) => ({
  specificationVersion: 'v4' as const, provider: 'm', modelId: 'm', supportedUrls: {},
  doGenerate: async ({ prompt }: any) => ({
    ...fn(prompt),
    usage: { inputTokens: { total: 1 }, outputTokens: { total: 1 } },
    warnings: [],
  }),
});
const text = (t: string) => ({ content: [{ type: 'text' as const, text: t }], finishReason: { unified: 'stop' as const, raw: 'stop' } });
const PRINCIPALS: Record<string, unknown> = {
  alice: { kind: 'subject', id: 'alice', roles: ['admin'] },
  mallory: { kind: 'subject', id: 'mallory', roles: ['admin'] },
};
const auth = {
  authenticate: (req: Request) => PRINCIPALS[req.headers.get('authorization')?.replace('Bearer ', '') ?? ''] ?? null,
  authorize: () => ({ allow: true }),
};

function setup() {
  const storage = new InMemoryStorage();
  let workerCalls = 0;
  const worker = textModel(() => { workerCalls++; return text('w'); });
  const parent = textModel((prompt) => prompt.some((m: any) => m.role === 'tool')
    ? text('done')
    : { content: [{ type: 'tool-call', toolCallId: 'tc1', toolName: 'agent_w', input: JSON.stringify({ task: 'ALICE-TASK' }) }], finishReason: { unified: 'tool-calls', raw: 'tool-calls' } });
  const config = { storage, agents: { parent: { model: parent, agents: ['w'] }, w: { model: worker } } } as any;
  const api = createRestApi(config, { auth: auth as never, protectionsBanner: false });
  const call = async (who: string, path: string, body: unknown) => {
    const r = await api(new Request(`http://x${path}`, { method: 'POST', headers: { authorization: `Bearer ${who}`, 'content-type': 'application/json' }, body: JSON.stringify(body) }));
    return { status: r.status, body: await r.text() };
  };
  return { config, call, storage, workerCalls: () => workerCalls };
}

describe('a derived run is born by the engine, through the HTTP door', () => {
  it.each(['agent:P:tc1', 'wf:P:tc1', 'net:P:0', 'net:P:7'])('a stranger naming %s is refused as a task: id is and writes nothing; the owner\'s run is unharmed', async (runId) => {
    const { config, call, storage, workerCalls } = setup();
    const task = await call('mallory', '/agents/w/run', { runId: 'task:P:tc1', prompt: 'x' });
    const res = await call('mallory', '/agents/w/run', { runId, prompt: 'MALLORY-SECRET' });
    expect(res.status).toBe(task.status);
    expect(res.status).toBe(404);
    expect(JSON.parse(res.body)).toEqual({ error: 'run not found', code: 'run_not_found' });
    expect(res.body).not.toContain('MALLORY-SECRET');
    expect(await (storage.runs as any).listKeys(runId)).toEqual([]);
    expect(workerCalls()).toBe(0);
    if (runId === 'agent:P:tc1') {
      const r = await createGnl(config).run('parent', { runId: 'P', prompt: 'go', caller: user('alice') });
      expect(r.text).toBe('done');
      expect(workerCalls()).toBe(1);
      expect((await (storage.runs as any).get('agent:P:tc1:input'))?.resourceId).toBe('alice');
    }
  });

  it('the owner continues the child her run made, through the same door', async () => {
    const { config, call, storage } = setup();
    await createGnl(config).run('parent', { runId: 'P', prompt: 'go', caller: user('alice') });
    expect((await call('alice', '/agents/w/run', { runId: 'agent:P:tc1', prompt: 'ALICE-TASK' })).status).toBe(200);
    // …and the stranger gets the bytes an absent id gets: the child's existence is not his to learn.
    const foreign = await call('mallory', '/agents/w/run', { runId: 'agent:P:tc1', prompt: 'x' });
    expect(foreign).toEqual(await call('mallory', '/agents/w/run', { runId: 'agent:P:tc2', prompt: 'x' }));
    expect(foreign.status).toBe(404);
    expect((await (storage.runs as any).get('agent:P:tc1:input'))?.resourceId).toBe('alice');
  });
});
