// d25 / memory cluster, finding 1: a `memory` OBJECT plus an org-bound credential (no `org` option).
// The REST host dropped the object silently (`orgInstance` strips `config.memory`) while the boot
// guard only fired for `opts.org`. Rule: a value given in the wrong place must either work or fail loudly.
import { describe, it, expect } from 'vitest';
import { InMemoryStorage } from '@gnldev/durable';
import { roleAuth } from '@gnldev/auth';
import { createRestApi } from '../src/index.js';

const mkModel = () => ({
  specificationVersion: 'v4' as const, provider: 'm', modelId: 'm', supportedUrls: {},
  doGenerate: async () => ({
    content: [{ type: 'text' as const, text: 'ok' }],
    finishReason: { unified: 'stop' as const, raw: 'stop' },
    usage: { inputTokens: { total: 1 }, outputTokens: { total: 1 } },
    warnings: [],
  }),
});

function recordingMemory() {
  const seen: string[] = [];
  return { seen, mem: { loadContext: async (t: string) => { seen.push(t); return { messages: [] }; }, append: async () => {}, getMessages: async () => [] } };
}

describe('memory object + org-bound credential (no `org` option)', () => {
  // KARAR-1 (user decision, 8 Nov 2026): an object the framework cannot split per organization is
  // REFUSED under organizations — at construction, or (the organization is learnt from the credential)
  // at the org-bound request. Consulting it would share one store across organizations, so the earlier
  // "or consults it" branch is no longer an acceptable outcome. Full matrix of doors:
  // unsplittable-memory-is-refused-under-orgs.test.ts.
  it('refuses at construction or at the org-bound request, naming memoryFactory (never silently drops, never shares)', async () => {
    const { seen, mem } = recordingMemory();
    let app: ((r: Request) => Promise<Response> | Response) | undefined;
    let refused = false;
    try {
      app = createRestApi(
        { storage: new InMemoryStorage(), memory: mem as never, agents: { a: { model: mkModel() as never } } } as never,
        { auth: roleAuth({ client: { token: 'C', orgId: 'acme' } }) },
      ) as never;
    } catch { refused = true; }
    if (!refused) {
      const r = await app!(new Request('http://x/agents/a/run', {
        method: 'POST', headers: { authorization: 'Bearer C', 'content-type': 'application/json' },
        body: JSON.stringify({ runId: 'r1', prompt: 'hi', threadId: 't1', resourceId: 'u1' }),
      }));
      const text = await r.text();
      expect(r.status, `memory object was silently ignored: the org-bound run was served (${text.slice(0, 120)})`).toBeGreaterThanOrEqual(500);
      expect(seen, 'the unsplittable object was consulted for an organization').toEqual([]);
    }
  });

  it('same rule on a second path: /run with an org given by the x-gnl-org header (opts.org: {}) is refused at boot', () => {
    const { mem } = recordingMemory();
    expect(() => createRestApi({ storage: new InMemoryStorage(), memory: mem as never, agents: {} } as never, { org: {} } as never)).toThrow(/memoryFactory/);
  });
});
