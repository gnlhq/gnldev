// An organization's request is served only from a store Studio obtained FOR that organization.
//
// Six host-supplied stores sit behind Studio routes: `memory`, `workflowStore`, `queue`, `events`,
// `cache` and `vectors`. Each used to accept `orgScoped: true` — the host's word that its ONE object
// "honours the orgId it is handed". For `memory` that promise could not be kept: `Memory`'s methods
// take a thread id and nothing else, so Studio never told the object who was asking. Measured with the
// flag set: globex read acme's messages (200) and deleted acme's thread. For the other five the org
// arrives as an advisory `ctx`, which nothing can check was read.
//
// The flag is gone. A store reaches organizations only as a function of the organization,
// `({ orgId }) => Store`, called once per organization; a plain object is the root/single-tenant form
// and an organization's request for it is refused, naming the function form.
import { describe, it, expect, vi } from 'vitest';
import { InMemoryJournal } from '@gnldev/durable';
import { createStudioApi, type StudioMemory, type WorkflowDef } from '../src/server.js';
import { call } from './call.js';

const auth = {
  authenticate: (req: Request) => {
    const t = req.headers.get('authorization')?.replace('Bearer ', '');
    if (t === 'acme') return { kind: 'operator', roles: ['admin'], id: 'u-acme', orgId: 'acme' };
    if (t === 'globex') return { kind: 'operator', roles: ['admin'], id: 'u-globex', orgId: 'globex' };
    if (t === 'root') return { kind: 'operator', roles: ['admin', 'platform-admin'], id: 'u-root' };
    return null;
  },
  authorize: () => ({ allow: true }),
  capabilities: () => ({ sso: false, rbac: false, audit: false, multiOrganization: false, users: false }),
};
type Who = 'acme' | 'globex' | 'root';
type Api = (r: Request) => Promise<Response>;

const send = (api: Api, who: Who, method: string, path: string, body?: unknown) =>
  call(api, path, {
    method,
    headers: { authorization: `Bearer ${who}`, ...(body === undefined ? {} : { 'content-type': 'application/json' }) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });

/** One organization's conversation store: real state, so a delete is observable afterwards. */
function threadStore(owner: string) {
  const threads = new Map<string, { title: string; resourceId: string; messages: string[]; wm: string }>([
    [`${owner}-t`, { title: `${owner} thread`, resourceId: `${owner}-user`, messages: [`${owner.toUpperCase()}-SECRET-1`, `${owner.toUpperCase()}-SECRET-2`], wm: `${owner}-wm` }],
  ]);
  const memory: StudioMemory = {
    getMessages: async (id) => (threads.get(id)?.messages ?? []).map((content) => ({ role: 'user', content })) as never,
    getWorkingMemory: async (id) => threads.get(id)?.wm,
    listAllThreads: async () => [...threads.entries()].map(([id, t]) => ({ id, title: t.title, resourceId: t.resourceId })) as never,
    listThreads: async (o) => [...threads.entries()].filter(([, t]) => t.resourceId === o.resourceId).map(([id, t]) => ({ id, title: t.title })) as never,
    updateThread: async (id, patch) => { const t = threads.get(id); if (!t) throw new Error('no such thread'); t.title = String(patch.title ?? t.title); return { id, title: t.title } as never; },
    deleteThread: async (id) => { threads.delete(id); },
    truncateMessagesAfter: async (id, after) => { const t = threads.get(id); if (!t) return 0; const n = t.messages.length - (after + 1); t.messages = t.messages.slice(0, after + 1); return n; },
  };
  return { threads, memory };
}

describe('the measured leak: one memory object declared `orgScoped: true`', () => {
  it('globex can neither read nor delete acme\'s thread — the declaration no longer exists', async () => {
    // ONE store for both organizations, exactly as a host that set the flag had it.
    const shared = threadStore('acme');
    const api = createStudioApi({
      reader: new InMemoryJournal(), auth: auth as never, org: {},
      // @ts-expect-error — `orgScoped` is not a field of StudioMemory any more.
      memory: { ...shared.memory, orgScoped: true },
    }) as unknown as Api;

    const read = await send(api, 'globex', 'GET', '/threads/acme-t/messages');
    const readBody = await read.text();
    expect(readBody, 'globex read acme\'s messages').not.toContain('ACME-SECRET');
    expect(read.status).toBe(403);
    expect(JSON.parse(readBody).code).toBe('org_scope_refused');
    expect(JSON.parse(readBody).error, 'the refusal names the way through').toMatch(/\(\{ orgId \}\) =>/);

    const del = await send(api, 'globex', 'DELETE', '/threads/acme-t');
    expect(del.status).toBe(403);
    expect(shared.threads.has('acme-t'), 'globex deleted acme\'s thread').toBe(true);
  });
});

describe('`memory` as a function of the organization', () => {
  const build = () => {
    const stores = new Map<string, ReturnType<typeof threadStore>>();
    const factory = vi.fn(({ orgId }: { orgId?: string }) => {
      const s = threadStore(orgId ?? 'root');
      stores.set(orgId ?? '(root)', s);
      return s.memory;
    });
    const api = createStudioApi({ reader: new InMemoryJournal(), auth: auth as never, org: {}, memory: factory }) as unknown as Api;
    return { api, factory, stores };
  };

  it('serves acme and globex from their own stores on every thread route', async () => {
    const { api, stores } = build();
    for (const [who, other] of [['acme', 'globex'], ['globex', 'acme']] as const) {
      const list = await (await send(api, who, 'GET', '/threads')).json() as Array<{ id: string }>;
      expect(list.map((t) => t.id)).toEqual([`${who}-t`]);
      const byRes = await (await send(api, who, 'GET', `/threads?resourceId=${who}-user`)).json() as Array<{ id: string }>;
      expect(byRes.map((t) => t.id)).toEqual([`${who}-t`]);
      expect(await (await send(api, who, 'GET', `/threads?resourceId=${other}-user`)).json()).toEqual([]);

      const own = await (await send(api, who, 'GET', `/threads/${who}-t/messages`)).text();
      expect(own).toContain(`${who.toUpperCase()}-SECRET-1`);
      const foreign = await (await send(api, who, 'GET', `/threads/${other}-t/messages`)).text();
      expect(foreign).not.toContain(`${other.toUpperCase()}-SECRET`);
      expect(await (await send(api, who, 'GET', `/threads/${who}-t/working-memory`)).json()).toEqual({ value: `${who}-wm` });
      expect(await (await send(api, who, 'GET', `/threads/${other}-t/working-memory`)).json()).toEqual({ value: null });
    }

    // Writes land in the caller's store only.
    expect((await send(api, 'globex', 'PATCH', '/threads/acme-t', { title: 'hijacked' })).status).toBe(400);
    expect(stores.get('acme')!.threads.get('acme-t')!.title).toBe('acme thread');
    expect((await send(api, 'acme', 'PATCH', '/threads/acme-t', { title: 'renamed' })).status).toBe(200);
    expect(stores.get('acme')!.threads.get('acme-t')!.title).toBe('renamed');

    await send(api, 'globex', 'DELETE', '/threads/acme-t/messages', { afterIndex: 0 });
    expect(stores.get('acme')!.threads.get('acme-t')!.messages).toHaveLength(2);
    expect(await (await send(api, 'acme', 'DELETE', '/threads/acme-t/messages', { afterIndex: 0 })).json()).toEqual({ ok: true, removed: 1 });
    expect(stores.get('acme')!.threads.get('acme-t')!.messages).toHaveLength(1);

    await send(api, 'globex', 'DELETE', '/threads/acme-t');
    expect(stores.get('acme')!.threads.has('acme-t')).toBe(true);
    expect((await send(api, 'acme', 'DELETE', '/threads/acme-t')).status).toBe(200);
    expect(stores.get('acme')!.threads.has('acme-t')).toBe(false);
  });

  it('is called once per organization, and with no orgId for the root operator', async () => {
    const { api, factory } = build();
    for (let i = 0; i < 3; i++) {
      await send(api, 'acme', 'GET', '/threads');
      await send(api, 'globex', 'GET', '/threads');
      await send(api, 'root', 'GET', '/threads');
    }
    expect(factory.mock.calls.map(([s]) => s.orgId)).toEqual(['acme', 'globex', undefined]);
    const root = await (await send(api, 'root', 'GET', '/threads')).json() as Array<{ id: string }>;
    expect(root.map((t) => t.id)).toEqual(['root-t']);
  });

  it('a throwing factory fails that request, caches nothing, and never falls back to another store', async () => {
    let fail = true;
    const acme = threadStore('acme');
    const api = createStudioApi({
      reader: new InMemoryJournal(), auth: auth as never, org: {},
      memory: ({ orgId }) => { if (fail && orgId === 'globex') throw new Error('store down'); return orgId === 'acme' ? acme.memory : threadStore(orgId ?? 'root').memory; },
    }) as unknown as Api;
    await send(api, 'acme', 'GET', '/threads');
    const r = await send(api, 'globex', 'GET', '/threads');
    expect(r.status).toBe(500);
    expect(await r.text()).not.toContain('acme');
    fail = false;
    expect(await (await send(api, 'globex', 'GET', '/threads')).json()).toEqual([{ id: 'globex-t', title: 'globex thread', resourceId: 'globex-user' }]);
  });
});

describe('a plain memory object at the root / single tenant', () => {
  it('is served unchanged to a caller with no organization', async () => {
    const s = threadStore('solo');
    const api = createStudioApi({ reader: new InMemoryJournal(), memory: s.memory }) as unknown as Api;
    const list = await (await call(api, '/threads')).json() as Array<{ id: string }>;
    expect(list.map((t) => t.id)).toEqual(['solo-t']);
    expect(await (await call(api, '/threads/solo-t/messages')).text()).toContain('SOLO-SECRET-1');
  });

  it('is served to the root operator of a multi-organization deployment, refused to an organization', async () => {
    const s = threadStore('root');
    const api = createStudioApi({ reader: new InMemoryJournal(), auth: auth as never, org: {}, memory: s.memory }) as unknown as Api;
    expect((await send(api, 'root', 'GET', '/threads')).status).toBe(200);
    const r = await send(api, 'acme', 'GET', '/threads');
    expect(r.status).toBe(403);
    expect((await r.json() as { error: string }).error).toMatch(/\(\{ orgId \}\) =>/);
  });
});

/**
 * The five other host stores. Each receives `ctx.orgId` on every method, but a host that ignores it
 * serves every organization from one store and nothing here can tell — so the argument is information,
 * not a licence. The SAME rule as `memory`: an object is root/single-tenant; organizations need the
 * function form.
 */
type Kind = 'queue' | 'events' | 'cache' | 'vectors' | 'workflowStore';
function storeFor(kind: Kind, owner: string): Record<string, unknown> {
  const SECRET = `${owner.toUpperCase()}-PRIVATE`;
  switch (kind) {
    case 'queue': return { listJobs: () => [{ id: `${owner}-job`, type: SECRET, status: 'failed', attempts: 1 }], retry: (id: string) => (id === `${owner}-job` ? `${owner}-job-2` : null) };
    case 'events': return {
      topics: () => [{ topic: `${owner}.topic`, consumers: ['c'] }],
      listDead: () => [{ id: `${owner}-e`, topic: `${owner}.topic`, consumer: 'c', status: 'quarantined', attempts: 1, at: 1, error: SECRET }],
      release: (_t: string, _c: string, id: string) => id === `${owner}-e`,
    };
    case 'cache': return { stats: () => ({ hits: owner.length, misses: 0, hitRate: 1, size: owner.length }), invalidate: () => owner.length };
    case 'vectors': return { search: () => [{ id: `${owner}-v`, text: SECRET, score: 1 }] };
    case 'workflowStore': {
      const defs = new Map<string, WorkflowDef>([[`${owner}-wf`, { name: `${owner}-wf`, description: SECRET, steps: [] }]]);
      return { list: () => [...defs.values()], get: (n: string) => defs.get(n), set: (d: WorkflowDef) => { defs.set(d.name, d); }, delete: (n: string) => { defs.delete(n); } };
    }
  }
}
/** A read that shows whose store answered, per kind. */
const PROBE: Record<Kind, [method: string, path: string, body?: unknown]> = {
  queue: ['GET', '/jobs'],
  events: ['GET', '/dead-events?topic=x.topic&consumer=c'],
  cache: ['GET', '/cache/stats'],
  vectors: ['POST', '/knowledge/search', { query: 'q' }],
  workflowStore: ['GET', '/workflows'],
};
/** A route that refuses (rather than omits) when the caller may not reach the store. */
const REFUSE_PROBE: Record<Kind, [method: string, path: string, body?: unknown]> = {
  ...PROBE,
  // `GET /workflows` keeps listing code workflows and omits the managed half; the definition route refuses.
  workflowStore: ['GET', '/workflows/acme-wf/def'],
};
/** The capabilities each store backs. */
const CAPS: Record<Kind, string[]> = {
  queue: ['queue', 'queueManage'], events: ['deadEvents', 'eventsManage'], cache: ['cache', 'cacheManage'],
  vectors: ['knowledge'], workflowStore: ['workflowManage'],
};
const KINDS = Object.keys(PROBE) as Kind[];

describe.each(KINDS)('`%s`', (kind) => {
  const [method, path, body] = PROBE[kind];

  it('as a function: each organization reaches its own store, built once', async () => {
    const factory = vi.fn(({ orgId }: { orgId?: string }) => storeFor(kind, orgId ?? 'root'));
    const api = createStudioApi({ reader: new InMemoryJournal(), auth: auth as never, org: {}, [kind]: factory } as never) as unknown as Api;
    const acme = await send(api, 'acme', method, path, body);
    const globex = await send(api, 'globex', method, path, body);
    expect(acme.status).toBe(200);
    expect(globex.status).toBe(200);
    const [a, g] = [await acme.text(), await globex.text()];
    expect(a).not.toBe(g);
    expect(g).not.toContain('ACME');
    expect(a).not.toContain('GLOBEX');
    await send(api, 'acme', method, path, body);
    await send(api, 'root', method, path, body);
    expect(factory.mock.calls.map(([s]) => s.orgId)).toEqual(['acme', 'globex', undefined]);
    // Reported reachable, so the UI shows the surface rather than its refusal.
    const caps = await (await send(api, 'acme', 'GET', '/capabilities')).json() as Record<string, unknown> & { scopeRefused: string[] };
    for (const cap of CAPS[kind]) {
      expect(caps[cap], cap).toBe(true);
      expect(caps.scopeRefused).not.toContain(cap);
    }
  });

  it('as a plain object: served to the root operator, refused to an organization even if it claims `orgScoped`', async () => {
    const [method, path, body] = REFUSE_PROBE[kind];
    const api = createStudioApi({ reader: new InMemoryJournal(), auth: auth as never, org: {}, [kind]: { ...storeFor(kind, 'acme'), orgScoped: true } } as never) as unknown as Api;
    expect((await send(api, 'root', method, path, body)).status).toBe(200);
    const r = await send(api, 'globex', method, path, body);
    const text = await r.text();
    expect(r.status).toBe(403);
    expect(text).not.toContain('ACME-PRIVATE');
    expect(JSON.parse(text).code).toBe('org_scope_refused');
    expect(JSON.parse(text).error).toMatch(/\(\{ orgId \}\) =>/);
  });

  it('as a plain object with no organizations at all: unchanged', async () => {
    const api = createStudioApi({ reader: new InMemoryJournal(), [kind]: storeFor(kind, 'solo') } as never) as unknown as Api;
    const r = await call(api, path, { method, ...(body ? { headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) } : {}) });
    expect(r.status).toBe(200);
  });

  it('a throwing factory answers 500 for that organization and is asked again next time', async () => {
    let fail = true;
    const factory = vi.fn(({ orgId }: { orgId?: string }) => { if (fail) throw new Error('down'); return storeFor(kind, orgId ?? 'root'); });
    const api = createStudioApi({ reader: new InMemoryJournal(), auth: auth as never, org: {}, [kind]: factory } as never) as unknown as Api;
    expect((await send(api, 'acme', method, path, body)).status).toBe(500);
    fail = false;
    expect((await send(api, 'acme', method, path, body)).status).toBe(200);
  });
});

describe('writes through the function form stay in the caller\'s store', () => {
  it('queue retry, dead-event release, workflow delete', async () => {
    const wf = new Map<string, Record<string, unknown>>();
    const api = createStudioApi({
      reader: new InMemoryJournal(), auth: auth as never, org: {},
      queue: ({ orgId }) => storeFor('queue', orgId!) as never,
      events: ({ orgId }) => storeFor('events', orgId!) as never,
      workflowStore: ({ orgId }) => { const s = storeFor('workflowStore', orgId!); wf.set(orgId!, s); return s as never; },
    }) as unknown as Api;
    await send(api, 'acme', 'GET', '/workflows');
    expect((await send(api, 'globex', 'POST', '/jobs/acme-job/retry', {})).status).toBe(409);
    expect((await send(api, 'acme', 'POST', '/jobs/acme-job/retry', {})).status).toBe(200);
    expect((await send(api, 'globex', 'POST', '/dead-events/release', { topic: 'acme.topic', consumer: 'c', id: 'acme-e' })).status).toBe(409);
    expect((await send(api, 'acme', 'POST', '/dead-events/release', { topic: 'acme.topic', consumer: 'c', id: 'acme-e' })).status).toBe(200);
    await send(api, 'globex', 'DELETE', '/workflows/acme-wf');
    expect(await (wf.get('acme')!.get as (n: string) => unknown)('acme-wf')).toBeDefined();
    await send(api, 'acme', 'DELETE', '/workflows/acme-wf');
    expect(await (wf.get('acme')!.get as (n: string) => unknown)('acme-wf')).toBeUndefined();
  });
});
