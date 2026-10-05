// `gnl dev` (and `gnl studio`) run the config they are given — the same one the deployed
// src/app.ts runs. The Playground used to get a memory store the config did not have (derived from
// `storage`), so a conversation remembered on the developer's machine and forgot after deploy; the
// banner warned about it. Measured below by talking twice to the same thread through the Playground
// and through the REST host the project deploys, and comparing what the model saw on the 2nd turn.
import { describe, it, expect } from 'vitest';
import * as Durable from '@gnldev/durable';
import { InMemoryStorage } from '@gnldev/durable';
import * as Hono from 'hono';
import * as Server from '@gnldev/server';
import * as Studio from '@gnldev/studio';
import * as StudioAi from '@gnldev/studio/ai';
import * as Auth from '@gnldev/auth';
import * as Memory from '@gnldev/memory';
import { buildDevApp, type DevRuntimeModules } from '../src/dev-server.js';

const rt = { hono: Hono, durable: Durable, server: Server, studio: Studio, studioAi: StudioAi, auth: Auth, memory: Memory } as unknown as DevRuntimeModules;
const usage = { inputTokens: 1, outputTokens: 1, totalTokens: 2 };
/** Answers with how many user messages it was shown: 1 = no memory of the earlier turn. */
const counting: any = {
  specificationVersion: 'v2', provider: 'mock', modelId: 'count', supportedUrls: {},
  doGenerate: async ({ prompt }: any) => ({ content: [{ type: 'text', text: `saw ${(prompt ?? []).filter((m: any) => m.role === 'user').length}` }], finishReason: 'stop', usage, warnings: [] }),
};
async function twoTurns(app: any, path: string, thread: string) {
  const post = (runId: string, prompt: string) => app.request(path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ runId, prompt, threadId: thread, resourceId: 'u1' }) });
  const a = await post(`${thread}-1`, 'one'); expect(a.status, await a.clone().text()).toBe(200);
  const b = await post(`${thread}-2`, 'two'); expect(b.status, await b.clone().text()).toBe(200);
  return (await b.json()).text as string;
}

describe('the Playground and the deployed host see the same memory', () => {
  for (const [label, extra] of [
    ['a config with no memory', {}],
    ['a config with a memory factory', { memoryFactory: (s: any) => Memory.memoryPreset(s, 'chat') }],
  ] as const) {
    it(label, async () => {
      const storage = new InMemoryStorage();
      const app = buildDevApp({ storage, agents: { a: { model: counting } }, ...extra } as any, rt);
      const playground = await twoTurns(app, '/studio/api/agents/a/run', 'tp');
      const deployed = await twoTurns(app, '/agents/a/run', 'td');
      expect(playground).toBe(deployed);
    });
  }
});
