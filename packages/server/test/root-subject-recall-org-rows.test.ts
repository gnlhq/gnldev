// ADR-0001:33-34 — "In the root scope, every organization's rows are hidden" — through the doors.
//
// One identity provider binds SOME users to an organization and leaves others unbound (a JWT with an
// optional org claim is the everyday shape), and returns the same user id either way. Without the
// `org` option the REST API serves both from one store: acme's `u-shared` under `org:acme:`, the
// unbound `u-shared` from the root. Measured before the fix, with `memoryPreset(s, 'recall')`: the
// root user's turn carried acme's message in the prompt sent to the model — on REST and on the
// standalone chat door, which has no `org` option at all. The store's resource-scoped recall matched
// on resource id alone; see `recallPartition` in @gnldev/durable.
import { describe, it, expect } from 'vitest';
import { InMemoryStorage, type Storage } from '@gnldev/durable';
import { SqliteStorage } from '../../durable/src/sqlite-storage.js';
import { echoModel } from '@gnldev/durable/mock';
import { memoryPreset } from '../../memory/src/index.js';
import { createChatRoute } from '../../chat-adapter/src/index.js';
import { createRestApi } from '../src/index.js';

(globalThis as any).AI_SDK_LOG_WARNINGS = false;

const SECRET = 'ACME-SECRET-42';

/** The framework's echo model, wrapped so every prompt the model received can be read back. */
function spyModel() {
  const inner: any = echoModel();
  const prompts: string[] = [];
  const m: any = {
    ...inner,
    doGenerate: async (o: any) => { prompts.push(JSON.stringify(o.prompt)); return inner.doGenerate(o); },
    doStream: async (o: any) => { prompts.push(JSON.stringify(o.prompt)); return inner.doStream(o); },
  };
  return { m, prompts };
}

const provider = {
  authenticate: (req: Request) => {
    const t = req.headers.get('authorization')?.replace('Bearer ', '');
    if (t === 'acme-user') return { kind: 'subject' as const, id: 'u-shared', roles: ['end-user'], orgId: 'acme' };
    if (t === 'root-user') return { kind: 'subject' as const, id: 'u-shared', roles: ['end-user'] };
    return null;
  },
  authorize: (p: unknown) => (p ? { allow: true } : { allow: false, status: 401, reason: 'no' }),
  capabilities: () => ({ sso: false, rbac: false, audit: false, multiOrganization: false, users: false }),
};

function restApi(storage: Storage) {
  const spy = spyModel();
  const config: any = { storage, memoryFactory: (s: any) => memoryPreset(s, 'recall'), agents: { a: { model: spy.m } } };
  const api: any = createRestApi(config, { auth: provider, protectionsBanner: false } as any);
  const run = (tok: string, runId: string, threadId: string, prompt: string) =>
    api.fetch(new Request('http://x/agents/a/run', {
      method: 'POST', headers: { authorization: `Bearer ${tok}`, 'content-type': 'application/json' },
      body: JSON.stringify({ runId, threadId, prompt }),
    }));
  const get = (tok: string, path: string) => api.fetch(new Request(`http://x${path}`, { headers: { authorization: `Bearer ${tok}` } }));
  return { spy, run, get };
}

const engines: [string, () => Storage][] = [
  ['InMemoryStorage', () => new InMemoryStorage()],
  ['SqliteStorage', () => new SqliteStorage(':memory:') as unknown as Storage],
];

for (const [name, make] of engines) {
  describe(`REST, no \`org\` option, one provider with and without orgId (${name})`, () => {
    it('the root-scope turn of u-shared does not carry acme\'s message to the model', async () => {
      const { spy, run } = restApi(make());
      expect((await run('acme-user', 'r-acme', 't-acme', `my secret password is ${SECRET}`)).status).toBe(200);
      expect((await run('root-user', 'r-root', 't-root', 'what is my secret password')).status).toBe(200);
      expect(spy.prompts.at(-1)!).toContain('what is my secret password');
      expect(spy.prompts.at(-1)!).not.toContain(SECRET);
    });

    it('CONTROL: the root user recalls its own earlier thread', async () => {
      const { spy, run } = restApi(make());
      await run('root-user', 'r-1', 't-1', 'my secret password is ROOT-OWN-7');
      await run('root-user', 'r-2', 't-2', 'what is my secret password');
      expect(spy.prompts.at(-1)!).toContain('ROOT-OWN-7');
    });

    it('CONTROL (reverse): acme\'s u-shared does not recall the root row', async () => {
      const { spy, run } = restApi(make());
      await run('root-user', 'r-root', 't-root', `my secret password is ${SECRET}`);
      await run('acme-user', 'r-acme', 't-acme', 'what is my secret password');
      expect(spy.prompts.at(-1)!).not.toContain(SECRET);
    });

    it('SIBLING: GET /threads for the root user lists no acme thread', async () => {
      const { run, get } = restApi(make());
      await run('acme-user', 'r-acme', 't-acme', `my secret password is ${SECRET}`);
      await run('root-user', 'r-root', 't-root', 'hello');
      const res = await get('root-user', '/threads');
      expect(res.status).toBe(200);
      const ids = ((await res.json()) as { id: string }[]).map((t) => t.id);
      expect(ids).toEqual(['t-root']);
    });

    it('SIBLING: GET /threads/:id/messages for acme\'s physical thread id answers nothing to the root user', async () => {
      const { run, get } = restApi(make());
      await run('acme-user', 'r-acme', 't-acme', `my secret password is ${SECRET}`);
      const res = await get('root-user', '/threads/org:acme:t-acme/messages');
      expect(await res.text()).not.toContain(SECRET);
    });
  });
}

describe('standalone chat door (no `org` option exists there)', () => {
  it('the root user\'s turn does not carry acme\'s message to the model', async () => {
    const spy = spyModel();
    const config: any = { storage: new InMemoryStorage(), memoryFactory: (s: any) => memoryPreset(s, 'recall'), agents: { a: { model: spy.m } } };
    const route: any = createChatRoute(config, { identify: (req: Request) => provider.authenticate(req) ?? undefined } as any);
    const chat = async (tok: string, id: string, text: string) => {
      const res = await route.fetch(new Request('http://x/agents/a/chat', {
        method: 'POST', headers: { authorization: `Bearer ${tok}`, 'content-type': 'application/json' },
        body: JSON.stringify({ id, messages: [{ id: `${id}-m1`, role: 'user', parts: [{ type: 'text', text }] }] }),
      }));
      await res.text();
      return res.status;
    };
    expect(await chat('acme-user', 'conv-acme', `my secret password is ${SECRET}`)).toBe(200);
    expect(await chat('root-user', 'conv-root', 'what is my secret password')).toBe(200);
    expect(spy.prompts.at(-1)!).toContain('what is my secret password');
    expect(spy.prompts.at(-1)!).not.toContain(SECRET);
  });
});
