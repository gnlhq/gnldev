// ADR-0001: "In the root scope, every organization's rows are hidden" — also when a root-scope caller
// NAMES an organization's thread.
//
// Organization threads live in the root store as `org:<id>:<threadId>`, and a thread id is the
// client's to choose. Measured before (review panel, F8 sibling D): a root-scope end user posting
// `threadId: 'org:acme:fresh'` got acme's secret in the prompt sent to the model — the store took the
// recall partition from the id. With the partition now taken from the scope that alone no longer
// leaks, but the id still names acme's partition: a run there would create a root user's thread
// inside acme, and `org:acme:t-acme` names acme's existing thread directly. The door refuses the
// reserved space for root-scope callers with `thread_id_reserved` (400) before anything runs.
import { describe, it, expect } from 'vitest';
import { InMemoryStorage, RESERVED_ID_ERROR_CODES, type Storage } from '@gnldev/durable';
import { SqliteStorage } from '@gnldev/durable/sqlite';
import { echoModel } from '@gnldev/durable/mock';
import { memoryPreset } from '../../memory/src/index.js';
import { createChatRoute } from '../../chat-adapter/src/index.js';
import { createRestApi } from '../src/index.js';

(globalThis as any).AI_SDK_LOG_WARNINGS = false;
const SECRET = 'ACME-SECRET-42';

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
    if (t === 'root-op') return { kind: 'operator' as const, id: 'op', roles: ['admin'] };
    return null;
  },
  authorize: (p: unknown) => (p ? { allow: true } : { allow: false, status: 401, reason: 'no' }),
  capabilities: () => ({ sso: false, rbac: false, audit: false, multiOrganization: false, users: false }),
};

function restApi(storage: Storage) {
  const spy = spyModel();
  const api: any = createRestApi({ storage, memoryFactory: (s: any) => memoryPreset(s, 'recall'), agents: { a: { model: spy.m } } } as any, { auth: provider, protectionsBanner: false } as any);
  const post = (tok: string, path: string, body: unknown) => api.fetch(new Request(`http://x${path}`, {
    method: 'POST', headers: { authorization: `Bearer ${tok}`, 'content-type': 'application/json' }, body: JSON.stringify(body) }));
  const run = (tok: string, runId: string, threadId: string, prompt: string) => post(tok, '/agents/a/run', { runId, threadId, prompt });
  const get = (tok: string, path: string) => api.fetch(new Request(`http://x${path}`, { headers: { authorization: `Bearer ${tok}` } }));
  return { spy, run, post, get };
}

const engines: [string, () => Storage][] = [
  ['InMemoryStorage', () => new InMemoryStorage()],
  ['SqliteStorage', () => new SqliteStorage(':memory:') as unknown as Storage],
];

describe.each(engines)('REST: a root-scope caller cannot name a thread under org: (%s)', (_n, make) => {
  it.each([
    ['a fresh id in acme\'s space', 'org:acme:fresh'],
    ['acme\'s existing thread', 'org:acme:t-acme'],
    ['a malformed org id', 'org:x'],
  ])('root user, %s: 400 thread_id_reserved, nothing reaches the model', async (_l, threadId) => {
    const { spy, run } = restApi(make());
    expect((await run('acme-user', 'r-acme', 't-acme', `my secret password is ${SECRET}`)).status).toBe(200);
    const before = spy.prompts.length;
    const res = await run('root-user', 'r-root', threadId, 'what is my secret password');
    expect(res.status).toBe(400);
    expect((await res.json()).code).toBe('thread_id_reserved');
    expect(RESERVED_ID_ERROR_CODES.ReservedThreadIdError).toBe('thread_id_reserved');
    expect(spy.prompts.length).toBe(before);
  });

  it('a root operator is refused the same way (the root scope cannot name them, whoever asks)', async () => {
    const { run } = restApi(make());
    const res = await run('root-op', 'r-op', 'org:acme:t-acme', 'hi');
    expect(res.status).toBe(400);
    expect((await res.json()).code).toBe('thread_id_reserved');
  });

  it('GET /threads/org:acme:t-acme/messages as the root operator: 400, not acme\'s messages', async () => {
    const { run, get } = restApi(make());
    await run('acme-user', 'r-acme', 't-acme', `my secret password is ${SECRET}`);
    const res = await get('root-op', '/threads/org:acme:t-acme/messages');
    expect(res.status).toBe(400);
    expect(await res.text()).not.toContain(SECRET);
  });

  it('CONTROL: an acme user may call its own thread `org:notes` — its organization prefixes it', async () => {
    const { run, get } = restApi(make());
    expect((await run('acme-user', 'r-1', 'org:notes', 'hello')).status).toBe(200);
    expect((await get('acme-user', '/threads/org:notes/messages')).status).toBe(200);
  });

  it('CONTROL: the root user\'s ordinary threads still run and recall', async () => {
    const { spy, run } = restApi(make());
    expect((await run('root-user', 'r-1', 't-1', 'my secret password is ROOT-7')).status).toBe(200);
    expect((await run('root-user', 'r-2', 'organization-notes', 'what is my secret password')).status).toBe(200);
    expect(spy.prompts.at(-1)!).toContain('ROOT-7');
  });
});

describe('standalone chat door, root user naming acme\'s space (no door check there: the memory refuses)', () => {
  it('fails closed: acme\'s message never reaches the model', async () => {
    const spy = spyModel();
    const config: any = { storage: new InMemoryStorage(), memoryFactory: (s: any) => memoryPreset(s, 'recall'), agents: { a: { model: spy.m } } };
    const route: any = createChatRoute(config, { identify: (req: Request) => provider.authenticate(req) ?? undefined } as any);
    const chat = async (tok: string, id: string, text: string) => {
      const res = await route.fetch(new Request('http://x/agents/a/chat', {
        method: 'POST', headers: { authorization: `Bearer ${tok}`, 'content-type': 'application/json' },
        body: JSON.stringify({ id, messages: [{ id: `${id}-m1`, role: 'user', parts: [{ type: 'text', text }] }] }),
      }));
      return { status: res.status, body: await res.text() };
    };
    expect((await chat('acme-user', 'conv-acme', `my secret password is ${SECRET}`)).status).toBe(200);
    const before = spy.prompts.length;
    const r = await chat('root-user', 'org:acme:conv-acme', 'what is my secret password');
    expect(r.body).not.toContain(SECRET);
    expect(spy.prompts.slice(before).join('')).not.toContain(SECRET);
  });
});

// ONE ERROR, ONE ANSWER ON EVERY DOOR. `ReservedThreadIdError` is answered through @gnldev/durable's
// `requestRefusal`: 400, `code: 'thread_id_reserved'`, `detail.threadId`. Measured before (round 5):
// Studio's GET /threads/:id/messages and /working-memory answered 500; Studio PATCH/DELETE and the
// chat and AG-UI routes 400 with no `code`; only REST said `thread_id_reserved`, from its own copy of
// the `org:` test and its own sentence.
describe('every door answers a reserved thread id with the same status, code and detail', async () => {
  const { createStudioApi } = await import('../../studio/src/server.js');
  const { createAguiRoute } = await import('../../agui/src/index.js');
  const { WIRE_ERROR_STATUS } = await import('@gnldev/durable');
  const threadId = 'org:acme:t';
  const enc = encodeURIComponent(threadId);
  const json = { 'content-type': 'application/json' };
  const mk = () => {
    const storage = new InMemoryStorage();
    return { storage, memory: memoryPreset(storage, 'chat') as any, agents: { a: { model: echoModel() } } };
  };
  const doors: Array<[string, () => Promise<Response>]> = [
    ['studio GET messages', async () => { const k = mk(); return (createStudioApi({ reader: k.storage.runs as any, memory: k.memory }) as any)(new Request(`http://x/threads/${enc}/messages`)); }],
    ['studio GET working-memory', async () => { const k = mk(); return (createStudioApi({ reader: k.storage.runs as any, memory: k.memory }) as any)(new Request(`http://x/threads/${enc}/working-memory`)); }],
    ['studio PATCH thread', async () => { const k = mk(); return (createStudioApi({ reader: k.storage.runs as any, memory: k.memory }) as any)(new Request(`http://x/threads/${enc}`, { method: 'PATCH', headers: json, body: '{"title":"x"}' })); }],
    ['studio DELETE thread', async () => { const k = mk(); return (createStudioApi({ reader: k.storage.runs as any, memory: k.memory }) as any)(new Request(`http://x/threads/${enc}`, { method: 'DELETE' })); }],
    ['rest GET messages', async () => { const k = mk(); return (createRestApi({ storage: k.storage, memory: k.memory, agents: k.agents } as any, { protectionsBanner: false } as any) as any).fetch(new Request(`http://x/threads/${enc}/messages`)); }],
    ['rest POST run', async () => { const k = mk(); return (createRestApi({ storage: k.storage, memory: k.memory, agents: k.agents } as any, { protectionsBanner: false } as any) as any).fetch(new Request('http://x/agents/a/run', { method: 'POST', headers: json, body: JSON.stringify({ runId: 'r', threadId, resourceId: 'u', prompt: 'x' }) })); }],
    ['chat POST', async () => { const k = mk(); return (createChatRoute({ storage: k.storage, memory: k.memory, agents: k.agents } as any, {}) as any).fetch(new Request('http://x/agents/a/chat', { method: 'POST', headers: json, body: JSON.stringify({ id: 'c', threadId, messages: [{ id: 'm', role: 'user', parts: [{ type: 'text', text: 'hi' }] }] }) })); }],
    ['agui POST', async () => { const k = mk(); return (createAguiRoute({ storage: k.storage, memory: k.memory, agents: k.agents } as any, {}) as any).fetch(new Request('http://x/agents/a/run', { method: 'POST', headers: json, body: JSON.stringify({ threadId, runId: 'r', messages: [{ id: 'm', role: 'user', content: 'hi' }] }) })); }],
  ];
  it.each(doors)('%s', async (_door, hit) => {
    const res = await hit();
    const body = await res.json();
    expect(res.status).toBe(WIRE_ERROR_STATUS.thread_id_reserved);
    expect(body).toMatchObject({ code: 'thread_id_reserved', detail: { threadId } });
  });
});
